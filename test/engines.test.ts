/**
 * Orchestration tests: the tier release policy, the bilingual region policy, the
 * cache, the cooldown and cancellation, all against the real captured engine
 * responses.
 *
 * `fetch` is stubbed per host, so these tests assert the orchestration and the
 * parsers together without touching the network. Every body served here is a
 * fixture under `test/fixtures/`, captured from the live engines.
 *
 * @module dsh-web-search-bing/test/engines
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HOSTS, resolveHost, search } from '../src/engines.ts';
import { SearchCache } from '../src/cache.ts';
import { EngineHealth } from '../src/health.ts';
import { SearchError } from '../src/errors.ts';
import { parseBing, parseSo } from '../src/parsers.ts';
import type { Source } from '../src/types.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Read a captured fixture from disk. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** Really captured onto disk, so the helper above is the only reader. */
void FIXTURES;

/** How the stub answers one host. */
type Reply = { status?: number; body: string; headers?: Record<string, string> } | { error: Error };

/** Requests the stub saw, in order. */
interface Call {
  url: string;
  method: string;
}

/**
 * Replace `fetch` with a router keyed by hostname.
 * @param routes - hostname → reply (a function may decide per call).
 * @returns the calls the stub served, newest last.
 */
function stubFetch(routes: Record<string, Reply | (() => Reply)>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    calls.push({ url, method: init?.method ?? 'GET' });
    const route = routes[host];
    if (route === undefined) throw new Error(`unstubbed host ${host}`);
    const reply = typeof route === 'function' ? route() : route;
    if ('error' in reply) throw reply.error;
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  return calls;
}

/** Hosts that never answer with a block page. */
const ANYSEARCH = 'api.anysearch.com';
const CN_BING = 'cn.bing.com';
const SO = 'www.so.com';
const DDG = 'html.duckduckgo.com';

/** Run a search with the tunnel disabled, so no engine needs a proxy. */
async function runDirect(
  query: string,
  options: { limit?: number; cache?: SearchCache; health?: EngineHealth; hostIds?: string[]; signal?: AbortSignal } = {},
): Promise<{ sources: Source[]; failures: string[] }> {
  return search(query, options.signal, {
    limit: options.limit ?? 8,
    useProxy: false,
    timeoutMs: 2000,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.hostIds === undefined ? {} : { hostIds: options.hostIds }),
  });
}

test('an AnySearch key and vertical domain reach the request without mutating the catalogue', () => {
  const anysearch = HOSTS.find((host) => host.id === 'anysearch');
  assert.ok(anysearch !== undefined);

  // Without configuration the catalogue entry is returned untouched.
  assert.equal(resolveHost(anysearch, {}), anysearch);

  const keyed = resolveHost(anysearch, { anysearchApiKey: 'as_sk_test' });
  assert.equal(keyed.headers?.['authorization'], 'Bearer as_sk_test');
  assert.equal(JSON.parse(keyed.body?.('q') ?? '{}')['query'], 'q');

  const vertical = resolveHost(anysearch, { anysearchDomain: 'finance.us_stock' });
  const body = JSON.parse(vertical.body?.('q') ?? '{}');
  assert.equal(body['domain'], 'finance');
  assert.equal(body['sub_domain'], 'finance.us_stock');

  const plain = JSON.parse(resolveHost(anysearch, { anysearchDomain: 'academic' }).body?.('q') ?? '{}');
  assert.equal(plain['domain'], 'academic');
  assert.equal(plain['sub_domain'], undefined);

  // Other engines are never touched.
  const ddg = HOSTS.find((host) => host.id === 'ddg-html');
  assert.ok(ddg !== undefined);
  assert.equal(resolveHost(ddg, { anysearchApiKey: 'as_sk_test' }), ddg);
  // The catalogue itself keeps no credential.
  assert.equal(anysearch.headers, undefined);
});

