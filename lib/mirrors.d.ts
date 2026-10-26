/**
 * Official mirrors for a few standards pages that block automated readers.
 *
 * This is not a scraper fallback hierarchy: it is a very small, explicit map
 * from a canonical standards URL to the same organisation's public GitHub
 * Pages copy. A mirror is only tried after the canonical URL failed or returned
 * an empty body. The citation keeps the canonical W3C page; the body is the
 * official mirror copy.
 *
 * @module @fangchenghao/dsh-web-search/mirrors
 */
/**
 * Return an official mirror for a blocked standards URL, if one is known.
 * @param raw - canonical URL.
 * @returns the mirror URL, or `undefined` when no rule applies.
 */
export declare function alternateOfficialUrl(raw: string): string | undefined;
/**
 * Map a mirror URL back to the canonical page that is safe to cite.
 * @param raw - URL actually fetched.
 * @returns the canonical URL, or the input when it is not a known mirror.
 */
export declare function canonicalOfficialUrl(raw: string): string;
