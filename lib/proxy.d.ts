/** Proxy host, port and optional `Proxy-Authorization` value. */
export interface ProxyTarget {
    /** Proxy host name or IP literal, without brackets or port. */
    host: string;
    /** Proxy port; already defaulted to 80 or 443 by {@link parseProxy}. */
    port: number;
    /** Ready-to-send `Proxy-Authorization` header value, when credentials exist. */
    authorization?: string;
}
/** One HTTP response, after decoding, as the engines need it. */
export interface ProxyResponse {
    /** Final hop's status code; `0` when no response could be read. */
    status: number;
    /** Decoded (de-chunked, decompressed) body text. */
    text: string;
    /** Final hop's absolute URL, after any redirects. */
    url: string;
    /** Final hop's headers, names lowercased. */
    headers: Record<string, string>;
}
/** Inputs accepted by {@link proxyGet}. */
export interface ProxyRequestOptions {
    /** Proxy URL to tunnel through; required, this transport never goes direct. */
    proxy: string;
    /** Extra request headers, written after the built-in ones. */
    headers?: Record<string, string>;
    /** Per-hop deadline in milliseconds; defaults to 15000. */
    timeoutMs?: number;
    /** Caller cancellation, aborted as a rejection. */
    signal?: AbortSignal;
    /** Redirect hops to follow; defaults to 4. */
    redirects?: number;
    /** Request method; `GET` unless this is `POST`. */
    method?: 'GET' | 'POST';
    /** Request body, sent verbatim for `POST`. */
    body?: string;
}
/** A raw response split into its parts, before it is mapped to `{ url }`. */
export interface ParsedResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
}
/**
 * Parse a proxy URL, accepting only the schemes `CONNECT` can tunnel through.
 *
 * `http:` is the normal case; `https:` is accepted for its default port only —
 * the tunnel itself is always opened with a plain `CONNECT`, because the
 * request written inside it is already TLS for `https:` targets.
 *
 * @param raw - candidate `http://[user:pass@]host[:port]` string.
 * @returns the proxy host, port and optional `Proxy-Authorization` value.
 * @throws `Error` on an empty value, an unsupported scheme or an unparsable URL.
 */
export declare function parseProxy(raw: string): ProxyTarget;
/**
 * Whether a `NO_PROXY` value names only loopback destinations.
 *
 * This transport only tunnels requests to public search hosts, so a list like
 * `localhost,127.0.0.1` — the usual shell default — cannot apply to anything it
 * sends and must not be read as "do not use the proxy". An empty value counts as
 * loopback-only: there is nothing it could bypass.
 *
 * @param raw - the `NO_PROXY`/`no_proxy` value, if set.
 * @returns `true` when every entry is a loopback host (with optional port).
 */
export declare function noProxyIsLoopbackOnly(raw: string | undefined): boolean;
/**
 * Read the proxy from the conventional environment variables.
 *
 * Order: `DSH_WEB_SEARCH_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `HTTP_PROXY`, each
 * in upper and lower case. Values that are not plain `http://` proxies are
 * skipped rather than treated as a failure.
 *
 * @param env - environment to read; defaults to `process.env`.
 * @returns the proxy URL, or `undefined` when the environment names none.
 */
export declare function proxyFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Read the macOS system proxy (`scutil --proxy`), which is where a Clash-style
 * client publishes `127.0.0.1:7890` when "set as system proxy" is on.
 *
 * @returns the HTTPS/HTTP proxy URL, or `undefined` on any other platform or
 *   when no proxy is enabled.
 */
export declare function proxyFromSystem(): Promise<string | undefined>;
/**
 * Decide which proxy to use, if any.
 *
 * Order: an explicit plugin setting, the cached decision, the environment, then
 * the macOS system proxy. The system proxy is only honoured when its port
 * accepts a connection, so turning the tunnel off degrades to a direct request
 * instead of breaking search. The decision is cached for a minute.
 *
 * @param explicit - the plugin's `proxy` config value.
 * @returns the proxy URL to use, or `undefined` for a direct request.
 */
export declare function resolveProxy(explicit?: string): Promise<string | undefined>;
/**
 * Split a raw response into status, headers and body text.
 *
 * Pure: no socket, no network. Exported so the framing can be tested without a
 * proxy, which is where the de-chunking and decompression rules are decided.
 * Header names are lowercased so callers can index them directly.
 *
 * @param buffer - the bytes received from the socket.
 * @returns the parsed response, or `undefined` when the head is incomplete.
 */
export declare function readResponse(buffer: Buffer): ParsedResponse | undefined;
/**
 * Perform a request through the proxy, following redirects.
 *
 * `GET` unless `options.method` is `POST`, in which case `options.body` is sent
 * verbatim with a content length. Search APIs that take a JSON body need this;
 * the scraped result pages do not.
 *
 * Redirects are followed hop by hop, re-opening the tunnel per hop. `307`/`308`
 * preserve the method and body, because the target is explicitly asking for the
 * same request at a new address; every other `3xx` downgrades a `POST` to a
 * `GET` without a body, which is what the older semantics require and what the
 * AnySearch endpoint expects when it moves.
 *
 * @param url - absolute `http(s)` URL.
 * @param options - `proxy`, `headers`, `timeoutMs`, `signal`, `redirects`,
 *   `method` and `body`.
 * @returns `{ status, text, url, headers }` for the final hop.
 */
export declare function proxyGet(url: string, options: ProxyRequestOptions): Promise<ProxyResponse>;
