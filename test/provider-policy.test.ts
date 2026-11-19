import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { apply } from '../src/index.ts';
import type { SearchProvider } from '../src/index.ts';
import type { AdvancedSearchValue } from '../src/advanced-search.ts';
import type { SearchManyValue } from '../src/search-many.ts';
import type { SubToolDefinition } from '../src/tool-suite.ts';
import type { TimeRange } from '../src/types.ts';

const ordinaryUrl = 'https://guides.example.org/reference';
const paperQuery = 'arXiv papers on electron spectroscopy';
const batchQueries = [paperQuery, 'npm package react latest version'];

async function mount(context: TestContext, blockedDomains: string[], limit = 3, timeRange: TimeRange = 'off') {
  const [papers, packages] = await Promise.all(
    ['verticals-arxiv.xml', 'verticals-npm.json'].map((name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
  );
  const called: string[] = [];
  const ordinary: { url: string; title: string; date?: string }[] = [{ url: ordinaryUrl, title: 'Reference' }];
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    const { hostname } = new URL(input);
    called.push(hostname);
    if (hostname === 'api.anysearch.com') {
      return Response.json({ code: 0, data: { results: ordinary } });
    }
    if (hostname === 'export.arxiv.org') return new Response(papers);
    if (hostname === 'registry.npmjs.org') return new Response(packages);
    if (hostname === 'pypi.org') {
      const name = new URL(input).pathname.split('/')[2];
      return Response.json({ info: { name, package_url: `https://pypi.org/project/${name}/` },
        urls: [{ upload_time_iso_8601: name === 'alpha' ? new Date().toISOString() : '2001-01-01T00:00:00Z' }] });
    }
    if (hostname === 'www.postgresql.org') {
      return new Response('<table><tr><td>18</td><td>18.1</td><td>Yes</td><td>September 25, 2025</td><td>November 14, 2030</td></tr></table>');
    }
    if (hostname === 'chromereleases.googleblog.com') {
      return Response.json({ feed: { entry: [{
        title: { $t: 'Stable Channel Update for Desktop' },
        published: { $t: new Date().toISOString() },
        link: [{ rel: 'alternate', href: 'https://chromereleases.googleblog.com/example' }],
      }] } });
    }
    throw new Error(`unexpected test route: ${hostname}`);
  });
  const providers: SearchProvider[] = [];
  const tools = new Map<string, SubToolDefinition>();
  apply({
    web: { registerSearchProvider: (provider) => providers.push(provider), registerFetchProvider() {} },
    tools: { register: (definition: SubToolDefinition) => tools.set(definition.name, definition) },
  }, { hosts: ['anysearch'], cachePersist: false, cacheTtlMs: 0, toolSurface: 'legacy', limit, timeRange, blockedDomains });
  const provider = providers[0];
  assert.ok(provider);
  const run = (name: string, args: unknown) => {
    const definition = tools.get(name);
    assert.ok(definition);
    return definition.execute(args, {});
  };
  return { provider, run, called, ordinary };
}

test('official and arXiv web_search additions cannot reintroduce a blocked domain at rank one', async (context) => {
  const { provider, called } = await mount(context, ['*.postgresql.org', 'https://arxiv.org/abs/']);
  for (const query of ['PostgreSQL latest version EOL', paperQuery]) {
    const result = await provider.search({ query, maxResults: 1 });
    assert.deepEqual(result.sources.map((source) => source.url), [ordinaryUrl]);
  }
  assert.ok(called.includes('www.postgresql.org'));
  assert.ok(called.includes('export.arxiv.org'));
});

test('advanced_search falls back to ordinary results when the Chrome feed has only blocked posts', async (context) => {
  const { run, called } = await mount(context, ['*.googleblog.com']);
  const result = await run('advanced_search', { query: 'Chrome releases', timeRange: 'week' }) as AdvancedSearchValue;
  assert.deepEqual(result.sources.map((source) => source.url), [ordinaryUrl]);
  assert.ok(called.includes('chromereleases.googleblog.com'));
});

test('blocked arXiv and registry results in search_many use its normal web fallback', async (context) => {
  const { run, called } = await mount(context, ['arxiv.org', 'npmjs.com']);
  const result = await run('search_many', { queries: batchQueries }) as SearchManyValue;
  assert.deepEqual(result.results.map((entry) => entry.sources.map((source) => source.url)), [[ordinaryUrl], [ordinaryUrl]]);
  assert.ok(called.includes('registry.npmjs.org'));
  assert.ok(called.includes('export.arxiv.org'));
});

test('unblocked registry and arXiv shortcuts still win and report the deployment limit', async (context) => {
  const { run, called } = await mount(context, [], 1);
  const result = await run('search_many', { queries: batchQueries, limit: 4 }) as SearchManyValue;
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results.map((entry) => entry.sources.length), [1, 1]);
  assert.deepEqual(result.results.map((entry) => new URL(entry.sources[0]!.url).hostname), ['arxiv.org', 'www.npmjs.com']);
  assert.ok(!called.includes('api.anysearch.com'));
});

test('a dated arXiv paper outside the deployment window does not displace ordinary results', async (context) => {
  const { provider, run } = await mount(context, [], 3, 'week');
  const single = await provider.search({ query: paperQuery, maxResults: 1 });
  const batch = await run('search_many', { queries: [paperQuery] }) as SearchManyValue;
  assert.deepEqual(single.sources.map((source) => source.url), [ordinaryUrl]);
  assert.deepEqual(batch.results[0]?.sources.map((source) => source.url), [ordinaryUrl]);
});

test('an undated official addition preserves the date already known for the same page', async (context) => {
  const { provider, ordinary } = await mount(context, [], 2, 'week');
  const officialUrl = 'https://www.postgresql.org/support/versioning/';
  ordinary[0]!.date = '2 hours ago';
  ordinary.push({ url: officialUrl, title: 'Versioning', date: '1 hour ago' });
  const result = await provider.search({ query: 'PostgreSQL latest version EOL' });
  assert.deepEqual(result.sources.map((source) => source.url), [officialUrl, ordinaryUrl]);
  assert.ok(result.sources[0]?.publishedAt);
  assert.match(result.sources[0]?.title ?? '', /versioning policy/i);
});

test('a package dropped by the time window does not count as budget truncation', async (context) => {
  const { run } = await mount(context, [], 1, 'week');
  const result = await run('search_many', { queries: ['PyPI packages alpha and beta'], limit: 1 }) as SearchManyValue;
  assert.deepEqual(result.results[0]?.sources.map((source) => source.url), ['https://pypi.org/project/alpha/']);
  assert.equal(result.truncated, false);
});
