/**
 * End-to-end policy tests for the P0 additions: a primary failure may or may
 * not fall back, a blocked domain disappears even on a cache hit, and a safe
 * search level reaches the URL only for the engines that understand it.
 *
 * The network is stubbed; the parsers and the orchestration are real.
 *
 * @module dsh-web-search-bing/test/search-policy
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOSTS, search } from '../src/engines.ts';
import { withSafeSearch } from '../src/transport.ts';
import { SearchCache } from '../src/cache.ts';
import type { EngineFailure, SearchOutcome } from '../src/types.ts';

/** One captured response. */
type Reply = { status?: number; body: string; headers?: Record<string, string> };

/** Requests the stub answered. */
interface Call {
  url: string;
}

/** Route `fetch` by hostname and record every URL. */
function stubFetch(routes: Record<string, Reply | (() => Reply)>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    calls.push({ url });
    const route = routes[host];
    if (route === undefined) throw new Error(`unstubbed host ${host}`);
    const reply = typeof route === 'function' ? route() : route;
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  return calls;
}

/** Read one fixture. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** Run a search against the stubbed network with no tunnel. */
async function run(
  query: string,
  options: {
    hostIds: string[];
    fallbackOn?: string[];
    blockedDomains?: string[];
    safeSearch?: 'off' | 'moderate' | 'strict';
    cache?: SearchCache;
  },
): Promise<SearchOutcome> {
  return search(query, undefined, {
    limit: 5,
    wait: 'all',
    useProxy: false,
    timeoutMs: 2_000,
    hostIds: options.hostIds,
    ...(options.fallbackOn === undefined ? {} : { fallbackOn: options.fallbackOn as EngineFailure['kind'][] }),
    ...(options.blockedDomains === undefined ? {} : { blockedDomains: options.blockedDomains }),
    ...(options.safeSearch === undefined ? {} : { safeSearch: options.safeSearch }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  });
}

/** A block page that the transport turns into a bot-wall failure. */
const BLOCKED: Reply = { status: 403, body: 'your request was blocked by a bot check' };

test('a disallowed failure skips the fallback tier and explains why', async () => {
  const so = await fixture('so.html');
  const calls = stubFetch({
    'cn.bing.com': BLOCKED,
    'www.so.com': { body: so },
  });
  const outcome = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['cn.bing', 'so'],
    fallbackOn: [],
  });
  assert.equal(calls.some((call) => call.url.includes('www.so.com')), false, 'the fallback must not run');
  assert.equal(outcome.sources.length, 0);
  assert.match(outcome.note ?? '', /fallback skipped: bot-wall/u);
  assert.equal(outcome.failureDetails.some((detail) => detail.kind === 'bot-wall'), true);
});

test('an allowed failure still falls back, and the result says so', async () => {
  const so = await fixture('so.html');
  const calls = stubFetch({
    'cn.bing.com': BLOCKED,
    'www.so.com': { body: so },
  });
  const outcome = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['cn.bing', 'so'],
    fallbackOn: ['bot-wall'],
  });
  assert.equal(calls.some((call) => call.url.includes('www.so.com')), true, 'the fallback must run');
  assert.ok(outcome.sources.length > 0);
  assert.match(outcome.note ?? '', /using fallback/u);
});

test('omitting fallbackOn preserves the old always-fallback behaviour', async () => {
  const so = await fixture('so.html');
  stubFetch({
    'cn.bing.com': BLOCKED,
    'www.so.com': { body: so },
  });
  const outcome = await run('如何配置 postgres 逻辑复制', { hostIds: ['cn.bing', 'so'] });
  assert.ok(outcome.sources.length > 0);
});

test('a blocked domain is removed from fresh results without refilling the count', async () => {
  const so = await fixture('so.html');
  stubFetch({ 'www.so.com': { body: so } });
  const all = await run('如何配置 postgres 逻辑复制', { hostIds: ['so'] });
  assert.ok(all.sources.some((source) => new URL(source.url).hostname === 'blog.csdn.net'));

  stubFetch({ 'www.so.com': { body: so } });
  const filtered = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['so'],
    blockedDomains: ['csdn.net'],
  });
  assert.ok(filtered.sources.length > 0);
  assert.equal(filtered.sources.some((source) => new URL(source.url).hostname.endsWith('csdn.net')), false);
  assert.ok(filtered.sources.length < all.sources.length, 'explicit blocking may shorten the list');
});

test('the blocklist accepts wildcards and pasted URLs', async () => {
  const so = await fixture('so.html');
  stubFetch({ 'www.so.com': { body: so } });
  const filtered = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['so'],
    blockedDomains: ['*.csdn.net', 'https://www.cnblogs.com/path'],
  });
  const hosts = filtered.sources.map((source) => new URL(source.url).hostname);
  assert.equal(hosts.some((host) => host.endsWith('csdn.net')), false);
  assert.equal(hosts.includes('www.cnblogs.com'), false);
  assert.ok(hosts.length > 0);
});

