/** The name this tool prefers. */
export const RESEARCH_TOOL_NAME = 'research';
/** The name used when another plugin already registered `research`. */
export const RESEARCH_TOOL_FALLBACK_NAME = 'web_research';
/** Pages fetched when the call names no budget. */
export const RESEARCH_DEFAULT_SOURCES = 3;
/** Smallest fetch budget a call may ask for. */
export const RESEARCH_MIN_SOURCES = 1;
/** Largest fetch budget a call may ask for. */
export const RESEARCH_MAX_SOURCES = 5;
/** Distinct queries accepted in one call. */
export const RESEARCH_MAX_QUERIES = 3;
/** Characters kept from each fetched page. */
export const RESEARCH_EXCERPT_CHARS = 1_200;
/** Pages fetched at the same time. */
export const RESEARCH_PAGE_CONCURRENCY = 3;
/** Wall-clock budget for the whole call, below the tool's host timeout. */
export const RESEARCH_BUDGET_MS = 45_000;
/** Below this much budget a page fetch is not worth starting. */
const RESEARCH_MIN_PAGE_MS = 2_500;
/**
 * Canonical form used to decide whether two rows are the same page.
 *
 * Search engines disagree about `www.`, trailing slashes and fragments; two
 * rows that differ only in those are one page, and fetching both wastes the
 * whole budget.
 * @param raw - candidate URL.
 * @returns a stable key, or `undefined` for a non-http(s) URL.
 */
export function canonicalKey(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        const host = url.hostname.toLowerCase().replace(/^www\./u, '');
        const path = url.pathname.replace(/\/+$/u, '') || '/';
        return `${host}${path}${url.search}`;
    }
    catch {
        return undefined;
    }
}
/** Collapse page text into a readable excerpt. */
function excerptOf(text, max) {
    const flattened = text
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (flattened.length <= max)
        return flattened;
    return `${flattened.slice(0, max - 1).trimEnd()}…`;
}
/** Walk `worker` over items with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}
/** Words that carry no retrieval signal in a research query. */
const QUERY_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
    'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'is', 'are',
    'was', 'were', 'be', 'been', 'do', 'does', 'did', 'vs', 'versus', 'about',
    'please', 'tell', 'give', 'show', 'find', 'compare', 'difference', 'between',
]);
/** CJK stopword bigrams that would match almost any Chinese page. */
const CJK_STOPWORDS = new Set(['的是', '了吗', '什么', '怎么', '如何', '哪些', '多少', '一下', '请问', '最近', '以及']);
/**
 * Tokens a candidate should contain to count as relevant.
 *
 * ASCII words shorter than three characters are dropped, and Chinese runs are
 * cut into bigrams; that is enough to tell an article about `东数西算` from a
 * dictionary entry for the single character `东`.
 * @param queries - the queries this call ran.
 * @returns distinct lowercase tokens.
 */
