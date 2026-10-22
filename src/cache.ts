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
import type { CacheOptions, Source } from './types.ts';

/** Default entry lifetime: ten minutes. */
const DEFAULT_TTL_MS = 600_000;

/** Default number of retained entries. */
const DEFAULT_MAX_ENTRIES = 100;

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
}

/**
 * Build the cache key for one search request.
 *
 * The query is trimmed, lowercased and has internal whitespace collapsed, so
 * `'  PostgreSQL   Replication '` and `'postgresql replication'` share an
 * entry. Engine order never matters because the ids are sorted; every other
 * field is positional, so differing `limit`, `wait`, `lead` or engine set
 * yields a different key. The query is last so a query containing the field
 * separator cannot collide with a different request's prefix.
 *
 * @param parts - the logical request.
 * @returns a deterministic, comparison-safe cache key.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const query = parts.query.trim().toLowerCase().replace(/\s+/gu, ' ');
  const engines = [...parts.engines].sort().join('+');
  return `${parts.lead}|${parts.wait}|${parts.limit}|${engines}|${query}`;
}

/** One cached answer plus the moment it stops being usable. */
interface CacheEntry {
  /** Defensive copy of the sources, never mutated in place. */
  sources: Source[];
  /** Absolute expiry timestamp from the injected clock. */
  expiresAt: number;
}

/**
 * Copy the array and each source.
 *
 * A shallow array copy alone would still let a caller mutate a cached `Source`
 * object, so every hand-off gets fresh objects. Result lists are tiny, which
 * makes the safety worth the allocation.
 */
function cloneSources(sources: Source[]): Source[] {
  return sources.map((source) => ({ ...source }));
}

/** Accept only a usable non-negative duration; fall back on the default. */
function normaliseDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** Accept only a usable non-negative entry cap; fall back on the default. */
function normaliseCount(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

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
export class SearchCache {
  /** Entry lifetime in milliseconds; `0` disables the cache completely. */
  private readonly ttlMs: number;
  /** Maximum retained entries; the oldest read is evicted first. */
  private readonly maxEntries: number;
  /** Injected clock, so tests never wait on real time. */
  private readonly now: () => number;
  /** Insertion order doubles as LRU order: the first key is the coldest. */
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * @param options - TTL and entry cap, both optional.
   * @param now - clock override; defaults to `Date.now`.
   */
  constructor(options: CacheOptions = {}, now?: () => number) {
    this.ttlMs = normaliseDuration(options.ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = normaliseCount(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.now = now ?? Date.now;
  }

  /** Number of retained entries, including ones whose TTL already elapsed. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Read an entry and mark it most recently used.
   *
   * An expired entry is deleted on the spot rather than left to accumulate.
   *
   * @param key - result of {@link cacheKey}.
   * @returns a copy of the cached sources, or `undefined` on miss/expiry.
   */
  get(key: string): Source[] | undefined {
    if (this.ttlMs === 0) return undefined;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move the entry to the young end of the map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneSources(entry.sources);
  }

  /**
   * Store an answer, refreshing its position and evicting the coldest entry
   * when the cap is exceeded.
   *
   * @param key - result of {@link cacheKey}.
   * @param sources - the merged source list; copied before storage.
   */
  set(key: string, sources: Source[]): void {
    if (this.ttlMs === 0 || this.maxEntries === 0) return;
    this.entries.delete(key);
    this.entries.set(key, {
      sources: cloneSources(sources),
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }
}
