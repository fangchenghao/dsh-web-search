/**
 * The model-facing `research` tool: one call that searches, opens the best
 * pages, and returns an evidence pack with the citations already attached.
 *
 * `web_search` answers "what links exist" and `web_fetch` answers "read this
 * page". The step the model keeps doing by hand is the middle one: pick the
 * two or three rows that matter, fetch them without timing out, and keep track
 * of which sentence came from which URL. This tool performs exactly that step:
 * it runs up to three searches through the normal engine path, de-duplicates
 * the rows, fetches the leading pages through the same ladder `web_fetch` uses,
 * and returns one Markdown document in which every excerpt sits under its URL.
 *
 * Failure is part of the contract. A page that will not load is reported by
 * URL and reason, the remaining pages still arrive, and a total fetch failure
 * still returns the search rows — a research call that found links but could
 * not open them is still useful evidence.
 *
 * @module @fangchenghao/dsh-web-search/research
 */
import type { Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';

/** The name this tool prefers. */
export const RESEARCH_TOOL_NAME = 'research';
/** The name used when another plugin already registered `research`. */
export const RESEARCH_TOOL_FALLBACK_NAME = 'web_research';

/** Pages fetched when the call names no budget. */
export const RESEARCH_DEFAULT_SOURCES = 3;
/** Smallest fetch budget a call may ask for. */
export const RESEARCH_MIN_SOURCES = 1;
/** Largest fetch budget a call may ask for. */
export const RESEARCH_MAX_SOURCES = 5;
/** Distinct queries accepted in one call. */
export const RESEARCH_MAX_QUERIES = 3;
/** Characters kept from each fetched page. */
export const RESEARCH_EXCERPT_CHARS = 1_200;
/** Pages fetched at the same time. */
export const RESEARCH_PAGE_CONCURRENCY = 3;
/** Wall-clock budget for the whole call, below the tool's host timeout. */
export const RESEARCH_BUDGET_MS = 45_000;
/** Below this much budget a page fetch is not worth starting. */
const RESEARCH_MIN_PAGE_MS = 2_500;

/** What one search reports to the tool. */
export interface ResearchSearchOutcome {
  sources: Source[];
  failures: string[];
}

/** Runs one query through the plugin's normal engine path. */
export type ResearchSearcher = (
  query: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<ResearchSearchOutcome>;

/** What the fetch ladder reports for one URL. */
export interface ResearchFetchedPage {
  url: string;
  status: number;
  text: string;
  truncated: boolean;
}

/** Fetches one URL through the plugin's normal ladder. */
export type ResearchFetcher = (url: string, signal?: AbortSignal) => Promise<ResearchFetchedPage>;

/** One page in the evidence pack. */
export interface ResearchPage {
  url: string;
  title?: string;
  status: number;
  chars: number;
  excerpt: string;
  truncated: boolean;
}

/** A URL the call found but could not turn into evidence. */
export interface ResearchFetchFailure {
  url: string;
  reason: string;
}

/** What the tool returns to the model. */
export interface ResearchValue {
  /** The query exactly as accepted (trimmed). */
  query: string;
  /** Every query the call actually ran. */
  queries: string[];
  /** Fetched pages, in the order they were chosen. */
  pages: ResearchPage[];
  /** Rows that were found but not fetched, with their titles when known. */
  sources: Array<{ url: string; title?: string }>;
  /** Fetch failures, one entry per URL. */
  failures: ResearchFetchFailure[];
  /** Number of search rows seen before the fetch budget cut them. */
  found: number;
  /** True when the search row list was cut by the fetch budget. */
  truncated: boolean;
}

/** A tool definition in the registry's native shape. */
export interface ResearchDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: ResearchValue) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<ResearchValue>;
}

/** The slice of the tool registry this module needs. */
export interface ResearchRegistryLike {
  register(definition: ResearchDefinition): unknown;
  get?(name: string, scope?: unknown): unknown;
}

/** Construction seams. */
export interface ResearchOptions {
  /** Registration diagnostics. */
  warn?: (message: string) => void;
}

/** A successful registration plus the exact way to undo it. */
export interface ResearchRegistration {
  name: string;
  dispose: () => void;
}

/** Parsed arguments. */
interface ResearchArgs {
  queries: string[];
  maxSources: number;
}

/**
 * Canonical form used to decide whether two rows are the same page.
 *
 * Search engines disagree about `www.`, trailing slashes and fragments; two
 * rows that differ only in those are one page, and fetching both wastes the
 * whole budget.
 * @param raw - candidate URL.
 * @returns a stable key, or `undefined` for a non-http(s) URL.
 */
export function canonicalKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return `${host}${path}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Collapse page text into a readable excerpt. */
function excerptOf(text: string, max: number): string {
  const flattened = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max - 1).trimEnd()}…`;
}

