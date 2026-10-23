/**
 * Proxy-aware HTTP transport for the search engines.
 *
 * Node's global `fetch` neither reads the macOS system proxy settings nor the
 * conventional `HTTPS_PROXY` variables: undici ignores them unless the process
 * is started with `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`), which cannot be
 * turned on from inside a running process. `undici.ProxyAgent` is not reachable
 * either — Node does not export `undici` as a module.
 *
 * So when a proxy is configured this module speaks to it directly: it opens an
 * HTTP `CONNECT` tunnel, upgrades it with TLS for `https:` targets, and writes
 * the request itself. That keeps proxying scoped to this plugin — the rest of
 * the app keeps using the ordinary network path.
 *
 * The raw-socket path and the redirect rules below were established by live
 * debugging and are load-bearing; treat them as a specification.
 *
 * @module @fangchenghao/dsh-web-search/proxy
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
/** How long a resolved proxy decision stays valid, in milliseconds. */
const CACHE_MS = 60_000;
/** Default per-request deadline, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default number of redirect hops to follow. */
const DEFAULT_REDIRECTS = 4;
/**
 * Environment variables read by {@link proxyFromEnv}, highest precedence first.
 * Both casings are listed because shells disagree about which one they export.
 */
const ENV_KEYS = [
    'DSH_WEB_SEARCH_PROXY',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
];
/** Cached proxy decision: `{ at, proxy }`, where `proxy` may be `undefined`. */
let cached;
/** Decode one URL credential, tolerating a malformed percent escape. */
function decodeCredential(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
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
export function parseProxy(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0)
        throw new Error('proxy URL must be a non-empty string');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`unparsable proxy URL: ${JSON.stringify(raw)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`unsupported proxy scheme ${JSON.stringify(url.protocol)} in ${JSON.stringify(raw)}: only http:// and https:// proxies are supported`);
    }
    if (url.hostname.length === 0)
        throw new Error(`proxy URL has no host: ${JSON.stringify(raw)}`);
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`proxy URL has an invalid port: ${JSON.stringify(raw)}`);
    }
    const username = decodeCredential(url.username);
    const password = decodeCredential(url.password);
    const authorization = username.length === 0 && password.length === 0 ? undefined : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    return { host: url.hostname, port, ...(authorization === undefined ? {} : { authorization }) };
}
/**
 * Parse a proxy string for the detection paths, which treat an unusable value
 * as "not configured" rather than as an error.
 *
 * Only `http:` is accepted here, matching the original transport: an `https:`
 * proxy URL elsewhere in the environment must not select a tunnel that this
 * module cannot actually speak.
 */
function proxyUrl(value) {
    if (typeof value !== 'string' || value.trim().length === 0)
        return undefined;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'http:')
            return undefined;
        if (url.hostname.length === 0)
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
/** Serialise a parsed proxy URL without a trailing slash. */
function formatProxyUrl(url) {
    return url.toString().replace(/\/$/, '');
}
/** Loopback host patterns that `NO_PROXY` commonly names. */
const LOOPBACK_PATTERNS = [/^localhost$/i, /^127(?:\.\d{1,3}){3}$/, /^::1$/, /^\[::1\]$/, /^0\.0\.0\.0$/];
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
export function noProxyIsLoopbackOnly(raw) {
    if (typeof raw !== 'string')
        return true;
    const entries = raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0)
        return true;
    return entries.every((entry) => {
        const host = entry.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
        return LOOPBACK_PATTERNS.some((pattern) => pattern.test(host) || pattern.test(entry));
    });
}
/**
 * Whether a `NO_PROXY` value is the wildcard that disables proxying entirely.
 * @param raw - the `NO_PROXY`/`no_proxy` value, if set.
 */
