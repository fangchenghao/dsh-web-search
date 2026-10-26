/**
 * Tests for the proxy transport.
 *
 * Everything here is pure: no socket is opened, no `scutil` is spawned, no
 * network is touched. `readResponse` is exported for exactly this reason — it
 * owns the framing rules (chunking, compression, header casing) that the live
 * transport depends on, and those rules are cheaper to pin here than in a live
 * request.
 *
 * Run with: node --test test/proxy.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { noProxyIsLoopbackOnly, parseProxy, proxyFromEnv, proxyFromWindowsRegistry, proxyGet, readResponse, resolveProxy } from '../src/proxy.ts';

/** Assemble a raw HTTP response buffer from its parts. */
function rawResponse(statusLine: string, headerLines: string[], body: Buffer | string): Buffer {
  const head = [statusLine, ...headerLines].join('\r\n') + '\r\n\r\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]);
}

// --- parseProxy -----------------------------------------------------------

test('parseProxy accepts a plain host and defaults the port to 80', () => {
  assert.deepEqual(parseProxy('http://proxy.local'), { host: 'proxy.local', port: 80 });
  assert.equal('authorization' in parseProxy('http://proxy.local'), false);
});

test('parseProxy keeps an explicit port', () => {
  assert.deepEqual(parseProxy('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
});

test('parseProxy defaults an https proxy port to 443', () => {
  assert.deepEqual(parseProxy('https://proxy.local'), { host: 'proxy.local', port: 443 });
  assert.deepEqual(parseProxy('https://proxy.local:8443'), { host: 'proxy.local', port: 8443 });
});

test('parseProxy turns URL credentials into a Basic authorization value', () => {
  const target = parseProxy('http://alice:s%40cret@proxy.local:3128');
  assert.equal(target.host, 'proxy.local');
  assert.equal(target.port, 3128);
  assert.equal(target.authorization, `Basic ${Buffer.from('alice:s@cret').toString('base64')}`);
});

test('parseProxy trims surrounding whitespace', () => {
  assert.deepEqual(parseProxy('  http://127.0.0.1:7890  '), { host: '127.0.0.1', port: 7890 });
});

test('parseProxy rejects an empty value', () => {
  assert.throws(() => parseProxy(''), /non-empty/);
  assert.throws(() => parseProxy('   '), /non-empty/);
});

test('parseProxy rejects a non-http scheme instead of silently ignoring it', () => {
  assert.throws(() => parseProxy('socks5://127.0.0.1:1080'), /unsupported proxy scheme/);
  assert.throws(() => parseProxy('ftp://proxy.local:21'), /unsupported proxy scheme/);
});

test('parseProxy rejects a scheme-less host:port', () => {
  // `new URL` refuses it outright, so the error is "unparsable", not "scheme".
  assert.throws(() => parseProxy('127.0.0.1:7890'), /unparsable|unsupported proxy scheme/);
});

test('parseProxy rejects an unparsable value', () => {
  assert.throws(() => parseProxy('http://'), /unparsable/);
  assert.throws(() => parseProxy('not a proxy'), /unparsable|unsupported/);
});

// --- proxyFromEnv ---------------------------------------------------------

test('proxyFromEnv reads HTTPS_PROXY in both casings', () => {
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890');
  assert.equal(proxyFromEnv({ https_proxy: 'http://127.0.0.1:7891' }), 'http://127.0.0.1:7891');
});

test('proxyFromEnv reads HTTP_PROXY in both casings', () => {
  assert.equal(proxyFromEnv({ HTTP_PROXY: 'http://127.0.0.1:3128' }), 'http://127.0.0.1:3128');
  assert.equal(proxyFromEnv({ http_proxy: 'http://127.0.0.1:3129' }), 'http://127.0.0.1:3129');
});

test('proxyFromEnv reads ALL_PROXY in both casings', () => {
  assert.equal(proxyFromEnv({ ALL_PROXY: 'http://127.0.0.1:8888' }), 'http://127.0.0.1:8888');
  assert.equal(proxyFromEnv({ all_proxy: 'http://127.0.0.1:8889' }), 'http://127.0.0.1:8889');
});

test('proxyFromEnv returns undefined when nothing is set', () => {
  assert.equal(proxyFromEnv({}), undefined);
  assert.equal(proxyFromEnv({ PATH: '/usr/bin', HOME: '/tmp' }), undefined);
});

test('proxyFromEnv skips values it cannot tunnel through and keeps looking', () => {
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), undefined);
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'https://proxy.local:8443' }), undefined);
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080', HTTP_PROXY: 'http://127.0.0.1:3128' }), 'http://127.0.0.1:3128');
});

test('proxyFromEnv honours the variable precedence', () => {
  const env = {
    DSH_WEB_SEARCH_PROXY: 'http://127.0.0.1:1111',
    HTTPS_PROXY: 'http://127.0.0.1:2222',
    ALL_PROXY: 'http://127.0.0.1:3333',
    HTTP_PROXY: 'http://127.0.0.1:4444',
  };
  assert.equal(proxyFromEnv(env), 'http://127.0.0.1:1111');
  assert.equal(proxyFromEnv({ ...env, DSH_WEB_SEARCH_PROXY: undefined }), 'http://127.0.0.1:2222');
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:2222', HTTP_PROXY: 'http://127.0.0.1:4444' }), 'http://127.0.0.1:2222');
});

test('proxyFromEnv is not defeated by a loopback-only NO_PROXY', () => {
  assert.equal(
    proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' }),
    'http://127.0.0.1:7890',
  );
});

