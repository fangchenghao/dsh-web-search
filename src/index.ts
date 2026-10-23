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
import { registerDomainTool } from './domain-tool.ts';
import type { DomainToolSettings, ToolRegistryLike } from './domain-tool.ts';
import { registerSearchManyTool } from './search-many.ts';
import type { SearchManyOutcome, SearchManyRegistryLike } from './search-many.ts';
import { registerReadPageTool } from './read-page.ts';
import type { ReadPageRegistryLike } from './read-page.ts';
import { registerResearchTool } from './research.ts';
import type { ResearchFetcher, ResearchRegistryLike } from './research.ts';
import type { Source } from './types.ts';

export const name = 'dsh-web-search';

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
  /**
   * Cordis's inject-free service lookup. `tools` is read through this rather
   * than added to {@link inject} on purpose: a hard `tools` dependency would
   * stop the whole plugin (including `web_search`) from mounting in a
   * deployment that has no tool registry.
   */
  get?: (name: string) => unknown;
  /** Fallback for tests and hosts that expose the registry as a property. */
  tools?: unknown;
  /**
   * Cordis lifecycle hook. `effect` is the canonical registration; `on` is the
   * older/test fallback. Both let the tool registration and the cache release
   * their resources when the plugin is disposed.
   */
  effect?: (execute: () => (() => void) | void) => unknown;
  on?: (event: string, listener: () => void) => unknown;
}

/**
 * Read the optional tool registry without requiring it.
 * @param ctx - the plugin context.
 * @returns the registry, or `undefined` when this deployment has none.
 */
