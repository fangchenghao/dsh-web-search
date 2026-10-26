/**
 * Keyless search across six community platforms: Bilibili, V2EX, Reddit,
 * YouTube, Zhihu and Juejin.
 *
 * Each platform answers from a public endpoint first. Those endpoints are
 * borrowed from result pages, so they are allowed to break: a JSON API may
 * answer with an anti-bot HTML page, a page may stop embedding
 * `ytInitialData`, V2EX's hot list is a snapshot rather than a search. When
 * the direct attempt fails or yields nothing, the platform is retried through
 * an injected {@link PlatformSearchOptions.fallbackSearch} (normally a
 * `site:<domain>` web search). Zhihu has no usable keyless endpoint at all and
 * goes straight to that fallback.
 *
 * One platform failing never fails the call: the reason is recorded in
 * `failures`, the other platforms still answer, and the rows are interleaved
 * by rank so a single prolific platform cannot crowd the rest out.
 *
 * @module @fangchenghao/dsh-web-search/platforms
 */
import type { Source } from './types.ts';
/** The platforms this module can search without a credential. */
export type PlatformId = 'bilibili' | 'v2ex' | 'reddit' | 'youtube' | 'zhihu' | 'juejin';
/** Every supported platform, in the order results are interleaved. */
export declare const PLATFORM_IDS: readonly PlatformId[];
/** Human labels, used in notes and in the model-facing tool description. */
export declare const PLATFORM_LABELS: Readonly<Record<PlatformId, string>>;
/** Results wanted when the caller names no limit. */
export declare const DEFAULT_PLATFORM_LIMIT = 5;
/** Upper bound a single call may request. */
export declare const MAX_PLATFORM_LIMIT = 10;
/** True for a value usable as a platform id. */
export declare function isPlatformId(value: unknown): value is PlatformId;
/** Options for {@link searchPlatforms}. */
export interface PlatformSearchOptions {
    /** Platform ids to query; empty or absent means every id in {@link PLATFORM_IDS}. */
    ids?: readonly string[];
    /** Results wanted per platform, clamped to 1…10 and capped again after the merge. */
    limit?: number;
    /** Per-platform deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation, propagated to every request and fallback. */
    signal?: AbortSignal;
    /** Tunnel URL; when set, direct requests go through {@link proxyGet}. */
    proxy?: string;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: typeof fetch;
    /**
     * Web search used when a platform's direct endpoint fails, is blocked or
     * returns nothing. It receives a `site:<domain> <query>` string, the same
     * budget and the caller's signal.
     */
    fallbackSearch?: (query: string, limit: number, signal?: AbortSignal) => Promise<{
        sources: Source[];
        failures: string[];
    }>;
}
/** What one platform run reports. */
export interface PlatformOutcome {
    /** Merged, de-duplicated sources, capped at the caller's budget. */
    sources: Source[];
    /** One `id: reason` line per platform that could not answer. */
    failures: string[];
    /** Parsed row count per platform, before the global cap. */
    counts: Record<string, number>;
    /** Whether rows were dropped because of the global cap. */
    truncated: boolean;
    /**
     * How each platform was served: `api` for its own endpoint, `fallback` when
     * the web-search fallback answered (or was the last route tried).
     */
    via: Record<string, 'api' | 'fallback'>;
}
/**
 * Parse Bilibili's video search envelope.
 *
 * Row-level drift yields fewer sources; an anti-bot envelope (HTML or a
 * non-zero `code`) throws so the caller knows to fall back.
 *
 * @param payload - `api.bilibili.com/x/web-interface/search/type` JSON.
 * @param limit - rows to keep.
 * @returns video sources in API order.
 * @throws `Error` on a wall or an unparsable envelope.
 */
export declare function parseBilibili(payload: string, limit?: number, query?: string): Source[];
/**
 * Parse a YouTube results page through the embedded `ytInitialData` graph.
 *
 * `videoRenderer` is looked up at any depth because YouTube reshuffles the
 * section wrappers between experiments; the marker and the JSON are the only
 * two things the parser insists on.
 *
 * @param payload - `/results?search_query=` HTML.
 * @param limit - rows to keep.
 * @returns video sources in page order.
 * @throws `Error` when the page embeds no parsable `ytInitialData`.
 */