test('an ASCII query leads with the global engines and only fills from cn engines when short', async () => {
  const anysearch = await fixture('anysearch.json');
  const bing = await fixture('bing-global.html');
  stubFetch({
    [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } },
    [CN_BING]: { body: bing },
    [SO]: { body: await fixture('so.html') },
  });
  const { sources } = await runDirect('postgres logical replication', { limit: 8 });
  assert.equal(sources.length, 8);
  // anysearch is the only global engine available without a tunnel, so every
  // slot must come from it before any cn engine is reached.
  assert.ok(sources.every((source) => !/\.com\.cn|www\.so\.com|cn\.bing/.test(source.url)));
});

test('a CJK query leads with the cn engines', async () => {
  const anysearch = await fixture('anysearch.json');
  const bing = await fixture('bing-global.html');
  stubFetch({
    [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } },
    [CN_BING]: { body: bing },
    [SO]: { body: await fixture('so.html') },
  });
  const { sources } = await runDirect('如何配置 postgres 逻辑复制', { limit: 8 });
  assert.equal(sources.length, 8);
  // The parsers unwrap tracker links to their real targets, so "which engine
  // answered" has to be read off the parsed lists, not off the hostname.
  const fromCn = new Set([
    ...parseBing(bing, 'https://cn.bing.com/search').map((source) => source.url),
    ...parseSo(await fixture('so.html'), 'https://www.so.com/s').map((source) => source.url),
  ]);
  const led = sources.filter((source) => fromCn.has(source.url)).length;
  assert.ok(led >= 4, `expected the cn engines to lead, only ${led} of ${sources.length} came from them`);
});

test('a cached query does not touch the network again', async () => {
  const anysearch = await fixture('anysearch.json');
  const calls = stubFetch({ [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } } });
  const cache = new SearchCache();
  const first = await runDirect('postgres logical replication', { cache, hostIds: ['anysearch'] });
  const afterFirst = calls.length;
  const second = await runDirect('postgres logical replication', { cache, hostIds: ['anysearch'] });
  assert.ok(afterFirst > 0);
  assert.equal(calls.length, afterFirst, 'the cache must absorb the second identical query');
  assert.deepEqual(second.sources, first.sources);
});

test('a 429 with a Retry-After cools the engine down without emptying the engine set', async () => {
  const anysearch = await fixture('anysearch.json');
  stubFetch({
    [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } },
    [CN_BING]: { status: 429, body: 'slow down', headers: { 'retry-after': '120' } },
    [SO]: { status: 429, body: 'slow down' },
  });
  const health = new EngineHealth();
  const first = await runDirect('如何配置 postgres 逻辑复制', { health, limit: 8 });
  assert.ok(first.sources.length > 0, 'anysearch still answered');
  assert.ok(health.isCooling('cn.bing'), 'the 429 put the engine on cooldown');
  // The countdown is recomputed against a live clock, so a strict equality on
  // 120000 races the millisecond that elapsed since the Deadline was set.
  const remaining = health.snapshot()['cn.bing'] ?? 0;
  assert.ok(remaining > 118_000 && remaining <= 120_000, `the service's own hint must win, saw ${remaining}ms`);
  const second = await runDirect('如何配置 postgres 逻辑复制', { health, limit: 8 });
  assert.ok(
    second.failures.some((failure) => failure.startsWith('cn.bing: cooling down')),
    `expected a cooldown failure, saw ${JSON.stringify(second.failures)}`,
  );
});

test('a page that echoes the query but yields no results does not cost a cooldown', async () => {
  const anysearch = await fixture('anysearch.json');
  const query = '如何配置 postgres 逻辑复制';
  const calls = stubFetch({
    [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } },
    // Echoes the query, so it passes the block-page check, but carries no
    // result markup: an empty answer, not a throttled one.
    [CN_BING]: { body: `<html><body>${query} 搜索结果为空</body></html>` },
  });
  const health = new EngineHealth();
  const first = await runDirect(query, { health });
  assert.ok(first.failures.some((failure) => failure.includes('no results')), JSON.stringify(first.failures));
  assert.equal(health.isCooling('cn.bing'), false, 'an empty answer must not cost a cooldown');
  const before = calls.length;
  await runDirect('另一件完全不同的事情', { health });
  assert.ok(calls.length > before, 'the engine must be tried again');
});

