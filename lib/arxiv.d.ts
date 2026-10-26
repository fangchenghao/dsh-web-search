/**
 * Explicit `arXiv` research queries, answered by the existing arXiv vertical.
 *
 * A general web query that merely contains the word `arxiv` should not be
 * hijacked, but a query that explicitly asks arXiv for a survey or paper is a
 * clear registry lookup. The lookup runs in parallel with the ordinary
 * fan-out, so it cannot delay a query that is not about arXiv.
 *
 * @module @fangchenghao/dsh-web-search/arxiv
 */
import type { Source } from './types.ts';
/** Options for the narrow arXiv lookup. */
export interface ArxivLookupOptions {
    /** Result budget; defaults to four. */
    limit?: number;
    /** Deadline in milliseconds; defaults to 3.5 s. */
    timeoutMs?: number;
    /** Configured tunnel. */
    proxy?: string;
    /** Caller cancellation. */
    signal?: AbortSignal;
}
/**
 * The query text with the registry name removed, or `undefined` when the
 * query is not explicitly arXiv-scoped.
 *
 * @param query - raw user query.
 * @returns cleaned query, or `undefined`.
 */
export declare function arxivQueryText(query: string): string | undefined;
/**
 * Query the arXiv vertical for an explicitly scoped query.
 *
 * @param query - raw user query.
 * @param options - deadline, budget, proxy and cancellation.
 * @returns matching sources, or an empty array when the query is not scoped.
 */
export declare function arxivLookup(query: string, options?: ArxivLookupOptions): Promise<Source[]>;
/**
 * Put arXiv rows first and remove duplicate URLs.
 *
 * @param sources - ordinary fused rows.
 * @param arxiv - rows from the arXiv vertical.
 * @returns merged rows.
 */
export declare function mergeArxiv(sources: readonly Source[], arxiv: readonly Source[]): Source[];
