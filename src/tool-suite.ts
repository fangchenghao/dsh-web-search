/**
 * One model-facing entry point for the plugin's optional capabilities.
 *
 * The plugin used to register eight separate tools. That made every capability
 * visible all the time, which is expensive in a long system prompt and makes
 * the model choose between near-synonyms before it has even read the question.
 * This module keeps the same handlers but exposes them as one `web_tools`
 * definition with an `action` discriminator:
 *
 * - `search_many`
 * - `advanced_search`
 * - `domain_search`
 * - `platform_search`
 * - `read_page`
 * - `research`
 * - `cache_search`
 * - `engine_test`
 *
 * The sub-definitions are still the source of truth for validation, execution
 * and rendering. This adapter only validates the envelope, dispatches to the
 * matching definition and forwards its rendered text. A host that wants the
 * old eight names can opt in with `toolSurface: "legacy"`; the default is the
 * unified surface.
 *
 * @module @fangchenghao/dsh-web-search/tool-suite
 */
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';

/** Preferred name for the unified tool. */
export const UNIFIED_TOOL_NAME = 'web_tools';
/** Name used when another plugin already owns {@link UNIFIED_TOOL_NAME}. */
export const UNIFIED_TOOL_FALLBACK_NAME = 'web_search_tools';

/** Every action the unified tool accepts, in prompt-friendly order. */
export const UNIFIED_ACTIONS = [
  'search_many',
  'advanced_search',
  'domain_search',
  'platform_search',
  'read_page',
  'research',
  'cache_search',
  'engine_test',
] as const;

/** One accepted action name. */
export type UnifiedAction = (typeof UNIFIED_ACTIONS)[number];

/** Runtime test for an action name. */
export function isUnifiedAction(value: unknown): value is UnifiedAction {
  return typeof value === 'string' && (UNIFIED_ACTIONS as readonly string[]).includes(value);
}

/** The subset of a sub-tool definition this adapter needs. */
export interface SubToolDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: never) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>;
}

/** A registry-shaped adapter, matching the host's raw tool dialect. */
export interface UnifiedToolDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: unknown) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<UnifiedValue>;
}

/** The value returned by the unified tool. */
export interface UnifiedValue {
  action: UnifiedAction;
  result: unknown;
}

/** The registry slice used for registration. */
export interface UnifiedToolRegistryLike {
  register(definition: UnifiedToolDefinition): unknown;
  get?(name: string, scope?: unknown): unknown;
}

/** Registration options. */
export interface UnifiedToolOptions {
  /** Diagnostics for a rejected registration. */
  warn?: (message: string) => void;
}

/** True for a plain object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove the envelope field before a sub-tool sees its own arguments. */
function withoutAction(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest['action'];
  return rest;
}

/**
 * The envelope schema. Action-specific required fields are validated by the
 * matching sub-definition, which keeps this schema small enough to understand
 * while still rejecting an unknown action at the boundary.
 */
function parameterSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [...UNIFIED_ACTIONS],
        description:
          'Which capability to run. Use search_many for several independent searches, advanced_search for one search with a per-call date window, domain_search for packages/papers/repositories/Q&A, platform_search for Bilibili/V2EX/Reddit/YouTube/Zhihu/Juejin, read_page to continue a long page from nextOffset, research for a cited evidence pack, cache_search for full texts already fetched by research, and engine_test for engine health.',
      },
      query: {
        type: 'string',
        description: 'The main query or URL-adjacent question for the selected action.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional independent queries for search_many, or extra queries for research.',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'domain_search source ids. Omit to use the deployment default.',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: 'platform_search platform ids. Omit to search all six.',
      },
      url: {
        type: 'string',
        description: 'Absolute http(s) URL for read_page.',
      },
      offset: {
        type: 'integer',
        description: 'read_page first character, zero-based. Pass the previous nextOffset to continue.',
      },
      maxLength: {
        type: 'integer',
        description: 'read_page characters to return; omit to use the configured fetchMaxLength.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'read_page output style; omit to use the configured fetchFormat.',
      },
      limit: {
        type: 'integer',
        description: 'Action-specific result budget (domain/platform/search_many/cache_search).',
      },
      maxResults: {
        type: 'integer',
        description: 'advanced_search result budget; overrides limit for that action.',
      },
      maxSources: {
        type: 'integer',
        description: 'research pages to fetch and quote (1-5, default 3).',
      },
      timeRange: {
        type: 'string',
        enum: ['off', 'day', 'week', 'month', 'year'],
        description: 'advanced_search or domain_search publication window.',
      },
      withSites: {
        type: 'boolean',
        description: 'search_many: attach each result hostname. Defaults to false.',
      },
      engine: {
        type: 'string',
        description: 'engine_test: optional engine id to test alone.',
      },
    },
    required: ['action'],
  };
}

