/**
 * `dsh-web-search-bing` — a key-free search provider for the `ctx.web` seam.
 *
 * Why this exists: the shipped DeepSeek search provider needs a credential
 * because it delegates searching to DeepSeek's server-side `web_search` tool,
 * and that tool only runs on a DeepSeek-hosted Messages endpoint. This provider
 * does the searching itself — an anonymous JSON API first, public result pages
 * as the fallback — so `web_search` works with no provider key at all.
 *
 * @module dsh-web-search-bing
 */
import { Config, resolveConfig } from './config.ts';
import type { ConfigInput, PluginConfig } from './config.ts';
import { search } from './engines.ts';
import { SearchCache } from './cache.ts';
import { EngineHealth } from './health.ts';
import { createFetchProvider } from './fetch.ts';
import type { FetchProvider } from './fetch.ts';
import type { Source } from './types.ts';

export const name = 'dsh-web-search-bing';

/** The `ctx.web` service this plugin registers a search provider with. */
export const inject = ['web'];

/** Provider id referenced by `web.searchProvider`. */
export const PROVIDER_ID = 'bing';
/** Fetch provider id, named in the `web` service config as `fetchProvider`. */
export const FETCH_PROVIDER_ID = 'http-proxy';

/** The request shape the `web` seam hands a search provider. */
export interface SearchRequest {
  query?: unknown;
  maxResults?: unknown;
}

/** One source, as the seam expects it back. */
export interface ProviderResult {
  sources: Source[];
  truncated?: boolean;
}

/** The provider contract of the `ctx.web` seam. */
export interface SearchProvider {
  id: string;
  available: () => boolean;
  search: (request: SearchRequest, signal?: AbortSignal) => Promise<ProviderResult>;
}

/** The slice of the plugin context this plugin uses. */
export interface PluginContext {
  web: {
    registerSearchProvider: (provider: SearchProvider) => void;
    registerFetchProvider: (provider: FetchProvider) => void;
  };
}

/** Configuration as the loader hands it over, already schema-validated. */
export type ApplyConfig = PluginConfig;

/**
 * Register the search provider.
 * @param ctx - plugin context carrying the `web` service.
 * @param config - the validated configuration section: volatile fields arrive as
 * live references the Loader updates in place, so the section is read again for
 * every search instead of being frozen at mount time.
 */
export function apply(ctx: PluginContext, config: unknown = {}): void {
  const section = (config ?? {}) as ConfigInput;
  const mounted = resolveConfig(section, undefined);
  // One cache and one health tracker per mounted plugin, so a config change
  // through a restart starts from a clean slate instead of inheriting the
  // cooldowns of a previous instance.
  const cache = new SearchCache({ ttlMs: mounted.cacheTtlMs, maxEntries: mounted.cacheEntries });
  const health = new EngineHealth({ baseCooldownMs: mounted.baseCooldownMs, maxCooldownMs: mounted.maxCooldownMs });

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    async search(request: SearchRequest, signal?: AbortSignal): Promise<ProviderResult> {
      // A Settings commit only mutates the existing references; reading the
      // section here is what makes the edit apply without a restart.
      const resolved = resolveConfig(section, undefined);
      const query = request.query;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('web search requires a non-empty query');
      }
      if (signal?.aborted === true) throw new Error('web search was cancelled');
      const asked = typeof request.maxResults === 'number' && Number.isInteger(request.maxResults) && request.maxResults > 0
        ? request.maxResults
        : undefined;
      const limit = Math.min(asked ?? resolved.limit, resolved.limit);
      const { sources, failures } = await search(query, signal, {
        limit,
        wait: resolved.wait,
        timeoutMs: resolved.timeoutMs,
        ...(resolved.proxy === undefined ? {} : { proxy: resolved.proxy }),
        ...(resolved.hostIds === undefined ? {} : { hostIds: resolved.hostIds }),
        rank: resolved.rank,
        ...(resolved.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: resolved.anysearchApiKey }),
        ...(resolved.anysearchDomain.length === 0 ? {} : { anysearchDomain: resolved.anysearchDomain }),
        cache,
        health,
        ...(signal === undefined ? {} : { signal }),
      });
      if (sources.length === 0) {
        throw new Error(`no search engine returned results for ${JSON.stringify(query)} (${failures.join('; ')})`);
      }
      if (sources.length <= limit) return { sources, truncated: false };
      return { sources: sources.slice(0, limit), truncated: true };
    },
  });

  // The same tunnel the search side resolves, offered to `web_fetch`: a search
  // that finds a page on a blocked host is useless if the agent cannot read it.
  ctx.web.registerFetchProvider(
    createFetchProvider({
      id: FETCH_PROVIDER_ID,
      timeoutMs: mounted.timeoutMs,
      ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
      ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
    }),
  );
}

export { Config, resolveConfig } from './config.ts';

/**
 * The plugin as the Loader hands it to the Host.
 *
 * `dsh-settings` reads the config schema from `entry.fiber.runtime.Config`, and
 * for a function-style plugin the runtime *is* that function — a named export is
 * not reachable from it. Without this attachment the settings document drops the
 * row before it ever looks at the schema, which is why the page stayed empty with
 * a perfectly valid Config. Object-style plugins carry the schema as
 * `static Config`; this is the function-style equivalent.
 */
// `inject` must travel with the runtime object too: Cordis reads the service
// dependencies from the plugin it mounts, so an object without it rejects every
// service the plugin touches ("cannot get property "web" without inject").
export default Object.assign(apply, { Config, inject });
export { HOSTS, search } from './engines.ts';
export { SearchCache, cacheKey } from './cache.ts';
export { EngineHealth } from './health.ts';
export { SearchError, parseRetryAfter } from './errors.ts';
export {
  resolveHref,
  parseDdgHtml,
  parseDdgLite,
  parseBing,
  parseSo,
  parseAnySearch,
  echoesQuery,
} from './parsers.ts';
export { fuse, interleave, dedupe, mergeRegions } from './rank.ts';
export { parseProxy, proxyFromEnv, resolveProxy, proxyGet } from './proxy.ts';
export type { Source, SearchOutcome, RankOptions, SearchOptions, HostSpec, Region, WaitPolicy } from './types.ts';
