import { wrapUntrustedContent } from "./untrusted.js";
/** The name this tool prefers. */
export const CACHE_SEARCH_TOOL_NAME = 'cache_search';
/** The name used when another plugin already registered `cache_search`. */
export const CACHE_SEARCH_FALLBACK_NAME = 'web_cache_search';
/** How long a fetched body stays searchable. */
export const CACHE_SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** Bounded memory: enough for a normal research session, not a crawler. */
export const CACHE_SEARCH_MAX_BODIES = 24;
/** Per-body storage cap, in characters. */
export const CACHE_SEARCH_MAX_CHARS = 400_000;
/** Snippet budget returned for one matching body. */
export const CACHE_SEARCH_SNIPPET_CHARS = 1_600;
/** Default and maximum result count for one query. */
export const CACHE_SEARCH_DEFAULT_LIMIT = 3;
export const CACHE_SEARCH_MAX_LIMIT = 10;
/** True for a value usable as a record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Lowercase search terms; CJK runs become bigrams, matching research's lexical gate. */
export function cacheTokens(query) {
    const text = query.toLowerCase();
    const tokens = new Set();
    for (const word of text.match(/[a-z][a-z0-9.+#-]{2,}/gu) ?? [])
        tokens.add(word);
    for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
        if (run.length === 2) {
            tokens.add(run);
            continue;
        }
        for (let index = 0; index < run.length - 1; index += 1)
            tokens.add(run.slice(index, index + 2));
    }
    return [...tokens];
}
/** Split a page into paragraph windows small enough to quote. */
export function cacheWindows(text, size = 700) {
    const blocks = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').split(/\n{2,}/u)
        .map((block) => block.trim()).filter((block) => block.length > 0);
    const windows = [];
    for (const block of blocks) {
        if (block.length <= size) {
            windows.push(block);
            continue;
        }
        for (let offset = 0; offset < block.length; offset += size)
            windows.push(block.slice(offset, offset + size));
    }
    return windows;
}
/** Score one window by distinct query-term hits and a small repetition bonus. */
function scoreWindow(window, tokens) {
    const haystack = window.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        if (!haystack.includes(token))
            continue;
        score += 1;
        let at = haystack.indexOf(token) + token.length;
        while (at < haystack.length) {
            const next = haystack.indexOf(token, at);
            if (next < 0)
                break;
            score += 0.1;
            at = next + token.length;
        }
    }
    return score;
}
/** In-memory, bounded, expiring cache of research bodies. */
export class ResearchBodyCache {
    entries = new Map();
    ttlMs;
    maxBodies;
    maxChars;
    now;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? CACHE_SEARCH_TTL_MS;
        this.maxBodies = options.maxBodies ?? CACHE_SEARCH_MAX_BODIES;
        this.maxChars = options.maxChars ?? CACHE_SEARCH_MAX_CHARS;
        this.now = options.now ?? Date.now;
    }
    /** Store one successful research body, replacing an older copy of the URL. */
    put(body) {
        if (body.text.trim().length === 0)
            return;
        const text = body.text.length > this.maxChars ? body.text.slice(0, this.maxChars) : body.text;
        const entry = {
            url: body.url,
            ...(body.title === undefined || body.title.length === 0 ? {} : { title: body.title }),
            text,
            fetchedAt: this.now(),
            queries: [...(body.queries ?? [])],
        };
        this.entries.delete(body.url);
        this.entries.set(body.url, entry);
        while (this.entries.size > this.maxBodies) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
        }
    }
    /** Number of live entries, after dropping expired rows. */
    size() {
        this.evict();
        return this.entries.size;
    }
    /** Drop expired entries; called by both `put` and `search`. */
    evict() {
        const cutoff = this.now() - this.ttlMs;
        for (const [url, entry] of this.entries) {
            if (entry.fetchedAt < cutoff)
                this.entries.delete(url);
        }
    }
    /**
     * Search all cached bodies lexically and return the best passage per body.
     * @param query - what to look for.
     * @param limit - maximum matches, clamped to 1...10.
     * @returns matches ordered by score, then recency.
     */
    search(query, limit = CACHE_SEARCH_DEFAULT_LIMIT) {
        this.evict();
        const tokens = cacheTokens(query);
        if (tokens.length === 0)
            return [];
        const matches = [];
        for (const entry of this.entries.values()) {
            const windows = cacheWindows(entry.text);
            const best = windows
                .map((window, index) => ({ window, index, score: scoreWindow(window, tokens) }))
                .filter((row) => row.score > 0)
                .sort((a, b) => b.score - a.score || a.index - b.index)
                .slice(0, 2);
            if (best.length === 0)
                continue;
            const snippet = best.map((row) => row.window).join('\n\n…\n\n').slice(0, CACHE_SEARCH_SNIPPET_CHARS);
            matches.push({
                url: entry.url,
                ...(entry.title === undefined ? {} : { title: entry.title }),
                snippet,
                score: best[0]?.score ?? 0,
                fetchedAt: entry.fetchedAt,
            });
        }
        return matches.sort((a, b) => b.score - a.score || b.fetchedAt - a.fetchedAt)
            .slice(0, Math.max(1, Math.min(CACHE_SEARCH_MAX_LIMIT, Math.floor(limit))));
    }
    /** Remove every entry; used by tests and disposal. */
    clear() {
        this.entries.clear();
    }
}
/** Render results for the model, inside the untrusted-content boundary. */
export function formatCacheSearchValue(value) {
    const head = `Research cache search: ${JSON.stringify(value.query)} — ${value.matches.length} match(es).`;
    const lines = value.matches.map((match, index) => [
        `${index + 1}. ${match.title ?? match.url}`,
        `   ${match.url}`,
        `   ${match.snippet}`,
    ].join('\n'));
    if (value.matches.length === 0)
        lines.push('No matching passage in the bodies fetched by research in this process.');
    return [head, '', ...lines].join('\n').trimEnd();
}
/** Parameter schema. */
function parameterSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string', description: 'Words to find in the full texts already fetched by research.' },
            limit: {
                type: 'integer',
                description: `Matches wanted, 1–${CACHE_SEARCH_MAX_LIMIT}; defaults to ${CACHE_SEARCH_DEFAULT_LIMIT}.`,
            },
        },
        required: ['query'],
    };
}
/** Output schema. */
function outputSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string' },
            matches: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        url: { type: 'string' },
                        title: { type: 'string' },
                        snippet: { type: 'string' },
                        score: { type: 'number' },
                        fetchedAt: { type: 'number' },
                    },
                    required: ['url', 'snippet', 'score', 'fetchedAt'],
                },
            },
            failures: { type: 'array', items: { type: 'string' } },
        },
        required: ['query', 'matches', 'failures'],
    };
}
/** Parse and validate arguments. */
function parseArgs(args) {
    if (!isRecord(args) || typeof args['query'] !== 'string' || args['query'].trim().length === 0) {
        throw new Error('cache_search requires a non-empty query');
    }
    const raw = args['limit'];
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > CACHE_SEARCH_MAX_LIMIT)) {
        throw new Error(`cache_search limit must be an integer between 1 and ${CACHE_SEARCH_MAX_LIMIT}`);
    }
    return { query: args['query'].trim(), limit: raw ?? CACHE_SEARCH_DEFAULT_LIMIT };
}
/**
 * Build the `cache_search` definition.
 * @param name - preferred or fallback tool name.
 * @param cache - live cache populated by research.
 */
