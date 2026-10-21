/**
 * Proxy-aware HTTP GET for the search engines.
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
 * @module dsh-web-search-bing/proxy
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

/** How long a resolved proxy decision stays valid, in milliseconds. */
const CACHE_MS = 60_000;

/** Cached proxy decision: `{ at, proxy }`, where `proxy` may be `undefined`. */
let cached;

/**
 * Parse a proxy URL, accepting only the HTTP proxy scheme that `CONNECT` uses.
 * @param value - candidate `http://host:port` string.
 * @returns the normalized URL, or `undefined` when unusable.
 */
export function parseProxy(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:') return undefined;
    if (url.hostname.length === 0) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Read the proxy from the conventional environment variables. */
export function proxyFromEnv(env = process.env) {
  for (const key of ['DSH_WEB_SEARCH_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const parsed = parseProxy(env?.[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Read the macOS system proxy (`scutil --proxy`), which is where a Clash-style
 * client publishes `127.0.0.1:7890` when "set as system proxy" is on.
 * @returns the HTTPS/HTTP proxy URL, or `undefined` on any other platform or
 *   when no proxy is enabled.
 */
export async function proxyFromSystem() {
  if (process.platform !== 'darwin') return undefined;
  const output = await new Promise((resolve) => {
    let text = '';
    const child = spawn('scutil', ['--proxy']);
    child.stdout.on('data', (chunk) => { text += chunk });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });
  if (!/HTTPSEnable\s*:\s*1|HTTPEnable\s*:\s*1/.test(output)) return undefined;
  const host = /HTTPSProxy\s*:\s*(\S+)/.exec(output)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(output)?.[1];
  const port = /HTTPSPort\s*:\s*(\d+)/.exec(output)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(output)?.[1];
  if (host === undefined || port === undefined) return undefined;
  return parseProxy(`http://${host}:${port}`);
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
 * Order: an explicit plugin setting, then the environment, then the macOS
 * system proxy. The system proxy is only honoured when its port accepts a
 * connection, so turning the tunnel off degrades to a direct request instead of
 * breaking search. The decision is cached for a minute.
 *
 * @param explicit - the plugin's `proxy` config value.
 * @returns the proxy URL to use, or `undefined` for a direct request.
 */
export async function resolveProxy(explicit) {
  const configured = parseProxy(explicit ?? '');
  if (configured !== undefined) return configured;
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.proxy;
  const fromEnv = proxyFromEnv();
  let proxy = fromEnv;
  if (proxy === undefined) {
    const system = await proxyFromSystem();
    if (system !== undefined && (await reachable(system))) proxy = system;
  }
  cached = { at: Date.now(), proxy };
  return proxy;
}

/** Open a `CONNECT` tunnel to `host:port` through the proxy. */
async function openTunnel(proxy, host, port, timeoutMs, signal) {
  const request = http.request({
    host: proxy.hostname,
    port: Number(proxy.port || 80),
    method: 'CONNECT',
    path: `${host}:${port}`,
    headers: { host: `${host}:${port}` },
  });
  const connected = once(request, 'connect');
  const abort = () => request.destroy(new Error('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  request.setTimeout(timeoutMs, () => request.destroy(new Error('proxy CONNECT timed out')));
  request.end();
  try {
    const [response, socket] = await connected;
    if (response.statusCode !== 200) {
      socket.destroy();
      throw new Error(`proxy CONNECT returned HTTP ${response.statusCode}`);
    }
    return socket;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** Write one request over a connected socket and collect the raw response. */
function exchange(socket, head, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      settle(value);
    };
    const timer = setTimeout(() => done(reject, new Error('request timed out')), timeoutMs);
    const abort = () => done(reject, new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => done(resolve, Buffer.concat(chunks)));
    socket.on('error', (error) => done(reject, error));
    socket.write(head);
  });
}

/** Decode a `Transfer-Encoding: chunked` body. */
function dechunk(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    parts.push(buffer.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

/** Split a raw response into status, headers and body text. */
function readResponse(buffer) {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator === -1) return undefined;
  const [statusLine, ...lines] = buffer.subarray(0, separator).toString('latin1').split('\r\n');
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isFinite(status)) return undefined;
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = buffer.subarray(separator + 4);
  if (/chunked/i.test(headers['transfer-encoding'] ?? '')) body = dechunk(body);
  else if (headers['content-length'] !== undefined) body = body.subarray(0, Number(headers['content-length']));
  const encoding = (headers['content-encoding'] ?? '').toLowerCase();
  try {
    if (encoding.includes('gzip')) body = zlib.gunzipSync(body);
    else if (encoding.includes('deflate')) body = zlib.inflateSync(body);
    else if (encoding.includes('br')) body = zlib.brotliDecompressSync(body);
  } catch {
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
 * @param url - absolute `http(s)` URL.
 * @param options - `proxy`, `headers`, `timeoutMs`, `signal`, `redirects`,
 *   `method` and `body`.
 * @returns `{ status, text, url }` for the final hop.
 */
export async function proxyGet(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const redirects = Number.isInteger(options.redirects) ? options.redirects : 4;
  let current = new URL(url);
  let method = options.method === 'POST' ? 'POST' : 'GET';
  let payload = method === 'POST' && typeof options.body === 'string' ? options.body : undefined;
  for (let hop = 0; hop <= redirects; hop += 1) {
    const secure = current.protocol === 'https:';
    const port = Number(current.port || (secure ? 443 : 80));
    const raw = await openTunnel(options.proxy, current.hostname, port, timeoutMs, options.signal);
    const socket = secure ? tls.connect({ socket: raw, servername: current.hostname }) : raw;
    if (secure) await once(socket, 'secureConnect');
    const head =
      `${method} ${current.pathname}${current.search} HTTP/1.1\r\n` +
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
    return { status: response?.status ?? 0, text: response?.text ?? '', url: current.toString() };
  }
  return { status: 0, text: '', url: current.toString() };
}
