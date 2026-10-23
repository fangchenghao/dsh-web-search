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
export declare function searchHost(host: HostSpec, query: string, signal: AbortSignal | undefined, timeoutMs?: number, proxy?: string, timeRange?: TimeRange): Promise<AttemptOutcome>;
