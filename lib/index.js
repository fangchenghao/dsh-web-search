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
import { Config, resolveConfig } from "./config.js";
import { search } from "./engines.js";
import { SearchCache } from "./cache.js";
import { EngineHealth } from "./health.js";
import { createFetchProvider } from "./fetch.js";
import { registerDomainTool } from "./domain-tool.js";
import { registerSearchManyTool } from "./search-many.js";
import { registerReadPageTool } from "./read-page.js";
import { registerResearchTool } from "./research.js";
export const name = 'dsh-web-search';
/** The `ctx.web` service this plugin registers a search provider with. */
export const inject = ['web'];
/** Provider id referenced by `web.searchProvider`. */
export const PROVIDER_ID = 'bing';
/** Fetch provider id, named in the `web` service config as `fetchProvider`. */
export const FETCH_PROVIDER_ID = 'http-proxy';
/**
 * Read the optional tool registry without requiring it.
 * @param ctx - the plugin context.
 * @returns the registry, or `undefined` when this deployment has none.
 */
function readToolRegistry(ctx) {
    let candidate;
    try {
        const found = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
        // Cordis throws on an un-injected service property, so even the fallback
        // read is guarded: a missing `tools` is a supported deployment, not an error.
        candidate = found ?? ctx.tools;
    }
    catch {
        return undefined;
    }
    if (typeof candidate !== 'object' || candidate === null)
        return undefined;
    return typeof candidate.register === 'function'
        ? candidate
        : undefined;
}
/** Report a skipped tool registration without breaking plugin loading. */
function warnTool(message) {
    try {
        console.warn(`[dsh-web-search-bing] ${message}`);
    }
    catch {
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
function onDispose(ctx, cleanup) {
    try {
        if (typeof ctx.effect === 'function') {
            ctx.effect(() => cleanup);
            return;
        }
        if (typeof ctx.on === 'function')
            ctx.on('dispose', cleanup);
    }
    catch (error) {
        warnTool(`dispose hook skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Register the search provider.
 * @param ctx - plugin context carrying the `web` service.
 * @param config - the validated configuration section: volatile fields arrive as
 * live references the Loader updates in place, so the section is read again for
 * every search instead of being frozen at mount time.
 */
export function apply(ctx, config = {}) {
    const section = (config ?? {});
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
    const runQuery = async (query, requested, signal) => {
        const resolved = resolveConfig(section, undefined);
        if (typeof query !== 'string' || query.trim().length === 0) {
            throw new Error('web search requires a non-empty query');
        }
        if (signal?.aborted === true)
            throw new Error('web search was cancelled');
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
        async search(request, signal) {
            // A Settings commit only mutates the existing references; reading the
            // section inside `runQuery` is what makes the edit apply without a restart.
            const query = request.query;
            if (typeof query !== 'string' || query.trim().length === 0) {
                throw new Error('web search requires a non-empty query');
            }
            if (signal?.aborted === true)
                throw new Error('web search was cancelled');
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
    ctx.web.registerFetchProvider(createFetchProvider({
        id: FETCH_PROVIDER_ID,
        timeoutMs: mounted.timeoutMs,
        format: () => resolveConfig(section, undefined).fetchFormat,
        maxLength: () => resolveConfig(section, undefined).fetchMaxLength,
        renderJs: () => resolveConfig(section, undefined).renderJs,
        renderTimeoutMs: () => resolveConfig(section, undefined).renderTimeoutMs,
        ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
        ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
    }));
    // Optional half: `domain_search`, `search_many` and `read_page`. Fail-safe by
    // construction — a deployment without `ctx.tools` still loads this plugin and
    // keeps `web_search`; the registration path is the host's
    // `ToolRuntime.register(definition)`.
    try {
        const tools = readToolRegistry(ctx);
        if (tools !== undefined) {
            registerDomainTool(tools, () => {
                const live = resolveConfig(section, undefined);
                const settings = {
                    sourceIds: live.domainSourceIds,
                    limit: live.domainLimit,
                    timeoutMs: live.domainTimeoutMs,
                    ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                };
                return settings;
            }, { warn: warnTool });
            // Batch tool: same optional-registry path, same fail-safe mounting. The
            // runner is the `web_search` path, so both tools share lookups and cache.
            const batch = registerSearchManyTool(tools, (query, limit, signal) => runQuery(query, limit, signal), { warn: warnTool });
            if (batch !== undefined) {
                onDispose(ctx, batch.dispose);
            }
            // Resumable reading: `web_fetch` cannot continue from an offset because
            // the host request carries only `url`, but a plugin-owned tool can. It
            // reuses the same fetch ladder and the same live Settings readers.
            const paged = registerReadPageTool(tools, () => {
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
            }, { warn: warnTool });
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
            const researchFetch = async (url, signal) => {
                const outcome = await researchProvider.fetch({ url }, signal);
                return {
                    url: outcome.url,
                    status: outcome.statusCode,
                    text: outcome.body.kind === 'text' ? outcome.body.content : '',
                    truncated: outcome.truncated,
                };
            };
            const research = registerResearchTool(tools, (query, limit, signal) => runQuery(query, limit, signal), researchFetch, { warn: warnTool });
            if (research !== undefined) {
                onDispose(ctx, research.dispose);
            }
        }
    }
    catch (error) {
        warnTool(`optional tool registration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export { Config, resolveConfig } from "./config.js";
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
export { HOSTS, search } from "./engines.js";
export { SearchCache, cacheKey } from "./cache.js";
export { CACHE_FILE_VERSION, DEFAULT_CACHE_FILE_MAX_BYTES, defaultCacheFile, resolveCacheFile, readCacheFile, serializeCache, writeCacheFile, } from "./cache-persist.js";
export { EngineHealth } from "./health.js";
export { SearchError, parseRetryAfter } from "./errors.js";
export { resolveHref, parseDdgHtml, parseDdgLite, parseBing, parseSo, parseAnySearch, echoesQuery, } from "./parsers.js";
export { fuse, interleave, dedupe, mergeRegions } from "./rank.js";
export { MS_PER_DAY, TIME_RANGE_MS, TIME_RANGES, parsePublishedAt, extractPublishedAt, publishedTimestamp, isWithinTimeRange, filterByTimeRange, } from "./freshness.js";
export { parseProxy, proxyFromEnv, resolveProxy, proxyGet } from "./proxy.js";
export { DEFAULT_VERTICAL_IDS, VERTICAL_IDS, VERTICALS, searchVerticals, verticalById, isVerticalId, parseGithub, parseNpm, parsePypi, parseArxiv, parseWikipedia, parseHn, parseStackExchange, parseCrates, } from "./verticals.js";
export { DOMAIN_TOOL_NAME, DOMAIN_TOOL_FALLBACK_NAME, createDomainToolDefinition, registerDomainTool, formatDomainValue, } from "./domain-tool.js";
export { SEARCH_MANY_TOOL_NAME, SEARCH_MANY_FALLBACK_NAME, SEARCH_MANY_CONCURRENCY, SEARCH_MANY_DEFAULT_LIMIT, createSearchManyDefinition, registerSearchManyTool, pickSearchManyToolName, formatSearchManyValue, } from "./search-many.js";
export { RESEARCH_TOOL_NAME, RESEARCH_TOOL_FALLBACK_NAME, RESEARCH_DEFAULT_SOURCES, RESEARCH_MAX_SOURCES, RESEARCH_MAX_QUERIES, RESEARCH_EXCERPT_CHARS, RESEARCH_BUDGET_MS, createResearchDefinition, registerResearchTool, pickResearchToolName, formatResearchValue, } from "./research.js";
export { READ_PAGE_TOOL_NAME, READ_PAGE_TOOL_FALLBACK_NAME, READ_PAGE_MIN_LENGTH, READ_PAGE_MAX_LENGTH, READ_PAGE_DEFAULT_LENGTH, READ_PAGE_INTERNAL_MAX_CHARS, READ_PAGE_CACHE_ENTRIES, READ_PAGE_PROVIDER_ID, createReadPageDefinition, registerReadPageTool, pickReadPageToolName, formatReadPageValue, } from "./read-page.js";
