/**
 * The model-facing `platform_search` tool.
 *
 * It is the community/video counterpart to `domain_search`: one call can ask
 * Bilibili, V2EX, Reddit, YouTube, Zhihu and Juejin for pages about a topic.
 * The transport and parser live in `platforms.ts`; this module owns only the
 * tool contract (arguments, validation, rendering, fallback name and
 * registration). That keeps the network adapters testable without the host
 * registry and keeps the tool definition in the same raw JSON-Schema dialect
 * as the other optional tools.
 *
 * @module @fangchenghao/dsh-web-search/platform-tool
 */
import type { Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
import { wrapUntrustedContent } from './untrusted.ts';
import { MAX_PLATFORM_LIMIT, PLATFORM_IDS, PLATFORM_LABELS, isPlatformId } from './platforms.ts';
import type { PlatformId } from './platforms.ts';

/** The name this tool prefers. */
export const PLATFORM_TOOL_NAME = 'platform_search';
/** The name used when another plugin already registered `platform_search`. */
export const PLATFORM_TOOL_FALLBACK_NAME = 'web_platform_search';
/** Default and maximum result count per call (merged across platforms). */
export const PLATFORM_DEFAULT_LIMIT = 5;
export const PLATFORM_MAX_LIMIT = 10;

/** What one platform call returns to the model. */
export interface PlatformToolValue {
  query: string;
  platforms: PlatformId[];
  sources: Source[];
  failures: string[];
  via: Partial<Record<PlatformId, 'api' | 'fallback'>>;
  truncated: boolean;
}

/** The network half, injectable so the tool definition can be tested offline. */
export type PlatformRunner = (
  query: string,
  ids: readonly PlatformId[],
  limit: number,
  signal?: AbortSignal,
) => Promise<Omit<PlatformToolValue, 'query' | 'platforms'>>;

/** A registry definition in the host's raw JSON-Schema dialect. */
export interface PlatformToolDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: PlatformToolValue) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: () => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<PlatformToolValue>;
}

/** The slice of the tool registry this module needs. */
export interface PlatformToolRegistryLike {
  register(definition: PlatformToolDefinition): unknown;
  get?(name: string, scope?: unknown): unknown;
}

/** True for a value usable as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parameter schema. */
function parameterSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'What to look for on the selected community/video platforms; distinctive words work best.',
      },
      platforms: {
        type: 'array',
        items: { type: 'string', enum: [...PLATFORM_IDS] },
        description: `Platforms to search: ${PLATFORM_IDS.join(', ')}. Omit to search all six.`,
      },
      limit: {
        type: 'integer',
        description: `Merged results wanted, 1–${PLATFORM_MAX_LIMIT}; defaults to ${PLATFORM_DEFAULT_LIMIT}.`,
      },
    },
    required: ['query'],
  };
}

/** Output schema. */
function outputSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      platforms: { type: 'array', items: { type: 'string', enum: [...PLATFORM_IDS] } },
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
      via: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bilibili: { type: 'string', enum: ['api', 'fallback'] },
          v2ex: { type: 'string', enum: ['api', 'fallback'] },
          reddit: { type: 'string', enum: ['api', 'fallback'] },
          youtube: { type: 'string', enum: ['api', 'fallback'] },
          zhihu: { type: 'string', enum: ['api', 'fallback'] },
          juejin: { type: 'string', enum: ['api', 'fallback'] },
        },
      },
      truncated: { type: 'boolean' },
    },
    required: ['query', 'platforms', 'sources', 'failures', 'via', 'truncated'],
  };
}