test('a blocked domain is cached in its filtered form and stays filtered on a hit', async () => {
  const so = await fixture('so.html');
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 10 });
  stubFetch({ 'www.so.com': { body: so } });
  const first = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['so'],
    cache,
    blockedDomains: ['csdn.net'],
  });
  assert.ok(first.sources.length > 0);
  assert.equal(first.sources.some((source) => new URL(source.url).hostname.endsWith('csdn.net')), false);

  // No route is stubbed now: a network request would fail. The same blocklist
  // must produce a cache hit, and the cached list must already be filtered.
  stubFetch({});
  const second = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['so'],
    cache,
    blockedDomains: ['csdn.net'],
  });
  assert.equal(second.sources.length, first.sources.length);
  assert.equal(second.sources.some((source) => new URL(source.url).hostname.endsWith('csdn.net')), false);
});

test('removing the blocklist does not reuse the filtered cache entry', async () => {
  const so = await fixture('so.html');
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 10 });
  stubFetch({ 'www.so.com': { body: so } });
  const blocked = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['so'],
    cache,
    blockedDomains: ['csdn.net'],
  });
  assert.equal(blocked.sources.some((source) => new URL(source.url).hostname.endsWith('csdn.net')), false);

  stubFetch({ 'www.so.com': { body: so } });
  const unblocked = await run('如何配置 postgres 逻辑复制', { hostIds: ['so'], cache });
  assert.ok(unblocked.sources.some((source) => new URL(source.url).hostname === 'blog.csdn.net'));
});

test('safeSearch reaches Bing only when it is not off', async () => {
  const body = await fixture('bing-global.html');
  const calls = stubFetch({ 'cn.bing.com': { body } });
  await run('如何配置 postgres 逻辑复制', { hostIds: ['cn.bing'], safeSearch: 'strict' });
  assert.equal(calls.length > 0, true);
  assert.match(calls[0]?.url ?? '', /[?&]adlt=strict(?:&|$)/u);
});

test('safeSearch off leaves the engine URL untouched', async () => {
  const body = await fixture('bing-global.html');
  const calls = stubFetch({ 'cn.bing.com': { body } });
  await run('如何配置 postgres 逻辑复制', { hostIds: ['cn.bing'], safeSearch: 'off' });
  assert.equal(calls.length > 0, true);
  assert.equal(calls[0]?.url.includes('adlt='), false);
});

test('DuckDuckGo receives its own kp parameter, not Bing adlt', () => {
  const url = 'https://html.duckduckgo.com/html/?q=test';
  assert.match(withSafeSearch('ddg-html', url, 'strict'), /[?&]kp=1(?:&|$)/u);
  assert.match(withSafeSearch('ddg-lite', 'https://lite.duckduckgo.com/lite/?q=test', 'moderate'), /[?&]kp=-1(?:&|$)/u);
  assert.equal(withSafeSearch('ddg-html', url, 'off'), url);
});

test('a fallback policy is part of the cache key, so a cached fallback cannot bypass it', async () => {
  const so = await fixture('so.html');
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 10 });
  stubFetch({
    'cn.bing.com': BLOCKED,
    'www.so.com': { body: so },
  });
  const first = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['cn.bing', 'so'],
    cache,
    fallbackOn: ['bot-wall'],
  });
  assert.ok(first.sources.length > 0);
  assert.match(first.note ?? '', /using fallback/u);

  // Same query, same cache, but the policy now forbids the fallback: the entry
  // must not be reused, because it was produced under a different policy.
  const calls = stubFetch({
    'cn.bing.com': BLOCKED,
    'www.so.com': { body: so },
  });
  const second = await run('如何配置 postgres 逻辑复制', {
    hostIds: ['cn.bing', 'so'],
    cache,
    fallbackOn: [],
  });
  assert.equal(calls.some((call) => call.url.includes('www.so.com')), false);
  assert.equal(second.sources.length, 0);
  assert.match(second.note ?? '', /fallback skipped/u);
});

test('safeSearch is part of the cache key, so strict and off never share an entry', async () => {
  const body = await fixture('bing-global.html');
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 10 });
  stubFetch({ 'cn.bing.com': { body } });
  await run('如何配置 postgres 逻辑复制', { hostIds: ['cn.bing'], cache, safeSearch: 'off' });
  stubFetch({ 'cn.bing.com': { body } });
  const calls = stubFetch({ 'cn.bing.com': { body } });
  await run('如何配置 postgres 逻辑复制', { hostIds: ['cn.bing'], cache, safeSearch: 'strict' });
  assert.equal(calls.length > 0, true, 'the strict search must miss the cache');
  assert.match(calls[0]?.url ?? '', /adlt=strict/u);
});

test('every catalogue id used by these tests still exists', () => {
  const ids = HOSTS.map((host) => host.id);
  for (const id of ['cn.bing', 'so', 'www.bing', 'ddg-html', 'ddg-lite']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
});
