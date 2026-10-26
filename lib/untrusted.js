/**
 * A marker the model can recognise as a hard data boundary.
 *
 * Search results, page bodies and vertical records are written by websites and
 * APIs outside this plugin. A title or snippet that says "ignore previous
 * instructions" is still data, so every custom tool render wraps its web-derived
 * body in explicit open/close tags. The matching sentence lives in the system
 * prompt section (see `system-prompt.ts`).
 *
 * The wrapper strips any copy of the boundary tags found inside the payload:
 * otherwise a page could close the boundary early and make the rest look like
 * instructions. It deliberately does not touch the `Source` objects themselves,
 * because the same strings are also shown in the DSH result cards; the boundary
 * belongs to the model-facing text only.
 *
 * @module @fangchenghao/dsh-web-search/untrusted
 */
/** Opening tag inserted before page-derived text. */
export const UNTRUSTED_OPEN = '<untrusted-web-content>';
/** Closing tag inserted after page-derived text. */
export const UNTRUSTED_CLOSE = '</untrusted-web-content>';
/**
 * Matches a forged boundary tag, including whitespace and attributes.
 * A legitimate payload has no reason to contain this element.
 */
const FORGED_BOUNDARY = /<\s*\/?\s*untrusted-web-content\b[^>]*>/giu;
/**
 * Remove boundary-shaped tags from arbitrary text.
 * @param text - page or API text.
 * @returns the text without an attacker-supplied boundary.
 */
export function stripUntrustedBoundary(text) {
    return text.replace(FORGED_BOUNDARY, '');
}
/**
 * Wrap page-derived text in the untrusted-content boundary.
 * @param text - the model-facing body to delimit.
 * @returns an open tag, the payload, and a close tag on their own lines.
 */
export function wrapUntrustedContent(text) {
    return `${UNTRUSTED_OPEN}\n${stripUntrustedBoundary(text)}\n${UNTRUSTED_CLOSE}`;
}
