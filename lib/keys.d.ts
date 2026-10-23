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
/** Why a key was set aside. */
export type KeyFailureKind = 'unauthorized' | 'throttled' | 'blocked';
/** The part of an error this module classifies. */
export interface KeyFailureLike {
    code?: string;
    message?: string;
}
/** Tunable cooldowns. */
export interface KeyPoolOptions {
    /** Clock, for tests. */
    now?: () => number;
    /** How long a rejected key is retired, in ms. */
    unauthorizedCooldownMs?: number;
    /** First throttle rest, doubling per consecutive throttle. */
    throttleBaseMs?: number;
    /** Ceiling for the throttle rest. */
    throttleMaxMs?: number;
    /** How long a forbidden key rests. */
    blockedCooldownMs?: number;
}
/**
 * Split a Settings value into usable keys.
 * @param raw - comma/newline/space separated keys, or a single key.
 * @returns distinct keys, in the order given.
 */
export declare function parseApiKeys(raw: unknown): string[];
/**
 * Decide whether an error blames the key rather than the engine.
 * @param error - classified search or fetch failure.
 * @returns the kind of key failure, or `undefined` when the key is not at fault.
 */
export declare function keyFailureKind(error: KeyFailureLike | undefined): KeyFailureKind | undefined;
/**
 * A rotating set of keys with per-key cooldowns.
 *
 * `pick` never returns a resting key; when every key rests it returns
 * `undefined` and callers fall back to anonymous access. That is deliberate: a
 * rejected key retried immediately is how a temporary 429 becomes a longer
 * ban.
 */
export declare class KeyPool {
    readonly keys: readonly string[];
    private readonly states;
    private readonly now;
    private readonly unauthorizedMs;
    private readonly throttleBaseMs;
    private readonly throttleMaxMs;
    private readonly blockedMs;
    private cursor;
    constructor(keys: readonly string[], options?: KeyPoolOptions);
    /** Number of configured keys. */
    get size(): number;
    /** True when every configured key is resting. */
    allCooling(now?: number): boolean;
    /** Milliseconds until this key may be used again; 0 means now. */
    cooldownLeft(key: string, now?: number): number;
    /**
     * Take the next available key, round-robin.
     * @param now - clock override.
     * @returns a usable key, or `undefined` when none is configured or all rest.
     */
    pick(now?: number): string | undefined;
    /**
     * Record that a key worked: clear its strikes and any rest.
     * @param key - the key that answered.
     */
    reward(key: string): void;
    /**
     * Rest a key after a failure it caused.
     * @param key - the rejected key.
     * @param kind - why it was rejected.
     * @param now - clock override.
     * @returns milliseconds until the key may be tried again.
     */
    penalize(key: string, kind: KeyFailureKind, now?: number): number;
}
/**
 * Get or create the pool for a Settings value.
 * @param raw - the `anysearchApiKey` field.
 * @returns a stable pool for this key list.
 */
export declare function keyPoolFor(raw: string | undefined): KeyPool;
/** Drop cached pools; used by tests and after a Settings save. */
export declare function resetKeyPools(): void;