function queryTokens(queries) {
    const text = queries.join(' ').toLowerCase();
    const tokens = new Set();
    for (const word of text.match(/[a-z][a-z0-9.+#-]{2,}/gu) ?? []) {
        if (!QUERY_STOPWORDS.has(word))
            tokens.add(word);
    }
    for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
        if (run.length === 2) {
            if (!CJK_STOPWORDS.has(run))
                tokens.add(run);
            continue;
        }
        for (let index = 0; index < run.length - 1; index += 1) {
            const bigram = run.slice(index, index + 2);
            if (!CJK_STOPWORDS.has(bigram))
                tokens.add(bigram);
        }
    }
    return [...tokens];
}
/** Count how many query tokens appear in a row's title and snippet. */
function relevanceScore(source, tokens) {
    if (tokens.length === 0)
        return 0;
    const haystack = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
    return tokens.reduce((score, token) => (haystack.includes(token) ? score + 1 : score), 0);
}
/** Interleave per-query result lists by rank, so one query cannot fill the pack. */
function interleave(sourcesByQuery) {
    const merged = [];
    const seen = new Set();
    let depth = 0;
    for (const list of sourcesByQuery)
        depth = Math.max(depth, list.length);
    for (let rank = 0; rank < depth; rank += 1) {
        for (const list of sourcesByQuery) {
            const source = list[rank];
            if (source === undefined)
                continue;
            const key = canonicalKey(source.url);
            if (key === undefined || seen.has(key))
                continue;
            seen.add(key);
            merged.push(source);
        }
    }
    return merged;
}
/** Read the argument object, rejecting the shapes the model gets wrong. */
function parseArgs(args) {
    if (typeof args !== 'object' || args === null)
        throw new Error('research requires an object argument');
    const record = args;
    const query = typeof record['query'] === 'string' ? record['query'].trim() : '';
    const extra = record['queries'];
    const queries = [];
    if (query.length > 0)
        queries.push(query);
    if (extra !== undefined) {
        if (!Array.isArray(extra))
            throw new Error('research queries must be an array of strings');
        for (const item of extra) {
            if (typeof item !== 'string' || item.trim().length === 0) {
                throw new Error('research queries must be non-empty strings');
            }
            const trimmed = item.trim();
            if (!queries.includes(trimmed))
                queries.push(trimmed);
        }
    }
    if (queries.length === 0)
        throw new Error('research requires a non-empty query');
    if (queries.length > RESEARCH_MAX_QUERIES) {
        throw new Error(`research accepts at most ${RESEARCH_MAX_QUERIES} queries, got ${queries.length}`);
    }
    const rawSources = record['maxSources'];
    let maxSources = RESEARCH_DEFAULT_SOURCES;
    if (rawSources !== undefined) {
        if (typeof rawSources !== 'number' || !Number.isInteger(rawSources)) {
            throw new Error('research maxSources must be an integer');
        }
        maxSources = Math.min(RESEARCH_MAX_SOURCES, Math.max(RESEARCH_MIN_SOURCES, rawSources));
    }
    return { queries, maxSources };
}
/** The parameter schema, kept as plain JSON Schema like the other tools. */
function parameterSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: {
                type: 'string',
                description: 'The question to research. It is sent to the search engines verbatim.',
            },
            queries: {
                type: 'array',
                description: `Up to ${RESEARCH_MAX_QUERIES} additional distinct queries to widen the evidence; results are merged with the main query.`,
                items: { type: 'string' },
            },
            maxSources: {
                type: 'integer',
                description: `How many pages to fetch and quote (${RESEARCH_MIN_SOURCES}–${RESEARCH_MAX_SOURCES}, default ${RESEARCH_DEFAULT_SOURCES}).`,
            },
        },
        required: ['query'],
    };
}
/** The output schema: pages carry their own citation. */
function outputSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string' },
            queries: { type: 'array', items: { type: 'string' } },
            pages: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        url: { type: 'string' },
                        title: { type: 'string' },
                        status: { type: 'integer' },
                        chars: { type: 'integer' },
                        excerpt: { type: 'string' },
                        truncated: { type: 'boolean' },
                    },
                    required: ['url', 'status', 'chars', 'excerpt', 'truncated'],
                },
            },
            sources: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { url: { type: 'string' }, title: { type: 'string' } },
                    required: ['url'],
                },
            },
            failures: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { url: { type: 'string' }, reason: { type: 'string' } },
                    required: ['url', 'reason'],
                },
            },
            found: { type: 'integer' },
            truncated: { type: 'boolean' },
        },
        required: ['query', 'queries', 'pages', 'sources', 'failures', 'found', 'truncated'],
    };
}
/**
 * Format the evidence pack the model reads.
 * @param value - what the call produced.
 * @returns a Markdown document with one section per fetched page.
 */
export function formatResearchValue(value) {
    const head = [
        `Research: ${JSON.stringify(value.query)}`,
        `Searched ${value.queries.length} quer${value.queries.length === 1 ? 'y' : 'ies'}, `
            + `${value.found} source(s) found, ${value.pages.length} page(s) fetched.`,
    ];
    if (value.queries.length > 1) {
        head.push(`Queries: ${value.queries.map((query) => JSON.stringify(query)).join(', ')}`);
    }
    const sections = value.pages.map((page, index) => {
        const lines = [
            `## ${index + 1}. ${page.title !== undefined && page.title.length > 0 ? page.title : page.url}`,
            page.url,
            '',
            page.excerpt,
        ];
        if (page.truncated)
            lines.push('', '(excerpt truncated)');
        return lines.join('\n');
    });
    const notFetched = value.sources.length === 0
        ? []
        : [
            '## Found but not fetched',
            ...value.sources.map((source) => `- ${source.title !== undefined && source.title.length > 0 ? `${source.title} — ` : ''}${source.url}`),
        ];
    const failures = value.failures.length === 0
        ? []
        : ['## Fetch failures', ...value.failures.map((failure) => `- ${failure.url}: ${failure.reason}`)];
    return [...head, '', ...sections, ...(notFetched.length === 0 ? [] : ['', ...notFetched]), ...(failures.length === 0 ? [] : ['', ...failures])]
        .join('\n')
        .trimEnd();
}
/**
 * Build the tool definition the host registry accepts.
 * @param name - `research`, or the fallback when that name is taken.
 * @param search - runs one query through the plugin's search path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @returns a registry-ready definition.
 */