/** Walk `worker` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Interleave per-query result lists by rank, so one query cannot fill the pack. */
function interleave(sourcesByQuery: readonly Source[][]): Source[] {
  const merged: Source[] = [];
  const seen = new Set<string>();
  let depth = 0;
  for (const list of sourcesByQuery) depth = Math.max(depth, list.length);
  for (let rank = 0; rank < depth; rank += 1) {
    for (const list of sourcesByQuery) {
      const source = list[rank];
      if (source === undefined) continue;
      const key = canonicalKey(source.url);
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

/** Read the argument object, rejecting the shapes the model gets wrong. */
function parseArgs(args: unknown): ResearchArgs {
  if (typeof args !== 'object' || args === null) throw new Error('research requires an object argument');
  const record = args as Record<string, unknown>;
  const query = typeof record['query'] === 'string' ? record['query'].trim() : '';
  const extra = record['queries'];
  const queries: string[] = [];
  if (query.length > 0) queries.push(query);
  if (extra !== undefined) {
    if (!Array.isArray(extra)) throw new Error('research queries must be an array of strings');
    for (const item of extra as unknown[]) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error('research queries must be non-empty strings');
      }
      const trimmed = item.trim();
      if (!queries.includes(trimmed)) queries.push(trimmed);
    }
  }
  if (queries.length === 0) throw new Error('research requires a non-empty query');
  if (queries.length > RESEARCH_MAX_QUERIES) {
    throw new Error(`research accepts at most ${RESEARCH_MAX_QUERIES} queries, got ${queries.length}`);
  }
  const rawSources = record['maxSources'];
  let maxSources = RESEARCH_DEFAULT_SOURCES;
  if (rawSources !== undefined) {
    if (typeof rawSources !== 'number' || !Number.isInteger(rawSources)) {
      throw new Error('research maxSources must be an integer');
    }
    maxSources = Math.min(RESEARCH_MAX_SOURCES, Math.max(RESEARCH_MIN_SOURCES, rawSources));
  }
  return { queries, maxSources };
}

/** The parameter schema, kept as plain JSON Schema like the other tools. */
function parameterSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'The question to research. It is sent to the search engines verbatim.',
      },
      queries: {
        type: 'array',
        description: `Up to ${RESEARCH_MAX_QUERIES} additional distinct queries to widen the evidence; results are merged with the main query.`,
        items: { type: 'string' },
      },
      maxSources: {
        type: 'integer',
        description: `How many pages to fetch and quote (${RESEARCH_MIN_SOURCES}–${RESEARCH_MAX_SOURCES}, default ${RESEARCH_DEFAULT_SOURCES}).`,
      },
    },
    required: ['query'],
  };
}

/** The output schema: pages carry their own citation. */
function outputSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      queries: { type: 'array', items: { type: 'string' } },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            chars: { type: 'integer' },
            excerpt: { type: 'string' },
            truncated: { type: 'boolean' },
          },
          required: ['url', 'status', 'chars', 'excerpt', 'truncated'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { url: { type: 'string' }, title: { type: 'string' } },
          required: ['url'],
        },
      },
      failures: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { url: { type: 'string' }, reason: { type: 'string' } },
          required: ['url', 'reason'],
        },
      },
      found: { type: 'integer' },
      truncated: { type: 'boolean' },
    },
    required: ['query', 'queries', 'pages', 'sources', 'failures', 'found', 'truncated'],
  };
}

/**
 * Format the evidence pack the model reads.
 * @param value - what the call produced.
 * @returns a Markdown document with one section per fetched page.
 */
export function formatResearchValue(value: ResearchValue): string {
  const head = [
    `Research: ${JSON.stringify(value.query)}`,
    `Searched ${value.queries.length} quer${value.queries.length === 1 ? 'y' : 'ies'}, `
      + `${value.found} source(s) found, ${value.pages.length} page(s) fetched.`,
  ];
  if (value.queries.length > 1) {
    head.push(`Queries: ${value.queries.map((query) => JSON.stringify(query)).join(', ')}`);
  }
  const sections = value.pages.map((page, index) => {
    const lines = [
      `## ${index + 1}. ${page.title !== undefined && page.title.length > 0 ? page.title : page.url}`,
      page.url,
      '',
      page.excerpt,
    ];
    if (page.truncated) lines.push('', '(excerpt truncated)');
    return lines.join('\n');
  });
  const notFetched = value.sources.length === 0
    ? []
    : [
      '## Found but not fetched',
      ...value.sources.map((source) => `- ${source.title !== undefined && source.title.length > 0 ? `${source.title} — ` : ''}${source.url}`),
    ];
  const failures = value.failures.length === 0
    ? []
    : ['## Fetch failures', ...value.failures.map((failure) => `- ${failure.url}: ${failure.reason}`)];
  return [...head, '', ...sections, ...(notFetched.length === 0 ? [] : ['', ...notFetched]), ...(failures.length === 0 ? [] : ['', ...failures])]
    .join('\n')
    .trimEnd();
}

