/**
 * Official Rust release notes for an explicitly versioned release query.
 *
 * Search engines often return the Rust home page or a third-party changelog for
 * a query such as `Rust 1.90 发布说明`, even when the official announcement is
 * indexed. The release announcement has a deterministic shape once its date is
 * known: `https://blog.rust-lang.org/YYYY/MM/DD/Rust-X.Y.Z/`. GitHub's public
 * release endpoint is key-free and exposes that date, so this module can add
 * the official page as a high-priority row without hard-coding release dates.
 *
 * The lookup is deliberately narrow. Only a Rust query that names a numeric
 * version *and* asks for release notes is enriched; a generic Rust tutorial
 * keeps the normal engine ranking.
 *
 * @module @fangchenghao/dsh-web-search/official-release
 */
import type { Source } from './types.ts';
/** Public GitHub release endpoint for the Rust repository. */
export declare const RUST_RELEASE_API = "https://api.github.com/repos/rust-lang/rust/releases/tags";
/** Official Rust announcement host. */
export declare const RUST_BLOG_HOST = "blog.rust-lang.org";
/** Inputs accepted by {@link fetchRustRelease}. */
export interface RustReleaseOptions {
    /** Tunnel URL from the plugin's `proxy` setting, when configured. */
    proxy?: string;
    /** Per-request deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation. */
    signal?: AbortSignal;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: typeof fetch;
}
/** A version such as `1.90`, normalized to a release tag like `1.90.0`. */
export interface RustVersion {
    /** User-facing version, e.g. `1.90.0`. */
    readonly version: string;
    /** GitHub tag, normally identical to {@link version}. */
    readonly tag: string;
}
/** Extract a Rust version from a release query. */
export declare function rustReleaseVersion(query: string): RustVersion | undefined;
/** True for a query asking for a specific Rust release's notes. */
export declare function isRustReleaseQuery(query: string): boolean;
/**
 * Build the canonical announcement URL from a GitHub release timestamp.
 *
 * Rust publishes the post on the UTC date in the release metadata. Using UTC
 * avoids shifting the path when the machine is in a negative-offset timezone.
 */
export declare function rustBlogUrl(version: string, publishedAt: string): string | undefined;
/**
 * Parse a GitHub release response into one official-blog source.
 *
 * A malformed response, a missing publication date or a tag that does not
 * match the requested version returns `undefined`; the caller then keeps the
 * ordinary search rows.
 *
 * @param payload - GitHub JSON response body.
 * @param requested - normalized version from the query.
 * @returns the official source, or `undefined`.
 */
export declare function parseRustRelease(payload: string, requested: RustVersion): Source | undefined;
/**
 * Fetch the official Rust release page for a query.
 *
 * Failure is contained: an unavailable API, rate limit or malformed body
 * returns `undefined`, and the caller keeps its ordinary search rows.
 *
 * @param query - the original user query.
 * @param options - proxy, deadline, cancellation and fetch seam.
 * @returns the official blog source, or `undefined`.
 */
export declare function fetchRustRelease(query: string, options?: RustReleaseOptions): Promise<Source | undefined>;
