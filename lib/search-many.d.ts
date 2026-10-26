/**
 * The model-facing `search_many` tool: several independent searches in one
 * call, each reusing the same engine layer, cache and cooldown tracker as
 * `web_search`.
 *
 * The batch is deliberately boring: every query is a normal search, failures
 * are recorded per query instead of aborting the batch, and at most three
 * searches run at once so one call cannot spend the whole engine budget. The
 * registration path mirrors `domain-tool.ts` — raw JSON Schema, `output`
 * carrying `{ schema, render }`, the optional `ctx.get('tools')` lookup, a
 * fallback name on collision, and a contained failure path.
 *
 * @module @fangchenghao/dsh-web-search/search-many
 */
import type { EngineFailure, Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const SEARCH_MANY_TOOL_NAME = "search_many";
/** The name used when another plugin already registered `search_many`. */
export declare const SEARCH_MANY_FALLBACK_NAME = "web_search_many";
/** How many queries run at the same time; deliberately below the engine count. */
export declare const SEARCH_MANY_CONCURRENCY = 3;
/** Queries accepted in one call. */
export declare const SEARCH_MANY_MIN_QUERIES = 1;
/** Queries accepted in one call. */
export declare const SEARCH_MANY_MAX_QUERIES = 5;
/** Default result budget for a query that names none. */
export declare const SEARCH_MANY_DEFAULT_LIMIT = 5;
/** Largest per-query budget the tool accepts. */
export declare const SEARCH_MANY_MAX_LIMIT = 20;
/** One source as `search_many` reports it; `site` appears only when asked. */
export interface SearchManySource extends Source {
    /** Lower-cased hostname of {@link Source.url}, when `withSites` is true. */
    site?: string;
}
/** What one query in the batch produced. */
export interface SearchManyResult {
    /** The query exactly as it was accepted (trimmed). */
    query: string;
    sources: SearchManySource[];
    /** Failures for this query alone; a thrown search becomes one entry here. */
    failures: string[];
    /** Short policy note, such as why the fallback tier was used or skipped. */
    note?: string;
}
/** What the tool returns to the model. */
export interface SearchManyValue {
    results: SearchManyResult[];
    /** True when any per-query budget was cut by the deployment's limit. */
    truncated: boolean;
}
/** What a single query's runner reports back. */
export interface SearchManyOutcome {
    sources: Source[];
    failures: string[];
    /** Structured failures from the engine layer, when it reported any. */
    failureDetails?: EngineFailure[];
    /** Short policy note, when the fallback policy changed the answer. */
    note?: string;
    /** True when the deployment's configured limit cut the requested budget. */
    truncated: boolean;
}
/** Run one search; the plugin binds this to the same path as `web_search`. */
export type SearchManyRunner = (query: string, limit: number, signal?: AbortSignal) => Promise<SearchManyOutcome>;
/** A tool definition in the host registry's native shape. */
export interface SearchManyDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: SearchManyValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<SearchManyValue>;
}
/** The slice of the tool registry this module needs. */
export interface SearchManyRegistryLike {
    register(definition: SearchManyDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Construction seams. */
export interface SearchManyOptions {
    /** Registration diagnostics. */
    warn?: (message: string) => void;
}
/** A successful registration plus the exact way to undo it. */
export interface SearchManyRegistration {
    name: string;
    dispose: () => void;
}
/** Format the model-facing result text. */
export declare function formatSearchManyValue(value: SearchManyValue): string;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `search_many`, or the fallback when that name is taken.
 * @param runQuery - executes one search through the plugin's normal path.
 * @returns a registry-ready definition.
 */
export declare function createSearchManyDefinition(name: string, runQuery: SearchManyRunner): SearchManyDefinition;
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickSearchManyToolName(tools: SearchManyRegistryLike): string;
/**
 * Register the tool when a registry is available.
 *
 * Every failure path is contained: a duplicate name falls back, and any
 * registry rejection is reported and swallowed so `web_search` keeps working.
 * The returned registration owns the host disposer, so plugin disposal removes
 * exactly the definition this call added.
 *
 * @param tools - the live registry.
 * @param runQuery - executes one search through the plugin's normal path.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export declare function registerSearchManyTool(tools: SearchManyRegistryLike, runQuery: SearchManyRunner, options?: SearchManyOptions): SearchManyRegistration | undefined;
