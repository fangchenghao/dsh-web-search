/**
 * A small counting semaphore for engines with a strict request budget.
 *
 * Exa's anonymous MCP endpoint and Firecrawl's keyless API answer one request at
 * a time gracefully and reject bursts with 429. `search_many` and `research`
 * legitimately fire several searches at once, so the limit has to live outside
 * one `search()` call: a global gate per host id, shared by every concurrent
 * caller in the process.
 *
 * Waiting is cancellable, and a permit is always returned through `finally` so
 * a rejected request cannot shrink the pool permanently.
 *
 * @module @fangchenghao/dsh-web-search/semaphore
 */
/** A counting semaphore whose waiters can be cancelled. */
export declare class Semaphore {
    private active;
    private readonly waiting;
    private readonly permits;
    /**
     * @param permits - how many holders may run at once; at least one.
     */
    constructor(permits: number);
    /** Holders currently inside the gate. */
    get running(): number;
    /** Waiters queued behind the gate. */
    get pending(): number;
    /**
     * Take a permit, waiting for one when the gate is full.
     * @param signal - caller cancellation; waiting rejects when it fires.
     * @returns the release function; calling it more than once is harmless.
     */
    acquire(signal?: AbortSignal): Promise<() => void>;
    /** Build the idempotent release function handed to the caller. */
    private releaser;
}
/**
 * Get the process-wide gate for one engine.
 * @param id - engine id.
 * @param permits - concurrency limit declared by the engine.
 * @returns the shared semaphore.
 */
export declare function gateFor(id: string, permits: number): Semaphore;
/** Drop cached gates; used by tests. */
export declare function resetGates(): void;
