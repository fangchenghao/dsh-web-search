/**
 * The engine registry and the search orchestration.
 *
 * A run has three stages: every engine of the leading tier is asked
 * concurrently, the answers are fused by reciprocal rank fusion with the
 * bilingual region policy on top, and the result is memoised. The tier releases
 * on the first of: every engine settled, the engines that lead this query's
 * language all settled, enough sources from enough contributors, or the soft
 * deadline. Requiring more than one contributor is what keeps the fused list
 * cross-engine: the first engine to answer is usually fast but narrow.
 *
 * @module @fangchenghao/dsh-web-search/engines
 */
import type { EngineAnswer, EngineFailure, FailureKind, HostSpec, RankOptions, Region, SafeSearch, SearchOptions, SearchOutcome, Source, TimeRange, WaitPolicy } from './types.ts';
import type { SearchCache } from './cache.ts';
import type { EngineHealth } from './health.ts';
/**
 * Engines, in merge priority order.
 *
 * `region` decides which query language an engine leads (`both` leads either),
 * `weight` how many slots it takes per interleave round, and `tier` whether it
 * runs as a first choice or only when no primary answered.
 */
export declare const HOSTS: readonly HostSpec[];
/**
 * Whether a tier may release before its soft deadline.
 *
 * `limit` and `needed` are intentionally separate: eight rows from one engine
 * are still a single-engine answer, while eight rows from two engines are a
 * genuine cross-engine result. Counting every region here is what prevents a
 * slow lead engine from holding a query open after another region supplied
 * enough rows.
 */
export declare function tierReleaseReady(available: number, contributors: number, limit: number, needed: number): boolean;
/** Options for {@link search}: the seam's budget plus the plugin's runtime. */
export interface EngineRunOptions extends SearchOptions {
    /** AnySearch Bearer token; empty or absent means anonymous access. */
    anysearchApiKey?: string;
    /** AnySearch vertical domain, such as `finance` or `finance.us_stock`. */
    anysearchDomain?: string;
    /** Optional Firecrawl Bearer token; absent keeps the keyless fallback. */
    firecrawlApiKey?: string;
    /** Ranking knobs, falling back to the documented defaults. */
    rank?: RankOptions;
    /** Failure classes that may trigger the fallback tier; absent means all. */
    fallbackOn?: readonly FailureKind[];
    /** Domains the caller never wants in a result list. */
    blockedDomains?: readonly string[];
    /** Content-filter level forwarded to engines that support it. */
    safeSearch?: SafeSearch;
    /** Result cache to consult and fill, when one is configured. */
    cache?: SearchCache;
    /** Cooldown tracker, when one is configured. */
    health?: EngineHealth;
    /**
     * Read-only observer of the fusion inputs.
     *
     * Benchmark recorders use it to persist each engine's own list and rerun the
     * current ranking offline. It never changes the run: the snapshot is a copy
     * handed over after the fused list is final, and an absent hook costs one
     * `undefined` check per run.
     */
    trace?: (snapshot: SearchTrace) => void;
}
/**
 * What one search run handed to the ranking, captured for offline replay.
 *
 * `answers` are the exact per-engine lists that produced `sources`, in engine
 * priority order and already narrowed by an active time window. Only the tier
 * that actually supplied the fused list is present: when the primary tier
 * answered, the fallback engines never ran. A cache hit has no fresh answers,
 * so `answers` is empty and `cached` is `true`.
 */
export interface SearchTrace {
    /** Caller budget, after the engine layer's own clamp. */
    limit: number;
    /** Region that led this query. */
    lead: Region;
    /** Release policy used for the tier run. */
    wait: WaitPolicy;
    /** Active publication window. */
    timeRange: TimeRange;
    /** Ranking knobs, with the window folded in. */
    rank: RankOptions;
    /** Which path produced `sources`. */
    tier: 'primary' | 'fallback' | 'none' | 'cache';
    /** Per-engine lists that were fused, in engine priority order. */
    answers: EngineAnswer[];
    /** The fused list `search` returned. */
    sources: Source[];
    /** Failure strings accumulated by this run. */
    failures: string[];
    /** Structured failures, including the class used by `fallbackOn`. */
    failureDetails: EngineFailure[];
    /** Human-readable note when policy changed the answer. */
    note?: string;
    /** Whether the result came from the cache. */
    cached: boolean;
}
/**
 * Search the web with every configured engine and fuse the answers.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param options - budget, policy and runtime dependencies.
 * @returns fused sources plus the failures worth reporting; throws on cancellation.
 */
/**
 * Apply per-run configuration to an engine definition.
 *
 * AnySearch can be pointed at one of its vertical domains; both AnySearch and
 * Firecrawl authenticate with an optional Bearer token. Returning a copy keeps
 * the exported `HOSTS` catalogue static, so a stale credential can never leak
 * into the next run through a mutated descriptor.
 * @param host - the engine definition from `HOSTS`.
 * @param options - the run options carrying credentials and the domain.
 * @returns the engine definition to use for this run.
 */
export declare function resolveHost(host: HostSpec, options: Pick<EngineRunOptions, 'anysearchApiKey' | 'anysearchDomain' | 'firecrawlApiKey'>): HostSpec;
export declare function search(query: string, signal: AbortSignal | undefined, options: EngineRunOptions): Promise<SearchOutcome>;
