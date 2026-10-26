import type { PluginConfig } from './config.ts';
import type { FetchProvider } from './fetch.ts';
import type { InjectableHost } from './inject.ts';
import type { Source } from './types.ts';
export declare const name = "dsh-web-search";
/** The `ctx.web` service this plugin registers a search provider with. */
export declare const inject: string[];
/** Provider id referenced by `web.searchProvider`. */
export declare const PROVIDER_ID = "bing";
/** Fetch provider id, named in the `web` service config as `fetchProvider`. */
export declare const FETCH_PROVIDER_ID = "http-proxy";
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
/** Configuration as the loader hands it over, already schema-validated. */
export type ApplyConfig = PluginConfig;
/**
 * Register the search provider.
 * @param ctx - plugin context carrying the `web` service.
 * @param config - the validated configuration section: volatile fields arrive as
 * live references the Loader updates in place, so the section is read again for
 * every search instead of being frozen at mount time.
 */
export declare function apply(ctx: PluginContext, config?: unknown): void;
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
declare const _default: typeof apply & {
    Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        hosts: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        fetchFormat: import("@deepseek-ai/schemastery").default<"text" | "markdown", "text" | "markdown", "volatile-defined">;
        fetchMaxLength: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        renderJs: import("@deepseek-ai/schemastery").default<"off" | "auto" | "always", "off" | "auto" | "always", "volatile-defined">;
        renderTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        wait: import("@deepseek-ai/schemastery").default<"auto" | "all" | "fast", "auto" | "all" | "fast", "volatile-defined">;
        proxy: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        limit: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        rrfConstant: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        authorityDomains: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        authorityBoost: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        freshnessBoost: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        freshnessDays: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        timeRange: import("@deepseek-ai/schemastery").default<"off" | "day" | "week" | "month" | "year", "off" | "day" | "week" | "month" | "year", "volatile-defined">;
        blockedDomains: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        safeSearch: import("@deepseek-ai/schemastery").default<"off" | "moderate" | "strict", "off" | "moderate" | "strict", "volatile-defined">;
        fallbackOn: import("@deepseek-ai/schemastery").default<NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, "volatile-defined">;
        cacheTtlMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        cacheEntries: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        cachePersist: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        cacheFile: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        anysearchApiKey: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        anysearchDomain: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        firecrawlApiKey: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        baseCooldownMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxCooldownMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        domainSources: import("@deepseek-ai/schemastery").default<NoInfer<string | string[]>, NoInfer<string | string[]>, "volatile-defined">;
        domainLimit: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        domainTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        toolSurface: import("@deepseek-ai/schemastery").default<"unified" | "legacy", "unified" | "legacy", "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        hosts: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        fetchFormat: import("@deepseek-ai/schemastery").default<"text" | "markdown", "text" | "markdown", "volatile-defined">;
        fetchMaxLength: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        renderJs: import("@deepseek-ai/schemastery").default<"off" | "auto" | "always", "off" | "auto" | "always", "volatile-defined">;
        renderTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        wait: import("@deepseek-ai/schemastery").default<"auto" | "all" | "fast", "auto" | "all" | "fast", "volatile-defined">;
        proxy: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        limit: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        rrfConstant: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        authorityDomains: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        authorityBoost: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        freshnessBoost: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        freshnessDays: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        timeRange: import("@deepseek-ai/schemastery").default<"off" | "day" | "week" | "month" | "year", "off" | "day" | "week" | "month" | "year", "volatile-defined">;
        blockedDomains: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        safeSearch: import("@deepseek-ai/schemastery").default<"off" | "moderate" | "strict", "off" | "moderate" | "strict", "volatile-defined">;
        fallbackOn: import("@deepseek-ai/schemastery").default<NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, "volatile-defined">;
        cacheTtlMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        cacheEntries: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        cachePersist: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        cacheFile: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        anysearchApiKey: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        anysearchDomain: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        firecrawlApiKey: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        baseCooldownMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxCooldownMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        domainSources: import("@deepseek-ai/schemastery").default<NoInfer<string | string[]>, NoInfer<string | string[]>, "volatile-defined">;
        domainLimit: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        domainTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        toolSurface: import("@deepseek-ai/schemastery").default<"unified" | "legacy", "unified" | "legacy", "volatile-defined">;
    }>>, "plain">;
    inject: string[];
};
export default _default;
export { HOSTS, search } from './engines.ts';
export { SearchCache, cacheKey } from './cache.ts';
export type { CachePersistOptions, SearchCacheOptions } from './cache.ts';
export { CACHE_FILE_VERSION, DEFAULT_CACHE_FILE_MAX_BYTES, defaultCacheFile, resolveCacheFile, readCacheFile, serializeCache, writeCacheFile, } from './cache-persist.ts';
export type { CacheFileIo, CacheWriteOptions, PersistedEntry, SerializedCache } from './cache-persist.ts';
export { EngineHealth } from './health.ts';
export { SearchError, parseRetryAfter } from './errors.ts';
export { resolveHref, parseDdgHtml, parseDdgLite, parseBing, parseSo, parseAnySearch, echoesQuery, } from './parsers.ts';
export { fuse, interleave, dedupe, mergeRegions } from './rank.ts';
export { MS_PER_DAY, TIME_RANGE_MS, TIME_RANGES, parsePublishedAt, extractPublishedAt, publishedTimestamp, isWithinTimeRange, filterByTimeRange, } from './freshness.ts';
export { parseProxy, proxyFromEnv, resolveProxy, proxyGet } from './proxy.ts';
export { DEFAULT_VERTICAL_IDS, VERTICAL_IDS, VERTICALS, searchVerticals, verticalById, isVerticalId, parseGithub, parseNpm, parsePypi, parseArxiv, parseWikipedia, parseHn, parseStackExchange, parseCrates, } from './verticals.ts';
export { DOMAIN_TOOL_NAME, DOMAIN_TOOL_FALLBACK_NAME, createDomainToolDefinition, registerDomainTool, formatDomainValue, } from './domain-tool.ts';
export type { VerticalId, VerticalSpec, VerticalOutcome, VerticalSearchOptions } from './verticals.ts';
export type { DomainToolSettings, DomainToolValue, DomainToolDefinition, ToolRegistryLike } from './domain-tool.ts';
export { ADVANCED_SEARCH_TOOL_NAME, ADVANCED_SEARCH_FALLBACK_NAME, ADVANCED_SEARCH_DEFAULT_LIMIT, ADVANCED_SEARCH_MAX_LIMIT, createAdvancedSearchDefinition, registerAdvancedSearchTool, pickAdvancedSearchToolName, formatAdvancedSearchValue, } from './advanced-search.ts';
export type { AdvancedSearchDefinition, AdvancedSearchOutcome, AdvancedSearchRegistration, AdvancedSearchRegistryLike, AdvancedSearchRunner, AdvancedSearchValue, } from './advanced-search.ts';
export { SEARCH_PROMPT_SECTION, SEARCH_PROMPT_ORDER, SEARCH_PROMPT_TEXT, registerSearchPrompt, } from './system-prompt.ts';
export { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, stripUntrustedBoundary, wrapUntrustedContent } from './untrusted.ts';
export { SEARCH_MANY_TOOL_NAME, SEARCH_MANY_FALLBACK_NAME, SEARCH_MANY_CONCURRENCY, SEARCH_MANY_DEFAULT_LIMIT, createSearchManyDefinition, registerSearchManyTool, pickSearchManyToolName, formatSearchManyValue, } from './search-many.ts';
export type { SearchManyDefinition, SearchManyOutcome, SearchManyRegistration, SearchManyRegistryLike, SearchManyResult, SearchManyRunner, SearchManySource, SearchManyValue, } from './search-many.ts';
export { RESEARCH_TOOL_NAME, RESEARCH_TOOL_FALLBACK_NAME, RESEARCH_DEFAULT_SOURCES, RESEARCH_MAX_SOURCES, RESEARCH_MAX_QUERIES, RESEARCH_EXCERPT_CHARS, RESEARCH_BUDGET_MS, createResearchDefinition, registerResearchTool, pickResearchToolName, formatResearchValue, } from './research.ts';
export type { ResearchDefinition, ResearchFetcher, ResearchFetchedPage, ResearchFetchFailure, ResearchPage, ResearchRegistration, ResearchRegistryLike, ResearchSearcher, ResearchSearchOutcome, ResearchValue, } from './research.ts';
export { PLATFORM_DEFAULT_LIMIT, PLATFORM_MAX_LIMIT, PLATFORM_TOOL_FALLBACK_NAME, PLATFORM_TOOL_NAME, createPlatformToolDefinition, parsePlatformArgs, pickPlatformToolName, registerPlatformTool, } from './platform-tool.ts';
export type { PlatformRunner, PlatformToolDefinition, PlatformToolRegistryLike, PlatformToolValue, } from './platform-tool.ts';
export { DEFAULT_PLATFORM_LIMIT, MAX_PLATFORM_LIMIT, PLATFORM_IDS, PLATFORM_LABELS, isPlatformId, parseBilibili, parseJuejin, parseReddit, parseV2ex, parseYoutube, searchPlatforms, } from './platforms.ts';
export type { PlatformId, PlatformOutcome, PlatformSearchOptions, } from './platforms.ts';
export { CACHE_SEARCH_DEFAULT_LIMIT, CACHE_SEARCH_FALLBACK_NAME, CACHE_SEARCH_MAX_BODIES, CACHE_SEARCH_MAX_CHARS, CACHE_SEARCH_MAX_LIMIT, CACHE_SEARCH_SNIPPET_CHARS, CACHE_SEARCH_TTL_MS, CACHE_SEARCH_TOOL_NAME, ResearchBodyCache, cacheTokens, cacheWindows, createCacheSearchDefinition, formatCacheSearchValue, pickCacheSearchToolName, registerCacheSearchTool, } from './research-cache.ts';
export type { CacheSearchDefinition, CacheSearchRegistryLike, CacheSearchValue, CachedResearchBody, CachedResearchMatch, ResearchBodyCacheOptions, } from './research-cache.ts';
export { alternateOfficialUrl, canonicalOfficialUrl } from './mirrors.ts';
export { READ_PAGE_TOOL_NAME, READ_PAGE_TOOL_FALLBACK_NAME, READ_PAGE_MIN_LENGTH, READ_PAGE_MAX_LENGTH, READ_PAGE_DEFAULT_LENGTH, READ_PAGE_INTERNAL_MAX_CHARS, READ_PAGE_CACHE_ENTRIES, READ_PAGE_PROVIDER_ID, createReadPageDefinition, registerReadPageTool, pickReadPageToolName, formatReadPageValue, } from './read-page.ts';
export type { ReadPageDefinition, ReadPageOptions, ReadPageRegistration, ReadPageRegistryLike, ReadPageSettings, ReadPageValue, } from './read-page.ts';
export type { Source, SearchOutcome, RankOptions, SearchOptions, HostSpec, Region, TimeRange, WaitPolicy } from './types.ts';
