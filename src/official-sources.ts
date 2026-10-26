/**
 * Route a versioned query to the narrow official lookup that can answer it.
 *
 * Keep this as a separate seam rather than putting network calls inside
 * `engines.search()`: the engine layer stays a pure keyless fan-out, while the
 * provider, MCP server and public benchmark can all enrich the same result with
 * the project's own release facts.
 *
 * @module @fangchenghao/dsh-web-search/official-sources
 */
import type { Source } from './types.ts';
import { fetchPostgresSupport, isPostgresVersionQuery } from './official-support.ts';
import { fetchRustRelease, isRustReleaseQuery } from './official-release.ts';
import { searchVerticals } from './verticals.ts';

/** Options shared by the official lookup implementations. */
export interface OfficialLookupOptions {
  /** Tunnel URL from the plugin's `proxy` setting, when configured. */
  proxy?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Test seam; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}

/** Scoped npm package name in an explicitly npm-scoped query. */
export function scopedNpmPackage(query: string): string | undefined {
  if (typeof query !== 'string' || !/\bnpm(?:js)?\b/iu.test(query)) return undefined;
  const match = /(?:^|\s)(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?=\s|$)/iu.exec(query.trim());
  return match?.[1];
}

/** Resolve one scoped npm package through the existing npm vertical. */
async function fetchNpmPackage(name: string, options: OfficialLookupOptions): Promise<Source | undefined> {
  try {
    const result = await searchVerticals(name, {
      ids: ['npm'],
      limit: 1,
      timeoutMs:
        typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? Math.min(options.timeoutMs, 8_000)
          : 8_000,
      ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return result.sources[0];
  } catch {
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
export function officialLookup(
  query: string,
  options: OfficialLookupOptions = {},
): Promise<Source | undefined> | undefined {
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
export function mergeOfficial(sources: readonly Source[], official: Source | undefined): Source[] {
  if (official === undefined || official.url.length === 0) return [...sources];
  const seen = new Set<string>([official.url]);
  const merged = [official];
  for (const source of sources) {
    if (source.url.length === 0 || seen.has(source.url)) continue;
    seen.add(source.url);
    merged.push(source);
  }
  return merged;
}
