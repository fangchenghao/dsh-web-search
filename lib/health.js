/** Default cooldown after the first failure without a wait hint. */
const DEFAULT_BASE_COOLDOWN_MS = 300_000;
/** Default ceiling for the exponential backoff. */
const DEFAULT_MAX_COOLDOWN_MS = 1_800_000;
/** Codes for which a later retry cannot help, so they must not cool down. */
const PERMANENT_CODES = new Set(['SEARCH_PARSE', 'SEARCH_ABORTED']);
/** Accept only a usable non-negative duration; fall back on the default. */
function normaliseDuration(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}
/** Render whole seconds in the compact `2m 10s` form used in failure lists. */
function formatDuration(totalSeconds) {
    const seconds = Math.max(1, totalSeconds);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes === 0)
        return `${rest}s`;
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
    baseCooldownMs;
    /** Hard ceiling for any cooldown, including a `Retry-After` hint. */
    maxCooldownMs;
    /** Current state per engine id. */
    records = new Map();
    /**
     * @param options - base cooldown and ceiling, both optional.
     */
    constructor(options = {}) {
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
    noteFailure(id, error, now = Date.now()) {
        if (PERMANENT_CODES.has(error.code))
            return;
        const previous = this.records.get(id);
        const failures = (previous?.failures ?? 0) + 1;
        let cooldownMs = this.baseCooldownMs * 2 ** (failures - 1);
        const hint = error.retryAfterMs;
        if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0)
            cooldownMs = hint;
        cooldownMs = Math.min(cooldownMs, this.maxCooldownMs);
        this.records.set(id, { failures, until: now + cooldownMs, code: error.code });
    }
    /**
     * Record a successful answer: the engine is usable again and its failure
     * streak is over.
     *
     * @param id - engine id.
     */
    noteSuccess(id) {
        this.records.delete(id);
    }
    /**
     * @param id - engine id.
     * @param now - shared timestamp; defaults to `Date.now`.
     * @returns whether the engine must be skipped at `now`.
     */
    isCooling(id, now = Date.now()) {
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
    skipped(id, now = Date.now()) {
        const record = this.records.get(id);
        if (record === undefined || record.until <= now)
            return undefined;
        const seconds = Math.ceil((record.until - now) / 1_000);
        return `cooling down for another ${formatDuration(seconds)} after ${record.code}`;
    }
    /**
     * @param now - shared timestamp; defaults to `Date.now`.
     * @returns engine id to remaining cooldown in milliseconds, for engines
     *   currently resting; usable engines are omitted.
     */
    snapshot(now = Date.now()) {
        const snapshot = {};
        for (const [id, record] of this.records) {
            const remaining = record.until - now;
            if (remaining > 0)
                snapshot[id] = remaining;
        }
        return snapshot;
    }
    /** Forget every engine, including failure streaks. */
    clear() {
        this.records.clear();
    }
}
