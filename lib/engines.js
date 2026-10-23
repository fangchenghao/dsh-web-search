import { SearchError } from "./errors.js";
import { filterByTimeRange, preferWindow } from "./freshness.js";
import { resolveProxy } from "./proxy.js";
import { parseAnySearch, parseBing, parseDdgHtml, parseDdgLite, parseExaMcp, parseFirecrawl, parseSo } from "./parsers.js";
import { mergeRegions } from "./rank.js";
import { cacheKey } from "./cache.js";
import { searchHost } from "./transport.js";
import { keyFailureKind, keyPoolFor } from "./keys.js";
/** How many rows to ask AnySearch for; the merge picks from them. */
// AnySearch caps max_results at 10: asking for more returns 10 with HTTP
// 200, so the constant matches the real ceiling instead of over-asking.
const ANYSEARCH_MAX_RESULTS = 10;
/**
 * Engines, in merge priority order.
 *
 * `region` decides which query language an engine leads (`both` leads either),
 * `weight` how many slots it takes per interleave round, and `tier` whether it
 * runs as a first choice or only when no primary answered.
 */
export const HOSTS = [
    {
        id: 'anysearch',
        tier: 'primary',
        // Serves both languages: it answers Chinese queries with the original
        // documentation and book translations rather than SEO farms, so it leads a
        // CJK query as well as an ASCII one (A/B measured: the domestic-only run
        // answered "如何配置 postgres 逻辑复制" with a dictionary page).
        region: 'both',
        // A JSON API rather than a result page: it takes a POST body, answers with
        // its own envelope, and is reachable directly. Its precision is the highest
        // here, so it takes the most slots.
        weight: 2,
        method: 'POST',
        skipEcho: true,
        build: () => 'https://api.anysearch.com/v1/search',
        body: (query) => JSON.stringify({ query, max_results: ANYSEARCH_MAX_RESULTS }),
        parse: parseAnySearch,
    },
    {
        id: 'exa',
        // A semantic (embedding) index rather than a keyword page: it answers with
        // the page itself plus highlights. The MCP endpoint accepts anonymous
        // calls, so it costs no key. Measured on the same recorded fixtures with the
        // tier-aware replay, MRR@8 0.8071 with Exa in the primary tier versus
        // 0.7738 without it, and it removes the one zero-hit query.
        tier: 'primary',
        region: 'global',
        weight: 1,
        viaProxy: true,
        method: 'POST',
        skipEcho: true,
        headers: { accept: 'application/json, text/event-stream' },
        build: () => 'https://mcp.exa.ai/mcp',
        body: (query) => JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search_exa', arguments: { query, numResults: 10 } },
        }),
        parse: parseExaMcp,
    },
    {
        id: 'firecrawl',
        // The keyless tier of the Firecrawl search API. It returns extracted page
        // Markdown rather than snippets, so only the opening prose is kept as the
        // row's snippet; it handled a Chinese query with the same shape. It ships as
        // a fallback because it diluted the fusion when it led: MRR@8 0.7208 with
        // Firecrawl in the primary tier versus 0.8071 with Exa there instead, on the
        // same fixtures (standalone 0.4625). `hostIds: ['firecrawl']` still forces
        // it, and it answers whenever every primary came back empty.
        tier: 'fallback',
        region: 'both',
        weight: 1,
        viaProxy: true,
        method: 'POST',
        skipEcho: true,
        build: () => 'https://api.firecrawl.dev/v1/search',
        body: (query) => JSON.stringify({ query, limit: 10 }),
        parse: parseFirecrawl,
    },
    {
        id: 'ddg-html',
        tier: 'primary',
        region: 'global',
        viaProxy: true,
        build: (query, timeRange) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${ddgWindow(timeRange)}`,
        parse: parseDdgHtml,
    },
    {
        id: 'www.bing',
        // A fallback rather than a primary: measured on stopword-heavy English
        // queries it matched a single token and answered with unrelated pages
        // ("how to set up postgres logical replication" returned jigsaw-puzzle
        // sites for "set"), while the engines above stayed on topic.
        tier: 'fallback',
        region: 'global',
        viaProxy: true,
        // No `filters` parameter: see the measurement note before `HOSTS`.
        build: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US&setlang=en&cc=US`,
        parse: parseBing,
    },
    {
        id: 'cn.bing',
        tier: 'primary',
        region: 'cn',
        // No `filters` parameter: see the measurement note before `HOSTS`.
        build: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
        parse: parseBing,
    },
    {
        id: 'so',
        // 360 answers an anti-bot wall from this network and from the tunnel, so it
        // is demoted: tried only when every primary engine came back empty.
        tier: 'fallback',
        region: 'cn',
        build: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
        parse: parseSo,
    },
    {
        id: 'ddg-lite',
        tier: 'fallback',
        region: 'global',
        viaProxy: true,
        build: (query, timeRange) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}${ddgWindow(timeRange)}`,
        parse: parseDdgLite,
    },
];
/** Scripts that make a query CJK rather than ASCII. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
/**
 * DuckDuckGo's own date filter, appended to a result-page URL.
 *
 * Measured live on both endpoints: adding `df=d`, `df=w` or `df=m` changed the
 * returned result set, so this is a real pushdown rather than a decorative
 * parameter. `off` (and the absent value) adds nothing.
 *
 * @param timeRange - active window, if any.
 * @returns `&df=x` for a supported window, otherwise an empty string.
 */
function ddgWindow(timeRange) {
    switch (timeRange) {
        case 'day':
            return '&df=d';
        case 'week':
            return '&df=w';
        case 'month':
            return '&df=m';
        case 'year':
            return '&df=y';
        case 'off':
        case undefined:
        default:
            return '';
    }
}
/*
 * Why Bing has no time parameter.
 *
 * Measured on `cn.bing.com` and `www.bing.com` (which redirects to `cn.bing`):
 * `filters=ex1:"ez1|ez2|ez3|ez5_…"` is accepted — the response marks the
 * matching entry as selected — but the ten returned URLs were byte-for-byte
 * identical to the unfiltered run for both a general and a news query. Bing's
 * filter is therefore not written into the request; the engine layer filters
 * Bing's parsed dates locally instead.
 */
/** Soft deadline per wait policy, in milliseconds. */
const SOFT_DEADLINE = {
    auto: (ascii) => (ascii ? 6000 : 3500),
    all: () => 10000,
    fast: () => 3500,
};
/** Whether an engine leads a query whose language belongs to `lead`. */
function leadsQuery(host, lead) {
    return host.region === 'both' || host.region === lead;
}
/**
 * Ask one engine, rotating to the next key when the failure blames the key.
 *
 * A 401 or 429 from the one credentialed engine is the only failure a second
 * attempt can fix; an engine that timed out or lost the network will fail the
 * same way with a different token. At most two keys are tried per engine per
 * tier, which bounds the added latency to one extra request.
 * @param host - the engine definition.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-engine deadline.
 * @param proxy - tunnel URL, or `undefined`.
 * @param timeRange - active publication window.
 * @param pool - configured keys, possibly empty.
 * @param domain - AnySearch vertical domain, if configured.
 * @returns the last attempt's outcome.
 */
async function searchHostWithKeys(host, query, signal, timeoutMs, proxy, timeRange, pool, domain) {
    if (host.id !== 'anysearch' || pool.size === 0) {
        return searchHost(host, query, signal, timeoutMs, proxy, timeRange);
    }
    let key = pool.pick();
    let last;
    for (let attempt = 0; attempt < 2 && key !== undefined; attempt += 1) {
        const configured = resolveHost(host, {
            anysearchApiKey: key,
            ...(domain === undefined ? {} : { anysearchDomain: domain }),
        });
        const outcome = await searchHost(configured, query, signal, timeoutMs, proxy, timeRange);
        if (outcome.ok) {
            pool.reward(key);
            return outcome;
        }
        last = outcome;
        const kind = keyFailureKind(outcome.error);
        if (kind === undefined || signal?.aborted === true)
            return outcome;
        pool.penalize(key, kind);
        const next = pool.pick();
        if (next === undefined || next === key)
            return outcome;
        key = next;
    }
    return last;
}
/**
 * Run one tier concurrently and return the answers that arrived in time.
 * @param hosts - engines of this tier, in priority order.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-engine deadline.
 * @param failures - collector for caller-facing failure strings.
 * @param proxy - tunnel URL, or `undefined`.
 * @param limits - release thresholds.
 * @param health - cooldown tracker to update, when one is configured.
 * @returns one answer per engine that produced sources.
 */
async function runTier(hosts, query, signal, timeoutMs, failures, proxy, limits, health, pool, anysearchDomain) {
    const counters = limits.lead === 'all' || !hosts.some((host) => leadsQuery(host, limits.lead))
        ? () => true
        : (host) => leadsQuery(host, limits.lead);
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    const outcomes = new Array(hosts.length).fill(undefined);
    const answered = () => outcomes.filter((outcome) => outcome instanceof SearchError || outcome !== undefined);
    const available = () => outcomes.reduce((total, outcome) => total + (outcome instanceof SearchError || outcome === undefined ? 0 : outcome.sources.length), 0);
    const contributors = () => outcomes.filter((outcome, index) => counters(hosts[index]) && !(outcome instanceof SearchError) && outcome !== undefined && outcome.sources.length > 0).length;
    const leadTotal = hosts.filter(counters).length || hosts.length;
    const needed = Math.min(limits.needed, leadTotal);
    // Nothing more can arrive from the leading region once every one of its
    // engines settled, so a failed engine there must not hold the tier open until
    // the soft deadline.
    const leadSettled = () => outcomes.filter((outcome, index) => counters(hosts[index]) && outcome !== undefined).length >= leadTotal;
    const done = () => answered().length === hosts.length || leadSettled() || (available() >= limits.limit && contributors() >= needed);
    let releasedEarly = false;
    let closed = false;
    let released = () => { };
    const enough = new Promise((resolve) => {
        released = resolve;
    });
    const release = (early) => {
        if (closed)
            return;
        closed = true;
        releasedEarly = early;
        released();
    };
    const running = hosts.map((host, index) => searchHostWithKeys(host, query, controller.signal, timeoutMs, proxy, limits.timeRange, pool, anysearchDomain).then((outcome) => {
        if (outcome.ok) {
            outcomes[index] = { host, sources: outcome.sources };
            health?.noteSuccess(host.id);
        }
        else {
            outcomes[index] = outcome.error;
            health?.noteFailure(host.id, outcome.error);
        }
        if (done())
            release(true);
    }, (error) => {
        // An engine's own failure is a returned value, but cancellation comes
        // from the caller: propagate it instead of finishing a search nobody is
        // waiting for any more.
        if (signal?.aborted === true)
            throw error;
        const message = error instanceof Error ? error.message : String(error);
        outcomes[index] = new SearchError(`${host.id}: ${message}`, 'SEARCH_NETWORK', true);
        if (done())
            release(true);
    }));
    const timer = setTimeout(() => release(false), limits.softMs);
    try {
        await Promise.race([Promise.all(running), enough]);
    }
    finally {
        clearTimeout(timer);
        controller.abort();
        signal?.removeEventListener('abort', relayAbort);
    }
    const answers = [];
    for (const [index, outcome] of outcomes.entries()) {
        const host = hosts[index];
        if (outcome === undefined) {
            failures.push(releasedEarly ? `${host.id}: aborted once enough results had arrived` : `${host.id}: still running at deadline`);
        }
        else if (outcome instanceof SearchError) {
            failures.push(outcome.message);
        }
        else if (outcome.sources.length === 0) {
            failures.push(`${host.id}: no results`);
        }
        else {
            answers.push(outcome);
        }
    }
    return answers;
}
/**
 * Search the web with every configured engine and fuse the answers.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param options - budget, policy and runtime dependencies.
 * @returns fused sources plus the failures worth reporting; throws on cancellation.
 */
/**
 * Apply per-run configuration to an engine definition.
 *
 * Only AnySearch is configurable today: it authenticates with a Bearer token and
 * can be pointed at one of its vertical domains. Returning a copy keeps the
 * exported `HOSTS` catalogue static, so a stale credential can never leak into
 * the next run through a mutated descriptor.
 * @param host - the engine definition from `HOSTS`.
 * @param options - the run options carrying the credential and domain.
 * @returns the engine definition to use for this run.
 */
export function resolveHost(host, options) {
    if (host.id !== 'anysearch')
        return host;
    const key = (options.anysearchApiKey ?? '').trim();
    const domain = (options.anysearchDomain ?? '').trim();
    if (key.length === 0 && domain.length === 0)
        return host;
    const headers = key.length === 0 ? undefined : { authorization: `Bearer ${key}` };
    const body = (query) => {
        const payload = { query, max_results: ANYSEARCH_MAX_RESULTS };
        if (domain.length > 0) {
            const dot = domain.indexOf('.');
            if (dot > 0) {
                payload['domain'] = domain.slice(0, dot);
                payload['sub_domain'] = domain;
            }
            else {
                payload['domain'] = domain;
            }
        }
        return JSON.stringify(payload);
    };
    return { ...host, body, ...(headers === undefined ? {} : { headers }) };
}
export async function search(query, signal, options) {
    // A blank query used to reach every engine, burn seven seconds and come back
    // with six identical "empty query" failures; refuse it before any request.
    if (typeof query !== 'string' || query.trim().length === 0) {
        throw new SearchError('the search query is empty', 'SEARCH_INVALID', false);
    }
    const limit = Math.max(1, Math.min(options.limit, 20));
    const timeoutMs = options.timeoutMs ?? 15000;
    const wait = options.wait ?? 'auto';
    const timeRange = options.timeRange ?? 'off';
    const proxy = options.useProxy === false ? undefined : await resolveProxy(options.proxy);
    const pool = keyPoolFor(options.anysearchApiKey);
    const anysearchDomain = (options.anysearchDomain ?? '').trim();
    const allow = options.hostIds !== undefined && options.hostIds.length > 0 ? new Set(options.hostIds) : undefined;
    const hosts = HOSTS.filter((host) => allow === undefined || allow.has(host.id))
        .filter((host) => host.viaProxy !== true || proxy !== undefined)
        .map((host) => resolveHost(host, options.anysearchDomain === undefined ? {} : { anysearchDomain: options.anysearchDomain }));
    // Skip engines that are cooling down, but never end up with no engine at all:
    // a throttled engine is still better than no search.
    const now = Date.now();
    const failures = [];
    const rested = hosts.filter((host) => options.health?.isCooling(host.id, now) !== true);
    if (rested.length > 0 && options.health !== undefined) {
        for (const host of hosts) {
            if (rested.includes(host))
                continue;
            const reason = options.health.skipped(host.id, now);
            failures.push(`${host.id}: ${reason ?? 'cooling down'}`);
        }
    }
    const usable = rested.length > 0 ? rested : hosts;
    const ascii = !CJK.test(query);
    const lead = ascii ? 'global' : 'cn';
    const wanted = usable.filter((host) => leadsQuery(host, lead)).length;
    const softMs = options.softMs ?? SOFT_DEADLINE[wait](ascii);
    const needed = wait === 'all' ? usable.length : wait === 'fast' ? 1 : wanted > 0 ? wanted : Math.min(2, usable.length);
    const limits = { limit, softMs, needed, lead: wait === 'all' ? 'all' : lead, timeRange };
    // Ranking does not drop rows; the engine layer does. `timeRange` is passed
    // into the rank options only so undated rows are scored lower while a window
    // is active. Keeping it out of the configured `rank` object preserves the
    // documented shape of `ResolvedConfig.rank`.
    const rank = {
        ...(options.rank ?? {}),
        ...(timeRange === 'off' ? {} : { timeRange }),
    };
    /**
     * Drop results whose parsed date is outside the window.
     *
     * Undated results survive on purpose: most documentation pages publish no
     * date, and discarding them would empty the list for a library query. They
     * are down-weighted during fusion instead, so a dated in-window page wins a
     * close comparison without erasing the undated long tail.
     */
    const applyWindow = (answers) => timeRange === 'off'
        ? answers
        : answers.map((answer) => ({ host: answer.host, sources: filterByTimeRange(answer.sources, timeRange) }));
    // The key names the engines the run *would* use, not the ones that survived
    // the cooldown filter: an engine entering or leaving a cooldown must not
    // invalidate an entry that is still fresh, or every throttle would turn the
    // next identical query into a cache miss.
    const key = options.cache === undefined ? undefined : cacheKey({ query, limit, wait, lead, engines: hosts.map((host) => host.id), timeRange });
    const cached = key === undefined ? undefined : options.cache?.get(key);
    if (cached !== undefined) {
        options.trace?.({
            limit,
            lead,
            wait,
            timeRange,
            rank,
            tier: 'cache',
            answers: [],
            sources: cached,
            failures: [...failures],
            cached: true,
        });
        return { sources: cached, failures, ...(proxy === undefined ? {} : { proxy }) };
    }
    const ordered = [...usable.filter((host) => leadsQuery(host, lead)), ...usable.filter((host) => !leadsQuery(host, lead))];
    const primary = ordered.filter((host) => host.tier === 'primary');
    const fallback = ordered.filter((host) => host.tier === 'fallback');
    let tier = 'none';
    let answers = applyWindow(await runTier(primary, query, signal, timeoutMs, failures, proxy, limits, options.health, pool, anysearchDomain));
    if (answers.length > 0)
        tier = 'primary';
    let sources = answers.length === 0 ? [] : preferWindow(mergeRegions(answers, lead, limit, rank), timeRange);
    if (sources.length === 0 && fallback.length > 0) {
        tier = 'fallback';
        answers = applyWindow(await runTier(fallback, query, signal, timeoutMs, failures, proxy, limits, options.health, pool, anysearchDomain));
        sources = answers.length === 0 ? [] : preferWindow(mergeRegions(answers, lead, limit, rank), timeRange);
    }
    if (signal?.aborted === true)
        throw new SearchError('web search was cancelled', 'SEARCH_ABORTED', false);
    if (key !== undefined && sources.length > 0)
        options.cache?.set(key, sources);
    options.trace?.({
        limit,
        lead,
        wait,
        timeRange,
        rank,
        tier,
        answers,
        sources,
        failures: [...failures],
        cached: false,
    });
    return { sources, failures, ...(proxy === undefined ? {} : { proxy }) };
}