function readToolRegistry(ctx: PluginContext): ToolRegistryLike | undefined {
  let candidate: unknown;
  try {
    const found = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
    // Cordis throws on an un-injected service property, so even the fallback
    // read is guarded: a missing `tools` is a supported deployment, not an error.
    candidate = found ?? ctx.tools;
  } catch {
    return undefined;
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return typeof (candidate as { register?: unknown }).register === 'function'
    ? (candidate as ToolRegistryLike)
    : undefined;
}

/** Report a skipped tool registration without breaking plugin loading. */
function warnTool(message: string): void {
  try {
    console.warn(`[dsh-web-search-bing] ${message}`);
  } catch {
    // Logging must never be the reason a plugin fails to mount.
  }
}

/**
 * Register a cleanup with the plugin lifecycle.
 *
 * `ctx.effect(() => cleanup)` is Cordis's ownership primitive; a host that
 * predates it (or a test double) may only expose a `dispose` event, so that is
 * the fallback. Losing the hook must not break mounting.
 */
function onDispose(ctx: PluginContext, cleanup: () => void): void {
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => cleanup);
      return;
    }
    if (typeof ctx.on === 'function') ctx.on('dispose', cleanup);
  } catch (error) {
    warnTool(`dispose hook skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const cache = new SearchCache({
    // Read through on every use: a Settings edit must take effect without a
    // remount, which is the whole point of marking these fields volatile.
    ttlMs: () => resolveConfig(section, undefined).cacheTtlMs,
    maxEntries: () => resolveConfig(section, undefined).cacheEntries,
    ...(mounted.cachePersist
      ? { persist: { ...(mounted.cacheFile === undefined ? {} : { file: mounted.cacheFile }) } }
      : {}),
  });
  const health = new EngineHealth({ baseCooldownMs: mounted.baseCooldownMs, maxCooldownMs: mounted.maxCooldownMs });

  // The disk snapshot is flushed at plugin disposal; the cache also flushes on
  // its own exit hook, so an abrupt process end keeps the newest state.
  onDispose(ctx, () => cache.close());

  /**
   * Run one query through the same engine path as `web_search`.
   *
   * Reading `section` on every call is what makes a Settings commit visible
   * without a restart. The configured limit is the hard ceiling: a caller may
   * ask for fewer results, never for more.
   */
  const runQuery = async (
    query: string,
    requested: number | undefined,
    signal?: AbortSignal,
  ): Promise<SearchManyOutcome> => {
    const resolved = resolveConfig(section, undefined);
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('web search requires a non-empty query');
    }
    if (signal?.aborted === true) throw new Error('web search was cancelled');
    const asked = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : undefined;
    const limit = Math.min(asked ?? resolved.limit, resolved.limit);
    const { sources, failures } = await search(query, signal, {
      limit,
      wait: resolved.wait,
      timeRange: resolved.timeRange,
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
    return {
      sources,
      failures,
      truncated: asked !== undefined && asked > resolved.limit,
    };
  };

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    async search(request: SearchRequest, signal?: AbortSignal): Promise<ProviderResult> {
      // A Settings commit only mutates the existing references; reading the
      // section inside `runQuery` is what makes the edit apply without a restart.
      const query = request.query;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('web search requires a non-empty query');
      }
      if (signal?.aborted === true) throw new Error('web search was cancelled');
      const asked = typeof request.maxResults === 'number' && Number.isInteger(request.maxResults) && request.maxResults > 0
        ? request.maxResults
        : undefined;
      const outcome = await runQuery(query, asked, signal);
      if (outcome.sources.length === 0) {
        throw new Error(`no search engine returned results for ${JSON.stringify(query)} (${outcome.failures.join('; ')})`);
      }
      return { sources: outcome.sources, truncated: outcome.truncated };
    },
  });

  // The same tunnel the search side resolves, offered to `web_fetch`: a search
  // that finds a page on a blocked host is useless if the agent cannot read it.
  ctx.web.registerFetchProvider(
    createFetchProvider({
      id: FETCH_PROVIDER_ID,
      timeoutMs: mounted.timeoutMs,
      format: () => resolveConfig(section, undefined).fetchFormat,
      maxLength: () => resolveConfig(section, undefined).fetchMaxLength,
      renderJs: () => resolveConfig(section, undefined).renderJs,
      renderTimeoutMs: () => resolveConfig(section, undefined).renderTimeoutMs,
      ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
      ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
    }),
  );

  // Optional half: `domain_search`, `search_many` and `read_page`. Fail-safe by
  // construction — a deployment without `ctx.tools` still loads this plugin and
  // keeps `web_search`; the registration path is the host's
  // `ToolRuntime.register(definition)`.
  try {
    const tools = readToolRegistry(ctx);
    if (tools !== undefined) {
      registerDomainTool(
        tools,
        () => {
          const live = resolveConfig(section, undefined);
          const settings: DomainToolSettings = {
            sourceIds: live.domainSourceIds,
            limit: live.domainLimit,
            timeoutMs: live.domainTimeoutMs,
            ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
          };
          return settings;
        },
        { warn: warnTool },
      );

      // Batch tool: same optional-registry path, same fail-safe mounting. The
      // runner is the `web_search` path, so both tools share lookups and cache.
      const batch = registerSearchManyTool(
        tools as unknown as SearchManyRegistryLike,
        (query, limit, signal) => runQuery(query, limit, signal),
        { warn: warnTool },
      );
      if (batch !== undefined) {
        onDispose(ctx, batch.dispose);
      }

      // Resumable reading: `web_fetch` cannot continue from an offset because
      // the host request carries only `url`, but a plugin-owned tool can. It
      // reuses the same fetch ladder and the same live Settings readers.
      const paged = registerReadPageTool(
        tools as unknown as ReadPageRegistryLike,
        () => {
          const live = resolveConfig(section, undefined);
          return {
            maxLength: live.fetchMaxLength,
            format: live.fetchFormat,
            timeoutMs: live.timeoutMs,
            renderJs: live.renderJs,
            renderTimeoutMs: live.renderTimeoutMs,
            ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
            ...(live.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: live.anysearchApiKey }),
          };
        },
        { warn: warnTool },
      );
      if (paged !== undefined) {
        onDispose(ctx, paged.dispose);
      }

      // Research: search -> fetch -> cite in one call. The fetch side reuses the
      // same ladder as `web_fetch`, but through its own provider: the renderer
      // load is cached per provider, and a research pack must not replace the
      // page the host already fetched for the user.
      const researchProvider = createFetchProvider({
        id: 'http-proxy-research',
        timeoutMs: mounted.timeoutMs,
        format: 'markdown',
        maxLength: 6_000,
        renderJs: () => resolveConfig(section, undefined).renderJs,
        renderTimeoutMs: () => resolveConfig(section, undefined).renderTimeoutMs,
        ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
        ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
      });
      const researchFetch: ResearchFetcher = async (url, signal) => {
        const outcome = await researchProvider.fetch({ url }, signal);
        return {
          url: outcome.url,
          status: outcome.statusCode,
          text: outcome.body.kind === 'text' ? outcome.body.content : '',
          truncated: outcome.truncated,
        };
      };
      const research = registerResearchTool(
        tools as unknown as ResearchRegistryLike,
        (query, limit, signal) => runQuery(query, limit, signal),
        researchFetch,
        { warn: warnTool },
      );
      if (research !== undefined) {
        onDispose(ctx, research.dispose);
      }
    }
  } catch (error) {
    warnTool(`optional tool registration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
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
export type { CachePersistOptions, SearchCacheOptions } from './cache.ts';
export {
  CACHE_FILE_VERSION,
  DEFAULT_CACHE_FILE_MAX_BYTES,
  defaultCacheFile,
  resolveCacheFile,
  readCacheFile,
  serializeCache,
  writeCacheFile,
} from './cache-persist.ts';
export type { CacheFileIo, CacheWriteOptions, PersistedEntry, SerializedCache } from './cache-persist.ts';
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
export {
  MS_PER_DAY,
  TIME_RANGE_MS,
  TIME_RANGES,
  parsePublishedAt,
  extractPublishedAt,
  publishedTimestamp,
  isWithinTimeRange,
  filterByTimeRange,
} from './freshness.ts';
export { parseProxy, proxyFromEnv, resolveProxy, proxyGet } from './proxy.ts';
export {
  DEFAULT_VERTICAL_IDS,
  VERTICAL_IDS,
  VERTICALS,
  searchVerticals,
  verticalById,
  isVerticalId,
  parseGithub,
  parseNpm,
  parsePypi,
  parseArxiv,
  parseWikipedia,
  parseHn,
  parseStackExchange,
  parseCrates,
} from './verticals.ts';
export {
  DOMAIN_TOOL_NAME,
  DOMAIN_TOOL_FALLBACK_NAME,
  createDomainToolDefinition,
  registerDomainTool,
  formatDomainValue,
} from './domain-tool.ts';
export type { VerticalId, VerticalSpec, VerticalOutcome, VerticalSearchOptions } from './verticals.ts';
export type { DomainToolSettings, DomainToolValue, DomainToolDefinition, ToolRegistryLike } from './domain-tool.ts';
export {
  SEARCH_MANY_TOOL_NAME,
  SEARCH_MANY_FALLBACK_NAME,
  SEARCH_MANY_CONCURRENCY,
  SEARCH_MANY_DEFAULT_LIMIT,
  createSearchManyDefinition,
  registerSearchManyTool,
  pickSearchManyToolName,
  formatSearchManyValue,
} from './search-many.ts';
export type {
  SearchManyDefinition,
  SearchManyOutcome,
  SearchManyRegistration,
  SearchManyRegistryLike,
  SearchManyResult,
  SearchManyRunner,
  SearchManySource,
  SearchManyValue,
} from './search-many.ts';
export {
  RESEARCH_TOOL_NAME,
  RESEARCH_TOOL_FALLBACK_NAME,
  RESEARCH_DEFAULT_SOURCES,
  RESEARCH_MAX_SOURCES,
  RESEARCH_MAX_QUERIES,
  RESEARCH_EXCERPT_CHARS,
  RESEARCH_BUDGET_MS,
  createResearchDefinition,
  registerResearchTool,
  pickResearchToolName,
  formatResearchValue,
} from './research.ts';
export type {
  ResearchDefinition,
  ResearchFetcher,
  ResearchFetchedPage,
  ResearchFetchFailure,
  ResearchPage,
  ResearchRegistration,
  ResearchRegistryLike,
  ResearchSearcher,
  ResearchSearchOutcome,
  ResearchValue,
} from './research.ts';
export {
  READ_PAGE_TOOL_NAME,
  READ_PAGE_TOOL_FALLBACK_NAME,
  READ_PAGE_MIN_LENGTH,
  READ_PAGE_MAX_LENGTH,
  READ_PAGE_DEFAULT_LENGTH,
  READ_PAGE_INTERNAL_MAX_CHARS,
  READ_PAGE_CACHE_ENTRIES,
  READ_PAGE_PROVIDER_ID,
  createReadPageDefinition,
  registerReadPageTool,
  pickReadPageToolName,
  formatReadPageValue,
} from './read-page.ts';
export type {
  ReadPageDefinition,
  ReadPageOptions,
  ReadPageRegistration,
  ReadPageRegistryLike,
  ReadPageSettings,
  ReadPageValue,
} from './read-page.ts';
export type { Source, SearchOutcome, RankOptions, SearchOptions, HostSpec, Region, TimeRange, WaitPolicy } from './types.ts';
