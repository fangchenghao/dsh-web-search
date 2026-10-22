import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchCache, cacheKey } from '../src/cache.ts';
import type { Source } from '../src/types.ts';

const source = (url: string): Source => ({ url });

test('cache: set then get returns the stored sources and a miss is undefined', () => {
  const cache = new SearchCache();
  const sources: Source[] = [{ url: 'https://example.com/a', title: 'A' }];
  cache.set('k', sources);
  assert.deepEqual(cache.get('k'), sources);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('missing'), undefined);
});

test('cache: the default ttl is ten minutes', () => {
  let clock = 0;
  const cache = new SearchCache({}, () => clock);
  cache.set('k', [source('https://example.com/a')]);
  clock = 599_999;
  assert.equal(cache.get('k')?.length, 1);
  clock = 600_000;
  assert.equal(cache.get('k'), undefined);
});

test('cache: an expired get deletes the entry and returns undefined', () => {
  let clock = 1_000;
  const cache = new SearchCache({ ttlMs: 1_000 }, () => clock);
  cache.set('k', [source('https://example.com/a')]);
  clock = 1_999;
  assert.equal(cache.get('k')?.length, 1);
  clock = 2_000;
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
});

test('cache: ttlMs 0 disables caching entirely', () => {
  const cache = new SearchCache({ ttlMs: 0 });
  cache.set('k', [source('https://example.com/a')]);
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
});

test('cache: maxEntries 0 retains nothing', () => {
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 0 });
  cache.set('k', [source('https://example.com/a')]);
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
});

test('cache: insertion beyond maxEntries evicts the least recently used entry', () => {
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 2 }, () => 0);
  cache.set('a', [source('https://example.com/a')]);
  cache.set('b', [source('https://example.com/b')]);
  cache.set('c', [source('https://example.com/c')]);
  assert.equal(cache.get('a'), undefined);
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'));
  assert.equal(cache.size, 2);
});

test('cache: a get refreshes recency, so the untouched entry is evicted first', () => {
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 2 }, () => 0);
  cache.set('a', [source('https://example.com/a')]);
  cache.set('b', [source('https://example.com/b')]);
  assert.ok(cache.get('a'));
  cache.set('c', [source('https://example.com/c')]);
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
});

test('cache: overwriting a key keeps the size stable and refreshes its recency', () => {
  const cache = new SearchCache({ ttlMs: 60_000, maxEntries: 2 }, () => 0);
  cache.set('a', [source('https://example.com/a')]);
  cache.set('b', [source('https://example.com/b')]);
  cache.set('a', [source('https://example.com/a2')]);
  cache.set('c', [source('https://example.com/c')]);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get('a'), [source('https://example.com/a2')]);
  assert.equal(cache.get('b'), undefined);
});

test('cache: the default cap is one hundred entries', () => {
  const cache = new SearchCache({ ttlMs: 60_000 }, () => 0);
  for (let index = 0; index < 101; index += 1) {
    cache.set(`k${index}`, [source(`https://example.com/${index}`)]);
  }
  assert.equal(cache.size, 100);
  assert.equal(cache.get('k0'), undefined);
  assert.ok(cache.get('k100'));
});

test('cache: stored and returned arrays are defensive copies', () => {
  const cache = new SearchCache();
  const stored: Source = { url: 'https://example.com/a', title: 'original' };
  const input: Source[] = [stored];
  cache.set('k', input);
  // Mutating the caller's array and object after set must not reach the cache.
  input.push(source('https://example.com/extra'));
  stored.title = 'mutated outside';

  const first = cache.get('k');
  assert.ok(first);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.title, 'original');
  assert.notEqual(first, input);

  // Mutating a returned array/object must not reach the cache either.
  first.push(source('https://example.com/extra'));
  const firstSource = first[0];
  assert.ok(firstSource);
  firstSource.title = 'mutated result';

  const second = cache.get('k');
  assert.ok(second);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.title, 'original');
  assert.notEqual(first, second);
});

test('cache: clear drops every entry', () => {
  const cache = new SearchCache();
  cache.set('a', [source('https://example.com/a')]);
  cache.set('b', [source('https://example.com/b')]);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});

test('cacheKey: normalises query case, padding and internal whitespace', () => {
  const base = cacheKey({
    query: '  PostgreSQL   Replication\tGuide\n',
    limit: 8,
    wait: 'auto',
    lead: 'cn',
    engines: ['bing', 'ddg'],
  });
  const messy = cacheKey({
    query: 'postgresql replication guide',
    limit: 8,
    wait: 'auto',
    lead: 'cn',
    engines: ['bing', 'ddg'],
  });
  assert.equal(base, messy);
  assert.equal(base, 'cn|auto|8|bing+ddg|postgresql replication guide');
});

test('cacheKey: engine order does not matter but every other field does', () => {
  const parts = {
    query: 'kubernetes ingress',
    limit: 8,
    wait: 'auto',
    lead: 'global',
    engines: ['bing', 'ddg', 'anysearch'],
  };
  const key = cacheKey(parts);
  assert.equal(key, cacheKey({ ...parts, engines: ['ddg', 'anysearch', 'bing'] }));
  assert.equal(key, cacheKey({ ...parts, engines: ['bing', 'anysearch', 'ddg'] }));
  assert.notEqual(key, cacheKey({ ...parts, limit: 10 }));
  assert.notEqual(key, cacheKey({ ...parts, wait: 'fast' }));
  assert.notEqual(key, cacheKey({ ...parts, lead: 'cn' }));
  assert.notEqual(key, cacheKey({ ...parts, engines: ['bing', 'ddg'] }));
  assert.notEqual(key, cacheKey({ ...parts, query: 'kubernetes service' }));
});

test('live readers make a Settings edit effective without a remount', () => {
  let ttl = 10_000;
  let max = 10;
  let now = 0;
  const cache = new SearchCache({ ttlMs: () => ttl, maxEntries: () => max }, () => now);
  const row = [source('https://example.com/a')];
  cache.set('k', row);
  now = 20_000;
  assert.equal(cache.get('k'), undefined, 'expired under the mounted TTL');
  // The user raises the TTL on the Settings page; the next write must use it,
  // because the cache asks for the value instead of remembering the mount one.
  ttl = 600_000;
  cache.set('k', row);
  now = 60_000;
  assert.equal(cache.get('k')?.length, 1, 'the raised TTL applies immediately');
  max = 0;
  assert.equal(cache.get('k'), undefined, 'a zero cap disables reads immediately');
});
