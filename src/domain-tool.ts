/**
 * The model-facing `domain_search` tool.
 *
 * The host's tool registry is reached through `ctx.get('tools')`, deliberately
 * **not** through `inject`: an inject entry is a hard dependency, so a
 * deployment that loads this plugin without the tool service would refuse to
 * mount the plugin at all and `web_search` would disappear with it. Reading the
 * service at mount time and declining to register when it is absent keeps the
 * plugin fail-safe, and matches how the shipped tool packages read optional
 * services (`ctx.get(...)` without `inject`).
 *
 * The definition is built from the registry's raw JSON-Schema dialect rather
 * than `defineTool`, because this package must not take a runtime dependency on
 * `@deepseek-ai/dsh-tools` (the host owns that package and it is not resolvable
 * from a plugin's own `node_modules`). The shape below is the one
 * `ToolRuntime.register()` accepts: `parameters` is an object-rooted JSON
 * Schema with a `required` **array**, and `output` carries `{ schema, render }`.
 *
 * @module @fangchenghao/dsh-web-search/domain-tool
 */
import type { Source } from './types.ts';
import { wrapUntrustedContent } from './untrusted.ts';
import { resolveProxy } from './proxy.ts';
import { TIME_RANGES, filterByTimeRange } from './freshness.ts';
import { DEFAULT_VERTICAL_IDS, searchVerticals, isVerticalId, VERTICAL_IDS } from './verticals.ts';
import type { FetchLike, VerticalId } from './verticals.ts';
import type { TimeRange } from './types.ts';

/** The name this tool prefers. */
export const DOMAIN_TOOL_NAME = 'domain_search';
/** The name used when another plugin already registered `domain_search`. */
export const DOMAIN_TOOL_FALLBACK_NAME = 'web_domain_search';

/** The subset of JSON Schema the host registry enforces. */
export interface ToolJsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: string[];
}

/** One model-facing content block, as `output.render` returns. */
export interface ToolContent {
  type: 'text';
  text: string;
}

/** A tool definition in the registry's native shape. */
export interface DomainToolDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: DomainToolValue) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<DomainToolValue>;
}

/** The slice of the tool registry this module needs. */
export interface ToolRegistryLike {
  register(definition: DomainToolDefinition): unknown;
  get?(name: string, scope?: unknown): unknown;
}

/** What the tool returns to the model. */
export interface DomainToolValue {
  sources: Source[];
  failures: string[];
  truncated: boolean;
  /** Present only when this call asked for a publication window. */
  timeRange?: TimeRange;
  /** Why the window did or did not narrow the rows. */
  note?: string;
}

/** Settings the tool reads live for every call. */
export interface DomainToolSettings {
  /** Enabled source ids; empty means every source. */
  sourceIds: readonly string[];
  /** Default result budget per source. */
  limit: number;
  /** Per-source deadline in milliseconds. */
  timeoutMs: number;
  /** Explicit tunnel URL, or `undefined` to auto-detect. */
  proxy?: string;
}

/** Construction seams, so the definition is testable without a network. */
export interface DomainToolOptions {
  /** Replace the platform `fetch` (tests). */
  fetch?: FetchLike;
  /** Replace proxy detection (tests). */
  detectProxy?: () => Promise<string | undefined>;
  /** Registration diagnostics. */
  warn?: (message: string) => void;
}

/** True for a value usable as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamp a tool budget into the range the adapters serve. */
function clampToolLimit(value: number, fallback: number): number {
  const base = Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(20, base));
}

/** The parameter schema, in the registry's raw JSON-Schema dialect. */
function parameterSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'What to look for: a package name, paper topic, repository, error message, or question.',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: `Sources to query: ${VERTICAL_IDS.join(', ')}. Omit to use the deployment default.`,
      },
      limit: {
        type: 'integer',
        description: 'Results wanted per source, 1–20. Omit to use the deployment default.',
      },
      timeRange: {
        type: 'string',
        enum: [...TIME_RANGES],
        description:
          'Optional publication window: off, day, week, month or year. Sources without publication dates are kept only when no dated row falls inside the window.',
      },
    },
    required: ['query'],
  };
}

