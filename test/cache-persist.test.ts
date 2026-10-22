/**
 * Persistence for the search cache.
 *
 * Every test writes under `os.tmpdir()`: the real `~/.dsh/cache` is never
 * touched. The filesystem seam is exercised directly where a real failure
 * (a rejected rename) would be hard to provoke, which is also how the atomic
 * replacement contract is pinned down.
 *
 * @module dsh-web-search-bing/test/cache-persist
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchCache, cacheKey } from '../src/cache.ts';
import {
  CACHE_FILE_VERSION,
  defaultCacheFile,
  nodeCacheFileIo,
  resolveCacheFile,
  writeCacheFile,
} from '../src/cache-persist.ts';
import type { CacheFileIo } from '../src/cache-persist.ts';
import { resolveConfig } from '../src/config.ts';
import type { ConfigInput } from '../src/config.ts';
import type { Source } from '../src/types.ts';

/** A temp directory removed after the test, whatever it contains. */
function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stable clock for expiry assertions. */
const NOW = 1_700_000_000_000;

/** One summary source. */
function source(url: string, title = 'Title'): Source {
  return { url, title, snippet: 'snippet' };
}

/** The on-disk shape this test asserts against. */
interface Snapshot {
  version: number;
  savedAt: number;
  entries: { key: string; expiresAt: number; sources: Record<string, string>[] }[];
}

/** Read a JSON snapshot from disk. */
function readSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
}

test('a set entry is not written synchronously, then a flush round-trips it', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  const cache = new SearchCache(
    { ttlMs: 600_000, maxEntries: 10, persist: { file, throttleMs: 2_000 } },
    () => NOW,
  );
  const key = cacheKey({ query: 'Persisted Search', limit: 5, wait: 'auto', lead: 'global', engines: ['bing', 'ddg'] });
  const stored = { ...source('https://example.com/a', 'A'), html: '<p>body</p>' } as Source & { html: string };
  cache.set(key, [stored]);

  assert.equal(existsSync(file), false, 'a set must only schedule the throttled write');
  assert.equal(cache.flush(), true, 'flush writes the pending snapshot');
  cache.close();
  assert.equal(cache.flush(), false, 'a clean cache has nothing to write');

  const snapshot = readSnapshot(file);
  assert.equal(snapshot.version, CACHE_FILE_VERSION);
  assert.equal(snapshot.savedAt, NOW);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]?.key, key);
  assert.equal(snapshot.entries[0]?.expiresAt, NOW + 600_000);
  assert.deepEqual(snapshot.entries[0]?.sources, [
    { url: 'https://example.com/a', title: 'A', snippet: 'snippet' },
  ]);
  assert.equal('html' in (snapshot.entries[0]?.sources[0] ?? {}), false, 'the page body is never persisted');

  // A new process (new instance) reading the same file gets a normal hit.
  const reopened = new SearchCache(
    { ttlMs: 600_000, maxEntries: 10, persist: { file } },
    () => NOW,
  );
  assert.equal(reopened.size, 1);
  assert.deepEqual(reopened.get(key), [source('https://example.com/a', 'A')]);
  const hit = reopened.get(key);
  assert.ok(hit);
  hit.push(source('https://example.com/mutated'));
  assert.equal(reopened.get(key)?.length, 1, 'a reloaded hit is still a defensive copy');
  reopened.close();
});

test('a corrupt JSON file is treated as an empty cache, silently', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  writeFileSync(file, '{not json at all', 'utf8');
  const cache = new SearchCache({ ttlMs: 600_000, maxEntries: 10, persist: { file } }, () => NOW);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('anything'), undefined);
  cache.close();
});

test('a foreign file version is ignored wholesale', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  writeFileSync(file, JSON.stringify({
    version: CACHE_FILE_VERSION + 1,
    savedAt: NOW,
    entries: [{ key: 'k', expiresAt: NOW + 60_000, sources: [{ url: 'https://example.com/a' }] }],
  }), 'utf8');
  const cache = new SearchCache({ ttlMs: 600_000, maxEntries: 10, persist: { file } }, () => NOW);
  assert.equal(cache.size, 0);
  cache.close();
});

