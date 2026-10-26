import type { EngineFailure, Source, TimeRange } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const ADVANCED_SEARCH_TOOL_NAME = "advanced_search";
/** The name used when another plugin already registered `advanced_search`. */
export declare const ADVANCED_SEARCH_FALLBACK_NAME = "web_search_advanced";
/** Default result budget when the caller names none. */
export declare const ADVANCED_SEARCH_DEFAULT_LIMIT = 5;
/** Largest result budget the tool accepts; the deployment limit still caps it. */
export declare const ADVANCED_SEARCH_MAX_LIMIT = 20;
/** What one advanced search produced, including the window that was applied. */
export interface AdvancedSearchOutcome {
    sources: Source[];
    failures: string[];
    /** Structured failures, kept for callers that want the business class. */
    failureDetails?: EngineFailure[];
    /** Short policy note, such as why the fallback tier was used or skipped. */
    note?: string;
    /** True when the deployment's configured limit cut the requested budget. */
    truncated: boolean;
    /** The effective window, after applying the deployment default if omitted. */
    timeRange: TimeRange;
}
/** What the tool returns to the model. */
export interface AdvancedSearchValue {
    query: string;
    timeRange: TimeRange;
    sources: Source[];
    failures: string[];
    note?: string;
    truncated: boolean;
}
/**
 * Explain an undated row when a window is active.
 *
 * The engine path prefers dated results inside the window, but falls back to
 * undated rows when no dated result lands inside it. Saying so keeps the model
 * from presenting an undated row as a confirmed "this week" item.
 * @param sources - the rows returned by the search.
 * @param timeRange - the effective window.
 * @returns one sentence, or `undefined` when every row is dated or the window is off.
 */
export declare function undatedWindowNote(sources: readonly Source[], timeRange: TimeRange): string | undefined;
/** Run one search with an optional window; `undefined` means the deployment default. */
export type AdvancedSearchRunner = (query: string, limit: number, timeRange: TimeRange | undefined, signal?: AbortSignal) => Promise<AdvancedSearchOutcome>;
/** A tool definition in the host registry's native shape. */
export interface AdvancedSearchDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: AdvancedSearchValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<AdvancedSearchValue>;
}
/** The slice of the tool registry this module needs. */
export interface AdvancedSearchRegistryLike {
    register(definition: AdvancedSearchDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Construction seams. */
export interface AdvancedSearchOptions {
    /** Registration diagnostics. */
    warn?: (message: string) => void;
}
/** A successful registration plus the exact way to undo it. */
export interface AdvancedSearchRegistration {
    name: string;
    dispose: () => void;
}
/**
 * Remove a relative window phrase that the structured window already carries.
 * "过去 7 天内 Chrome…" searches for `7` and `内`, not for Chrome; with an
 * explicit `timeRange` the phrase is redundant and only adds noise.
 * @param query - the caller's query.
 * @returns the query without a relative-time phrase, or the original when the
 *   removal would leave nothing.
 */
export declare function stripRelativeWindow(query: string): string;
/** Format the model-facing result text. */
export declare function formatAdvancedSearchValue(value: AdvancedSearchValue): string;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `advanced_search`, or the fallback when that name is taken.
 * @param runSearch - executes one search through the plugin's normal path.
 * @returns a registry-ready definition.
 */
export declare function createAdvancedSearchDefinition(name: string, runSearch: AdvancedSearchRunner): AdvancedSearchDefinition;
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickAdvancedSearchToolName(tools: AdvancedSearchRegistryLike): string;
/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param runSearch - executes one search through the plugin's normal path.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export declare function registerAdvancedSearchTool(tools: AdvancedSearchRegistryLike, runSearch: AdvancedSearchRunner, options?: AdvancedSearchOptions): AdvancedSearchRegistration | undefined;
