/**
 * Per-engine health and cooldown tracking.
 *
 * Scraping public result pages is not a supported interface: an engine that
 * decided this client is a robot stays that way for a while, and re-triggering
 * it on every search makes the failure list long without improving results.
 * This tracker gives such an engine a rest.
 *
 * The wait is not a fixed constant: when the service sends its own
 * `Retry-After` hint (surfaced as {@link SearchError.retryAfterMs}) that hint
 * wins. Otherwise the cooldown doubles on every consecutive failure up to a
 * ceiling, so a transient blip costs one short rest while a sustained block
 * quickly backs off to the maximum.
 *
 * Two failure classes never cool down, because retrying cannot change them:
 * `SEARCH_PARSE` (markup drift in the parser) and `SEARCH_ABORTED` (the caller
 * cancelled).
 *
 * @module @fangchenghao/dsh-web-search/health
 */
import type { HealthOptions } from './types.ts';
import type { SearchError } from './errors.ts';
/**
 * Track which engines are resting and for how long.
 *
 * Every method takes an optional `now`, so callers can share one timestamp per
 * search and tests can move time without timers.
 */
export declare class EngineHealth {
    /** Cooldown after the first failure without a hint. */
    private readonly baseCooldownMs;
    /** Hard ceiling for any cooldown, including a `Retry-After` hint. */
    private readonly maxCooldownMs;
    /** Current state per engine id. */
    private readonly records;
    /**
     * @param options - base cooldown and ceiling, both optional.
     */
    constructor(options?: HealthOptions);
    /**
     * Record a failure and open (or extend) the engine's cooldown.
     *
     * A finite `retryAfterMs > 0` wins outright, clamped to the ceiling.
     * Otherwise the wait is `base * 2 ** (consecutiveFailures - 1)`, clamped to
     * the ceiling. Permanent codes are ignored entirely: they neither cool the
     * engine down nor cancel a cooldown already in effect.
     *
     * @param id - engine id.
     * @param error - the failure the engine raised.
     * @param now - shared timestamp; defaults to `Date.now`.
     */
    noteFailure(id: string, error: SearchError, now?: number): void;
    /**
     * Record a successful answer: the engine is usable again and its failure
     * streak is over.
     *
     * @param id - engine id.
     */
    noteSuccess(id: string): void;
    /**
     * @param id - engine id.
     * @param now - shared timestamp; defaults to `Date.now`.
     * @returns whether the engine must be skipped at `now`.
     */
    isCooling(id: string, now?: number): boolean;
    /**
     * Build the caller-facing reason for skipping an engine.
     *
     * The remaining time is rounded up to whole seconds and the failure code is
     * included so a failure list stays diagnostic.
     *
     * @param id - engine id.
     * @param now - shared timestamp; defaults to `Date.now`.
     * @returns a reason such as `cooling down for another 2m 10s after
     *   SEARCH_THROTTLED`, or `undefined` when the engine is usable.
     */
    skipped(id: string, now?: number): string | undefined;
    /**
     * @param now - shared timestamp; defaults to `Date.now`.
     * @returns engine id to remaining cooldown in milliseconds, for engines
     *   currently resting; usable engines are omitted.
     */
    snapshot(now?: number): Record<string, number>;
    /** Forget every engine, including failure streaks. */
    clear(): void;
}
