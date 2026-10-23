import type { FetchProvider } from './fetch.ts';
import type { FetchFormat } from './markdown.ts';
import type { RenderMode, RenderReport } from './render.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const READ_PAGE_TOOL_NAME = "read_page";
/** The name used when another plugin already registered `read_page`. */
export declare const READ_PAGE_TOOL_FALLBACK_NAME = "web_read_page";
/** Smallest chunk a caller may request, matching `fetchMaxLength`'s floor. */
export declare const READ_PAGE_MIN_LENGTH = 1000;
/** Largest chunk a caller may request, matching `fetchMaxLength`'s ceiling. */
export declare const READ_PAGE_MAX_LENGTH = 200000;
/** Default chunk size when neither the caller nor the config names one. */
export declare const READ_PAGE_DEFAULT_LENGTH = 20000;
/**
 * Largest body this tool will hold. A page beyond it is cut once, after
 * conversion, and reported as `truncated`; chunks never pay this cost.
 */
export declare const READ_PAGE_INTERNAL_MAX_CHARS = 2000000;
/**
 * Byte budget handed to the fetch ladder. Four bytes per UTF-8 code point is
 * the worst case, so this is large enough for the full character cap while
 * still bounding what one response can allocate.
 */
export declare const READ_PAGE_MAX_BYTES: number;
/** How many converted pages stay cached per mounted tool. */
export declare const READ_PAGE_CACHE_ENTRIES = 8;
/** Internal fetch provider ids, one per output format. */
export declare const READ_PAGE_PROVIDER_ID = "http-proxy-read-page";
/** The fields a `read_page` result carries; see the module doc for semantics. */
export interface ReadPageValue {
    /** The URL exactly as the caller supplied it (trimmed). */
    url: string;
    /** The requested character range, with no hint line appended. */
    content: string;
    /** First character of `content`. */
    offset: number;
    /** Offset to pass on the next call, or `null` when the page is finished. */
    nextOffset: number | null;
    /** Length of the complete converted body, possibly cut by the safety cap. */
    totalLength: number;
    /** True when the source body itself was cut, so `totalLength` is a lower bound. */
    truncated: boolean;
    /** Progress through the document for this call's `maxLength`; `index` is 1-based. */
    chunk: {
        index: number;
        count: number;
    };
    /** Fetch failures, in the same shape `domain_search` and `search_many` use. */
    failures: string[];
    /** Why the optional browser rung did or did not run, when the provider says. */
    render?: RenderReport;
}
/** Settings read live for every call, so a Settings commit applies without a remount. */
export interface ReadPageSettings {
    /** Default chunk size, from `fetchMaxLength`. */
    maxLength: number;
    /** Default output style, from `fetchFormat`. */
    format: FetchFormat;
    /** Per-attempt fetch deadline, from `timeoutMs`. */
    timeoutMs?: number;
    /** Browser-render policy, from `renderJs`; read again by each internal fetch. */
    renderJs?: RenderMode;
    /** Browser-render deadline, from `renderTimeoutMs`. */
    renderTimeoutMs?: number;
    /** Tunnel URL, from `proxy`. */
    proxy?: string;
    /** AnySearch key, when the extraction rung is configured. */
    anysearchApiKey?: string;
}
/** Construction seams, so the definition is testable without a network. */
export interface ReadPageOptions {
    /**
     * Build the internal provider for one output format. The default is
     * `createFetchProvider`, so production always goes through the same ladder as
     * `web_fetch`; tests substitute a recorder.
     */
    createProvider?: (format: FetchFormat, settings: ReadPageSettings) => FetchProvider;
    /** Registration diagnostics. */
    warn?: (message: string) => void;
}
/** A tool definition in the host registry's native shape. */
export interface ReadPageDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: ReadPageValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<ReadPageValue>;
}
/** The slice of the tool registry this module needs. */
export interface ReadPageRegistryLike {
    register(definition: ReadPageDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** A successful registration plus the exact way to undo it. */
export interface ReadPageRegistration {
    name: string;
    dispose: () => void;
}
/** Format the model-facing result text: the chunk, then exactly one hint line. */
export declare function formatReadPageValue(value: ReadPageValue): string;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `read_page`, or the fallback when that name is taken.
 * @param readSettings - read the live config for every call.
 * @param options - test seams and diagnostics.
 * @returns a registry-ready definition.
 */
export declare function createReadPageDefinition(name: string, readSettings: () => ReadPageSettings, options?: ReadPageOptions): ReadPageDefinition;
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickReadPageToolName(tools: ReadPageRegistryLike): string;
/**
 * Register the tool when a registry is available.
 *
 * The failure paths mirror `search_many`: a duplicate name falls back, and a
 * registry rejection is reported and swallowed so the other tools keep working.
 * The returned registration owns the host disposer, so plugin disposal removes
 * exactly the definition this call added.
 *
 * @param tools - the live registry.
 * @param readSettings - live config reader.
 * @param options - test seams and diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export declare function registerReadPageTool(tools: ReadPageRegistryLike, readSettings: () => ReadPageSettings, options?: ReadPageOptions): ReadPageRegistration | undefined;
