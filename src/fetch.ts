/**
 * The fetch half: `web_fetch` for a network where a direct request is not
 * always enough.
 *
 * The shipped `http` provider issues one direct request. That is enough on an
 * open network, but on a restricted one it is not: measured here, a direct
 * request to `github.com` or `html.duckduckgo.com` times out while the same URL
 * answers through the local tunnel in one to three seconds. Searching therefore
 * found pages the agent could never read.
 *
 * This provider closes that loop with a three-step ladder:
 *
 * 1. direct, which is what the shipped provider already does and stays first so
 *    an open network pays no tunnel round trip;
 * 2. the tunnel, using the same proxy resolution the search side uses (explicit
 *    option, then the environment, then the macOS system proxy);
 * 3. AnySearch's extraction endpoint, when a key is configured — it renders the
 *    page server-side, so it also rescues a page that answers 403 to a bare
 *    request.
 *
 * A non-2xx response is a result, not a failure, and a failure on one rung is
 * not fatal: the ladder only throws when every rung is unavailable or failed.
 *
 * @module dsh-web-search-bing/fetch
 */
import { SearchError } from './errors.ts';
import { proxyGet, resolveProxy } from './proxy.ts';

/** One retrieval outcome, mirroring the Host's `WebFetchResult`. */
export interface FetchOutcome {
  readonly url: string;
  readonly statusCode: number;
  readonly body: { readonly kind: 'html' | 'text'; readonly content: string };
  readonly truncated: boolean;
}

/** What `ctx.web.registerFetchProvider` expects. */
export interface FetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<FetchOutcome>;
}

/** Construction options for the provider. */
export interface FetchProviderOptions {
  /** Provider id, registered under `fetchProvider` in the Host config. */
  id?: string;
  /** Per-attempt deadline in milliseconds. */
  timeoutMs?: number;
  /** Explicit tunnel URL, overriding detection. Empty means detect. */
  proxy?: string;
  /** `false` disables the tunnel rung entirely. */
  useProxy?: boolean;
  /** AnySearch key; enables the extraction rung when present. */
  anysearchApiKey?: string;
  /** Bytes kept from a response; the Host applies its own cap too. */
  maxBytes?: number;
  /** User agent sent on every rung. */
  userAgent?: string;
}

/** Injected transports, so the ladder is testable without a network. */
export interface FetchDependencies {
  /** Direct request. */
  direct: (url: string, timeoutMs: number, signal: AbortSignal | undefined, userAgent: string, maxBytes: number) => Promise<FetchOutcome>;
  /** Tunnelled request. */
  tunnel: (url: string, proxy: string, timeoutMs: number, signal: AbortSignal | undefined, userAgent: string, maxBytes: number) => Promise<FetchOutcome>;
  /** AnySearch extraction. */
  extract: (url: string, apiKey: string, timeoutMs: number, signal: AbortSignal | undefined) => Promise<FetchOutcome>;
  /** Proxy discovery. */
  detectProxy: (explicit: string | undefined) => Promise<string | undefined>;
}

/** Default user agent; kept in step with the search side. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** One mebibyte: enough for a documentation page, cheap enough to hold. */
const DEFAULT_MAX_BYTES = 1_048_576;

/** Default per-attempt deadline. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Pick the body kind from the content type, defaulting to text. */
function kindOf(contentType: string | null): 'html' | 'text' {
  if (contentType === null) return 'text';
  const value = contentType.toLowerCase();
  if (value.includes('html') || value.includes('xml')) return 'html';
  return 'text';
}

/**
 * Cut a body at the byte budget without splitting a surrogate pair.
 * @param text - the decoded body.
 * @param maxBytes - the byte budget.
 * @returns the body and whether it was cut.
 */
