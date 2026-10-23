/**
 * Credential rotation for the one optional key this plugin understands.
 *
 * AnySearch is the only engine with a credential, and it is optional: without a
 * key the plugin stays anonymous at a lower rate limit. A user who does hold
 * several keys should not have to edit Settings when one runs out mid-day, so
 * the plugin accepts a list and rotates through it. A key that answers 401 is
 * retired until Settings change; a key that answers 429 rests on an exponential
 * schedule, exactly like a throttled engine.
 *
 * The pool lives outside the search run because its whole point is memory: the
 * second request must know that the first key ran out. Pools are cached by the
 * raw Settings string, so editing the field creates a fresh pool and reverting
 * it restores the old one.
 *
 * @module @fangchenghao/dsh-web-search/keys
 */
/** Seconds in a day, used for the 401 rest. */
const DAY_MS = 86_400_000;
/** Keys separated by anything a person might type. */
const SEPARATOR = /[\s,;]+/u;
/** Placeholder-looking values users paste from documentation. */
const PLACEHOLDER = /^(?:your[-_ ]?key|api[-_ ]?key|token|none|null|undefined|x{3,})$/iu;
/**
 * Split a Settings value into usable keys.
 * @param raw - comma/newline/space separated keys, or a single key.
 * @returns distinct keys, in the order given.
 */
export function parseApiKeys(raw) {
    if (typeof raw !== 'string')
        return [];
    const seen = new Set();
    const keys = [];
    for (const part of raw.split(SEPARATOR)) {
        const key = part.trim();
        if (key.length === 0 || PLACEHOLDER.test(key) || seen.has(key))
            continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}
/**
 * Decide whether an error blames the key rather than the engine.
 * @param error - classified search or fetch failure.
 * @returns the kind of key failure, or `undefined` when the key is not at fault.
 */
export function keyFailureKind(error) {
    if (error === undefined)
        return undefined;
    if (error.code === 'SEARCH_THROTTLED')
        return 'throttled';
    const message = error.message ?? '';
    if (/HTTP 401|invalid api key|api key (?:is )?invalid|unauthori[sz]ed/iu.test(message))
        return 'unauthorized';
    if (/HTTP 403|forbidden/iu.test(message))
        return 'blocked';
    return undefined;
}
/**
 * A rotating set of keys with per-key cooldowns.
 *
 * `pick` never returns a resting key; when every key rests it returns
 * `undefined` and callers fall back to anonymous access. That is deliberate: a
 * rejected key retried immediately is how a temporary 429 becomes a longer
 * ban.
 */
export class KeyPool {
    keys;
    states = new Map();
    now;
    unauthorizedMs;
    throttleBaseMs;
    throttleMaxMs;
    blockedMs;
    cursor = 0;
    constructor(keys, options = {}) {
        this.keys = [...keys];
        this.now = options.now ?? Date.now;
        this.unauthorizedMs = options.unauthorizedCooldownMs ?? DAY_MS;
        this.throttleBaseMs = options.throttleBaseMs ?? 60_000;
        this.throttleMaxMs = options.throttleMaxMs ?? 1_800_000;
        this.blockedMs = options.blockedCooldownMs ?? 600_000;
    }
    /** Number of configured keys. */
    get size() {
        return this.keys.length;
    }
    /** True when every configured key is resting. */
    allCooling(now = this.now()) {
        return this.keys.length > 0 && this.keys.every((key) => this.cooldownLeft(key, now) > 0);
    }
    /** Milliseconds until this key may be used again; 0 means now. */
    cooldownLeft(key, now = this.now()) {
        const state = this.states.get(key);
        return state === undefined ? 0 : Math.max(0, state.cooldownUntil - now);
    }
    /**
     * Take the next available key, round-robin.
     * @param now - clock override.
     * @returns a usable key, or `undefined` when none is configured or all rest.
     */
    pick(now = this.now()) {
        const count = this.keys.length;
        if (count === 0)
            return undefined;
        for (let offset = 0; offset < count; offset += 1) {
            const index = (this.cursor + offset) % count;
            const key = this.keys[index];
            if (this.cooldownLeft(key, now) === 0) {
                this.cursor = (index + 1) % count;
                return key;
            }
        }
        return undefined;
    }
    /**
     * Record that a key worked: clear its strikes and any rest.
     * @param key - the key that answered.
     */
    reward(key) {
        this.states.set(key, { cooldownUntil: 0, strikes: 0 });
    }
    /**
     * Rest a key after a failure it caused.
     * @param key - the rejected key.
     * @param kind - why it was rejected.
     * @param now - clock override.
     * @returns milliseconds until the key may be tried again.
     */
    penalize(key, kind, now = this.now()) {
        const previous = this.states.get(key);
        const strikes = kind === 'throttled' ? (previous?.strikes ?? 0) + 1 : (previous?.strikes ?? 0);
        const rest = kind === 'unauthorized'
            ? this.unauthorizedMs
            : kind === 'blocked'
                ? this.blockedMs
                : Math.min(this.throttleMaxMs, this.throttleBaseMs * 2 ** Math.max(0, strikes - 1));
        this.states.set(key, { cooldownUntil: now + rest, strikes });
        return rest;
    }
}
/** Pools keyed by the exact Settings value, so an edit starts clean. */
const pools = new Map();
/**
 * Get or create the pool for a Settings value.
 * @param raw - the `anysearchApiKey` field.
 * @returns a stable pool for this key list.
 */
export function keyPoolFor(raw) {
    const keys = parseApiKeys(raw ?? '');
    const signature = keys.join('\n');
    const existing = pools.get(signature);
    if (existing !== undefined)
        return existing;
    const created = new KeyPool(keys);
    pools.set(signature, created);
    return created;
}
/** Drop cached pools; used by tests and after a Settings save. */
export function resetKeyPools() {
    pools.clear();
}
