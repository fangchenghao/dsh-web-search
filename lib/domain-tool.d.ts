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
import type { FetchLike } from './verticals.ts';
/** The name this tool prefers. */
export declare const DOMAIN_TOOL_NAME = "domain_search";
/** The name used when another plugin already registered `domain_search`. */
export declare const DOMAIN_TOOL_FALLBACK_NAME = "web_domain_search";
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
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<DomainToolValue>;
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
/** Format the model-facing result text. */
export declare function formatDomainValue(args: unknown, value: DomainToolValue): string;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `domain_search`, or the fallback when that name is taken.
 * @param readSettings - read the live config for every call (volatile fields).
 * @param options - test seams and diagnostics.
 * @returns a registry-ready definition.
 */
export declare function createDomainToolDefinition(name: string, readSettings: () => DomainToolSettings, options?: DomainToolOptions): DomainToolDefinition;
/**
 * Pick the tool name this deployment can accept.
 *
 * A plugin that already owns `domain_search` must not make this one fail to
 * register, so the fallback name is used instead. A registry without `get` is
 * assumed free.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickDomainToolName(tools: ToolRegistryLike): string;
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
export declare function registerDomainTool(tools: ToolRegistryLike, readSettings: () => DomainToolSettings, options?: DomainToolOptions): string | undefined;
