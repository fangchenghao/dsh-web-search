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
import { readCacheFile, resolveCacheFile, writeCacheFile } from './cache-persist.ts';
import type { CacheFileIo, PersistedEntry } from './cache-persist.ts';

/** Default entry lifetime: ten minutes. */
const DEFAULT_TTL_MS = 600_000;

/** Default number of retained entries. */
const DEFAULT_MAX_ENTRIES = 100;

/** Default minimum gap between disk writes. */
const DEFAULT_PERSIST_THROTTLE_MS = 2_000;

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
export function cacheKey(parts: CacheKeyParts): string {
  const query = parts.query.trim().toLowerCase().replace(/\s+/gu, ' ');
  const engines = [...parts.engines].sort().join('+');
  const window = parts.timeRange === undefined || parts.timeRange === 'off' ? '' : `${parts.timeRange}|`;
  return `${parts.lead}|${parts.wait}|${parts.limit}|${engines}|${window}${query}`;
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
  /** Live TTL reader: settings may change without a remount. */
  private readonly ttlOf: () => number;
  /** Maximum retained entries; the oldest read is evicted first. */
  /** Live entry-cap reader: settings may change without a remount. */
  private readonly maxOf: () => number;
  /** Injected clock, so tests never wait on real time. */
  private readonly now: () => number;
  /** Insertion order doubles as LRU order: the first key is the coldest. */
  private readonly entries = new Map<string, CacheEntry>();
  /** Snapshot destination, or `undefined` for a purely in-memory cache. */
  private readonly persistTo: { file: string; maxBytes?: number; io?: CacheFileIo } | undefined;
  /** Minimum gap between writes. */
  private readonly throttleMs: number;
  /** Whether memory changed since the last successful write. */
  private dirty = false;
  /** Pending throttled flush. */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param options - TTL, entry cap and optional persistence.
   * @param now - clock override; defaults to `Date.now`.
   */
  constructor(options: SearchCacheOptions = {}, now?: () => number) {
    const ttlOption = options.ttlMs;
    const maxOption = options.maxEntries;
    this.ttlOf = () =>
      normaliseDuration(typeof ttlOption === 'function' ? ttlOption() : ttlOption, DEFAULT_TTL_MS);
    this.maxOf = () =>
      normaliseCount(typeof maxOption === 'function' ? maxOption() : maxOption, DEFAULT_MAX_ENTRIES);
    this.now = now ?? Date.now;
    this.throttleMs = normaliseDuration(options.persist?.throttleMs, DEFAULT_PERSIST_THROTTLE_MS);

    const persist = options.persist;
    if (persist !== undefined && this.ttlOf() > 0 && this.maxOf() > 0) {
      const file = resolveCacheFile(persist.file);
      // Startup restore is synchronous and fully contained: an unreadable or
      // malformed snapshot simply yields an empty cache.
      const loaded = readCacheFile(file, this.now(), this.maxOf(), persist.io);
      for (const entry of loaded) {
        this.entries.set(entry.key, { sources: entry.sources, expiresAt: entry.expiresAt });
      }
      this.persistTo = {
        file,
        ...(persist.maxBytes === undefined ? {} : { maxBytes: persist.maxBytes }),
        ...(persist.io === undefined ? {} : { io: persist.io }),
      };
      liveCaches.add(this);
      installExitHook();
    }
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
    if (this.ttlOf() === 0 || this.maxOf() === 0) return undefined;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      this.touch();
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
    const ttlMs = this.ttlOf();
    const maxEntries = this.maxOf();
    if (ttlMs === 0 || maxEntries === 0) return;
    this.entries.delete(key);
    this.entries.set(key, {
      sources: cloneSources(sources),
      expiresAt: this.now() + ttlMs,
    });
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.touch();
  }

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
  flush(): boolean {
    if (this.persistTo === undefined) return false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return false;
    const entries: PersistedEntry[] = [];
    for (const [key, entry] of this.entries) {
      entries.push({ key, expiresAt: entry.expiresAt, sources: cloneSources(entry.sources) });
    }
    const written = writeCacheFile(this.persistTo.file, entries, this.now(), {
      ...(this.persistTo.maxBytes === undefined ? {} : { maxBytes: this.persistTo.maxBytes }),
      ...(this.persistTo.io === undefined ? {} : { io: this.persistTo.io }),
    });
    this.dirty = !written;
    if (!written) this.schedule();
    return written;
  }

  /** Stop the exit hook and flush whatever is still pending. */
  close(): void {
    this.flush();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    liveCaches.delete(this);
    if (liveCaches.size === 0) removeExitHook();
  }

  /** Drop every entry. */
  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.touch();
  }

  /** Mark the snapshot stale and arrange a throttled flush. */
  private touch(): void {
    if (this.persistTo === undefined) return;
    this.dirty = true;
    this.schedule();
  }

  /** Arm the single pending timer, if persistence is enabled. */
  private schedule(): void {
    if (this.persistTo === undefined || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.throttleMs);
    // A pending cache flush must not keep a one-shot CLI process alive; the
    // exit hook still writes it synchronously.
    this.timer.unref();
  }
}

/** Caches that still need an exit-time flush. */
const liveCaches = new Set<SearchCache>();

/** Set once the process-level hook is installed. */
let exitHookInstalled = false;

/** Flush every live cache; used only during process exit. */
function flushLiveCaches(): void {
  for (const cache of liveCaches) cache.flush();
}

/** Install one process-wide exit hook, lazily. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', flushLiveCaches);
}

/** Remove the hook when no persisted cache remains. */
function removeExitHook(): void {
  if (!exitHookInstalled) return;
  process.removeListener('exit', flushLiveCaches);
  exitHookInstalled = false;
}