/**
 * Build the tool definition the host registry accepts.
 * @param name - `research`, or the fallback when that name is taken.
 * @param search - runs one query through the plugin's search path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @returns a registry-ready definition.
 */
export function createResearchDefinition(
  name: string,
  search: ResearchSearcher,
  fetchPage: ResearchFetcher,
): ResearchDefinition {
  return {
    name,
    description:
      'Research a question end to end: run up to three searches, open the leading pages, and return an evidence pack in which every excerpt sits under its URL. Use it when the answer needs citations or several sources, not when one search row is enough. Pages that fail to load are reported by URL and reason instead of aborting the call.',
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: formatResearchValue(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseArgs(args);
      const signal = exec.signal;
      const startedAt = Date.now();
      const remaining = (): number => Math.max(0, RESEARCH_BUDGET_MS - (Date.now() - startedAt));
      const cancelled = (): boolean => signal !== undefined && signal.aborted;

      const searchLimit = Math.max(5, parsed.maxSources);
      const outcomes = await mapLimit(parsed.queries, 2, async (query) => {
        try {
          return await search(query, searchLimit, signal);
        } catch (error) {
          return {
            sources: [],
            failures: [error instanceof Error ? error.message : String(error)],
          } satisfies ResearchSearchOutcome;
        }
      });
      if (cancelled()) throw new Error('research was cancelled');
      const candidates = interleave(outcomes.map((outcome) => outcome.sources));
      const failures: ResearchFetchFailure[] = [];
      const wanted = candidates.slice(0, parsed.maxSources);
      const pages = await mapLimit(wanted, RESEARCH_PAGE_CONCURRENCY, async (source) => {
        if (cancelled()) return undefined;
        const budget = Math.min(20_000, remaining());
        if (budget < RESEARCH_MIN_PAGE_MS) {
          failures.push({ url: source.url, reason: 'no time left in the research budget' });
          return undefined;
        }
        const bound = signal === undefined
          ? AbortSignal.timeout(budget)
          : AbortSignal.any([signal, AbortSignal.timeout(budget)]);
        try {
          const fetched = await fetchPage(source.url, bound);
          const excerpt = excerptOf(fetched.text, RESEARCH_EXCERPT_CHARS);
          if (excerpt.length === 0) {
            failures.push({ url: source.url, reason: 'the page carried no readable text' });
            return undefined;
          }
          const page: ResearchPage = {
            url: fetched.url.length > 0 ? fetched.url : source.url,
            ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
            status: fetched.status,
            chars: fetched.text.length,
            excerpt,
            truncated: fetched.truncated || fetched.text.length > RESEARCH_EXCERPT_CHARS,
          };
          return page;
        } catch (error) {
          if (cancelled()) throw error;
          failures.push({ url: source.url, reason: error instanceof Error ? error.message : String(error) });
          return undefined;
        }
      });
      if (cancelled()) throw new Error('research was cancelled');
      const fetchedPages = pages.filter((page): page is ResearchPage => page !== undefined);
      const fetchedUrls = new Set(fetchedPages.map((page) => page.url));
      return {
        query: parsed.queries[0] as string,
        queries: parsed.queries,
        pages: fetchedPages,
        sources: candidates
          .filter((source) => !fetchedUrls.has(source.url))
          .slice(0, 20)
          .map((source) => ({
            url: source.url,
            ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
          })),
        failures,
        found: candidates.length,
        truncated: candidates.length > parsed.maxSources,
      };
    },
  };
}

/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickResearchToolName(tools: ResearchRegistryLike): string {
  if (typeof tools.get !== 'function') return RESEARCH_TOOL_NAME;
  try {
    return tools.get(RESEARCH_TOOL_NAME) === undefined ? RESEARCH_TOOL_NAME : RESEARCH_TOOL_FALLBACK_NAME;
  } catch {
    return RESEARCH_TOOL_NAME;
  }
}

/** Report a registration failure without throwing out of the plugin. */
function report(options: ResearchOptions, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    options.warn?.(`research registration skipped: ${message}`);
  } catch {
    // A diagnostic callback must never break plugin loading.
  }
}

/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param search - executes one search through the plugin's normal path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerResearchTool(
  tools: ResearchRegistryLike,
  search: ResearchSearcher,
  fetchPage: ResearchFetcher,
  options: ResearchOptions = {},
): ResearchRegistration | undefined {
  const name = pickResearchToolName(tools);
  try {
    const registered = tools.register(createResearchDefinition(name, search, fetchPage));
    const disposeHost = typeof registered === 'function' ? (registered as () => void) : undefined;
    let disposed = false;
    return {
      name,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try {
          disposeHost?.();
        } catch {
          // Disposal must stay contained; the plugin is already going away.
        }
      },
    };
  } catch (error) {
    report(options, error);
    return undefined;
  }
}