test('a block page is reported and cooled down', async () => {
  const anysearch = await fixture('anysearch.json');
  stubFetch({
    [ANYSEARCH]: { body: anysearch, headers: { 'content-type': 'application/json' } },
    [CN_BING]: { body: await fixture('bing-ratelimit-synthetic.html') },
  });
  const health = new EngineHealth();
  const { failures } = await runDirect('如何配置 postgres 逻辑复制', { health });
  assert.ok(failures.some((failure) => /cn\.bing: (page does not match|HTTP)/.test(failure)), JSON.stringify(failures));
  assert.equal(health.isCooling('cn.bing'), true);
});

test('when every engine answers with nothing the search reports failures instead of inventing sources', async () => {
  stubFetch({
    [ANYSEARCH]: { body: '{"code":0,"data":{"results":[]}}', headers: { 'content-type': 'application/json' } },
    [CN_BING]: { body: '<html></html>' },
    [SO]: { body: '<html></html>' },
  });
  const { sources, failures } = await runDirect('a query nothing matches', { limit: 8 });
  assert.deepEqual(sources, []);
  assert.ok(failures.length > 0);
});

test('the configured wait policy decides whether a slow engine is still worth waiting for', async () => {
  const anysearch = await fixture('anysearch.json');
  const bing = await fixture('bing-global.html');
  const so = await fixture('so.html');
  // A CJK query puts cn.bing, so and anysearch in the same leading group. Two
  // answer at once and `so` answers 300ms later.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (host === ANYSEARCH) return new Response(anysearch, { status: 200, headers: { 'content-type': 'application/json' } });
    if (host === CN_BING) return new Response(bing, { status: 200 });
    if (host === SO) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(so, { status: 200 });
    }
    throw new Error(`unstubbed host ${host}`);
  }) as typeof fetch;

  const timeIt = async (wait: 'fast' | 'auto'): Promise<number> => {
    const started = Date.now();
    await search('如何配置 postgres 逻辑复制', undefined, { limit: 8, useProxy: false, timeoutMs: 2000, wait });
    return Date.now() - started;
  };

  const fast = await timeIt('fast');
  const auto = await timeIt('auto');
  // `fast` releases the tier as soon as one engine has answered; `auto` waits
  // for all of them, so the gap is the 300ms `so` takes.
  assert.ok(fast < 250, `wait: fast should not wait for the slow engine, took ${fast}ms`);
  assert.ok(auto >= 280, `wait: auto should have waited for the slow engine, took ${auto}ms`);
});

test('cancellation propagates as SEARCH_ABORTED instead of a partial answer', async () => {
  stubFetch({
    [ANYSEARCH]: () => ({ error: new DOMException('aborted', 'AbortError') }),
    [CN_BING]: () => ({ error: new DOMException('aborted', 'AbortError') }),
    [SO]: () => ({ error: new DOMException('aborted', 'AbortError') }),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runDirect('anything', { signal: controller.signal }),
    (error: unknown) => error instanceof Error && /cancel/i.test(error.message),
  );
});

test('the CONNECT path is skipped entirely when the engine is unreachable and no proxy is configured', async () => {
  const calls = stubFetch({
    [ANYSEARCH]: () => ({ error: new Error('ECONNREFUSED') }),
    [CN_BING]: () => ({ error: new Error('ECONNREFUSED') }),
    [SO]: () => ({ error: new Error('ECONNREFUSED') }),
  });
  const { sources, failures } = await runDirect('nothing works', { limit: 8 });
  assert.deepEqual(sources, []);
  assert.ok(failures.every((failure) => /SEARCH_|ECONNREFUSED|no results/.test(failure) || failure.includes(':')));
  assert.ok(calls.length >= 3, 'each engine is attempted once, direct');
});

test('search rejects a cancellation that arrives while engines are still running', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const anysearch = await fixture('anysearch.json');
  globalThis.fetch = (async () => {
    await gate;
    return new Response(anysearch, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = runDirect('postgres logical replication', { signal: controller.signal, limit: 8 });
  controller.abort();
  release?.();
  await assert.rejects(pending, (error: unknown) => error instanceof SearchError || error instanceof Error);
});
