/**
 * The model-facing `research` tool: one call that searches, opens the best
 * pages, and returns an evidence pack with the citations already attached.
 *
 * `web_search` answers "what links exist" and `web_fetch` answers "read this
 * page". The step the model keeps doing by hand is the middle one: pick the
 * two or three rows that matter, fetch them without timing out, and keep track
 * of which sentence came from which URL. This tool performs exactly that step:
 * it runs up to three searches through the normal engine path, de-duplicates
 * the rows, ranks them by query relevance and then source authority, fetches
 * the leading pages through the same ladder `web_fetch` uses, and returns one
 * Markdown document in which every excerpt sits under its URL. A credible
 * government/academic/official-documentation page that matches the query leads
 * the pack; relevance still gates out official pages that match none of it.
 *
 * Failure is part of the contract. A page that will not load is reported by
 * URL and reason, the remaining pages still arrive, and a total fetch failure
 * still returns the search rows — a research call that found links but could
 * not open them is still useful evidence.
 *
 * @module @fangchenghao/dsh-web-search/research
 */
import type { Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const RESEARCH_TOOL_NAME = "research";
/** The name used when another plugin already registered `research`. */
export declare const RESEARCH_TOOL_FALLBACK_NAME = "web_research";
/** Pages fetched when the call names no budget. */
export declare const RESEARCH_DEFAULT_SOURCES = 3;
/** Smallest fetch budget a call may ask for. */
export declare const RESEARCH_MIN_SOURCES = 1;
/** Largest fetch budget a call may ask for. */
export declare const RESEARCH_MAX_SOURCES = 5;
/** Distinct queries accepted in one call. */
export declare const RESEARCH_MAX_QUERIES = 3;
/** Characters kept from each fetched page. */
export declare const RESEARCH_EXCERPT_CHARS = 1800;
/** Below this much readable text a page is boilerplate, not evidence. */
export declare const RESEARCH_MIN_TEXT_CHARS = 160;
/** Pages fetched at the same time. */
export declare const RESEARCH_PAGE_CONCURRENCY = 3;
/** Wall-clock budget for the whole call, below the tool's host timeout. */
export declare const RESEARCH_BUDGET_MS = 45000;
/** What one search reports to the tool. */
export interface ResearchSearchOutcome {
    sources: Source[];
    failures: string[];
}
/** Runs one query through the plugin's normal engine path. */
export type ResearchSearcher = (query: string, limit: number, signal?: AbortSignal) => Promise<ResearchSearchOutcome>;
/** What the fetch ladder reports for one URL. */
export interface ResearchFetchedPage {
    url: string;
    status: number;
    text: string;
    truncated: boolean;
}
/** Fetches one URL through the plugin's normal ladder. */
export type ResearchFetcher = (url: string, signal?: AbortSignal) => Promise<ResearchFetchedPage>;
/** One page in the evidence pack. */
export interface ResearchPage {
    url: string;
    title?: string;
    status: number;
    chars: number;
    excerpt: string;
    truncated: boolean;
}
/** A URL the call found but could not turn into evidence. */
export interface ResearchFetchFailure {
    url: string;
    reason: string;
}
/** What the tool returns to the model. */
export interface ResearchValue {
    /** The query exactly as accepted (trimmed). */
    query: string;
    /** Every query the call actually ran. */
    queries: string[];
    /** Fetched pages, in the order they were chosen. */
    pages: ResearchPage[];
    /** Rows that were found but not fetched, with their titles when known. */
    sources: Array<{
        url: string;
        title?: string;
    }>;
    /** Fetch failures, one entry per URL. */
    failures: ResearchFetchFailure[];
    /** Number of search rows seen before the fetch budget cut them. */
    found: number;
    /** True when the search row list was cut by the fetch budget. */
    truncated: boolean;
}
/** A tool definition in the registry's native shape. */
export interface ResearchDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: ResearchValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<ResearchValue>;
}
/** The slice of the tool registry this module needs. */
export interface ResearchRegistryLike {
    register(definition: ResearchDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Construction seams. */
export interface ResearchOptions {
    /** Registration diagnostics. */
    warn?: (message: string) => void;
    /**
     * Called once for every page that survives validation, with the full body.
     * Used by the optional cache_search tool; a throwing sink must never fail the
     * research call.
     */
    onPage?: (page: {
        url: string;
        title?: string;
        text: string;
        queries: readonly string[];
    }) => void;
}
/** A successful registration plus the exact way to undo it. */
export interface ResearchRegistration {
    name: string;
    dispose: () => void;
}
/**
 * Canonical form used to decide whether two rows are the same page.
 *
 * Search engines disagree about `www.`, trailing slashes and fragments; two
 * rows that differ only in those are one page, and fetching both wastes the
 * whole budget.
 * @param raw - candidate URL.
 * @returns a stable key, or `undefined` for a non-http(s) URL.
 */
export declare function canonicalKey(raw: string): string | undefined;
/**
 * Select the passages of a fetched page that actually answer the research
 * question, instead of always returning the first N characters.
 *
 * The search result's snippet is a summary, not the page: the fact can be
 * 20 KB down (a Kubernetes field, an RFC section). This second pass scores
 * paragraph windows against the same query tokens and keeps the best ones in
 * reading order. It is deterministic and lexical; no model call and no extra
 * network request. When nothing matches, the opening is still returned, so a
 * weakly matched page is not silently turned into an empty excerpt.
 *
 * @param text - full page text from the fetch layer.
 * @param tokens - query tokens from all research queries.
 * @param max - excerpt budget in characters.
 * @returns a bounded excerpt, with best passages first preserved in page order.
 */
export declare function selectExcerpt(text: string, tokens: readonly string[], max: number): string;
/**
 * Score a URL's source authority from 0 (generic page) to 5 (government,
 * academic or standards body). Credible sources lead only after they pass the
 * relevance gate, so an unrelated official page is not fetched as evidence.
 * @param raw - candidate URL from any engine.
 * @returns the authority score; malformed and non-HTTP(S) URLs score 0.
 */
export declare function authorityScore(raw: string): number;
/**
 * Format the evidence pack the model reads.
 * @param value - what the call produced.
 * @returns a Markdown document with one section per fetched page.
 */
export declare function formatResearchValue(value: ResearchValue): string;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `research`, or the fallback when that name is taken.
 * @param search - runs one query through the plugin's search path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @returns a registry-ready definition.
 */
export declare function createResearchDefinition(name: string, search: ResearchSearcher, fetchPage: ResearchFetcher, options?: ResearchOptions): ResearchDefinition;
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickResearchToolName(tools: ResearchRegistryLike): string;
/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param search - executes one search through the plugin's normal path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export declare function registerResearchTool(tools: ResearchRegistryLike, search: ResearchSearcher, fetchPage: ResearchFetcher, options?: ResearchOptions): ResearchRegistration | undefined;