export function createResearchDefinition(name, search, fetchPage) {
    return {
        name,
        description: 'Research a question end to end: run up to three searches, open the leading pages, and return an evidence pack in which every excerpt sits under its URL. Use it when the answer needs citations or several sources, not when one search row is enough. Pages that fail to load are reported by URL and reason instead of aborting the call.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: formatResearchValue(value) }],
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseArgs(args);
            const signal = exec.signal;
            const startedAt = Date.now();
            const remaining = () => Math.max(0, RESEARCH_BUDGET_MS - (Date.now() - startedAt));
            const cancelled = () => signal !== undefined && signal.aborted;
            const searchLimit = Math.max(5, parsed.maxSources);
            const outcomes = await mapLimit(parsed.queries, 2, async (query) => {
                try {
                    return await search(query, searchLimit, signal);
                }
                catch (error) {
                    return {
                        sources: [],
                        failures: [error instanceof Error ? error.message : String(error)],
                    };
                }
            });
            if (cancelled())
                throw new Error('research was cancelled');
            const candidates = interleave(outcomes.map((outcome) => outcome.sources));
            // Prefer rows whose title or snippet actually contains a query token.
            // Search engines return a few singletons for a long Chinese query (the
            // character `东`, a company named 东…); fetching those spends the budget
            // on prose that cannot answer the question. The filter is only a
            // preference: when too few rows match, every candidate is still eligible.
            const tokens = queryTokens(parsed.queries);
            const scored = candidates.map((source, index) => ({ source, index, score: relevanceScore(source, tokens) }));
            const matched = scored.filter((entry) => entry.score > 0);
            const pool = matched.length >= parsed.maxSources ? matched : scored;
            pool.sort((left, right) => right.score - left.score || left.index - right.index);
            const ranked = pool.map((entry) => entry.source);
            const failures = [];
            // Fill the quota even when a page fails: with `wanted = candidates.slice(0,
            // maxSources)`, one dead candidate produced a pack with two pages out of
            // three and a successful candidate never tried. Workers share a cursor and
            // stop pulling new candidates once enough pages have succeeded, so the
            // extra attempts stay bounded by the concurrency (three) plus the failures.
            const attempts = [];
            let cursor = 0;
            let succeeded = 0;
            const workers = Array.from({ length: Math.min(RESEARCH_PAGE_CONCURRENCY, candidates.length) }, async () => {
                for (;;) {
                    if (succeeded >= parsed.maxSources || cancelled())
                        return;
                    const index = cursor;
                    cursor += 1;
                    const source = ranked[index];
                    if (source === undefined)
                        return;
                    const budget = Math.min(20_000, remaining());
                    if (budget < RESEARCH_MIN_PAGE_MS) {
                        failures.push({ url: source.url, reason: 'no time left in the research budget' });
                        return;
                    }
                    const bound = signal === undefined
                        ? AbortSignal.timeout(budget)
                        : AbortSignal.any([signal, AbortSignal.timeout(budget)]);
                    try {
                        const fetched = await fetchPage(source.url, bound);
                        const excerpt = excerptOf(fetched.text, RESEARCH_EXCERPT_CHARS);
                        if (excerpt.length === 0) {
                            failures.push({ url: source.url, reason: 'the page carried no readable text' });
                            continue;
                        }
                        succeeded += 1;
                        attempts.push({
                            index,
                            page: {
                                url: fetched.url.length > 0 ? fetched.url : source.url,
                                ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
                                status: fetched.status,
                                chars: fetched.text.length,
                                excerpt,
                                truncated: fetched.truncated || fetched.text.length > RESEARCH_EXCERPT_CHARS,
                            },
                        });
                    }
                    catch (error) {
                        if (cancelled())
                            throw error;
                        failures.push({ url: source.url, reason: error instanceof Error ? error.message : String(error) });
                    }
                }
            });
            await Promise.all(workers);
            if (cancelled())
                throw new Error('research was cancelled');
            const fetchedPages = attempts
                .sort((left, right) => left.index - right.index)
                .map((attempt) => attempt.page)
                .filter((page) => page !== undefined)
                .slice(0, parsed.maxSources);
            const fetchedUrls = new Set(fetchedPages.map((page) => page.url));
            const failedUrls = new Set(failures.map((failure) => failure.url));
            return {
                query: parsed.queries[0],
                queries: parsed.queries,
                pages: fetchedPages,
                sources: candidates
                    .filter((source) => !fetchedUrls.has(source.url) && !failedUrls.has(source.url))
                    .slice(0, 20)
                    .map((source) => ({
                    url: source.url,
                    ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
                })),
                failures,
                found: candidates.length,
                truncated: candidates.length > parsed.maxSources,
            };
        },
    };
}
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickResearchToolName(tools) {
    if (typeof tools.get !== 'function')
        return RESEARCH_TOOL_NAME;
    try {
        return tools.get(RESEARCH_TOOL_NAME) === undefined ? RESEARCH_TOOL_NAME : RESEARCH_TOOL_FALLBACK_NAME;
    }
    catch {
        return RESEARCH_TOOL_NAME;
    }
}
/** Report a registration failure without throwing out of the plugin. */
function report(options, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
        options.warn?.(`research registration skipped: ${message}`);
    }
    catch {
        // A diagnostic callback must never break plugin loading.
    }
}
/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param search - executes one search through the plugin's normal path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerResearchTool(tools, search, fetchPage, options = {}) {
    const name = pickResearchToolName(tools);
    try {
        const registered = tools.register(createResearchDefinition(name, search, fetchPage));
        const disposeHost = typeof registered === 'function' ? registered : undefined;
        let disposed = false;
        return {
            name,
            dispose: () => {
                if (disposed)
                    return;
                disposed = true;
                try {
                    disposeHost?.();
                }
                catch {
                    // Disposal must stay contained; the plugin is already going away.
                }
            },
        };
    }
    catch (error) {
        report(options, error);
        return undefined;
    }
}
