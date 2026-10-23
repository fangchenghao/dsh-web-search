/**
 * One engine request, direct or tunnelled, classified.
 *
 * This module owns the only place where a transport failure becomes a
 * {@link SearchError} with a business code. That matters beyond diagnostics:
 * the engine health tracker decides from that code whether to cool the engine
 * down, and whether the service's own `Retry-After` should set the duration.
 *
 * @module @fangchenghao/dsh-web-search/transport
 */
import type { HostSpec, Source, TimeRange } from './types.ts';
import { SearchError } from './errors.ts';
/** Outcome of asking one engine once. */
export type AttemptOutcome = {
    ok: true;
    sources: Source[];
} | {
    ok: false;
    error: SearchError;
};
/**
 * Ask one engine, going direct first unless it is marked `viaProxy`.
 *
 * A domestic engine goes direct first, because that is both faster and the path
 * its site expects; only if that fails is it retried through the tunnel, so a
 * network that blocks it directly still works. An engine marked `viaProxy` is
 * tunnelled from the start.
 *
 * @param host - the engine.
 * @param query - the user query.
 * @param signal - cancellation.
 * @param timeoutMs - per-attempt deadline.
 * @param proxy - tunnel URL, or `undefined` when none is available.
 * @param timeRange - active publication window, forwarded to engines that can
 *   push it into their query (currently DuckDuckGo's `df`).
 * @returns the outcome of the route that got furthest; cancellation is rethrown.
 */
export declare function searchHost(host: HostSpec, query: string, signal: AbortSignal | undefined, timeoutMs?: number, proxy?: string, timeRange?: TimeRange): Promise<AttemptOutcome>;
