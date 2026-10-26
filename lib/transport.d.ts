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
import type { HostSpec, SafeSearch, Source, TimeRange } from './types.ts';
import { SearchError } from './errors.ts';
import type { EngineHealth } from './health.ts';
/** Outcome of asking one engine once. */
export type AttemptOutcome = {
    ok: true;
    sources: Source[];
    route?: 'direct' | 'proxy';
} | {
    ok: false;
    error: SearchError;
};
/**
 * Ask one engine, choosing its first route from health and host policy.
 *
 * A domestic engine normally goes direct first, because that is both faster
 * and the path its site expects. If direct fails, the tunnel is tried; if the
 * tunnel succeeds, a short-lived health preference makes the next request try
 * it first. The alternate route is still kept as a fallback, so a tunnel that
 * goes down does not make the engine disappear. An engine marked `viaProxy` is
 * tunnelled from the start, with the direct route as its fallback.
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
/**
 * Push the configured content filter down to the engines that accept one.
 *
 * `off` leaves the URL untouched on purpose: the engine then keeps its own
 * default, which is what every search did before this option existed. Only a
 * non-default choice changes the request, so old URLs and cached fixtures stay
 * valid.
 *
 * @param hostId - engine id.
 * @param url - the URL the engine definition built.
 * @param safeSearch - configured level.
 * @returns the URL to request.
 */
export declare function withSafeSearch(hostId: string, url: string, safeSearch: SafeSearch | undefined): string;
export declare function searchHost(host: HostSpec, query: string, signal: AbortSignal | undefined, timeoutMs?: number, proxy?: string, timeRange?: TimeRange, safeSearch?: SafeSearch, health?: EngineHealth): Promise<AttemptOutcome>;
