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
export class Semaphore {
    active = 0;
    waiting = [];
    permits;
    /**
     * @param permits - how many holders may run at once; at least one.
     */
    constructor(permits) {
        this.permits = permits;
        if (!Number.isInteger(permits) || permits < 1) {
            throw new Error(`a semaphore needs at least one permit, got ${permits}`);
        }
    }
    /** Holders currently inside the gate. */
    get running() {
        return this.active;
    }
    /** Waiters queued behind the gate. */
    get pending() {
        return this.waiting.length;
    }
    /**
     * Take a permit, waiting for one when the gate is full.
     * @param signal - caller cancellation; waiting rejects when it fires.
     * @returns the release function; calling it more than once is harmless.
     */
    async acquire(signal) {
        if (signal?.aborted === true)
            throw signal.reason ?? new Error('the wait was cancelled');
        if (this.active < this.permits) {
            this.active += 1;
            return this.releaser();
        }
        return new Promise((resolve, reject) => {
            const grant = () => {
                cleanup();
                this.active += 1;
                resolve(this.releaser());
            };
            const onAbort = () => {
                cleanup();
                const index = this.waiting.indexOf(grant);
                if (index >= 0)
                    this.waiting.splice(index, 1);
                reject(signal?.reason ?? new Error('the wait was cancelled'));
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiting.push(grant);
        });
    }
    /** Build the idempotent release function handed to the caller. */
    releaser() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.active -= 1;
            const next = this.waiting.shift();
            if (next !== undefined)
                next();
        };
    }
}
/** Gates keyed by engine id; created lazily and never removed. */
const gates = new Map();
/**
 * Get the process-wide gate for one engine.
 * @param id - engine id.
 * @param permits - concurrency limit declared by the engine.
 * @returns the shared semaphore.
 */
export function gateFor(id, permits) {
    const existing = gates.get(id);
    if (existing !== undefined)
        return existing;
    const created = new Semaphore(permits);
    gates.set(id, created);
    return created;
}
/** Drop cached gates; used by tests. */
export function resetGates() {
    gates.clear();
}
