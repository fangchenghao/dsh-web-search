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
import type { HealthOptions, SearchErrorCode } from './types.ts';
import type { SearchError } from './errors.ts';

/** Default cooldown after the first failure without a wait hint. */
const DEFAULT_BASE_COOLDOWN_MS = 300_000;

/** Default ceiling for the exponential backoff. */
const DEFAULT_MAX_COOLDOWN_MS = 1_800_000;

/** How long a successful proxy detour is remembered for an engine. */
const DEFAULT_ROUTE_PREFERENCE_MS = 600_000;

/** Codes for which a later retry cannot help, so they must not cool down. */
const PERMANENT_CODES: ReadonlySet<SearchErrorCode> = new Set<SearchErrorCode>(['SEARCH_PARSE', 'SEARCH_ABORTED']);

/** What the tracker remembers about one engine. */
interface HealthRecord {
  /** Consecutive service failures, reset by {@link EngineHealth.noteSuccess}. */
  failures: number;
  /** Timestamp until which the engine is resting; may already be in the past. */
  until: number;
  /** Code of the failure that opened the current cooldown. */
  code: SearchErrorCode;
}

/** A remembered, temporary transport preference for one engine. */
interface RoutePreference {
  /** Timestamp until which the proxy should be tried first. */
  until: number;
}

/** Accept only a usable non-negative duration; fall back on the default. */
function normaliseDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** Render whole seconds in the compact `2m 10s` form used in failure lists. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(1, totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Track which engines are resting and for how long.
 *
 * Every method takes an optional `now`, so callers can share one timestamp per
 * search and tests can move time without timers.
 */
export class EngineHealth {
  /** Cooldown after the first failure without a hint. */
  private readonly baseCooldownMs: number;
  /** Hard ceiling for any cooldown, including a `Retry-After` hint. */
  private readonly maxCooldownMs: number;
  /** Current state per engine id. */
  private readonly records = new Map<string, HealthRecord>();
  /** Engines whose direct route recently failed while the proxy worked. */
  private readonly routePreferences = new Map<string, RoutePreference>();

  /**
   * @param options - base cooldown and ceiling, both optional.
   */
  constructor(options: HealthOptions = {}) {
    this.baseCooldownMs = normaliseDuration(options.baseCooldownMs, DEFAULT_BASE_COOLDOWN_MS);
    this.maxCooldownMs = normaliseDuration(options.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS);
  }

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
  noteFailure(id: string, error: SearchError, now: number = Date.now()): void {
    if (PERMANENT_CODES.has(error.code)) return;
    const previous = this.records.get(id);
    const failures = (previous?.failures ?? 0) + 1;
    let cooldownMs = this.baseCooldownMs * 2 ** (failures - 1);
    const hint = error.retryAfterMs;
    if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) cooldownMs = hint;
    cooldownMs = Math.min(cooldownMs, this.maxCooldownMs);
    this.records.set(id, { failures, until: now + cooldownMs, code: error.code });
  }

  /**
   * Record a successful answer: the engine is usable again and its failure
   * streak is over.
   *
   * @param id - engine id.
   */
  noteSuccess(id: string): void {
    this.records.delete(id);
  }

  /**
   * Remember which route worked, so a blocked direct path is not paid for on
   * every request. Only a proxy success creates a preference: a direct success
   * clears it, because the direct path is normally faster and should win again
   * as soon as it recovers.
   *
   * @param id - engine id.
   * @param route - the route that produced the answer.
   * @param now - shared timestamp; defaults to `Date.now`.
   */
  noteRouteSuccess(id: string, route: 'direct' | 'proxy', now: number = Date.now()): void {
    if (route === 'direct') {
      this.routePreferences.delete(id);
      return;
    }
    this.routePreferences.set(id, { until: now + DEFAULT_ROUTE_PREFERENCE_MS });
  }

  /**
   * @param id - engine id.
   * @param now - shared timestamp; defaults to `Date.now`.
   * @returns whether the engine should try its tunnel before its direct route.
   */
  preferProxy(id: string, now: number = Date.now()): boolean {
    const preference = this.routePreferences.get(id);
    if (preference === undefined) return false;
    if (preference.until <= now) {
      this.routePreferences.delete(id);
      return false;
    }
    return true;
  }

  /**
   * @param id - engine id.
   * @param now - shared timestamp; defaults to `Date.now`.
   * @returns whether the engine must be skipped at `now`.
   */
  isCooling(id: string, now: number = Date.now()): boolean {
    const record = this.records.get(id);
    return record !== undefined && record.until > now;
  }

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
  skipped(id: string, now: number = Date.now()): string | undefined {
    const record = this.records.get(id);
    if (record === undefined || record.until <= now) return undefined;
    const seconds = Math.ceil((record.until - now) / 1_000);
    return `cooling down for another ${formatDuration(seconds)} after ${record.code}`;
  }

  /**
   * @param now - shared timestamp; defaults to `Date.now`.
   * @returns engine id to remaining cooldown in milliseconds, for engines
   *   currently resting; usable engines are omitted.
   */
  snapshot(now: number = Date.now()): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [id, record] of this.records) {
      const remaining = record.until - now;
      if (remaining > 0) snapshot[id] = remaining;
    }
    return snapshot;
  }

  /** Forget every engine, including failure streaks and route preferences. */
  clear(): void {
    this.records.clear();
    this.routePreferences.clear();
  }
}
