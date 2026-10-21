/**
 * The error every engine layer throws.
 *
 * A leaf module on purpose: both the transport and the orchestrator extend it,
 * and neither should import the other. `retryAfterMs` carries the service's own
 * wait hint (an HTTP `Retry-After`) so the cooldown can honour it instead of
 * guessing a fixed duration.
 *
 * @module dsh-web-search-bing/errors
 */
import type { SearchErrorCode } from './types.ts';

/** Failure raised by one engine, carrying its business code. */
export class SearchError extends Error {
  /** Business code, used for cooldown decisions and for caller diagnostics. */
  readonly code: SearchErrorCode;
  /** Whether retrying the same engine later could succeed. */
  readonly retryable: boolean;
  /** The service's own wait hint in milliseconds, when it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, code: SearchErrorCode, retryable = true, retryAfterMs?: number) {
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
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
