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
/**
 * Route an explicitly registry-scoped package query.
 *
 * @param query - one raw `search_many` query.
 * @returns the existing source id and a cleaned query, or `undefined` when the
 * query is not unambiguously about a package registry.
 */
export declare function routePackageQuery(query: string): PackageQueryRoute | undefined;
