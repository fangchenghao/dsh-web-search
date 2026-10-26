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
import { ResearchBodyCache, registerCacheSearchTool } from './research-cache.ts';
import { alternateOfficialUrl } from './mirrors.ts';
import { searchPlatforms } from './platforms.ts';
import { registerPlatformTool } from './platform-tool.ts';
import { registerEngineTestTool } from './engine-test.ts';
import type { EngineTestRegistryLike } from './engine-test.ts';
import { registerEngineTestBridge, registerUpdateBridge } from './bridge.ts';
import { registerAdvancedSearchTool, undatedWindowNote } from './advanced-search.ts';
import type { AdvancedSearchOutcome, AdvancedSearchRegistryLike, AdvancedSearchRunner } from './advanced-search.ts';
import { searchVerticals } from './verticals.ts';
import { routePackageQuery } from './query-router.ts';
import { mergeOfficial, officialLookup } from './official-sources.ts';
import {
  chromeFeedNote,
  chromeWindow,
  fetchChromeReleases,
  filterChromeChannel,
  hasNonStableChromePosts,
  isChromeSecurityQuery,
} from './official-feed.ts';
import { registerSearchPrompt } from './system-prompt.ts';
import { registerUnifiedTool } from './tool-suite.ts';
import type { SubToolDefinition, UnifiedToolRegistryLike } from './tool-suite.ts';
import type { InjectableHost } from './inject.ts';
import type { ResearchFetcher, ResearchRegistryLike } from './research.ts';
import type { CacheSearchRegistryLike } from './research-cache.ts';
import type { PlatformRunner, PlatformToolRegistryLike } from './platform-tool.ts';
import type { Source, TimeRange } from './types.ts';

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
  /** Optional Cordis injection hook; used for the Settings bridge and prompt. */
  inject?: NonNullable<InjectableHost['inject']>;
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
    overrides: { timeRange?: TimeRange } = {},
  ): Promise<SearchManyOutcome> => {
    const resolved = resolveConfig(section, undefined);
    const timeRange = overrides.timeRange ?? resolved.timeRange;
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('web search requires a non-empty query');
    }
    if (signal?.aborted === true) throw new Error('web search was cancelled');
    const asked = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : undefined;
    const limit = Math.min(asked ?? resolved.limit, resolved.limit);
    const outcome = await search(query, signal, {
      limit,
      wait: resolved.wait,
      timeRange,
      blockedDomains: resolved.blockedDomains,
      safeSearch: resolved.safeSearch,
      fallbackOn: resolved.fallbackOn,
      timeoutMs: resolved.timeoutMs,
      ...(resolved.proxy === undefined ? {} : { proxy: resolved.proxy }),
      ...(resolved.hostIds === undefined ? {} : { hostIds: resolved.hostIds }),
      rank: resolved.rank,
      ...(resolved.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: resolved.anysearchApiKey }),
      ...(resolved.anysearchDomain.length === 0 ? {} : { anysearchDomain: resolved.anysearchDomain }),
      ...(resolved.firecrawlApiKey.length === 0 ? {} : { firecrawlApiKey: resolved.firecrawlApiKey }),
      cache,
      health,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      sources: outcome.sources,
      failures: outcome.failures,
      failureDetails: outcome.failureDetails,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      truncated: asked !== undefined && asked > resolved.limit,
    };
  };

  /**
   * Official Chrome Releases path for a windowed security/release query.
   *
   * General search snippets for this blog often lose the post date; the feed
   * carries it. Returning an undefined value here means "not this path", so the
   * ordinary engine search remains the fallback when the feed is unavailable.
   */
  const runChromeOfficial = async (
    query: string,
    requested: number | undefined,
    effective: TimeRange,
    signal?: AbortSignal,
  ): Promise<AdvancedSearchOutcome | undefined> => {
    if (effective === 'off' || !isChromeSecurityQuery(query)) return undefined;
    const live = resolveConfig(section, undefined);
    try {
      const posts = await fetchChromeReleases({
        timeoutMs: Math.min(live.domainTimeoutMs, 8_000),
        ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
        ...(signal === undefined ? {} : { signal }),
      });
      const windowed = chromeWindow(posts, effective);
      const stableOnly = /\bstable\b|稳定版|稳定渠道/i.test(query);
      const selected = filterChromeChannel(windowed, query);
      // A stable-only feed with no stable post should not mask the ordinary
      // engine path; fall back rather than returning an empty evidence pack.
      if (selected.length === 0) return undefined;
      const budget = Math.min(requested ?? live.limit, live.limit);
      const note = chromeFeedNote(selected, effective, query);
      const channelNote = stableOnly && hasNonStableChromePosts(windowed, query)
        ? ` Stable-channel filter applied: ${windowed.length - selected.length} Beta/Dev/non-stable post(s) omitted.`
        : '';
      return {
        sources: selected.slice(0, budget),
        failures: [],
        note: `${note}${channelNote}`,
        truncated: selected.length > budget,
        timeRange: effective,
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Run one per-call windowed search. `undefined` keeps the deployment setting;
   * the tool's validation only lets the five known windows through.
   */
  const runAdvancedSearch: AdvancedSearchRunner = async (query, requested, timeRange, signal) => {
    const resolved = resolveConfig(section, undefined);
    const effective = timeRange ?? resolved.timeRange;
    const official = await runChromeOfficial(query, requested, effective, signal);
    if (official !== undefined) return official;
    const outcome = await runQuery(query, requested, signal, { timeRange: effective });
    const windowNote = undatedWindowNote(outcome.sources, effective);
    const note = [outcome.note, windowNote]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');
    return {
      ...outcome,
      ...(note.length > 0 ? { note } : {}),
      timeRange: effective,
    };
  };

  /**
   * Run one engine for diagnostics. Deliberately bypasses the cache and the
   * health tracker: a test must report the engine's current behaviour, not the
   * state left by an earlier failure.
   */
  const runEngineTest = async (engine: string, query: string, signal?: AbortSignal) => {
    const live = resolveConfig(section, undefined);
    return search(query, signal, {
      limit: 1,
      wait: 'all',
      timeoutMs: Math.min(live.timeoutMs, 8_000),
      safeSearch: live.safeSearch,
      ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
      ...(live.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: live.anysearchApiKey }),
      ...(live.anysearchDomain.length === 0 ? {} : { anysearchDomain: live.anysearchDomain }),
      ...(live.firecrawlApiKey.length === 0 ? {} : { firecrawlApiKey: live.firecrawlApiKey }),
      hostIds: [engine],
    });
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
      const live = resolveConfig(section, undefined);
      // Start an official lookup before the fan-out and await it afterwards.
      // It then costs max(search, lookup), not search + lookup, which matters
      // for a version query where the first result should be authoritative but
      // the ordinary engines still need to fill the remaining rows.
      const official = officialLookup(query, {
        timeoutMs: Math.min(live.timeoutMs, 2_500),
        ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
        ...(signal === undefined ? {} : { signal }),
      });
      const outcome = await runQuery(query, asked, signal);
      // A version/EOL question about PostgreSQL or Rust is better answered by
      // the project's own release facts than by whatever an engine ranks first.
      // The lookup is query-scoped and failure-tolerant; it never replaces the
      // ordinary rows when the page is unavailable.
      const sources = mergeOfficial(outcome.sources, await official);
      if (sources.length === 0) {
        throw new Error(`no search engine returned results for ${JSON.stringify(query)} (${outcome.failures.join('; ')})`);
      }
      const cap = Math.min(asked ?? live.limit, live.limit);
      return { sources: sources.slice(0, cap), truncated: outcome.truncated || sources.length > cap };
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

  // Optional half: the eight capabilities exposed through `web_tools` (or the
  // legacy names). Fail-safe by
  // construction — a deployment without `ctx.tools` still loads this plugin and
  // keeps `web_search`; the registration path is the host's
  // `ToolRuntime.register(definition)`.
  try {
    const tools = readToolRegistry(ctx);
    if (tools !== undefined) {
      // In unified mode the eight definitions are built against a capture
      // registry, then exposed through one `web_tools` entry. Legacy mode keeps
      // the old names and their independent lifecycle.
      const captured: SubToolDefinition[] = [];
      const capture = {
        get: () => undefined,
        register: (definition: unknown) => {
          captured.push(definition as SubToolDefinition);
          return () => undefined;
        },
      };
      const toolTarget = mounted.toolSurface === 'legacy'
        ? tools
        : (capture as unknown as typeof tools);
      /**
       * `search_many` is for general web queries, but an explicitly
       * registry-scoped package query is much better answered by the existing
       * domain source. It falls back to the ordinary path when that source
       * returns nothing, so a registry outage cannot empty the batch.
       */
      const runBatchQuery = async (
        query: string,
        limit: number,
        signal?: AbortSignal,
      ): Promise<SearchManyOutcome> => {
        const route = routePackageQuery(query);
        if (route !== undefined) {
          const live = resolveConfig(section, undefined);
          try {
            const names = route.names.length > 0 ? route.names : [route.query];
            const perName = Math.max(1, Math.ceil(limit / names.length));
            const verticals = await Promise.all(
              names.map((name) => searchVerticals(name, {
                ids: [route.id],
                limit: perName,
                timeoutMs: live.domainTimeoutMs,
                ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                ...(signal === undefined ? {} : { signal }),
              })),
            );
            const seen = new Set<string>();
            // Keep the exact first hit for every named package ahead of related
            // suggestions: a two-package comparison should show both packages
            // before serde-saphyr or react-router-style neighbours.
            const ordered = [
              ...verticals.flatMap((vertical) => vertical.sources.slice(0, 1)),
              ...verticals.flatMap((vertical) => vertical.sources.slice(1)),
            ];
            const sources = ordered
              .filter((source) => {
                if (seen.has(source.url)) return false;
                seen.add(source.url);
                return true;
              })
              .slice(0, limit);
            if (sources.length > 0) {
              return {
                sources,
                failures: verticals.flatMap((vertical) => vertical.failures),
                note: `Package query routed to ${route.label} for ${names.join(', ')}; registry rows have stable package URLs and versions.`,
                truncated: sources.length < verticals.reduce((sum, vertical) => sum + vertical.sources.length, 0),
              };
            }
          } catch {
            // The ordinary web path below is the fallback for a registry miss.
          }
        }
        return runQuery(query, limit, signal);
      };

      registerDomainTool(
        toolTarget,
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

      // Batch tool: same optional-registry path, same fail-safe mounting. Most
      // queries use the `web_search` path; an explicit package-registry query
      // can use the existing domain source instead.
      const batch = registerSearchManyTool(
        toolTarget as unknown as SearchManyRegistryLike,
        runBatchQuery,
        { warn: warnTool },
      );
      if (batch !== undefined) {
        onDispose(ctx, batch.dispose);
      }

      // Per-call date window: the only tool that can override the global
      // `timeRange` without changing the user's Settings.
      const advanced = registerAdvancedSearchTool(
        toolTarget as unknown as AdvancedSearchRegistryLike,
        runAdvancedSearch,
        { warn: warnTool },
      );
      if (advanced !== undefined) {
        onDispose(ctx, advanced.dispose);
      }

      // Resumable reading: `web_fetch` cannot continue from an offset because
      // the host request carries only `url`, but a plugin-owned tool can. It
      // reuses the same fetch ladder and the same live Settings readers.
      const paged = registerReadPageTool(
        toolTarget as unknown as ReadPageRegistryLike,
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
        // The evidence pack keeps ~6 K characters, but the second retrieval
        // (passage selection and cache_search) must be able to find a fact
        // deep in the page. 200 K is the provider ceiling, not the model budget.
        maxLength: 200_000,
        renderJs: () => resolveConfig(section, undefined).renderJs,
        renderTimeoutMs: () => resolveConfig(section, undefined).renderTimeoutMs,
        ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
        ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
      });
      const researchFetch: ResearchFetcher = async (url, signal) => {
        const read = async (target: string) => {
          const outcome = await researchProvider.fetch({ url: target }, signal);
          return {
            url: outcome.url,
            status: outcome.statusCode,
            text: outcome.body.kind === 'text' ? outcome.body.content : '',
            truncated: outcome.truncated,
          };
        };
        try {
          const first = await read(url);
          if (first.status < 400 && first.text.trim().length > 0) return first;
          const mirror = alternateOfficialUrl(url);
          // The canonical standards page rejected the reader (or returned a
          // shell); try the same organisation's public build once. A failure
          // here falls back to the original outcome so the caller sees the real
          // reason rather than a mirror-specific one.
          if (mirror !== undefined) return await read(mirror);
          return first;
        } catch (error) {
          const mirror = alternateOfficialUrl(url);
          if (mirror !== undefined) return await read(mirror);
          throw error;
        }
      };
      // Bodies fetched by research are kept in a bounded, expiring in-process
      // cache. `cache_search` is the second retrieval: it searches the full
      // text when the evidence pack only kept the relevant windows.
      const researchCache = new ResearchBodyCache();
      const research = registerResearchTool(
        toolTarget as unknown as ResearchRegistryLike,
        (query, limit, signal) => runQuery(query, limit, signal),
        researchFetch,
        {
          warn: warnTool,
          onPage: (page) => researchCache.put(page),
        },
      );
      if (research !== undefined) {
        onDispose(ctx, research.dispose);
      }
      const cacheSearch = registerCacheSearchTool(
        toolTarget as unknown as CacheSearchRegistryLike,
        researchCache,
        { warn: warnTool },
      );
      if (cacheSearch !== undefined) {
        onDispose(ctx, () => researchCache.clear());
      }

      // Community/video search: direct keyless adapters first, the normal
      // `web_search` path as a site-scoped fallback when an endpoint is blocked.
      const platformRunner: PlatformRunner = async (query, ids, limit, signal) => {
        const live = resolveConfig(section, undefined);
        const outcome = await searchPlatforms(query, {
          ids,
          limit,
          timeoutMs: Math.min(live.timeoutMs, 10_000),
          ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
          ...(signal === undefined ? {} : { signal }),
          fallbackSearch: async (fallbackQuery, fallbackLimit, fallbackSignal) => {
            const result = await runQuery(fallbackQuery, fallbackLimit, fallbackSignal);
            return { sources: result.sources, failures: result.failures };
          },
        });
        return {
          sources: outcome.sources,
          failures: outcome.failures,
          via: outcome.via,
          truncated: outcome.truncated,
        };
      };
      const platform = registerPlatformTool(
        toolTarget as unknown as PlatformToolRegistryLike,
        platformRunner,
        { warn: warnTool },
      );

      // Diagnostics: one tiny query per engine, no cache and no cooldown
      // mutation. It is registered last because it is the least essential tool.
      const engineTest = registerEngineTestTool(
        toolTarget as unknown as EngineTestRegistryLike,
        runEngineTest,
        { warn: warnTool },
      );
      if (engineTest !== undefined) {
        onDispose(ctx, engineTest.dispose);
      }

      if (mounted.toolSurface !== 'legacy') {
        // One entry point, eight actions. If the host rejects both candidate
        // names, fall back to the legacy definitions rather than losing every
        // optional capability.
        const unified = registerUnifiedTool(
          tools as unknown as UnifiedToolRegistryLike,
          captured,
          { warn: warnTool },
        );
        if (unified === undefined && captured.length > 0) {
          warnTool('web_tools unavailable; registering legacy tool names as a fallback');
          for (const definition of captured) {
            try {
              tools.register(definition as unknown as Parameters<typeof tools.register>[0]);
            } catch (error) {
              warnTool(`legacy fallback registration skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    }
  } catch (error) {
    warnTool(`optional tool registration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A short prompt section explains the relationships the tool schemas cannot:
  // when to use advanced_search, and that the boundary tags are data, not
  // instructions. Best-effort: a host without `systemPrompt` simply skips it.
  registerSearchPrompt(ctx);

  // The Settings page cannot call a model tool, so its "Test engines" button
  // gets one narrow loopback endpoint. The model-facing tool above stays the
  // primary path; this bridge is best-effort and silent on hosts without it.
  registerEngineTestBridge(ctx, runEngineTest);
  // The Settings page also gets a one-click update path; it uses the host
  // plugin manager rather than bundling a second updater.
  registerUpdateBridge(ctx);
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
  ADVANCED_SEARCH_TOOL_NAME,
  ADVANCED_SEARCH_FALLBACK_NAME,
  ADVANCED_SEARCH_DEFAULT_LIMIT,
  ADVANCED_SEARCH_MAX_LIMIT,
  createAdvancedSearchDefinition,
  registerAdvancedSearchTool,
  pickAdvancedSearchToolName,
  formatAdvancedSearchValue,
} from './advanced-search.ts';
export type {
  AdvancedSearchDefinition,
  AdvancedSearchOutcome,
  AdvancedSearchRegistration,
  AdvancedSearchRegistryLike,
  AdvancedSearchRunner,
  AdvancedSearchValue,
} from './advanced-search.ts';
export {
  SEARCH_PROMPT_SECTION,
  SEARCH_PROMPT_ORDER,
  SEARCH_PROMPT_TEXT,
  registerSearchPrompt,
} from './system-prompt.ts';
export { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, stripUntrustedBoundary, wrapUntrustedContent } from './untrusted.ts';
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
  PLATFORM_DEFAULT_LIMIT,
  PLATFORM_MAX_LIMIT,
  PLATFORM_TOOL_FALLBACK_NAME,
  PLATFORM_TOOL_NAME,
  createPlatformToolDefinition,
  parsePlatformArgs,
  pickPlatformToolName,
  registerPlatformTool,
} from './platform-tool.ts';
export type {
  PlatformRunner,
  PlatformToolDefinition,
  PlatformToolRegistryLike,
  PlatformToolValue,
} from './platform-tool.ts';
export {
  DEFAULT_PLATFORM_LIMIT,
  MAX_PLATFORM_LIMIT,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  isPlatformId,
  parseBilibili,
  parseJuejin,
  parseReddit,
  parseV2ex,
  parseYoutube,
  searchPlatforms,
} from './platforms.ts';
export type {
  PlatformId,
  PlatformOutcome,
  PlatformSearchOptions,
} from './platforms.ts';
export {
  CACHE_SEARCH_DEFAULT_LIMIT,
  CACHE_SEARCH_FALLBACK_NAME,
  CACHE_SEARCH_MAX_BODIES,
  CACHE_SEARCH_MAX_CHARS,
  CACHE_SEARCH_MAX_LIMIT,
  CACHE_SEARCH_SNIPPET_CHARS,
  CACHE_SEARCH_TTL_MS,
  CACHE_SEARCH_TOOL_NAME,
  ResearchBodyCache,
  cacheTokens,
  cacheWindows,
  createCacheSearchDefinition,
  formatCacheSearchValue,
  pickCacheSearchToolName,
  registerCacheSearchTool,
} from './research-cache.ts';
export type {
  CacheSearchDefinition,
  CacheSearchRegistryLike,
  CacheSearchValue,
  CachedResearchBody,
  CachedResearchMatch,
  ResearchBodyCacheOptions,
} from './research-cache.ts';
export { alternateOfficialUrl, canonicalOfficialUrl } from './mirrors.ts';
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
