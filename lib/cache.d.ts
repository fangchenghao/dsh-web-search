/**
 * A small TTL + LRU result cache.
 *
 * Search results are stable for minutes, while the scraped engines are rate
 * limited and the anonymous API is metered, so repeating the same query inside
 * a short window is pure waste. The cache keeps the merged source list keyed by
 * the logical request, expires entries after a TTL and evicts the least
 * recently used entry when it is full.
 *
 * Time is injected (`now`) instead of read from a timer so the behaviour is
 * testable without sleeping.
 *
 * @module @fangchenghao/dsh-web-search/cache
 */
import type { CacheOptions, Source, TimeRange } from './types.ts';
import type { CacheFileIo } from './cache-persist.ts';
/** Optional disk persistence, layered on top of the in-memory cache. */
export interface CachePersistOptions {
    /** Custom snapshot path; empty or absent uses `~/.dsh/cache/dsh-web-search/cache.json`. */
    file?: string;
    /** Serialised byte budget; the oldest entries are evicted to fit. */
    maxBytes?: number;
    /** Minimum gap between writes in milliseconds; defaults to two seconds. */
    throttleMs?: number;
    /** Filesystem seam, mainly for tests. */
    io?: CacheFileIo;
}
/** Constructor options: {@link CacheOptions} plus optional persistence. */
export interface SearchCacheOptions extends CacheOptions {
    /** Persist the cache when present; absent keeps the cache purely in memory. */
    persist?: CachePersistOptions;
}
/** The logical inputs that decide whether two searches may share an entry. */
export interface CacheKeyParts {
    /** Raw query text; normalised inside {@link cacheKey}. */
    query: string;
    /** Requested result budget. */
    limit: number;
    /** Wait policy the search ran with. */
    wait: string;
    /** Region that led the merge. */
    lead: string;
    /** Engine ids that took part in the run. */
    engines: string[];
    /** Active publication window; omitted and `off` share a key. */
    timeRange?: TimeRange;
}
/**
 * Build the cache key for one search request.
 *
 * The query is trimmed, lowercased and has internal whitespace collapsed, so
 * `'  PostgreSQL   Replication '` and `'postgresql replication'` share an
 * entry. Engine order never matters because the ids are sorted; every other
 * field is positional, so differing `limit`, `wait`, `lead`, `timeRange` or
 * engine set yields a different key. `timeRange` is appended only when it is
 * active, which keeps the key for an unfiltered search unchanged. The query is
 * last so a query containing the field separator cannot collide with a
 * different request's prefix.
 *
 * @param parts - the logical request.
 * @returns a deterministic, comparison-safe cache key.
 */
export declare function cacheKey(parts: CacheKeyParts): string;
/**
 * TTL + LRU cache of merged source lists.
 *
 * @example
 * ```ts
 * const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 20 });
 * cache.set(key, sources);
 * const hit = cache.get(key); // undefined on miss or expiry
 * ```
 */
export declare class SearchCache {
    /** Entry lifetime in milliseconds; `0` disables the cache completely. */
    /** Live TTL reader: settings may change without a remount. */
    private readonly ttlOf;
    /** Maximum retained entries; the oldest read is evicted first. */
    /** Live entry-cap reader: settings may change without a remount. */
    private readonly maxOf;
    /** Injected clock, so tests never wait on real time. */
    private readonly now;
    /** Insertion order doubles as LRU order: the first key is the coldest. */
    private readonly entries;
    /** Snapshot destination, or `undefined` for a purely in-memory cache. */
    private readonly persistTo;
    /** Minimum gap between writes. */
    private readonly throttleMs;
    /** Whether memory changed since the last successful write. */
    private dirty;
    /** Pending throttled flush. */
    private timer;
    /**
     * @param options - TTL, entry cap and optional persistence.
     * @param now - clock override; defaults to `Date.now`.
     */
    constructor(options?: SearchCacheOptions, now?: () => number);
    /** Number of retained entries, including ones whose TTL already elapsed. */
    get size(): number;
    /**
     * Read an entry and mark it most recently used.
     *
     * An expired entry is deleted on the spot rather than left to accumulate.
     *
     * @param key - result of {@link cacheKey}.
     * @returns a copy of the cached sources, or `undefined` on miss/expiry.
     */
    get(key: string): Source[] | undefined;
    /**
     * Store an answer, refreshing its position and evicting the coldest entry
     * when the cap is exceeded.
     *
     * @param key - result of {@link cacheKey}.
     * @param sources - the merged source list; copied before storage.
     */
    set(key: string, sources: Source[]): void;
    /**
     * Write the snapshot now, if there is anything to write.
     *
     * Writes are normally throttled and happen on a timer or at process exit;
     * this is the deterministic seam tests use, and the call a shutdown path can
     * make when it wants the newest state on disk immediately.
     *
     * @returns `true` when the file was replaced, `false` for "nothing to write"
     * or a contained filesystem failure.
     */
    flush(): boolean;
    /** Stop the exit hook and flush whatever is still pending. */
    close(): void;
    /** Drop every entry. */
    clear(): void;
    /** Mark the snapshot stale and arrange a throttled flush. */
    private touch;
    /** Arm the single pending timer, if persistence is enabled. */
    private schedule;
}
