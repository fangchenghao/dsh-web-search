import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const CACHE_SEARCH_TOOL_NAME = "cache_search";
/** The name used when another plugin already registered `cache_search`. */
export declare const CACHE_SEARCH_FALLBACK_NAME = "web_cache_search";
/** How long a fetched body stays searchable. */
export declare const CACHE_SEARCH_TTL_MS: number;
/** Bounded memory: enough for a normal research session, not a crawler. */
export declare const CACHE_SEARCH_MAX_BODIES = 24;
/** Per-body storage cap, in characters. */
export declare const CACHE_SEARCH_MAX_CHARS = 400000;
/** Snippet budget returned for one matching body. */
export declare const CACHE_SEARCH_SNIPPET_CHARS = 1600;
/** Default and maximum result count for one query. */
export declare const CACHE_SEARCH_DEFAULT_LIMIT = 3;
export declare const CACHE_SEARCH_MAX_LIMIT = 10;
/** One body stored after a successful research fetch. */
export interface CachedResearchBody {
    url: string;
    title?: string;
    text: string;
    fetchedAt: number;
    queries: string[];
}
/** One matching body and the passage that matched. */
export interface CachedResearchMatch {
    url: string;
    title?: string;
    snippet: string;
    score: number;
    fetchedAt: number;
}
/** What one cache search returns. */
export interface CacheSearchValue {
    query: string;
    matches: CachedResearchMatch[];
    failures: string[];
}
/** A registry definition in the host's raw JSON-Schema dialect. */
export interface CacheSearchDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: CacheSearchValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<CacheSearchValue>;
}
/** The slice of the tool registry this module needs. */
export interface CacheSearchRegistryLike {
    register(definition: CacheSearchDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Test seams. */
export interface ResearchBodyCacheOptions {
    ttlMs?: number;
    maxBodies?: number;
    maxChars?: number;
    now?: () => number;
}
/** Lowercase search terms; CJK runs become bigrams, matching research's lexical gate. */
export declare function cacheTokens(query: string): string[];
/** Split a page into paragraph windows small enough to quote. */
export declare function cacheWindows(text: string, size?: number): string[];
/** In-memory, bounded, expiring cache of research bodies. */
export declare class ResearchBodyCache {
    private readonly entries;
    private readonly ttlMs;
    private readonly maxBodies;
    private readonly maxChars;
    private readonly now;
    constructor(options?: ResearchBodyCacheOptions);
    /** Store one successful research body, replacing an older copy of the URL. */
    put(body: {
        url: string;
        title?: string;
        text: string;
        queries?: readonly string[];
    }): void;
    /** Number of live entries, after dropping expired rows. */
    size(): number;
    /** Drop expired entries; called by both `put` and `search`. */
    private evict;
    /**
     * Search all cached bodies lexically and return the best passage per body.
     * @param query - what to look for.
     * @param limit - maximum matches, clamped to 1...10.
     * @returns matches ordered by score, then recency.
     */
    search(query: string, limit?: number): CachedResearchMatch[];
    /** Remove every entry; used by tests and disposal. */
    clear(): void;
}
/** Render results for the model, inside the untrusted-content boundary. */
export declare function formatCacheSearchValue(value: CacheSearchValue): string;
/**
 * Build the `cache_search` definition.
 * @param name - preferred or fallback tool name.
 * @param cache - live cache populated by research.
 */
export declare function createCacheSearchDefinition(name: string, cache: ResearchBodyCache): CacheSearchDefinition;
/** Pick the preferred name unless another tool already owns it. */
export declare function pickCacheSearchToolName(tools: CacheSearchRegistryLike): string;
/**
 * Register the cache-search tool; every failure is contained so the rest of the
 * plugin keeps mounting.
 */
export declare function registerCacheSearchTool(tools: CacheSearchRegistryLike, cache: ResearchBodyCache, options?: {
    warn?: (message: string) => void;
}): string | undefined;
