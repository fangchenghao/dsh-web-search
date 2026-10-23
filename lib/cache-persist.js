/**
 * Optional disk persistence for the search cache.
 *
 * The cache itself stays a tiny TTL+LRU map; this module only knows how to
 * turn a snapshot of it into a file and back. Three properties matter more
 * than speed here:
 *
 * - **Never fail the plugin.** A missing, corrupt, foreign-version or
 *   unreadable file is treated as an empty cache. Every filesystem call is
 *   contained, because a cache is an optimisation and must never be the reason
 *   a plugin refuses to mount.
 * - **Never leave a half-written file.** The snapshot is written to a sibling
 *   temporary file and then `rename`d over the target, which is atomic on the
 *   same filesystem. A failure before the rename leaves the previous file
 *   intact and removes the temporary one.
 * - **Never grow without bound.** The serialised snapshot is trimmed in LRU
 *   order (oldest first) until it fits the byte budget.
 *
 * Only the search-result summary (`url`, `title`, `snippet`, `publishedAt`) is
 * stored. Page bodies are never touched by this cache, and any extra property a
 * caller attached to a {@link Source} is dropped at the serialisation boundary.
 *
 * @module @fangchenghao/dsh-web-search/cache-persist
 */
import { readFileSync, renameSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/** Version of the on-disk document; a different version is ignored wholesale. */
export const CACHE_FILE_VERSION = 1;
/** Default byte budget for the snapshot: 4 MiB. */
export const DEFAULT_CACHE_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** The real filesystem, exported so tests can override one operation. */
export const nodeCacheFileIo = {
    read(path) {
        try {
            return readFileSync(path, 'utf8');
        }
        catch {
            // Missing file, permission error, directory: all mean "empty cache".
            return undefined;
        }
    },
    write(path, data) {
        // The file only holds public search summaries, but 0600 keeps a shared
        // machine from reading another user's queries.
        writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 });
    },
    rename(from, to) {
        renameSync(from, to);
    },
    mkdir(path) {
        mkdirSync(path, { recursive: true });
    },
    remove(path) {
        rmSync(path, { force: true });
    },
};
/** Where a snapshot is written when the config names no path. */
export function defaultCacheFile() {
    return join(homedir(), '.dsh', 'cache', 'dsh-web-search', 'cache.json');
}
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
export function resolveCacheFile(value) {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0)
        return defaultCacheFile();
    const expanded = trimmed === '~'
        ? homedir()
        : /^~[\\/]/u.test(trimmed)
            ? join(homedir(), trimmed.slice(2))
            : trimmed;
    return resolve(expanded);
}
/** True for a value usable as a plain record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Read one persisted source, keeping only the four summary fields. */
function readSource(raw) {
    if (!isRecord(raw))
        return undefined;
    const url = raw['url'];
    if (typeof url !== 'string' || url.trim().length === 0)
        return undefined;
    const source = { url };
    if (typeof raw['title'] === 'string' && raw['title'].length > 0)
        source.title = raw['title'];
    if (typeof raw['snippet'] === 'string' && raw['snippet'].length > 0)
        source.snippet = raw['snippet'];
    if (typeof raw['publishedAt'] === 'string' && raw['publishedAt'].length > 0) {
        source.publishedAt = raw['publishedAt'];
    }
    return source;
}
/** Write one source as a summary-only record. */
function storedSource(source) {
    const stored = { url: source.url };
    if (source.title !== undefined && source.title.length > 0)
        stored['title'] = source.title;
    if (source.snippet !== undefined && source.snippet.length > 0)
        stored['snippet'] = source.snippet;
    if (source.publishedAt !== undefined && source.publishedAt.length > 0) {
        stored['publishedAt'] = source.publishedAt;
    }
    return stored;
}
/** Read one persisted entry, rejecting anything malformed or already expired. */
function readEntry(raw, now) {
    if (!isRecord(raw))
        return undefined;
    const key = raw['key'];
    const expiresAt = raw['expiresAt'];
    const rawSources = raw['sources'];
    if (typeof key !== 'string' || key.length === 0)
        return undefined;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now)
        return undefined;
    if (!Array.isArray(rawSources))
        return undefined;
    const sources = [];
    for (const item of rawSources) {
        const source = readSource(item);
        if (source !== undefined)
            sources.push(source);
    }
    // An entry with no usable result is not worth a slot in the file.
    if (sources.length === 0)
        return undefined;
    return { key, expiresAt, sources };
}
/** Clamp the byte budget to a usable positive integer. */
function normaliseMaxBytes(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : DEFAULT_CACHE_FILE_MAX_BYTES;
}
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
export function readCacheFile(file, now, maxEntries, io) {
    try {
        const text = (io ?? nodeCacheFileIo).read(file);
        if (text === undefined)
            return [];
        const parsed = JSON.parse(text);
        if (!isRecord(parsed))
            return [];
        if (parsed['version'] !== CACHE_FILE_VERSION)
            return [];
        const rawEntries = parsed['entries'];
        if (!Array.isArray(rawEntries))
            return [];
        const entries = [];
        for (const raw of rawEntries) {
            const entry = readEntry(raw, now);
            if (entry !== undefined)
                entries.push(entry);
        }
        const cap = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : entries.length;
        return entries.length > cap ? entries.slice(entries.length - cap) : entries;
    }
    catch {
        // Corrupt JSON, a foreign document, a getter that throws: empty cache.
        return [];
    }
}
/**
 * Serialise entries, evicting the oldest until the document fits the budget.
 *
 * @param entries - entries in LRU order (oldest first).
 * @param now - timestamp recorded as `savedAt`.
 * @param maxBytes - byte budget; defaults to 4 MiB.
 * @returns the document and how many entries it carries.
 */
export function serializeCache(entries, now, maxBytes) {
    const budget = normaliseMaxBytes(maxBytes);
    const kept = entries.map((entry) => ({
        key: entry.key,
        expiresAt: entry.expiresAt,
        sources: entry.sources.map(storedSource),
    }));
    const build = () => JSON.stringify({
        version: CACHE_FILE_VERSION,
        savedAt: now,
        entries: kept,
    });
    let data = build();
    while (kept.length > 0 && Buffer.byteLength(data, 'utf8') > budget) {
        kept.shift();
        data = build();
    }
    return { data, entries: kept.length, bytes: Buffer.byteLength(data, 'utf8') };
}
/** Distinguishes temporary files of concurrent writers in this process. */
let tempCounter = 0;
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
export function writeCacheFile(file, entries, now, options = {}) {
    const io = options.io ?? nodeCacheFileIo;
    const { data } = serializeCache(entries, now, options.maxBytes);
    tempCounter += 1;
    const temp = `${file}.${process.pid}.${tempCounter}.tmp`;
    try {
        io.mkdir(dirname(file));
        io.write(temp, data);
        io.rename(temp, file);
        return true;
    }
    catch {
        try {
            io.remove(temp);
        }
        catch {
            // Cleanup is best effort; the previous snapshot is still intact.
        }
        return false;
    }
}