export declare function parseYoutube(payload: string, limit?: number): Source[];
/**
 * Parse a Reddit search listing.
 *
 * The permalink is preferred over the external target so a post's citation
 * points at the discussion; `selftext` becomes the snippet, with a
 * subreddit/score line used when the post is link-only.
 *
 * @param payload - `reddit.com/search.json` JSON.
 * @param limit - rows to keep.
 * @returns post sources in listing order.
 * @throws `Error` on a wall, invalid JSON or an unexpected envelope.
 */
export declare function parseReddit(payload: string, limit?: number): Source[];
/**
 * Parse Juejin's article search envelope.
 *
 * The documented shape is `data[].result_model.article_info`; the collector
 * also accepts a bare `article_info` or an unwrapped `data` array because the
 * search API has changed wrappers before.
 *
 * @param payload - `api.juejin.cn/search_api/v1/search` JSON.
 * @param limit - rows to keep.
 * @returns article sources in API order.
 * @throws `Error` on a wall, invalid JSON or an API error code.
 */
export declare function parseJuejin(payload: string, limit?: number): Source[];
/**
 * Sort Juejin rows by likes only when the query asks for popular posts. The
 * API returns a relevance order; an explicit "高赞/热门" request should not
 * leave a 16-like post above a 217-like one. Rows without a like count keep
 * their relative order after measured rows.
 *
 * @param sources - rows from {@link parseJuejin}, or a fallback.
 * @param query - the caller's query.
 * @returns the original order when no popularity intent is present.
 */
export declare function normaliseJuejinSources(sources: readonly Source[], query: string): Source[];
/**
 * Filter V2EX's hot-topic snapshot by the query.
 *
 * The public API has no search endpoint, so the hot list is the only keyless
 * source; a query that does not appear in any title or body filters everything
 * out and the caller is expected to fall back to `site:v2ex.com`.
 *
 * @param payload - `v2ex.com/api/topics/hot.json` JSON.
 * @param query - text to look for in a title or body, case-insensitively.
 * @param limit - rows to keep.
 * @returns matching topics in hot-list order.
 * @throws `Error` on a Cloudflare page, invalid JSON or an unexpected envelope.
 */
export declare function parseV2ex(payload: string, query: string, limit?: number): Source[];
/**
 * Search the requested platforms and merge their answers.
 *
 * Every platform is asked concurrently. A direct endpoint that is blocked or
 * unparsable is retried through `fallbackSearch`; a platform that still has
 * nothing contributes a `failures` line instead of failing the call. Answers
 * are interleaved by rank (one row from each platform, then the second row
 * from each), duplicate URLs are dropped, and the merged list is capped at the
 * caller's budget.
 *
 * @param query - what to search for; empty input yields an empty outcome.
 * @param options - platform ids, budget, deadline, cancellation, tunnel, fetch
 *   seam and fallback search.
 * @returns merged sources plus per-platform counts, channels and failures.
 * @throws SearchError `SEARCH_ABORTED` when the caller cancelled the run.
 */
export declare function searchPlatforms(query: string, options?: PlatformSearchOptions): Promise<PlatformOutcome>;
/**
 * Drop a generic fallback row that shares almost none of a specific query.
 *
 * Zhihu has no keyless direct endpoint. Its fallback sometimes puts a broad
 * question such as "目前有哪些主流的 AI？" above an answer that actually names
 * coding assistants. This is a light preference, not a hard filter: when fewer
 * than two rows survive, the original list is returned.
 *
 * @param sources - fallback rows already filtered to the Zhihu host.
 * @param query - the caller's query.
 * @returns rows with at least two query-term matches, or the original list.
 */
export declare function normaliseZhihuFallback(sources: readonly Source[], query: string): Source[];
