/**
 * Tests for the second retrieval over research bodies: an in-memory cache and
 * the model-facing `cache_search` definition. No network and no shared state
 * between cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_SEARCH_FALLBACK_NAME,
  CACHE_SEARCH_TOOL_NAME,
  ResearchBodyCache,
  cacheTokens,
  cacheWindows,
  createCacheSearchDefinition,
  pickCacheSearchToolName,
  registerCacheSearchTool,
} from '../src/research-cache.ts';
import { RESEARCH_TOOL_NAME, createResearchDefinition } from '../src/research.ts';

test('cache search finds a deep passage and cites its URL', () => {
  const cache = new ResearchBodyCache();
  cache.put({
    url: 'https://example.com/guide',
    title: 'Guide',
    text: `Intro\n\n${'Unrelated background. '.repeat(100)}\n\nterminationGracePeriodSeconds defaults to 30 seconds.`,
  });
  const matches = cache.search('terminationGracePeriodSeconds');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.url, 'https://example.com/guide');
  assert.match(matches[0]?.snippet ?? '', /defaults to 30 seconds/u);
});

test('cache search returns nothing for an expired or absent body', () => {
  let now = 1_000;
  const cache = new ResearchBodyCache({ ttlMs: 100, now: () => now });
  cache.put({ url: 'https://example.com/old', text: 'A unique needle lives here.' });
  now += 101;
  assert.equal(cache.search('needle').length, 0);
  assert.equal(cache.size(), 0);
});

test('the cache is bounded and keeps the newest bodies', () => {
  const cache = new ResearchBodyCache({ maxBodies: 2 });
  cache.put({ url: 'https://example.com/a', text: 'alpha unique' });
  cache.put({ url: 'https://example.com/b', text: 'beta unique' });
  cache.put({ url: 'https://example.com/c', text: 'gamma unique' });
  assert.equal(cache.size(), 2);
  assert.equal(cache.search('alpha').length, 0);
  assert.equal(cache.search('gamma').length, 1);
});

test('CJK queries are searched as bigrams and windows stay bounded', () => {
  assert.deepEqual(cacheTokens('终止宽限期'), ['终止', '止宽', '宽限', '限期']);
  const body = '一段无关内容。\n\n终止宽限期默认是 30 秒。';
  const windows = cacheWindows(body);
  assert.ok(windows.length >= 2);
  const cache = new ResearchBodyCache();
  cache.put({ url: 'https://example.com/zh', text: body });
  assert.match(cache.search('终止宽限期')[0]?.snippet ?? '', /30 秒/u);
});

test('the cache_search tool is registered, falls back on a name collision, and renders untrusted text', async () => {
  const cache = new ResearchBodyCache();
  cache.put({ url: 'https://example.com/page', title: 'Page', text: 'The answer is hidden in this paragraph.' });
  const registered: string[] = [];
  const tools = {
    register(definition: { name: string }) { registered.push(definition.name); return () => {}; },
    get(name: string) { return name === CACHE_SEARCH_TOOL_NAME ? {} : undefined; },
  };
  const name = registerCacheSearchTool(tools, cache, {});
  assert.equal(name, CACHE_SEARCH_FALLBACK_NAME);
  assert.deepEqual(registered, [CACHE_SEARCH_FALLBACK_NAME]);
  const value = await createCacheSearchDefinition(CACHE_SEARCH_TOOL_NAME, cache).execute({ query: 'answer' }, {});
  assert.equal(value.matches.length, 1);
  const rendered = createCacheSearchDefinition(CACHE_SEARCH_TOOL_NAME, cache).output
    .render({ query: 'answer' }, value)[0]?.text ?? '';
  assert.match(rendered, /<untrusted-web-content>/u);
  assert.match(rendered, /https:\/\/example\.com\/page/u);
});

test('research exposes full bodies to the cache without changing the evidence contract', async () => {
  const cache = new ResearchBodyCache();
  const definition = createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({
      sources: [{ url: 'https://deep.example/', title: 'Deep' }],
      failures: [],
    }),
    async (url) => ({ url, status: 200, text: `${'background '.repeat(80)}\n\nneedle in the body`, truncated: false }),
    { onPage: (page) => cache.put(page) },
  );
  await definition.execute({ query: 'needle' }, {});
  assert.equal(cache.search('needle').length, 1);
});