test('unreadable paths and unreadable entries degrade to an empty cache', (t) => {
  const dir = tempDir(t);
  const unreadable: CacheFileIo = {
    ...nodeCacheFileIo,
    read() {
      throw new Error('EACCES');
    },
  };
  const denied = new SearchCache(
    { ttlMs: 600_000, maxEntries: 10, persist: { file: join(dir, 'cache.json'), io: unreadable } },
    () => NOW,
  );
  assert.equal(denied.size, 0);
  denied.close();

  const file = join(dir, 'partial.json');
  writeFileSync(file, JSON.stringify({
    version: CACHE_FILE_VERSION,
    savedAt: NOW,
    entries: [
      'not-an-entry',
      { key: '', expiresAt: NOW + 60_000, sources: [{ url: 'https://example.com/skipped' }] },
      { key: 'expired', expiresAt: NOW - 1, sources: [{ url: 'https://example.com/expired' }] },
      { key: 'good', expiresAt: NOW + 60_000, sources: [{ url: 'https://example.com/good' }, { url: '  ' }] },
    ],
  }), 'utf8');
  const partial = new SearchCache({ ttlMs: 600_000, maxEntries: 10, persist: { file } }, () => NOW);
  assert.equal(partial.size, 1, 'only the one valid, unexpired entry survives');
  assert.deepEqual(partial.get('good'), [{ url: 'https://example.com/good' }]);
  assert.equal(partial.get('expired'), undefined);
  partial.close();
});

test('a rejected rename leaves the previous snapshot intact and no temp file', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  writeCacheFile(file, [
    { key: 'old', expiresAt: NOW + 600_000, sources: [source('https://example.com/old')] },
  ], NOW);
  const before = readFileSync(file, 'utf8');

  const failing: CacheFileIo = {
    ...nodeCacheFileIo,
    rename() {
      throw new Error('rename denied');
    },
  };
  const cache = new SearchCache(
    { ttlMs: 600_000, maxEntries: 10, persist: { file, io: failing } },
    () => NOW,
  );
  cache.set('new', [source('https://example.com/new')]);
  assert.equal(cache.flush(), false, 'a filesystem failure is contained, not thrown');
  cache.close();

  assert.equal(readFileSync(file, 'utf8'), before, 'the old snapshot is untouched');
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    'the temporary file is cleaned up',
  );
});

test('the byte cap evicts the oldest entries until the snapshot fits', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  const maxBytes = 1_200;
  const cache = new SearchCache(
    { ttlMs: 600_000, maxEntries: 100, persist: { file, maxBytes } },
    () => NOW,
  );
  for (let index = 0; index < 10; index += 1) {
    cache.set(`k${index}`, [source(`https://example.com/${index}`, 'x'.repeat(200))]);
  }
  assert.equal(cache.flush(), true);
  cache.close();

  const raw = readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= maxBytes, `snapshot is ${Buffer.byteLength(raw, 'utf8')} bytes`);
  const snapshot = readSnapshot(file);
  assert.ok(snapshot.entries.length < 10, `expected eviction, kept ${snapshot.entries.length}`);
  assert.equal(snapshot.entries.at(-1)?.key, 'k9', 'the newest entry survives');
  assert.equal(snapshot.entries.some((entry) => entry.key === 'k0'), false, 'the oldest went first');

  const reopened = new SearchCache(
    { ttlMs: 600_000, maxEntries: 100, persist: { file, maxBytes } },
    () => NOW,
  );
  assert.ok(reopened.get('k9'));
  assert.equal(reopened.get('k0'), undefined);
  reopened.close();
});

test('loading more entries than maxEntries keeps the newest tail', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  const entries = ['a', 'b', 'c', 'd'].map((key) => ({
    key,
    expiresAt: NOW + 60_000,
    sources: [source(`https://example.com/${key}`)],
  }));
  writeCacheFile(file, entries, NOW);
  const cache = new SearchCache({ ttlMs: 600_000, maxEntries: 2, persist: { file } }, () => NOW);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('c'));
  assert.ok(cache.get('d'));
  cache.close();
});

test('an expired entry is dropped while loading instead of waiting for a read', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  writeCacheFile(file, [
    { key: 'stale', expiresAt: NOW - 1, sources: [source('https://example.com/stale')] },
  ], NOW);
  const cache = new SearchCache({ ttlMs: 600_000, maxEntries: 10, persist: { file } }, () => NOW);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('stale'), undefined);
  cache.close();
});

