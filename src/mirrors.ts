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

/** A URL rewrite for one blocked canonical page. */
interface MirrorRule {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => string;
}

const RULES: readonly MirrorRule[] = [
  {
    // W3C's WCAG 2.2 Understanding pages are served from a GitHub Pages build
    // of the same W3C repository when the main site rejects non-browser UAs.
    pattern: /^https?:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/([^/?#]+\.html?)$/iu,
    build: (match) => `https://w3c.github.io/wcag/understanding/${match[1]}`,
  },
  {
    // The WAI overview page is blocked too; use the same build's index.
    pattern: /^https?:\/\/www\.w3\.org\/WAI\/standards-guidelines\/wcag\/?$/iu,
    build: () => 'https://w3c.github.io/wcag/',
  },
  {
    // The TR landing page maps to the full guidelines build.
    pattern: /^https?:\/\/www\.w3\.org\/TR\/WCAG22\/?$/iu,
    build: () => 'https://w3c.github.io/wcag/guidelines/',
  },
];

/** A reverse rewrite for a mirror URL that is cited by its canonical page. */
interface CanonicalRule {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => string;
}

const CANONICAL_RULES: readonly CanonicalRule[] = [
  {
    pattern: /^https?:\/\/w3c\.github\.io\/wcag\/understanding\/([^/?#]+\.html?)$/iu,
    build: (match) => `https://www.w3.org/WAI/WCAG22/Understanding/${match[1]}`,
  },
  {
    pattern: /^https?:\/\/w3c\.github\.io\/wcag\/guidelines\/?$/iu,
    build: () => 'https://www.w3.org/TR/WCAG22/',
  },
  {
    pattern: /^https?:\/\/w3c\.github\.io\/wcag\/?$/iu,
    build: () => 'https://www.w3.org/WAI/standards-guidelines/wcag/',
  },
];

/**
 * Return an official mirror for a blocked standards URL, if one is known.
 * @param raw - canonical URL.
 * @returns the mirror URL, or `undefined` when no rule applies.
 */
export function alternateOfficialUrl(raw: string): string | undefined {
  for (const rule of RULES) {
    const match = rule.pattern.exec(raw);
    if (match !== null) return rule.build(match);
  }
  return undefined;
}

/**
 * Map a mirror URL back to the canonical page that is safe to cite.
 * @param raw - URL actually fetched.
 * @returns the canonical URL, or the input when it is not a known mirror.
 */
export function canonicalOfficialUrl(raw: string): string {
  for (const rule of CANONICAL_RULES) {
    const match = rule.pattern.exec(raw);
    if (match !== null) return rule.build(match);
  }
  return raw;
}
