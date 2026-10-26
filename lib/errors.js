/** Failure raised by one engine, carrying its business code. */
export class SearchError extends Error {
    /** Business code, used for cooldown decisions and for caller diagnostics. */
    code;
    /** Whether retrying the same engine later could succeed. */
    retryable;
    /** The service's own wait hint in milliseconds, when it sent one. */
    retryAfterMs;
    /** HTTP status when the failure came from a response. */
    status;
    constructor(message, code, retryable = true, retryAfterMs, status) {
        super(message);
        this.name = 'SearchError';
        this.code = code;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.status = status;
    }
}
/**
 * Classify one engine failure into an actionable kind.
 *
 * The mapping is deliberately conservative: only a response status that says
 * the credential or quota is the problem becomes `auth`/`quota`; an unexplained
 * 403 is treated as a bot wall, because retrying the same request cannot fix a
 * missing key but a wall often clears on its own.
 *
 * @param error - the classified engine failure.
 * @returns the kind used by `fallbackOn` and diagnostics.
 */
export function classifyFailure(error) {
    if (error.code === 'SEARCH_THROTTLED' || error.code === 'SEARCH_TIMEOUT')
        return 'transient';
    if (error.code === 'SEARCH_NETWORK')
        return 'transient';
    if (error.code === 'SEARCH_PARSE' || error.code === 'SEARCH_EMPTY' || error.code === 'SEARCH_UNSUPPORTED') {
        return 'invalid-response';
    }
    if (error.code === 'SEARCH_BLOCKED' || error.code === 'SEARCH_HTTP_STATUS') {
        if (error.status === 401)
            return 'auth';
        if (error.status === 402)
            return 'quota';
        if (error.status === 429)
            return 'transient';
        if (error.status !== undefined && error.status >= 500)
            return 'transient';
        if (/\b(quota|credit|out of budget|limit exceeded)\b/iu.test(error.message))
            return 'quota';
        if (/\b(unauthori[sz]ed|authenticat(?:ion|ed)?|api[ _-]?key|credential)\b/iu.test(error.message))
            return 'auth';
        return 'bot-wall';
    }
    return 'unknown';
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