/** Parse and validate arguments. */
export function parsePlatformArgs(args: unknown): { query: string; ids: PlatformId[]; limit: number } {
  if (!isRecord(args) || typeof args['query'] !== 'string' || args['query'].trim().length === 0) {
    throw new Error('platform_search requires a non-empty query');
  }
  const rawIds = args['platforms'];
  let ids: PlatformId[] = [...PLATFORM_IDS];
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds) || rawIds.some((item) => !isPlatformId(item))) {
      throw new Error(`platform_search platforms must be a subset of ${PLATFORM_IDS.join(', ')}`);
    }
    if (rawIds.length === 0) throw new Error('platform_search platforms must not be empty');
    ids = PLATFORM_IDS.filter((id) => (rawIds as readonly string[]).includes(id));
  }
  const rawLimit = args['limit'];
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > PLATFORM_MAX_LIMIT)) {
    throw new Error(`platform_search limit must be an integer between 1 and ${PLATFORM_MAX_LIMIT}`);
  }
  return { query: args['query'].trim(), ids, limit: rawLimit ?? PLATFORM_DEFAULT_LIMIT };
}

/** Format the model-facing result, inside the untrusted boundary. */
export function formatPlatformValue(value: PlatformToolValue): string {
  const platforms = value.platforms.map((id) => PLATFORM_LABELS[id]).join(', ');
  const head = `Platform search: ${JSON.stringify(value.query)} — ${value.sources.length} result(s) from ${platforms}${value.truncated ? ' (truncated)' : ''}.`;
  const lines = value.sources.map((source, index) => {
    const linesForSource = [`${index + 1}. ${source.title ?? source.url}`, `   ${source.url}`];
    if (source.snippet !== undefined && source.snippet.length > 0) linesForSource.push(`   ${source.snippet}`);
    if (source.publishedAt !== undefined && source.publishedAt.length > 0) linesForSource.push(`   ${source.publishedAt}`);
    return linesForSource.join('\n');
  });
  if (value.failures.length > 0) lines.push('', 'Unavailable platforms:', ...value.failures.map((failure) => `- ${failure}`));
  return [head, '', ...lines].join('\n').trimEnd();
}

/**
 * Build the tool definition.
 * @param name - preferred or fallback name.
 * @param run - network runner, normally `searchPlatforms` with the live proxy
 *   and the plugin's normal search as the fallback.
 */
export function createPlatformToolDefinition(name: string, run: PlatformRunner): PlatformToolDefinition {
  return {
    name,
    description:
      'Search community and video platforms directly: Bilibili, V2EX, Reddit, YouTube, Zhihu and Juejin. Use it when the user asks what a community, forum or video site says; use web_search for general pages. Results include title, URL, snippet and date when the platform exposes one.',
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: wrapUntrustedContent(formatPlatformValue(value)) }],
    },
    timeoutMs: 40_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parsePlatformArgs(args);
      const result = await run(parsed.query, parsed.ids, parsed.limit, exec.signal);
      return {
        query: parsed.query,
        platforms: [...parsed.ids],
        sources: result.sources.slice(0, parsed.limit).map((source) => ({ ...source })),
        failures: [...result.failures],
        via: { ...result.via },
        truncated: result.truncated || result.sources.length > parsed.limit,
      };
    },
  };
}

/** Pick the preferred name unless another tool already owns it. */
export function pickPlatformToolName(tools: PlatformToolRegistryLike): string {
  if (typeof tools.get !== 'function') return PLATFORM_TOOL_NAME;
  try {
    return tools.get(PLATFORM_TOOL_NAME) === undefined ? PLATFORM_TOOL_NAME : PLATFORM_TOOL_FALLBACK_NAME;
  } catch {
    return PLATFORM_TOOL_NAME;
  }
}

/** Register the tool; any registry failure is contained. */
export function registerPlatformTool(
  tools: PlatformToolRegistryLike,
  run: PlatformRunner,
  options: { warn?: (message: string) => void } = {},
): string | undefined {
  const name = pickPlatformToolName(tools);
  try {
    tools.register(createPlatformToolDefinition(name, run));
    return name;
  } catch (error) {
    try {
      options.warn?.(`platform_search registration skipped: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // Diagnostics must not break mounting.
    }
    return undefined;
  }
}

export { MAX_PLATFORM_LIMIT };
