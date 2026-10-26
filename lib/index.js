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
import { ResearchBodyCache, registerCacheSearchTool } from "./research-cache.js";
import { alternateOfficialUrl } from "./mirrors.js";
import { searchPlatforms } from "./platforms.js";
import { registerPlatformTool } from "./platform-tool.js";
import { registerEngineTestTool } from "./engine-test.js";
import { registerEngineTestBridge, registerUpdateBridge } from "./bridge.js";
import { registerAdvancedSearchTool, undatedWindowNote } from "./advanced-search.js";
import { searchVerticals } from "./verticals.js";
import { routePackageQuery } from "./query-router.js";
import { mergeOfficial, officialLookup } from "./official-sources.js";
import { arxivLookup, arxivQueryText, mergeArxiv } from "./arxiv.js";
import { chromeFeedNote, chromeWindow, fetchChromeReleases, filterChromeChannel, hasNonStableChromePosts, isChromeSecurityQuery, } from "./official-feed.js";
import { registerSearchPrompt } from "./system-prompt.js";
import { registerUnifiedTool } from "./tool-suite.js";
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
    const runQuery = async (query, requested, signal, overrides = {}) => {
        const resolved = resolveConfig(section, undefined);
        const timeRange = overrides.timeRange ?? resolved.timeRange;
        if (typeof query !== 'string' || query.trim().length === 0) {
            throw new Error('web search requires a non-empty query');
        }
        if (signal?.aborted === true)
            throw new Error('web search was cancelled');
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
    const runChromeOfficial = async (query, requested, effective, signal) => {
        if (effective === 'off' || !isChromeSecurityQuery(query))
            return undefined;
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
            if (selected.length === 0)
                return undefined;
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
        }
        catch {
            return undefined;
        }
    };
    /**
     * Run one per-call windowed search. `undefined` keeps the deployment setting;
     * the tool's validation only lets the five known windows through.
     */
    const runAdvancedSearch = async (query, requested, timeRange, signal) => {
        const resolved = resolveConfig(section, undefined);
        const effective = timeRange ?? resolved.timeRange;
        const official = await runChromeOfficial(query, requested, effective, signal);
        if (official !== undefined)
            return official;
        const outcome = await runQuery(query, requested, signal, { timeRange: effective });
        const windowNote = undatedWindowNote(outcome.sources, effective);
        const note = [outcome.note, windowNote]
            .filter((part) => typeof part === 'string' && part.length > 0)
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
    const runEngineTest = async (engine, query, signal) => {
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
            // An explicit `arXiv` query gets the preprint index in parallel with the
            // ordinary fan-out. This is separate from the official-release lookup:
            // a survey query needs arXiv's own search, not a release announcement.
            const arxiv = arxivLookup(query, {
                limit: 4,
                timeoutMs: Math.min(live.timeoutMs, 3_500),
                ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                ...(signal === undefined ? {} : { signal }),
            });
            const outcome = await runQuery(query, asked, signal);
            // A version/EOL question about PostgreSQL or Rust is better answered by
            // the project's own release facts than by whatever an engine ranks first.
            // The lookup is query-scoped and failure-tolerant; it never replaces the
            // ordinary rows when the page is unavailable.
            let sources = mergeOfficial(outcome.sources, await official);
            sources = mergeArxiv(sources, await arxiv);
            if (sources.length === 0) {
                throw new Error(`no search engine returned results for ${JSON.stringify(query)} (${outcome.failures.join('; ')})`);
            }
            const cap = Math.min(asked ?? live.limit, live.limit);
            return { sources: sources.slice(0, cap), truncated: outcome.truncated || sources.length > cap };
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
            const captured = [];
            const capture = {
                get: () => undefined,
                register: (definition) => {
                    captured.push(definition);
                    return () => undefined;
                },
            };
            const toolTarget = mounted.toolSurface === 'legacy'
                ? tools
                : capture;
            /**
             * `search_many` is for general web queries, but an explicitly
             * registry-scoped package query is much better answered by the existing
             * domain source. It falls back to the ordinary path when that source
             * returns nothing, so a registry outage cannot empty the batch.
             */
            const runBatchQuery = async (query, limit, signal) => {
                // An explicit arXiv query is a paper lookup, not a general web query.
                // Keep the ordinary path as the fallback when the index returns no rows.
                const arxivText = arxivQueryText(query);
                if (arxivText !== undefined) {
                    const live = resolveConfig(section, undefined);
                    const papers = await arxivLookup(query, {
                        limit,
                        timeoutMs: live.domainTimeoutMs,
                        ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                        ...(signal === undefined ? {} : { signal }),
                    });
                    if (papers.length > 0) {
                        return {
                            sources: papers.slice(0, limit),
                            failures: [],
                            note: `arXiv query routed to the arXiv index for ${JSON.stringify(arxivText)}; rows are preprints with stable abs URLs.`,
                            truncated: papers.length > limit,
                        };
                    }
                }
                const route = routePackageQuery(query);
                if (route !== undefined) {
                    const live = resolveConfig(section, undefined);
                    try {
                        const names = route.names.length > 0 ? route.names : [route.query];
                        const perName = Math.max(1, Math.ceil(limit / names.length));
                        const verticals = await Promise.all(names.map((name) => searchVerticals(name, {
                            ids: [route.id],
                            limit: perName,
                            timeoutMs: live.domainTimeoutMs,
                            ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                            ...(signal === undefined ? {} : { signal }),
                        })));
                        const seen = new Set();
                        // Keep the exact first hit for every named package ahead of related
                        // suggestions: a two-package comparison should show both packages
                        // before serde-saphyr or react-router-style neighbours.
                        const ordered = [
                            ...verticals.flatMap((vertical) => vertical.sources.slice(0, 1)),
                            ...verticals.flatMap((vertical) => vertical.sources.slice(1)),
                        ];
                        const sources = ordered
                            .filter((source) => {
                            if (seen.has(source.url))
                                return false;
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
                    }
                    catch {
                        // The ordinary web path below is the fallback for a registry miss.
                    }
                }
                return runQuery(query, limit, signal);
            };
            registerDomainTool(toolTarget, () => {
                const live = resolveConfig(section, undefined);
                const settings = {
                    sourceIds: live.domainSourceIds,
                    limit: live.domainLimit,
                    timeoutMs: live.domainTimeoutMs,
                    ...(live.proxy === undefined ? {} : { proxy: live.proxy }),
                };
                return settings;
            }, { warn: warnTool });
            // Batch tool: same optional-registry path, same fail-safe mounting. Most
            // queries use the `web_search` path; an explicit package-registry query
            // can use the existing domain source instead.
            const batch = registerSearchManyTool(toolTarget, runBatchQuery, { warn: warnTool });
            if (batch !== undefined) {
                onDispose(ctx, batch.dispose);
            }
            // Per-call date window: the only tool that can override the global
            // `timeRange` without changing the user's Settings.
            const advanced = registerAdvancedSearchTool(toolTarget, runAdvancedSearch, { warn: warnTool });
            if (advanced !== undefined) {
                onDispose(ctx, advanced.dispose);
            }
            // Resumable reading: `web_fetch` cannot continue from an offset because
            // the host request carries only `url`, but a plugin-owned tool can. It
            // reuses the same fetch ladder and the same live Settings readers.
            const paged = registerReadPageTool(toolTarget, () => {
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
                // The evidence pack keeps ~6 K characters, but the second retrieval
                // (passage selection and cache_search) must be able to find a fact
                // deep in the page. 200 K is the provider ceiling, not the model budget.
                maxLength: 200_000,
                renderJs: () => resolveConfig(section, undefined).renderJs,
                renderTimeoutMs: () => resolveConfig(section, undefined).renderTimeoutMs,
                ...(mounted.proxy === undefined ? {} : { proxy: mounted.proxy }),
                ...(mounted.anysearchApiKey.length === 0 ? {} : { anysearchApiKey: mounted.anysearchApiKey }),
            });
            const researchFetch = async (url, signal) => {
                const read = async (target) => {
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
                    if (first.status < 400 && first.text.trim().length > 0)
                        return first;
                    const mirror = alternateOfficialUrl(url);
                    // The canonical standards page rejected the reader (or returned a
                    // shell); try the same organisation's public build once. A failure
                    // here falls back to the original outcome so the caller sees the real
                    // reason rather than a mirror-specific one.
                    if (mirror !== undefined)
                        return await read(mirror);
                    return first;
                }
                catch (error) {
                    const mirror = alternateOfficialUrl(url);
                    if (mirror !== undefined)
                        return await read(mirror);
                    throw error;
                }
            };
            // Bodies fetched by research are kept in a bounded, expiring in-process
            // cache. `cache_search` is the second retrieval: it searches the full
            // text when the evidence pack only kept the relevant windows.
            const researchCache = new ResearchBodyCache();
            const research = registerResearchTool(toolTarget, (query, limit, signal) => runQuery(query, limit, signal), researchFetch, {
                warn: warnTool,
                onPage: (page) => researchCache.put(page),
            });
            if (research !== undefined) {
                onDispose(ctx, research.dispose);
            }
            const cacheSearch = registerCacheSearchTool(toolTarget, researchCache, { warn: warnTool });
            if (cacheSearch !== undefined) {
                onDispose(ctx, () => researchCache.clear());
            }
            // Community/video search: direct keyless adapters first, the normal
            // `web_search` path as a site-scoped fallback when an endpoint is blocked.
            const platformRunner = async (query, ids, limit, signal) => {
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
            const platform = registerPlatformTool(toolTarget, platformRunner, { warn: warnTool });
            // Diagnostics: one tiny query per engine, no cache and no cooldown
            // mutation. It is registered last because it is the least essential tool.
            const engineTest = registerEngineTestTool(toolTarget, runEngineTest, { warn: warnTool });
            if (engineTest !== undefined) {
                onDispose(ctx, engineTest.dispose);
            }
            if (mounted.toolSurface !== 'legacy') {
                // One entry point, eight actions. If the host rejects both candidate
                // names, fall back to the legacy definitions rather than losing every
                // optional capability.
                const unified = registerUnifiedTool(tools, captured, { warn: warnTool });
                if (unified === undefined && captured.length > 0) {
                    warnTool('web_tools unavailable; registering legacy tool names as a fallback');
                    for (const definition of captured) {
                        try {
                            tools.register(definition);
                        }
                        catch (error) {
                            warnTool(`legacy fallback registration skipped: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                }
            }
        }
    }
    catch (error) {
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
export { ADVANCED_SEARCH_TOOL_NAME, ADVANCED_SEARCH_FALLBACK_NAME, ADVANCED_SEARCH_DEFAULT_LIMIT, ADVANCED_SEARCH_MAX_LIMIT, createAdvancedSearchDefinition, registerAdvancedSearchTool, pickAdvancedSearchToolName, formatAdvancedSearchValue, } from "./advanced-search.js";
export { SEARCH_PROMPT_SECTION, SEARCH_PROMPT_ORDER, SEARCH_PROMPT_TEXT, registerSearchPrompt, } from "./system-prompt.js";
export { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, stripUntrustedBoundary, wrapUntrustedContent } from "./untrusted.js";
export { SEARCH_MANY_TOOL_NAME, SEARCH_MANY_FALLBACK_NAME, SEARCH_MANY_CONCURRENCY, SEARCH_MANY_DEFAULT_LIMIT, createSearchManyDefinition, registerSearchManyTool, pickSearchManyToolName, formatSearchManyValue, } from "./search-many.js";
export { RESEARCH_TOOL_NAME, RESEARCH_TOOL_FALLBACK_NAME, RESEARCH_DEFAULT_SOURCES, RESEARCH_MAX_SOURCES, RESEARCH_MAX_QUERIES, RESEARCH_EXCERPT_CHARS, RESEARCH_BUDGET_MS, createResearchDefinition, registerResearchTool, pickResearchToolName, formatResearchValue, } from "./research.js";
export { PLATFORM_DEFAULT_LIMIT, PLATFORM_MAX_LIMIT, PLATFORM_TOOL_FALLBACK_NAME, PLATFORM_TOOL_NAME, createPlatformToolDefinition, parsePlatformArgs, pickPlatformToolName, registerPlatformTool, } from "./platform-tool.js";
export { DEFAULT_PLATFORM_LIMIT, MAX_PLATFORM_LIMIT, PLATFORM_IDS, PLATFORM_LABELS, isPlatformId, parseBilibili, parseJuejin, parseReddit, parseV2ex, parseYoutube, searchPlatforms, } from "./platforms.js";
export { CACHE_SEARCH_DEFAULT_LIMIT, CACHE_SEARCH_FALLBACK_NAME, CACHE_SEARCH_MAX_BODIES, CACHE_SEARCH_MAX_CHARS, CACHE_SEARCH_MAX_LIMIT, CACHE_SEARCH_SNIPPET_CHARS, CACHE_SEARCH_TTL_MS, CACHE_SEARCH_TOOL_NAME, ResearchBodyCache, cacheTokens, cacheWindows, createCacheSearchDefinition, formatCacheSearchValue, pickCacheSearchToolName, registerCacheSearchTool, } from "./research-cache.js";
export { alternateOfficialUrl, canonicalOfficialUrl } from "./mirrors.js";
export { READ_PAGE_TOOL_NAME, READ_PAGE_TOOL_FALLBACK_NAME, READ_PAGE_MIN_LENGTH, READ_PAGE_MAX_LENGTH, READ_PAGE_DEFAULT_LENGTH, READ_PAGE_INTERNAL_MAX_CHARS, READ_PAGE_CACHE_ENTRIES, READ_PAGE_PROVIDER_ID, createReadPageDefinition, registerReadPageTool, pickReadPageToolName, formatReadPageValue, } from "./read-page.js";
