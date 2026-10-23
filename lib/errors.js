/** Failure raised by one engine, carrying its business code. */
export class SearchError extends Error {
    /** Business code, used for cooldown decisions and for caller diagnostics. */
    code;
    /** Whether retrying the same engine later could succeed. */
    retryable;
    /** The service's own wait hint in milliseconds, when it sent one. */
    retryAfterMs;
    constructor(message, code, retryable = true, retryAfterMs) {
        super(message);
        this.name = 'SearchError';
        this.code = code;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}
/**
 * Read the `Retry-After` header of a response.
 * @param value - raw header value: delta-seconds, or an HTTP date.
 * @returns the wait in milliseconds, or `undefined` when absent or unparsable.
 */
export function parseRetryAfter(value, now = Date.now()) {
    if (value === undefined)
        return undefined;
    const text = value.trim();
    if (text === '')
        return undefined;
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
    }
    const at = Date.parse(text);
    if (Number.isNaN(at))
        return undefined;
    return Math.max(0, at - now);
}