export function createCacheSearchDefinition(name, cache) {
    return {
        name,
        description: 'Search the full texts that the research tool already fetched in this process, without fetching them again. Use it when a research answer needs an exact detail, quote or section and the evidence pack only shows an excerpt. Returns matching passages with their source URLs.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: wrapUntrustedContent(formatCacheSearchValue(value)) }],
        },
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseArgs(args);
            if (exec.signal?.aborted === true)
                throw new Error('cache_search was cancelled');
            return { query: parsed.query, matches: cache.search(parsed.query, parsed.limit), failures: [] };
        },
    };
}
/** Pick the preferred name unless another tool already owns it. */
export function pickCacheSearchToolName(tools) {
    if (typeof tools.get !== 'function')
        return CACHE_SEARCH_TOOL_NAME;
    try {
        return tools.get(CACHE_SEARCH_TOOL_NAME) === undefined ? CACHE_SEARCH_TOOL_NAME : CACHE_SEARCH_FALLBACK_NAME;
    }
    catch {
        return CACHE_SEARCH_TOOL_NAME;
    }
}
/**
 * Register the cache-search tool; every failure is contained so the rest of the
 * plugin keeps mounting.
 */
export function registerCacheSearchTool(tools, cache, options = {}) {
    const name = pickCacheSearchToolName(tools);
    try {
        tools.register(createCacheSearchDefinition(name, cache));
        return name;
    }
    catch (error) {
        try {
            options.warn?.(`cache_search registration skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // A diagnostic must not break mounting.
        }
        return undefined;
    }
}