function noProxyIsWildcard(raw) {
    return raw
        .split(',')
        .map((entry) => entry.trim())
        .some((entry) => entry === '*');
}
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
export function proxyFromEnv(env = process.env) {
    const noProxy = env.NO_PROXY ?? env.no_proxy;
    // `NO_PROXY` lists destination hosts. A loopback-only list is skipped (it can
    // never cover a search host); a wildcard is the one form that means "never
    // proxy", so it is honoured before any variable is read.
    if (noProxy !== undefined && !noProxyIsLoopbackOnly(noProxy) && noProxyIsWildcard(noProxy))
        return undefined;
    for (const key of ENV_KEYS) {
        const parsed = proxyUrl(env[key]);
        if (parsed !== undefined)
            return formatProxyUrl(parsed);
    }
    return undefined;
}
/**
 * Read the macOS system proxy (`scutil --proxy`), which is where a Clash-style
 * client publishes `127.0.0.1:7890` when "set as system proxy" is on.
 *
 * @returns the HTTPS/HTTP proxy URL, or `undefined` on any other platform or
 *   when no proxy is enabled.
 */
export async function proxyFromSystem() {
    if (process.platform !== 'darwin')
        return undefined;
    const output = await new Promise((resolve) => {
        let text = '';
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const child = spawn('scutil', ['--proxy'], { stdio: ['ignore', 'pipe', 'ignore'] });
        // `scutil` answers in milliseconds; a wedged system call must not hold a
        // search open, so the probe is capped and the child is killed on expiry.
        const timer = setTimeout(() => {
            child.kill();
            finish('');
        }, 2_000);
        child.stdout.on('data', (chunk) => {
            text += chunk.toString();
        });
        child.on('error', () => finish(''));
        child.on('close', () => finish(text));
    });
    if (!/HTTPSEnable\s*:\s*1|HTTPEnable\s*:\s*1/.test(output))
        return undefined;
    const host = /HTTPSProxy\s*:\s*(\S+)/.exec(output)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(output)?.[1];
    const port = /HTTPSPort\s*:\s*(\d+)/.exec(output)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(output)?.[1];
    if (host === undefined || port === undefined)
        return undefined;
    const parsed = proxyUrl(`http://${host}:${port}`);
    return parsed === undefined ? undefined : formatProxyUrl(parsed);
}
/** Check that something is listening, so a stale setting cannot stall a search. */
async function reachable(proxy, timeoutMs = 400) {
    return await new Promise((resolve) => {
        const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
        const done = (value) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}
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
export async function resolveProxy(explicit) {
    const configured = proxyUrl(explicit);
    if (configured !== undefined)
        return formatProxyUrl(configured);
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS)
        return cached.proxy;
    const fromEnv = proxyFromEnv();
    let proxy = fromEnv;
    if (proxy === undefined) {
        const system = await proxyFromSystem();
        if (system !== undefined) {
            const parsed = proxyUrl(system);
            if (parsed !== undefined && (await reachable(parsed)))
                proxy = formatProxyUrl(parsed);
        }
    }
    cached = { at: Date.now(), proxy };
    return proxy;
}
/** Open a `CONNECT` tunnel to `host:port` through the proxy. */
async function openTunnel(proxy, host, port, timeoutMs, signal) {
    const request = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: {
            host: `${host}:${port}`,
            ...(proxy.authorization === undefined ? {} : { 'proxy-authorization': proxy.authorization }),
        },
    });
    const connected = once(request, 'connect');
    const abort = () => {
        request.destroy(new Error('aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('proxy CONNECT timed out')));
    request.end();
    try {
        const [response, socket] = (await connected);
        if (response.statusCode !== 200) {
            socket.destroy();
            throw new Error(`proxy CONNECT returned HTTP ${response.statusCode}`);
        }
        return socket;
    }
    finally {
        signal?.removeEventListener('abort', abort);
    }
}
/** Write one request over a connected socket and collect the raw response. */
function exchange(socket, head, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const done = (settle, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            socket.destroy();
            settle(value);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            socket.destroy();
            reject(error);
        };
        const timer = setTimeout(() => fail(new Error('request timed out')), timeoutMs);
        const abort = () => fail(new Error('aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('end', () => done(resolve, Buffer.concat(chunks)));
        socket.on('error', (error) => fail(error));
        socket.write(head);
    });
}
/** Decode a `Transfer-Encoding: chunked` body. */
function dechunk(buffer) {
    const parts = [];
    let offset = 0;
    while (offset < buffer.length) {
        const lineEnd = buffer.indexOf('\r\n', offset);
        if (lineEnd === -1)
            break;
        const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0]?.trim() ?? '', 16);
        if (!Number.isFinite(size) || size <= 0)
            break;
        const start = lineEnd + 2;
        parts.push(buffer.subarray(start, start + size));
        offset = start + size + 2;
    }
    return Buffer.concat(parts);
}
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
export function readResponse(buffer) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator === -1)
        return undefined;
    const [statusLine = '', ...lines] = buffer.subarray(0, separator).toString('latin1').split('\r\n');
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1]);
    if (!Number.isFinite(status))
        return undefined;
    const headers = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    let body = buffer.subarray(separator + 4);
    if (/chunked/i.test(headers['transfer-encoding'] ?? ''))
        body = dechunk(body);
    else if (headers['content-length'] !== undefined)
        body = body.subarray(0, Number(headers['content-length']));
    const encoding = (headers['content-encoding'] ?? '').toLowerCase();
    try {
        if (encoding.includes('gzip'))
            body = zlib.gunzipSync(body);
        else if (encoding.includes('deflate'))
            body = zlib.inflateSync(body);
        else if (encoding.includes('br'))
            body = zlib.brotliDecompressSync(body);
    }
    catch {
        // A truncated or mislabelled body is still worth parsing as-is.
    }
    return { status, headers, text: body.toString('utf8') };
}
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
export async function proxyGet(url, options) {
    const proxy = parseProxy(options.proxy);
    const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const redirects = options.redirects !== undefined && Number.isInteger(options.redirects) ? options.redirects : DEFAULT_REDIRECTS;
    let current = new URL(url);
    let method = options.method === 'POST' ? 'POST' : 'GET';
    let payload = method === 'POST' && typeof options.body === 'string' ? options.body : undefined;
    for (let hop = 0; hop <= redirects; hop += 1) {
        const secure = current.protocol === 'https:';
        const port = Number(current.port || (secure ? 443 : 80));
        const raw = await openTunnel(proxy, current.hostname, port, timeoutMs, options.signal);
        let socket = raw;
        if (secure) {
            const upgraded = tls.connect({ socket: raw, servername: current.hostname });
            // `once` also rejects on 'error', so a refused TLS handshake surfaces
            // instead of becoming an unhandled socket event.
            await once(upgraded, 'secureConnect');
            socket = upgraded;
        }
        const head = `${method} ${current.pathname}${current.search} HTTP/1.1\r\n` +
            `Host: ${current.host}\r\n` +
            Object.entries({
                'accept-encoding': 'identity',
                connection: 'close',
                ...(payload === undefined ? {} : { 'content-length': String(Buffer.byteLength(payload)) }),
                ...options.headers,
            })
                .map(([key, value]) => `${key}: ${value}\r\n`)
                .join('') +
            '\r\n' +
            (payload ?? '');
        // Follow one redirect hop at a time, re-opening the tunnel per hop.
        const response = readResponse(await exchange(socket, head, timeoutMs, options.signal));
        const location = response?.headers.location;
        if (response !== undefined && response.status >= 300 && response.status < 400 && location !== undefined && hop < redirects) {
            // 307/308 preserve the method and body; the older statuses downgrade to GET.
            if (method === 'POST' && response.status !== 307 && response.status !== 308) {
                method = 'GET';
                payload = undefined;
            }
            current = new URL(location, current);
            continue;
        }
        return { status: response?.status ?? 0, text: response?.text ?? '', url: current.toString(), headers: response?.headers ?? {} };
    }
    return { status: 0, text: '', url: current.toString(), headers: {} };
}
