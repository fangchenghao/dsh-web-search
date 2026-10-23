/**
 * The error every engine layer throws.
 *
 * A leaf module on purpose: both the transport and the orchestrator extend it,
 * and neither should import the other. `retryAfterMs` carries the service's own
 * wait hint (an HTTP `Retry-After`) so the cooldown can honour it instead of
 * guessing a fixed duration.
 *
 * @module @fangchenghao/dsh-web-search/errors
 */
import type { SearchErrorCode } from './types.ts';
/** Failure raised by one engine, carrying its business code. */
export declare class SearchError extends Error {
    /** Business code, used for cooldown decisions and for caller diagnostics. */
    readonly code: SearchErrorCode;
    /** Whether retrying the same engine later could succeed. */
    readonly retryable: boolean;
    /** The service's own wait hint in milliseconds, when it sent one. */
    readonly retryAfterMs: number | undefined;
    constructor(message: string, code: SearchErrorCode, retryable?: boolean, retryAfterMs?: number);
}
/**
 * Read the `Retry-After` header of a response.
 * @param value - raw header value: delta-seconds, or an HTTP date.
 * @returns the wait in milliseconds, or `undefined` when absent or unparsable.
 */
export declare function parseRetryAfter(value: string | undefined, now?: number): number | undefined;
