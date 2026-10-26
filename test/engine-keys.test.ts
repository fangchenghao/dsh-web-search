/**
 * Optional credentials must affect only the current request.
 *
 * In particular, adding a Firecrawl key must not mutate the shared `HOSTS`
 * descriptor, and leaving the key empty must keep the keyless fallback exactly
 * as it was.
 *
 * @module dsh-web-search-bing/test/engine-keys
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, resolveHost } from '../src/engines.ts';

test('a Firecrawl key adds a Bearer header to a copy only', () => {
  const firecrawl = HOSTS.find((host) => host.id === 'firecrawl');
  assert.ok(firecrawl);
  const keyed = resolveHost(firecrawl, { firecrawlApiKey: 'fc-test-key' });
  assert.equal(keyed.headers?.['authorization'], 'Bearer fc-test-key');
  assert.equal(firecrawl.headers, undefined, 'the shared descriptor must not be mutated');
  assert.equal(resolveHost(firecrawl, { firecrawlApiKey: '' }).headers, undefined);
});

test('AnySearch still carries its optional domain and key', () => {
  const anysearch = HOSTS.find((host) => host.id === 'anysearch');
  assert.ok(anysearch);
  const configured = resolveHost(anysearch, {
    anysearchApiKey: 'as-test-key',
    anysearchDomain: 'academic',
  });
  assert.equal(configured.headers?.['authorization'], 'Bearer as-test-key');
  assert.match(configured.body?.('test query') ?? '', /"domain":"academic"/u);
  assert.equal(anysearch.headers, undefined);
});
