/**
 * Pure parsers for the scraped engines and the AnySearch JSON API.
 *
 * These are ports of the parsers that shipped in `engines.js`; every quirk in
 * them was measured against a live response and is load-bearing. Nothing here
 * performs I/O or throws on malformed input: a drifted result page yields an
 * empty list so one engine can degrade instead of failing the search.
 *
 * @module @fangchenghao/dsh-web-search/parsers
 */
import type { Source } from './types.ts';
/**
 * Decode the HTML entities and strip tags from one fragment of result markup.
 * Highlight tags (`<em>`) are dropped, keeping only visible text.
 * @param value - raw markup.
 * @returns plain single-line text.
 */
export declare function text(value: unknown): string;
/**
 * Resolve an anchor target to an absolute http(s) URL, undoing the Bing
 * click-tracker wrapper (`/ck/a?...&u=a1<base64url>`) when present, and the
 * DuckDuckGo `/l/?uddg=<urlencoded>` wrapper.
 * @param raw - the raw `href` attribute, still HTML-escaped.
 * @param baseUrl - the page the anchor came from.
 * @returns the absolute URL, or `undefined` when there is none.
 */
export declare function resolveHref(raw: string | undefined, baseUrl: string): string | undefined;
/**
 * Parse a 360 (so.com) results page. The real URL lives in `data-mdurl`;
 * without it the only target is a 360 click tracker, which is not citable.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, oldest result first.
 */
export declare function parseSo(payload: string, baseUrl: string): Source[];
/**
 * Parse a Bing results page.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export declare function parseBing(payload: string, baseUrl: string): Source[];
/**
 * Parse a DuckDuckGo lite page.
 *
 * Its attributes are single-quoted (`class='result-link'`), unlike Bing's, so
 * the patterns here accept either quote style. The snippet lives in a sibling
 * row (`class='result-snippet'`) that follows the anchor, so each hit is
 * examined up to the next hit.
 * @param payload - the served lite page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export declare function parseDdgLite(payload: string, baseUrl: string): Source[];
/**
 * Parse a DuckDuckGo HTML page.
 *
 * The endpoint used to be richer than the lite one and carries a snippet per
 * hit (`result__snippet`), which the lite page also has but with different
 * markup. Outbound links are usually wrapped as `/l/?uddg=<percent-encoded>`,
 * which {@link resolveHref} unwraps; the endpoint also serves direct links.
 * Attribute order and quoting vary, so both are matched loosely.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export declare function parseDdgHtml(payload: string, baseUrl: string): Source[];
/**
 * Parse an AnySearch JSON envelope.
 *
 * The endpoint is a documented API rather than scraped markup, so it needs no
 * echo check: the envelope either carries `data.results` or reports a business
 * code. Rows without a usable URL are dropped — the seam requires a citable
 * URL, and inventing one would be a lie.
 * @param payload - the response body.
 * @param baseUrl - the API URL, used as the base for relative row URLs.
 * @returns parsed sources, in envelope order; `[]` for any unusable envelope.
 */
export declare function parseAnySearch(payload: string, baseUrl: string): Source[];
/**
 * Check that a page actually belongs to the query.
 *
 * Every engine echoes the query in its search box, so a genuine result page
 * contains it. A rate-limited reply does not: Bing answers repeated rapid
 * requests with a "trending" feed whose entries belong to somebody else's
 * search, and those results were previously attributed to the user's query.
 * Accepted when the query has no token long enough to be distinctive.
 * @param payload - the response body.
 * @param query - the query that was asked for.
 * @returns whether the payload contains a distinctive query token.
 */
export declare function echoesQuery(payload: string, query: string): boolean;
