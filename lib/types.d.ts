/**
 * Shared types for the search provider.
 *
 * Every module in this package imports its contracts from here so the
 * parsers, the ranking, the cache, the engine health tracker and the plugin
 * entry cannot drift apart. Nothing in this file has a runtime side effect.
 *
 * @module @fangchenghao/dsh-web-search/types
 */
/** One citable result, in the shape the `web` seam expects. */
export interface Source {
    url: string;
    title?: string;
    snippet?: string;
    publishedAt?: string;
}
/** Which language side an engine leads. `both` leads either side. */
export type Region = 'global' | 'cn' | 'both';
/**
 * How old a result may be: `off` disables time filtering, the rest are rolling
 * windows measured back from the moment of the search.
 */
export type TimeRange = 'off' | 'day' | 'week' | 'month' | 'year';
/** Engine priority tier: fallback engines run only when no primary answered. */
export type Tier = 'primary' | 'fallback';
/** How long a tier waits for its engines to answer. */
export type WaitPolicy = 'auto' | 'all' | 'fast';
/**
 * One search engine.
 *
 * A `build`/`parse` pair covers the scraped result pages; adding `body` turns
 * the request into a JSON `POST`, which is what the AnySearch API needs.
 */
export interface HostSpec {
    /** Stable id, also used in failure messages and configuration. */
    id: string;
    tier: Tier;
    region: Region;
    /** Slots taken per interleave round; higher means more of this engine. */
    weight?: number;
    /** Tunnel from the start instead of trying a direct request first. */
    viaProxy?: boolean;
    /**
     * Requests this engine accepts at once, process-wide.
     *
     * Exa and Firecrawl reject bursts with 429, and `search_many` legitimately
     * starts several searches together; a gate per engine id keeps those calls
     * from fighting each other.
     */
    maxConcurrent?: number;
    /** Send `body(query)` as a JSON POST rather than a GET. */
    method?: 'POST';
    /** Skip the echoed-query check: a JSON API validates itself. */
    skipEcho?: boolean;
    /** Confirm the payload really belongs to the query (scraped pages only). */
    echoesQuery?: (payload: string, query: string) => boolean;
    /** Absolute request URL for a query. `timeRange` may be pushed down when the engine supports it. */
    build: (query: string, timeRange?: TimeRange) => string;
    /** Request body for a JSON POST. */
    body?: (query: string) => string;
    /** Extra request headers, for a provider that authenticates. */
    headers?: Record<string, string>;
    /** Turn a response payload into sources; must never throw on markup drift. */
    parse: (payload: string, finalUrl: string) => Source[];
}
/** One engine's answer, as carried into ranking. */
export interface EngineAnswer {
    host: HostSpec;
    sources: Source[];
}
/** Failure description kept per engine, surfaced to the caller verbatim. */
export interface EngineFailure {
    /** Engine id the failure belongs to. */
    id: string;
    /** Human-readable reason, already prefixed with the engine id. */
    reason: string;
    /** Business code from {@link SearchErrorCode} when the failure has one. */
    code?: SearchErrorCode;
}
/** Options the plugin passes down from the `web` seam request. */
export interface SearchOptions {
    /** Maximum sources to return. */
    limit: number;
    /** Wait policy; defaults to `auto`. */
    wait?: WaitPolicy;
    /** Soft deadline override in milliseconds. */
    softMs?: number;
    /** Per-engine request deadline in milliseconds. */
    timeoutMs?: number;
    /** `false` disables the tunnel entirely. */
    useProxy?: boolean;
    /** Explicit proxy URL, overriding detection. */
    proxy?: string;
    /** Restrict the run to these engine ids. */
    hostIds?: string[];
    /** Rolling window results must fall in; `off` disables filtering. */
    timeRange?: TimeRange;
    /** Cancellation from the caller. */
    signal?: AbortSignal;
}
/** What {@link search} reports back. */
export interface SearchOutcome {
    sources: Source[];
    failures: string[];
    /** Proxy that was actually used, `undefined` when the run went direct. */
    proxy?: string;
}
/** Ranking knobs; every one has a documented default. */
export interface RankOptions {
    /** Reciprocal-rank-fusion constant; larger flattens the rank curve. */
    rrfConstant?: number;
    /** Domains that earn a ranking boost (official documentation and the like). */
    authorityDomains?: string[];
    /** Boost applied per authoritative domain. */
    authorityBoost?: number;
    /** Boost applied to recently published results. */
    freshnessBoost?: number;
    /** Age in days after which the freshness boost fades to zero. */
    freshnessDays?: number;
    /**
     * Active time window. Ranking never drops rows (the engine layer does), but
     * when a window is active a row without a usable date is scored lower so a
     * similarly relevant dated row wins.
     */
    timeRange?: TimeRange;
    /** Per-engine weight in the pre-fusion interleave. */
    weights?: number[];
    /**
     * Evaluation instant in milliseconds for the freshness boost, defaulting to
     * `Date.now()`. Benchmarks pin this to the fixture's recording time so a
     * replay does not drift as the fixture ages.
     */
    now?: number;
}
/** Cache knobs. */
export interface CacheOptions {
    /**
     * Entry lifetime in milliseconds. `0` disables the cache. A reader keeps
     * Settings edits live without a remount.
     */
    ttlMs?: number | (() => number);
    /** Maximum retained entries, or a reader for it; the least recently used goes. */
    maxEntries?: number | (() => number);
}
/** Health knobs for the per-engine cooldown. */
export interface HealthOptions {
    /** Cooldown after a throttling failure that carries no wait hint. */
    baseCooldownMs?: number;
    /** Ceiling for an exponential cooldown. */
    maxCooldownMs?: number;
}
/** Business codes a failure can carry. */
export type SearchErrorCode = 'SEARCH_THROTTLED' | 'SEARCH_BLOCKED' | 'SEARCH_TIMEOUT' | 'SEARCH_NETWORK' | 'SEARCH_PARSE' | 'SEARCH_NETWORK_BLOCKED_BY_POLICY' | 'SEARCH_ABORTED'
/** The caller sent nonsense (an empty query, a non-HTTP URL). */
 | 'SEARCH_INVALID'
/** The page answered, but nothing readable came back. */
 | 'SEARCH_EMPTY'
/** The page answered with a 4xx/5xx status. */
 | 'SEARCH_HTTP_STATUS'
/** The page is a binary document this plugin cannot convert to text. */
 | 'SEARCH_UNSUPPORTED';