function clamp(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { content: text, truncated: false };
  return { content: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * Combine a caller signal with the per-attempt deadline.
 * @param timeoutMs - the deadline.
 * @param signal - the caller signal, when present.
 * @returns the signal to pass to `fetch`.
 */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}

/** Direct request used by the first rung. */
async function directFetch(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  userAgent: string,
  maxBytes: number,
): Promise<FetchOutcome> {
  const response = await fetch(url, {
    signal: deadline(timeoutMs, signal),
    redirect: 'follow',
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
  });
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  const { content, truncated } = clamp(text, maxBytes);
  return { url: response.url === '' ? url : response.url, statusCode: response.status, body: { kind: kindOf(contentType), content }, truncated };
}

/** Tunnelled request used by the second rung. */
async function tunnelFetch(
  url: string,
  proxy: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  userAgent: string,
  maxBytes: number,
): Promise<FetchOutcome> {
  const response = await proxyGet(url, {
    proxy,
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  const { content, truncated } = clamp(response.text, maxBytes);
  return {
    url,
    statusCode: response.status,
    body: { kind: kindOf(response.headers?.['content-type'] ?? null), content },
    truncated,
  };
}

/** Server-side extraction used by the third rung. */
async function extractFetch(
  url: string,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const response = await fetch('https://api.anysearch.com/v1/extract', {
    method: 'POST',
    signal: deadline(timeoutMs, signal),
    headers: { 'user-agent': USER_AGENT, 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new SearchError(`anysearch extract: HTTP ${response.status}`, 'SEARCH_BLOCKED', true);
  const payload = (await response.json()) as { code?: number; message?: string; data?: { title?: string; content?: string } };
  if (payload.code !== 0 || typeof payload.data?.content !== 'string') {
    throw new SearchError(`anysearch extract: ${payload.message ?? 'no content'}`, 'SEARCH_BLOCKED', true);
  }
  const title = typeof payload.data.title === 'string' && payload.data.title.length > 0 ? `# ${payload.data.title}\n\n` : '';
  return { url, statusCode: 200, body: { kind: 'text', content: `${title}${payload.data.content}` }, truncated: false };
}

/**
 * Build the fetch provider.
 * @param options - timeouts, tunnel and extraction settings.
 * @param overrides - transport overrides, for tests.
 * @returns a provider suitable for `ctx.web.registerFetchProvider`.
 */
export function createFetchProvider(options: FetchProviderOptions = {}, overrides: Partial<FetchDependencies> = {}): FetchProvider {
  const deps: FetchDependencies = {
    direct: directFetch,
    tunnel: tunnelFetch,
    extract: extractFetch,
    detectProxy: (explicit) => resolveProxy(explicit),
    ...overrides,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? USER_AGENT;
  const apiKey = (options.anysearchApiKey ?? '').trim();

  return {
    id: options.id ?? 'http-proxy',
    available: () => true,
    async fetch(request, signal) {
      const target = request.url;
      if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
        throw new SearchError(`not an http(s) URL: ${String(target)}`, 'SEARCH_PARSE', false);
      }

      const failures: string[] = [];
      /** True once the caller cancelled; a cancellation must not be retried. */
      const cancelled = (): boolean => signal !== undefined && signal.aborted;

      try {
        return await deps.direct(target, timeoutMs, signal, userAgent, maxBytes);
      } catch (error) {
        if (cancelled()) throw error;
        failures.push(`direct: ${error instanceof Error ? error.message : String(error)}`);
      }

      let proxy: string | undefined;
      if (options.useProxy !== false) {
        try {
          proxy = options.proxy !== undefined && options.proxy.length > 0 ? options.proxy : await deps.detectProxy(options.proxy);
        } catch (error) {
          failures.push(`proxy: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (proxy !== undefined && proxy.length > 0) {
        try {
          return await deps.tunnel(target, proxy, timeoutMs, signal, userAgent, maxBytes);
        } catch (error) {
          if (cancelled()) throw error;
          failures.push(`tunnel: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (apiKey.length > 0) {
        try {
          return await deps.extract(target, apiKey, timeoutMs, signal);
        } catch (error) {
          if (cancelled()) throw error;
          failures.push(`extract: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      throw new SearchError(`cannot fetch ${target} (${failures.join('; ')})`, 'SEARCH_NETWORK', true);
    },
  };
}
