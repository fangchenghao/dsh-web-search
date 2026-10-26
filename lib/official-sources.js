import { fetchPostgresSupport, isPostgresVersionQuery } from "./official-support.js";
import { fetchRustRelease, isRustReleaseQuery } from "./official-release.js";
import { searchVerticals } from "./verticals.js";
/** Scoped npm package name in an explicitly npm-scoped query. */
export function scopedNpmPackage(query) {
    if (typeof query !== 'string' || !/\bnpm(?:js)?\b/iu.test(query))
        return undefined;
    const match = /(?:^|\s)(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?=\s|$)/iu.exec(query.trim());
    return match?.[1];
}
/** Resolve one scoped npm package through the existing npm vertical. */
async function fetchNpmPackage(name, options) {
    try {
        const result = await searchVerticals(name, {
            ids: ['npm'],
            limit: 1,
            timeoutMs: typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
                ? Math.min(options.timeoutMs, 8_000)
                : 8_000,
            ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return result.sources[0];
    }
    catch {
        return undefined;
    }
}
/**
 * Start the applicable official lookup, or return `undefined` when the query
 * has no official resolver.
 *
 * Returning the promise instead of awaiting it lets a caller overlap the lookup
 * with the ordinary search fan-out.
 */
export function officialLookup(query, options = {}) {
    if (isPostgresVersionQuery(query)) {
        return fetchPostgresSupport(options);
    }
    if (isRustReleaseQuery(query)) {
        return fetchRustRelease(query, options);
    }
    const npm = scopedNpmPackage(query);
    if (npm !== undefined) {
        return fetchNpmPackage(npm, options);
    }
    return undefined;
}
/**
 * Put official rows first and remove duplicate URLs.
 *
 * The order of `official` is preserved; ordinary rows keep their relative
 * order. A source with no usable URL is discarded rather than allowed to
 * displace a real result.
 */
export function mergeOfficial(sources, official) {
    if (official === undefined || official.url.length === 0)
        return [...sources];
    const seen = new Set([official.url]);
    const merged = [official];
    for (const source of sources) {
        if (source.url.length === 0 || seen.has(source.url))
            continue;
        seen.add(source.url);
        merged.push(source);
    }
    return merged;
}
