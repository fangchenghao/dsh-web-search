/**
 * Detect the narrow, unambiguous case where a `search_many` query names a
 * package registry. These queries answer far better from the registry itself
 * than from general web results, but routing every query that contains a short
 * English word would be worse than doing nothing. Only an explicit registry
 * name plus package intent is routed.
 *
 * @module @fangchenghao/dsh-web-search/query-router
 */
import type { VerticalId } from './verticals.ts';

/** A package query that can be answered by one existing vertical source. */
export interface PackageQueryRoute {
  /** Existing `domain_search` source id. */
  id: Extract<VerticalId, 'crates' | 'npm' | 'pypi'>;
  /** Query text with the registry name and release filler removed. */
  query: string;
  /** Package-name-shaped tokens extracted from the query. */
  names: string[];
  /** Human-readable source name for the result note. */
  label: string;
}

/** Words that signal package intent even when no version number is present. */
const PACKAGE_INTENT =
  /(?:package|packages|library|dependency|dependencies|crate|crates|module|版本|最新|依赖|包|库|发布)/iu;

/** Latin package-name-shaped tokens, used to clean Chinese filler words. */
const PACKAGE_TOKEN = /[A-Za-z][A-Za-z0-9_.-]{0,}/gu;

/** Filler that should never be sent to a registry search. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'by', 'compare', 'dependency', 'dependencies', 'do',
  'does', 'for', 'from', 'how', 'in', 'install', 'is', 'latest', 'library', 'module',
  'newest', 'of', 'on', 'or', 'package', 'packages', 'release', 'the', 'to', 'version',
  'versions', 'vs', 'what', 'which', 'with',
]);

/**
 * Route an explicitly registry-scoped package query.
 *
 * @param query - one raw `search_many` query.
 * @returns the existing source id and a cleaned query, or `undefined` when the
 * query is not unambiguously about a package registry.
 */
export function routePackageQuery(query: string): PackageQueryRoute | undefined {
  if (typeof query !== 'string') return undefined;
  const value = query.trim();
  if (value.length === 0) return undefined;

  let id: PackageQueryRoute['id'] | undefined;
  let label = '';
  if (/\bcrates?\.io\b/iu.test(value)) {
    id = 'crates';
    label = 'crates.io';
  } else if (/\bnpm(?:js)?\b/iu.test(value)) {
    id = 'npm';
    label = 'npm';
  } else if (/\bpypi\b/iu.test(value)) {
    id = 'pypi';
    label = 'PyPI';
  }
  if (id === undefined || !PACKAGE_INTENT.test(value)) return undefined;

  const cleaned = value
    .replace(/\b(?:crates?\.io|npm(?:js)?|pypi)\b/giu, ' ')
    .replace(/\b(?:latest|newest)\s+(?:version|release)\b/giu, ' ')
    .replace(/最新版本|最新版|最新|版本号|版本|发布/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  // Keep Latin package names when the surrounding sentence is Chinese; the
  // registry APIs are much better at `serde tokio` than at `上 serde 和 tokio`.
  const tokens = cleaned.match(PACKAGE_TOKEN) ?? [];
  const names = tokens.filter((token) => {
    const lower = token.toLowerCase();
    return !STOP_WORDS.has(lower) && !lower.includes('crates.io');
  });
  const routedQuery = names.length > 0 ? names.join(' ') : cleaned;
  if (routedQuery.length === 0) return undefined;
  return { id, query: routedQuery, names: names.slice(0, 5), label };
}