/** The output envelope; the sub-tool's own rendered text is the payload. */
function outputSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      action: { type: 'string', enum: [...UNIFIED_ACTIONS] },
      result: { type: 'object', additionalProperties: true },
    },
    required: ['action', 'result'],
  };
}

/** Read and validate the action envelope. */
function parseEnvelope(args: unknown): { action: UnifiedAction; rest: Record<string, unknown> } {
  if (!isRecord(args)) throw new Error('web_tools requires arguments');
  const action = args['action'];
  if (!isUnifiedAction(action)) {
    throw new Error(`web_tools action must be one of ${UNIFIED_ACTIONS.join(', ')}`);
  }
  return { action, rest: withoutAction(args) };
}

/** The sub-definition for one action, or undefined when it failed to register. */
function findDefinition(
  definitions: readonly SubToolDefinition[],
  action: UnifiedAction,
): SubToolDefinition | undefined {
  return definitions.find((definition) => definition.name === action);
}

/**
 * Build the single unified definition.
 * @param name - preferred or fallback name.
 * @param definitions - the eight sub-definitions, in registration order.
 * @returns a registry-ready tool definition.
 */
export function createUnifiedToolDefinition(
  name: string,
  definitions: readonly SubToolDefinition[],
): UnifiedToolDefinition {
  const byAction = new Map<UnifiedAction, SubToolDefinition>();
  for (const action of UNIFIED_ACTIONS) {
    const definition = findDefinition(definitions, action);
    if (definition !== undefined) byAction.set(action, definition);
  }

  return {
    name,
    description:
      'One entry point for advanced web work. Set action to search_many, advanced_search, domain_search, platform_search, read_page, research, cache_search or engine_test, then pass that action\'s fields. Use the host web_search for one ordinary search and web_fetch for one page; use this tool when the job needs several queries, a dedicated source, a community/video platform, a long page, cited evidence, a second lookup in already-fetched text, or engine diagnostics.',
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (args, value) => {
        if (!isRecord(value) || !isUnifiedAction(value['action'])) {
          return [{ type: 'text', text: 'web_tools returned no action result.' }];
        }
        const definition = byAction.get(value['action']);
        const inner = value['result'];
        if (definition === undefined || inner === undefined) {
          return [{ type: 'text', text: `web_tools action ${value['action']} returned no result.` }];
        }
        const rest = isRecord(args) ? withoutAction(args) : {};
        return definition.output.render(rest, inner as never);
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: (args) => {
      if (!isRecord(args) || !isUnifiedAction(args['action'])) return false;
      const definition = byAction.get(args['action']);
      return definition?.isConcurrencySafe?.(withoutAction(args)) ?? false;
    },
    async execute(args, exec) {
      const { action, rest } = parseEnvelope(args);
      const definition = byAction.get(action);
      if (definition === undefined) {
        throw new Error(`web_tools action ${action} is not registered in this deployment`);
      }
      const result = await definition.execute(rest, exec);
      return { action, result };
    },
  };
}

/** Choose the preferred name unless another plugin already owns it. */
export function pickUnifiedToolName(tools: UnifiedToolRegistryLike): string {
  if (typeof tools.get !== 'function') return UNIFIED_TOOL_NAME;
  try {
    if (tools.get(UNIFIED_TOOL_NAME) === undefined) return UNIFIED_TOOL_NAME;
    if (tools.get(UNIFIED_TOOL_FALLBACK_NAME) === undefined) return UNIFIED_TOOL_FALLBACK_NAME;
  } catch {
    // A host whose get() throws is treated as free; register() remains the
    // final authority and its failure is contained below.
    return UNIFIED_TOOL_NAME;
  }
  return UNIFIED_TOOL_FALLBACK_NAME;
}

/**
 * Register the unified tool. A rejection is reported and swallowed so the
 * search provider and fetch provider keep working.
 * @returns the registered name, or undefined when registration was skipped.
 */
export function registerUnifiedTool(
  tools: UnifiedToolRegistryLike,
  definitions: readonly SubToolDefinition[],
  options: UnifiedToolOptions = {},
): string | undefined {
  const name = pickUnifiedToolName(tools);
  try {
    tools.register(createUnifiedToolDefinition(name, definitions));
    return name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      options.warn?.(`web_tools registration skipped: ${message}`);
    } catch {
      // Diagnostics must never break plugin loading.
    }
    return undefined;
  }
}
