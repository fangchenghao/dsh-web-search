import type { Source } from './types.ts';
/** Version of the on-disk document; a different version is ignored wholesale. */
export declare const CACHE_FILE_VERSION = 1;
/** Default byte budget for the snapshot: 4 MiB. */
export declare const DEFAULT_CACHE_FILE_MAX_BYTES: number;
/** One cache entry as it travels to disk. */
export interface PersistedEntry {
    /** Deterministic key produced by `cacheKey`. */
    key: string;
    /** Absolute expiry timestamp; expired entries are dropped on load. */
    expiresAt: number;
    /** The search-result summary, never a page body. */
    sources: Source[];
}
/** Filesystem seam: every call may throw, and the caller contains it. */
export interface CacheFileIo {
    /** Read the file as UTF-8, or return `undefined` when it is absent. */
    read: (path: string) => string | undefined;
    /** Write a new file (the temporary one). */
    write: (path: string, data: string) => void;
    /** Atomically replace the target with the temporary file. */
    rename: (from: string, to: string) => void;
    /** Create the containing directory, including parents. */
    mkdir: (path: string) => void;
    /** Best-effort removal of the temporary file. */
    remove: (path: string) => void;
}
/** The real filesystem, exported so tests can override one operation. */
export declare const nodeCacheFileIo: CacheFileIo;
/** Where a snapshot is written when the config names no path. */
export declare function defaultCacheFile(): string;
/**
 * Expand a configured cache path.
 *
 * An empty value selects {@link defaultCacheFile}; a leading `~` expands to the
 * home directory so the documented default can be written verbatim in Settings.
 * Relative paths are resolved against the process working directory.
 *
 * @param value - the `cacheFile` setting, possibly empty.
 * @returns an absolute file path.
 */
export declare function resolveCacheFile(value?: string): string;
/**
 * Load the snapshot from disk.
 *
 * Every failure mode collapses to an empty list: absent file, unreadable path,
 * malformed JSON, a different `version`, and individually invalid entries. An
 * expired entry is dropped here rather than retained until its next read.
 *
 * @param file - absolute path to the snapshot.
 * @param now - current time from the cache's injected clock.
 * @param maxEntries - entry cap; the oldest surplus entries are discarded.
 * @param io - filesystem seam, defaulting to the real one.
 * @returns usable entries in stored (oldest to newest) order.
 */
export declare function readCacheFile(file: string, now: number, maxEntries: number, io?: CacheFileIo): PersistedEntry[];
/** One serialised snapshot plus what survived the byte cap. */
export interface SerializedCache {
    /** UTF-8 JSON document, ready for the atomic write. */
    data: string;
    /** Number of entries left after LRU eviction. */
    entries: number;
    /** Size of {@link data} in bytes. */
    bytes: number;
}
/**
 * Serialise entries, evicting the oldest until the document fits the budget.
 *
 * @param entries - entries in LRU order (oldest first).
 * @param now - timestamp recorded as `savedAt`.
 * @param maxBytes - byte budget; defaults to 4 MiB.
 * @returns the document and how many entries it carries.
 */
export declare function serializeCache(entries: readonly PersistedEntry[], now: number, maxBytes?: number): SerializedCache;
/** Write options, kept separate so the cache owns the policy, not the path. */
export interface CacheWriteOptions {
    /** Byte budget; defaults to 4 MiB. */
    maxBytes?: number;
    /** Filesystem seam for tests. */
    io?: CacheFileIo;
}
/**
 * Atomically replace the snapshot.
 *
 * The temporary file lives beside the target so the `rename` stays on one
 * filesystem. When anything fails (directory not writable, rename rejected),
 * the previous document is untouched, the temporary file is removed, and the
 * call returns `false` instead of throwing.
 *
 * @param file - absolute target path.
 * @param entries - entries in LRU order (oldest first).
 * @param now - timestamp recorded as `savedAt`.
 * @param options - byte budget and filesystem seam.
 * @returns `true` when the target now holds this snapshot.
 */
export declare function writeCacheFile(file: string, entries: readonly PersistedEntry[], now: number, options?: CacheWriteOptions): boolean;
