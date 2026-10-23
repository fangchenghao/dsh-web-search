/** Runs of CJK characters (Han, kana, Hangul). */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/gu;
/** Common CJK function-word bigrams that match almost any page. */
const CJK_STOPWORDS = new Set([
    '的是', '了吗', '什么', '怎么', '如何', '哪些', '多少', '一下', '请问',
    '帮我', '告诉', '介绍', '以及', '或者', '还是', '就是', '可以', '需要',
]);
/**
 * Build the overlap profile for a query.
 * @param query - the user's question.
 * @returns the profile; `cjk` is false for an English-only query.
 */
export function queryProfile(query) {
    const text = query.toLowerCase();
    const tokens = new Map();
    let cjk = false;
    for (const run of text.match(CJK_RUN) ?? []) {
        cjk = true;
        if (run.length === 1) {
            // A one-character query has no bigram; keep the character itself so the
            // check still has something to match.
            tokens.set(run, { text: run, weight: 1 });
            continue;
        }
        for (let index = 0; index < run.length - 1; index += 1) {
            const bigram = run.slice(index, index + 2);
            if (!CJK_STOPWORDS.has(bigram))
                tokens.set(bigram, { text: bigram, weight: 1 });
        }
    }
    // A specific ASCII word is stronger evidence than a two-character slice of a
    // Chinese phrase: a PostgreSQL page can match `postgres` without containing
    // any of the Chinese words around it, and dropping it would be worse than
    // keeping a dictionary page.
    for (const word of text.match(/[a-z][a-z0-9.+#_-]{2,}/gu) ?? [])
        tokens.set(word, { text: word, weight: 2 });
    const required = !cjk || tokens.size <= 1 ? 1 : Math.min(3, Math.max(2, Math.ceil(tokens.size * 0.2)));
    return { cjk, tokens: [...tokens.values()], required };
}
/**
 * Whether one row talks about the query at all.
 * @param source - engine row with title, snippet and URL.
 * @param profile - prepared query tokens.
 * @returns true when at least `profile.required` distinct tokens appear.
 */
export function isRelevant(source, profile) {
    if (!profile.cjk)
        return true;
    let haystack = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
    try {
        haystack += ` ${decodeURIComponent(source.url)}`.toLowerCase();
    }
    catch {
        haystack += ` ${source.url}`.toLowerCase();
    }
    let matched = 0;
    for (const token of profile.tokens) {
        if (haystack.includes(token.text)) {
            matched += token.weight;
            if (matched >= profile.required)
                return true;
        }
    }
    return profile.required === 0;
}
/**
 * Drop rows that do not share enough words with a CJK query.
 * @param sources - one engine's rows.
 * @param query - the user's question.
 * @returns the rows that survive; English queries are returned unchanged.
 */
export function filterRelevant(sources, query) {
    const profile = queryProfile(query);
    if (!profile.cjk)
        return [...sources];
    return sources.filter((source) => isRelevant(source, profile));
}