/** The output schema, in the same dialect. */
function outputSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            publishedAt: { type: 'string' },
          },
          required: ['url'],
        },
      },
      failures: { type: 'array', items: { type: 'string' } },
      truncated: { type: 'boolean' },
      timeRange: { type: 'string', enum: [...TIME_RANGES] },
      note: { type: 'string' },
    },
    required: ['sources', 'failures', 'truncated'],
  };
}

/** Parse model arguments into a validated shape, throwing on nonsense. */
function parseArgs(
  args: unknown,
  settings: DomainToolSettings,
): { query: string; ids: VerticalId[]; limit: number; timeRange?: TimeRange } {
  if (!isRecord(args)) throw new Error('domain_search requires arguments');
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) throw new Error('domain_search requires a non-empty query');

  const enabled = settings.sourceIds.filter(isVerticalId);
  let ids: VerticalId[] = enabled.length > 0 ? enabled : [...DEFAULT_VERTICAL_IDS];
  if (Array.isArray(args.sources) && args.sources.length > 0) {
    const asked = args.sources.filter(isVerticalId);
    if (asked.length === 0) {
      throw new Error(`domain_search: no known source in ${JSON.stringify(args.sources)}; known: ${VERTICAL_IDS.join(', ')}`);
    }
    ids = asked;
  }
  const limit = typeof args.limit === 'number'
    ? clampToolLimit(args.limit, settings.limit)
    : clampToolLimit(settings.limit, 5);
  const rawRange = args['timeRange'];
  if (rawRange !== undefined) {
    if (typeof rawRange !== 'string' || !TIME_RANGES.includes(rawRange as TimeRange)) {
      throw new Error(`domain_search timeRange must be one of ${TIME_RANGES.join(', ')}`);
    }
    return { query, ids, limit, timeRange: rawRange as TimeRange };
  }
  return { query, ids, limit };
}

/** Format the model-facing result text. */
export function formatDomainValue(args: unknown, value: DomainToolValue): string {
  const query = isRecord(args) && typeof args.query === 'string' ? args.query : 'the query';
  const window = value.timeRange === undefined ? '' : ` (timeRange=${value.timeRange})`;
  const head = value.sources.length === 0
    ? `No dedicated source returned a result for ${JSON.stringify(query)}${window}.`
    : `Dedicated search for ${JSON.stringify(query)}${window}: ${value.sources.length} result(s)${value.truncated ? ' (truncated)' : ''}.`;
  const lines = value.sources.map((source, index) => {
    const title = source.title !== undefined && source.title.length > 0 ? source.title : source.url;
    const body = [`${index + 1}. ${title}`, `   ${source.url}`];
    if (source.snippet !== undefined && source.snippet.length > 0) body.push(`   ${source.snippet}`);
    if (source.publishedAt !== undefined && source.publishedAt.length > 0) body.push(`   ${source.publishedAt}`);
    return body.join('\n');
  });
  if (value.note !== undefined && value.note.length > 0) lines.push(`Note: ${value.note}`);
  if (value.failures.length > 0) {
    lines.push('', 'Unavailable sources:', ...value.failures.map((failure) => `- ${failure}`));
  }
  return [head, '', ...lines].join('\n').trimEnd();
}

/**
 * Build the tool definition the host registry accepts.
 * @param name - `domain_search`, or the fallback when that name is taken.
 * @param readSettings - read the live config for every call (volatile fields).
 * @param options - test seams and diagnostics.
 * @returns a registry-ready definition.
 */
