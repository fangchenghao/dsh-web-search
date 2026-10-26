import { searchVerticals } from "./verticals.js";
const ARXIV_QUERY = /\barxiv(?:\.org)?\b/iu;
const ARXIV_ID = /\barxiv\s*:\s*(\d{4}\.\d{4,5})/iu;
/** A paper intent keeps "how to use arXiv" from becoming a paper search. */
const RESEARCH_INTENT = /\b(?:paper|papers|preprint|preprints|survey|surveys|study|studies|research|literature|review|reviews)\b|论文|文献|预印本|综述|研究/iu;
/**
 * The query text with the registry name removed, or `undefined` when the
 * query is not explicitly arXiv-scoped.
 *
 * @param query - raw user query.
 * @returns cleaned query, or `undefined`.
 */
export function arxivQueryText(query) {
    if (typeof query !== 'string')
        return undefined;
    const trimmed = query.trim();
    if (trimmed.length === 0)
        return undefined;
    const id = ARXIV_ID.exec(trimmed);
    if (id !== null)
        return id[1];
    if (!ARXIV_QUERY.test(trimmed) || !RESEARCH_INTENT.test(trimmed))
        return undefined;
    const cleaned = trimmed.replace(ARXIV_QUERY, ' ').replace(/\s+/gu, ' ').trim();
    return cleaned.length === 0 ? undefined : cleaned;
}
/**
 * Query the arXiv vertical for an explicitly scoped query.
 *
 * @param query - raw user query.
 * @param options - deadline, budget, proxy and cancellation.
 * @returns matching sources, or an empty array when the query is not scoped.
 */
export async function arxivLookup(query, options = {}) {
    const text = arxivQueryText(query);
    if (text === undefined)
        return [];
    const limit = options.limit ?? 4;
    try {
        const result = await searchVerticals(text, {
            ids: ['arxiv'],
            limit,
            timeoutMs: options.timeoutMs ?? 3_500,
            ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return result.sources;
    }
    catch {
        return [];
    }
}
/**
 * Put arXiv rows first and remove duplicate URLs.
 *
 * @param sources - ordinary fused rows.
 * @param arxiv - rows from the arXiv vertical.
 * @returns merged rows.
 */
export function mergeArxiv(sources, arxiv) {
    const seen = new Set();
    const merged = [];
    for (const source of [...arxiv, ...sources]) {
        if (source.url.length === 0 || seen.has(source.url))
            continue;
        seen.add(source.url);
        merged.push(source);
    }
    return merged;
}