test('a scheduled flush lands without an explicit flush call', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  const cache = new SearchCache(
    { ttlMs: 600_000, maxEntries: 10, persist: { file, throttleMs: 30 } },
    () => Date.now(),
  );
  cache.set('scheduled', [source('https://example.com/scheduled')]);
  assert.equal(existsSync(file), false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(file), true, 'the throttle timer wrote the snapshot');
  assert.equal(readSnapshot(file).entries[0]?.key, 'scheduled');
  cache.close();
});

test('distinct logical requests keep distinct persisted entries', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'cache.json');
  const cache = new SearchCache({ ttlMs: 600_000, maxEntries: 20, persist: { file } }, () => NOW);
  const base = {
    query: 'kubernetes ingress',
    limit: 5,
    wait: 'auto',
    lead: 'global',
    engines: ['bing', 'ddg'],
    timeRange: 'off' as const,
  };
  const keys = {
    base: cacheKey(base),
    query: cacheKey({ ...base, query: 'kubernetes service' }),
    timeRange: cacheKey({ ...base, timeRange: 'week' }),
    engines: cacheKey({ ...base, engines: ['bing'] }),
    limit: cacheKey({ ...base, limit: 6 }),
    wait: cacheKey({ ...base, wait: 'fast' }),
    lead: cacheKey({ ...base, lead: 'cn' }),
  };
  assert.equal(new Set(Object.values(keys)).size, 7, 'every variant must have its own key');

  cache.set(keys.base, [source('https://example.com/base')]);
  cache.set(keys.query, [source('https://example.com/query')]);
  cache.set(keys.timeRange, [source('https://example.com/week')]);
  cache.set(keys.engines, [source('https://example.com/bing-only')]);
  cache.set(keys.limit, [source('https://example.com/limit-6')]);
  cache.set(keys.wait, [source('https://example.com/fast')]);
  cache.set(keys.lead, [source('https://example.com/cn')]);
  assert.equal(cache.flush(), true);
  cache.close();

  const reopened = new SearchCache({ ttlMs: 600_000, maxEntries: 20, persist: { file } }, () => NOW);
  assert.deepEqual(reopened.get(keys.base), [source('https://example.com/base')]);
  assert.deepEqual(reopened.get(keys.query), [source('https://example.com/query')]);
  assert.deepEqual(reopened.get(keys.timeRange), [source('https://example.com/week')]);
  assert.deepEqual(reopened.get(keys.engines), [source('https://example.com/bing-only')]);
  assert.deepEqual(reopened.get(keys.limit), [source('https://example.com/limit-6')]);
  assert.deepEqual(reopened.get(keys.wait), [source('https://example.com/fast')]);
  assert.deepEqual(reopened.get(keys.lead), [source('https://example.com/cn')]);
  reopened.close();
});

test('cachePersist=false is a memory-only cache and writes nothing', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'unused.json');
  const memory = new SearchCache({ ttlMs: 600_000, maxEntries: 10 });
  memory.set('k', [source('https://example.com/a')]);
  assert.equal(memory.flush(), false, 'without a persist option there is no flush');
  assert.equal(existsSync(file), false);
  memory.close();

  const off = resolveConfig({ cachePersist: false, cacheFile: file } as ConfigInput, undefined);
  assert.equal(off.cachePersist, false);
  assert.equal(off.cacheFile, file);
  const defaults = resolveConfig({}, undefined);
  assert.equal(defaults.cachePersist, true, 'persistence is on by default');
  assert.equal(defaults.cacheFile, undefined, 'an empty path means the default location');
  const custom = resolveConfig({ cacheFile: '  ~/cache.json  ' } as ConfigInput, undefined);
  assert.equal(custom.cacheFile, '~/cache.json', 'the path is trimmed, not silently dropped');
});

test('path resolution expands the documented default and a leading tilde', () => {
  const expected = join(homedir(), '.dsh', 'cache', 'dsh-web-search', 'cache.json');
  assert.equal(defaultCacheFile(), expected);
  assert.equal(resolveCacheFile(), expected);
  assert.equal(resolveCacheFile('   '), expected);
  assert.equal(resolveCacheFile('~/cache.json'), join(homedir(), 'cache.json'));
  assert.equal(resolveCacheFile('/tmp/custom-cache.json'), '/tmp/custom-cache.json');
});