test('proxyFromEnv honours a NO_PROXY wildcard', () => {
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '*' }), undefined);
});

test('noProxyIsLoopbackOnly classifies the common NO_PROXY forms', () => {
  assert.equal(noProxyIsLoopbackOnly(undefined), true);
  assert.equal(noProxyIsLoopbackOnly(''), true);
  assert.equal(noProxyIsLoopbackOnly('localhost'), true);
  assert.equal(noProxyIsLoopbackOnly('localhost, 127.0.0.1 ,::1'), true);
  assert.equal(noProxyIsLoopbackOnly('127.0.0.1:8080'), true);
  assert.equal(noProxyIsLoopbackOnly('0.0.0.0'), true);
  assert.equal(noProxyIsLoopbackOnly('example.com'), false);
  assert.equal(noProxyIsLoopbackOnly('localhost,example.com'), false);
  assert.equal(noProxyIsLoopbackOnly('10.0.0.0/8'), false);
});

// --- Windows system proxy -------------------------------------------------

test('proxyFromWindowsRegistry reads the Windows Internet Settings value', () => {
  const enabled = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890',
  ].join('\r\n');
  assert.equal(proxyFromWindowsRegistry(enabled), 'http://127.0.0.1:7890');
});

test('proxyFromWindowsRegistry accepts a bare host:port and ignores SOCKS', () => {
  const bare = 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:3128\r\n';
  assert.equal(proxyFromWindowsRegistry(bare), 'http://127.0.0.1:3128');
  const socks = 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    socks=127.0.0.1:1080\r\n';
  assert.equal(proxyFromWindowsRegistry(socks), undefined);
});

test('proxyFromWindowsRegistry requires ProxyEnable and a usable server', () => {
  assert.equal(proxyFromWindowsRegistry('ProxyEnable    REG_DWORD    0x0\r\nProxyServer    REG_SZ    127.0.0.1:7890\r\n'), undefined);
  assert.equal(proxyFromWindowsRegistry('ProxyEnable    REG_DWORD    0x1\r\n'), undefined);
  assert.equal(proxyFromWindowsRegistry('ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    \r\n'), undefined);
  assert.equal(proxyFromWindowsRegistry(''), undefined);
});

// --- resolveProxy (explicit path only: no detection, no network) ----------

test('resolveProxy returns an explicit http proxy without touching detection', async () => {
  assert.equal(await resolveProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('resolveProxy keeps explicit proxy credentials in the returned URL', async () => {
  assert.equal(await resolveProxy('http://alice:s%40cret@proxy.local:3128'), 'http://alice:s%40cret@proxy.local:3128');
});

// --- readResponse ---------------------------------------------------------

test('readResponse lowercases header names and trims values', () => {
  const parsed = readResponse(
    rawResponse('HTTP/1.1 200 OK', ['Content-Type: text/html; charset=utf-8', 'X-RateLimit-Remaining: 7', 'Location:https://example.com/a:b'], 'body'),
  );
  assert.equal(parsed?.status, 200);
  assert.deepEqual(parsed?.headers, {
    'content-type': 'text/html; charset=utf-8',
    'x-ratelimit-remaining': '7',
    location: 'https://example.com/a:b',
  });
  assert.equal(parsed?.text, 'body');
});

test('readResponse parses non-200 statuses', () => {
  const parsed = readResponse(rawResponse('HTTP/1.1 429 Too Many Requests', ['Retry-After: 120'], 'slow down'));
  assert.equal(parsed?.status, 429);
  assert.equal(parsed?.headers['retry-after'], '120');
  assert.equal(parsed?.text, 'slow down');
});

test('readResponse honours Content-Length over trailing bytes', () => {
  const parsed = readResponse(rawResponse('HTTP/1.1 200 OK', ['Content-Length: 5'], 'hello world'));
  assert.equal(parsed?.text, 'hello');
});

test('readResponse de-chunks a chunked body', () => {
  const parsed = readResponse(
    rawResponse('HTTP/1.1 200 OK', ['Transfer-Encoding: chunked'], '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'),
  );
  assert.equal(parsed?.text, 'hello world');
});

test('readResponse decompresses gzip bodies', () => {
  const body = zlib.gzipSync(Buffer.from('压缩过的响应'));
  const parsed = readResponse(rawResponse('HTTP/1.1 200 OK', ['Content-Encoding: gzip', `Content-Length: ${body.length}`], body));
  assert.equal(parsed?.text, '压缩过的响应');
});

test('readResponse leaves a mislabelled body alone instead of throwing', () => {
  const parsed = readResponse(rawResponse('HTTP/1.1 200 OK', ['Content-Encoding: gzip'], 'not really gzip'));
  assert.equal(parsed?.status, 200);
  assert.equal(parsed?.text, 'not really gzip');
});

test('readResponse returns undefined when the head is incomplete', () => {
  assert.equal(readResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n')), undefined);
  assert.equal(readResponse(Buffer.from('garbage')), undefined);
});

// --- proxyGet argument handling (rejects before any I/O) ------------------

test('proxyGet rejects a bad proxy URL before opening a tunnel', async () => {
  await assert.rejects(proxyGet('https://example.com/', { proxy: 'socks5://127.0.0.1:1080' }), /unsupported proxy scheme/);
});

test('proxyGet rejects an unparsable target URL', async () => {
  await assert.rejects(proxyGet('not a url', { proxy: 'http://127.0.0.1:7890' }));
});
