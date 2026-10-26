/**
 * Small, key-free official feeds used to answer questions that ordinary
 * search-result snippets cannot date.
 *
 * Chrome Releases is the first entry: its Atom/JSON feed exposes the real
 * publication timestamp for every post, while the HTML search result often
 * loses it. The feed is deliberately bounded and only consulted for an
 * explicitly windowed Chrome security/release query; a generic web search still
 * uses the normal engine path.
 *
 * @module @fangchenghao/dsh-web-search/official-feed
 */
import type { Source, TimeRange } from './types.ts';
/** Chrome Releases' public Blogger feed, newest first. */
export declare const CHROME_RELEASES_FEED_URL = "https://chromereleases.googleblog.com/feeds/posts/default?alt=json&max-results=30";
/** Inputs accepted by {@link fetchChromeReleases}. */
export interface ChromeFeedOptions {
    /** Tunnel URL from the plugin's `proxy` setting, when configured. */
    proxy?: string;
    /** Per-request deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation. */
    signal?: AbortSignal;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: typeof fetch;
}
/** True for a query that is specifically about a Chrome release/security post. */
export declare function isChromeSecurityQuery(query: string): boolean;
/** One severity distribution exposed by a Chrome release post. */
export interface ChromeSecuritySummary {
    /** Version string found in the post, when one is stated. */
    version?: string;
    /** Number of fixes the post says the update contains. */
    total?: number;
    /** Distinct CVE rows by severity, when the post lists them. */
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
}
/**
 * Read the version, fix count and CVE severity distribution from a post body.
 *
 * Chrome release posts put the useful facts below the opening paragraph, past
 * the point where a short search snippet usually cuts off. Extracting them here
 * keeps the snippet useful without pretending the feed is a CVE database.
 *
 * @param plain - the post content converted to plain text.
 * @returns only the fields the post actually states.
 */
export declare function chromeSecuritySummary(plain: string): ChromeSecuritySummary;
/**
 * Parse the Chrome Releases JSON feed.
 *
 * The parser is intentionally tolerant: a feed shape change (or a non-JSON
 * maintenance page) yields an empty list instead of making the caller fail.
 *
 * @param payload - the feed body.
 * @param limit - maximum posts to keep.
 * @returns posts with their real publication timestamps, newest first.
 */
export declare function parseChromeReleases(payload: string, limit?: number): Source[];
/** Release channel inferred from a Chrome Releases post title. */
export type ChromeChannel = 'stable' | 'beta' | 'dev' | 'other';
/**
 * Classify one feed post by its title.
 *
 * Chrome's feed mixes Desktop, Android, iOS and ChromeOS posts in one stream.
 * The title is the only channel marker the feed exposes consistently, so the
 * query path uses it before handing posts to the model.
 *
 * @param source - one parsed feed post.
 * @returns the channel name, or `other` for an unrecognised title.
 */
export declare function chromeChannel(source: Source): ChromeChannel;
/**
 * Keep the posts that belong to the channel the query asked about.
 *
 * This is intentionally narrow: only an explicit Stable request changes the
 * feed, so a general Chrome security query still sees every channel. The
 * function is lexical and never invents a channel the title does not state.
 *
 * @param sources - posts inside the requested time window.
 * @param query - the caller's query.
 * @returns stable-only posts when the query says Stable; otherwise a copy.
 */
export declare function filterChromeChannel(sources: readonly Source[], query: string): Source[];
/** True when a stable-only query dropped any post, for an honest note. */
export declare function hasNonStableChromePosts(sources: readonly Source[], query: string): boolean;
/**
 * Fetch and parse the latest Chrome Releases posts.
 *
 * @param options - proxy/deadline/cancellation seams.
 * @returns dated posts, newest first; an empty list when the feed is malformed.
 */
export declare function fetchChromeReleases(options?: ChromeFeedOptions): Promise<Source[]>;
/**
 * Keep only posts inside the requested window.
 * @param sources - parsed feed posts.
 * @param range - the requested publication window.
 * @param now - test seam for the current time.
 * @returns posts inside the window, preserving feed order.
 */
export declare function chromeWindow(sources: readonly Source[], range: TimeRange, now?: number): Source[];
/**
 * Explain what the official feed showed, including the absence of a zero-day
 * mention. This is evidence about the feed, not an assertion that no such
 * vulnerability exists anywhere.
 * @param sources - feed posts inside the window.
 * @param range - the requested window.
 * @param query - the caller's query, used to decide whether zero-day matters.
 * @returns one short note.
 */
export declare function chromeFeedNote(sources: readonly Source[], range: TimeRange, query: string): string;