export function createDomainToolDefinition(
  name: string,
  readSettings: () => DomainToolSettings,
  options: DomainToolOptions = {},
): DomainToolDefinition {
  const detectProxy = options.detectProxy ?? (() => resolveProxy(undefined));
  return {
    name,
    description:
      'Search dedicated, key-free sources instead of the open web: GitHub repositories, npm/PyPI/crates packages, arXiv papers, Wikipedia, Hacker News and Stack Exchange. Use it when the question is about a package, paper, repository or Q&A thread; use web_search for general pages.',
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (args, value) => [{ type: 'text', text: wrapUntrustedContent(formatDomainValue(args, value)) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = readSettings();
      const parsed = parseArgs(args, settings);
      const explicit = typeof settings.proxy === 'string' ? settings.proxy.trim() : '';
      const proxy = explicit.length > 0 ? explicit : await detectProxy();
      // Ask for more than the caller needs when a window is active, so filtering
      // does not turn a date-ordered source into a one-row answer.
      const searchLimit = parsed.timeRange === undefined || parsed.timeRange === 'off'
        ? parsed.limit
        : Math.min(20, parsed.limit * 3);
      const outcome = await searchVerticals(parsed.query, {
        ids: parsed.ids,
        limit: searchLimit,
        timeoutMs: settings.timeoutMs,
        ...(proxy === undefined || proxy.length === 0 ? {} : { proxy }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        ...(parsed.timeRange === undefined ? {} : { timeRange: parsed.timeRange }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (parsed.timeRange === undefined || parsed.timeRange === 'off') {
        return {
          sources: outcome.sources.slice(0, parsed.limit),
          failures: outcome.failures,
          truncated: outcome.truncated || outcome.sources.length > parsed.limit,
          ...(parsed.timeRange === undefined ? {} : { timeRange: parsed.timeRange }),
        };
      }
      const filtered = filterByTimeRange(outcome.sources, parsed.timeRange);
      const note = filtered.length === 0
        ? `No result was dated inside the ${parsed.timeRange} window.`
        : `${filtered.length} of ${outcome.sources.length} result(s) were dated inside the ${parsed.timeRange} window; undated rows are kept only when no dated row qualified.`;
      return {
        sources: filtered.slice(0, parsed.limit),
        failures: outcome.failures,
        truncated: outcome.truncated || outcome.sources.length > parsed.limit,
        timeRange: parsed.timeRange,
        note,
      };
    },
  };
}

/**
 * Pick the tool name this deployment can accept.
 *
 * A plugin that already owns `domain_search` must not make this one fail to
 * register, so the fallback name is used instead. A registry without `get` is
 * assumed free.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickDomainToolName(tools: ToolRegistryLike): string {
  if (typeof tools.get !== 'function') return DOMAIN_TOOL_NAME;
  try {
    return tools.get(DOMAIN_TOOL_NAME) === undefined ? DOMAIN_TOOL_NAME : DOMAIN_TOOL_FALLBACK_NAME;
  } catch {
    return DOMAIN_TOOL_NAME;
  }
}

/** Report a registration failure without throwing out of the plugin. */
function report(options: DomainToolOptions, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    options.warn?.(`domain_search registration skipped: ${message}`);
  } catch {
    // A diagnostic callback must never break plugin loading.
  }
}

/**
 * Register the tool when a registry is available.
 *
 * Every failure path is contained: a missing service is the caller's job to
 * check, a duplicate name falls back, and any registry rejection is reported
 * and swallowed so `web_search` keeps working.
 * @param tools - the live registry.
 * @param readSettings - live config reader.
 * @param options - test seams and diagnostics.
 * @returns the registered name, or `undefined` when registration was skipped.
 */
export function registerDomainTool(
  tools: ToolRegistryLike,
  readSettings: () => DomainToolSettings,
  options: DomainToolOptions = {},
): string | undefined {
  const name = pickDomainToolName(tools);
  try {
    tools.register(createDomainToolDefinition(name, readSettings, options));
    return name;
  } catch (error) {
    report(options, error);
    return undefined;
  }
}
