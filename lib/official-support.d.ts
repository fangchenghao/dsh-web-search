/**
 * Official, key-free release facts that ordinary search results often miss.
 *
 * PostgreSQL's versioning page is the first entry: it is the authoritative
 * source for the current major, current minor and final-support date, while a
 * generic web query frequently returns cloud-provider EOL pages or an old
 * press kit. The lookup is deliberately narrow: only a PostgreSQL query that
 * asks about versions, support or EOL is enriched, so an ordinary PostgreSQL
 * how-to search keeps the normal engine ranking.
 *
 * @module @fangchenghao/dsh-web-search/official-support
 */
import type { Source } from './types.ts';
/** PostgreSQL's official versioning and support table. */
export declare const POSTGRES_SUPPORT_URL = "https://www.postgresql.org/support/versioning/";
/** One major release row from the official table. */
export interface PostgresRelease {
    /** Major version, e.g. `18` or `9.6`. */
    major: string;
    /** Current minor release, e.g. `18.6`. */
    minor: string;
    /** Whether the PostgreSQL project still supports this major. */
    supported: boolean;
    /** First release date as printed by the page. */
    firstRelease: string;
    /** Final release date as printed by the page. */
    finalRelease: string;
}
/** Inputs accepted by {@link fetchPostgresSupport}. */
export interface PostgresSupportOptions {
    /** Tunnel URL from the plugin's `proxy` setting, when configured. */
    proxy?: string;
    /** Per-request deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation. */
    signal?: AbortSignal;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: typeof fetch;
}
/** True for a PostgreSQL query that is asking about versions/support/EOL. */
export declare function isPostgresVersionQuery(query: string): boolean;
/**
 * Parse the official versioning table.
 *
 * The parser intentionally ignores the surrounding navigation and prose, and
 * returns only rows with five cells. A markup change yields an empty list so
 * the caller can fall back to ordinary search instead of returning a made-up
 * version.
 *
 * @param payload - the support page HTML.
 * @returns release rows, highest major first.
 */
export declare function parsePostgresSupport(payload: string): PostgresRelease[];
/**
 * Build one model-facing source from the parsed table.
 *
 * The EOL field is the page's "Final Release" column. It is labeled as the
 * official final release/EOL date rather than as a promise about the exact
 * day a deployment stops receiving fixes.
 *
 * @param releases - parsed rows.
 * @returns a source, or `undefined` when no usable row exists.
 */
export declare function postgresSupportSource(releases: readonly PostgresRelease[]): Source | undefined;
/**
 * Fetch and parse the official PostgreSQL support source.
 *
 * Failure is contained: a blocked page, a timeout or markup drift returns
 * `undefined` and the caller keeps its ordinary search rows.
 *
 * @param options - proxy, deadline, cancellation and fetch seam.
 * @returns the official source, or `undefined`.
 */
export declare function fetchPostgresSupport(options?: PostgresSupportOptions): Promise<Source | undefined>;
