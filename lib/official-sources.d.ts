/**
 * Route a versioned query to the narrow official lookup that can answer it.
 *
 * Keep this as a separate seam rather than putting network calls inside
 * `engines.search()`: the engine layer stays a pure keyless fan-out, while the
 * provider, MCP server and public benchmark can all enrich the same result with
 * the project's own release facts.
 *
 * @module @fangchenghao/dsh-web-search/official-sources
 */
import type { Source } from './types.ts';
/** Options shared by the official lookup implementations. */
export interface OfficialLookupOptions {
    /** Tunnel URL from the plugin's `proxy` setting, when configured. */
    proxy?: string;
    /** Per-request deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation. */
    signal?: AbortSignal;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: typeof fetch;
}
/** Scoped npm package name in an explicitly npm-scoped query. */
export declare function scopedNpmPackage(query: string): string | undefined;
/**
 * Start the applicable official lookup, or return `undefined` when the query
 * has no official resolver.
 *
 * Returning the promise instead of awaiting it lets a caller overlap the lookup
 * with the ordinary search fan-out.
 */
export declare function officialLookup(query: string, options?: OfficialLookupOptions): Promise<Source | undefined> | undefined;
/**
 * Put official rows first and remove duplicate URLs.
 *
 * The order of `official` is preserved; ordinary rows keep their relative
 * order. A source with no usable URL is discarded rather than allowed to
 * displace a real result.
 */
export declare function mergeOfficial(sources: readonly Source[], official: Source | undefined): Source[];
