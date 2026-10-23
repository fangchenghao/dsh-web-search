/**
 * Tests for the `research` tool: search -> fetch -> evidence pack.
 *
 * The stubs replace both seams, so the assertions are about the contract the
 * model depends on: one section per fetched page, a citation under every
 * excerpt, URLs de-duplicated across queries, a failed page reported by URL and
 * reason instead of aborting the pack, and a registration path that falls back
 * instead of breaking plugin loading.
 *
 * @module dsh-web-search-bing/test/research
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_DEFAULT_SOURCES,
  RESEARCH_MAX_SOURCES,
  RESEARCH_TOOL_FALLBACK_NAME,
  RESEARCH_TOOL_NAME,
  canonicalKey,
  createResearchDefinition,
  formatResearchValue,
  pickResearchToolName,
  registerResearchTool,
} from '../src/research.ts';
import type { ResearchDefinition, ResearchFetchFailure, ResearchFetcher, ResearchRegistryLike, ResearchValue } from '../src/research.ts';
import type { Source } from '../src/types.ts';

function source(url: string, title = ''): Source {
  return { url, ...(title ? { title } : {}), snippet: `snippet for ${url}` };
}

/** A search stub that answers each query with the same two rows, one shared. */
const search = async (query: string) => ({
  sources: [
    source(`https://example.com/${encodeURIComponent(query)}/a`, `A for ${query}`),
    source('https://shared.example/docs/', 'Shared doc'),
  ],
  failures: [],
});

/** A fetch stub: every URL reads back its own path, except the broken one. */
const fetchPage: ResearchFetcher = async (url) => {
  if (url.includes('broken')) throw new Error('timed out');
  return { url, status: 200, text: `Readable text for ${url}. `.repeat(20), truncated: false };
};

function definition(): ResearchDefinition {
  return createResearchDefinition(RESEARCH_TOOL_NAME, search, fetchPage);
}

test('a research call fetches the leading pages and cites each excerpt', async () => {
  const value = await definition().execute({ query: 'kubernetes' }, {});
  // One query yields two distinct rows (the per-query page and the shared doc).
  assert.equal(value.pages.length, 2);
  assert.equal(value.pages.length <= RESEARCH_DEFAULT_SOURCES, true);
  assert.ok(value.pages.every((page) => page.excerpt.length > 0));
  assert.ok(value.pages.every((page) => value.queries.includes('kubernetes')));
  const text = formatResearchValue(value);
  for (const page of value.pages) {
    assert.ok(text.includes(page.url), `missing citation ${page.url}`);
    assert.ok(text.includes(page.excerpt.slice(0, 40)));
  }
});

test('queries are merged and their shared URL is fetched once', async () => {
  const value = await definition().execute({ query: 'alpha', queries: ['beta', 'alpha'] }, {});
  assert.deepEqual(value.queries, ['alpha', 'beta']);
  const urls = value.pages.map((page) => page.url.toLowerCase());
  assert.equal(new Set(urls).size, urls.length);
  // Three distinct rows exist after folding the shared URL; the default budget
  // is three, so nothing is cut.
  assert.equal(value.found, 3);
  assert.equal(value.truncated, false);
});

test('a broken page is reported, and the rest of the pack still arrives', async () => {
  const url = 'https://broken.example/page';
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source(url), source('https://ok.example/page')], failures: [] }),
    fetchPage,
  ).execute({ query: 'x' }, {});
  assert.equal(value.pages.length, 1);
  assert.equal(value.failures.length, 1);
  assert.equal(value.failures[0]?.url, url);
  assert.match(value.failures[0]?.reason ?? '', /timed out/);
  assert.ok(formatResearchValue(value).includes('Fetch failures'));
});

test('a page with no readable text is a reported failure, not an empty citation', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://blank.example/')], failures: [] }),
    async (url) => ({ url, status: 200, text: '   \n\n  ', truncated: false }),
  ).execute({ query: 'x' }, {});
  assert.equal(value.pages.length, 0);
  assert.match(value.failures[0]?.reason ?? '', /no readable text/);
});

test('search failures do not stop the other queries', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async (query) => {
      if (query === 'bad') throw new Error('engine exploded');
      return { sources: [source('https://ok.example/')], failures: [] };
    },
    fetchPage,
  ).execute({ query: 'bad', queries: ['good'] }, {});
  assert.equal(value.queries.length, 2);
  assert.equal(value.pages.length, 1);
});

test('maxSources is clamped and bad arguments are rejected', async () => {
  const value = await definition().execute({ query: 'x', maxSources: 99 }, {});
  assert.ok(value.pages.length <= RESEARCH_MAX_SOURCES);
  await assert.rejects(() => definition().execute({}, {}), /non-empty query/);
  await assert.rejects(() => definition().execute({ query: 'x', queries: 'nope' }, {}), /array of strings/);
  await assert.rejects(() => definition().execute({ query: 'x', queries: ['a', 'b', 'c', 'd'] }, {}), /at most 3/);
  await assert.rejects(() => definition().execute({ query: 'x', maxSources: 1.5 }, {}), /integer/);
});

test('canonicalKey folds the differences engines disagree about', () => {
  assert.equal(canonicalKey('https://www.example.com/docs/'), canonicalKey('https://example.com/docs'));
  assert.equal(canonicalKey('https://example.com/a?x=1#top'), canonicalKey('https://example.com/a?x=1'));
  assert.equal(canonicalKey('ftp://example.com/a'), undefined);
});

test('the registration falls back when the name is taken and survives rejection', () => {
  const definitions: ResearchDefinition[] = [];
  const registry: ResearchRegistryLike = {
    register: (definition) => {
      definitions.push(definition);
      return () => undefined;
    },
    get: (name) => (name === RESEARCH_TOOL_NAME ? {} : undefined),
  };
  const registration = registerResearchTool(registry, search, fetchPage);
  assert.equal(registration?.name, RESEARCH_TOOL_FALLBACK_NAME);
  assert.equal(definitions[0]?.name, RESEARCH_TOOL_FALLBACK_NAME);

  const rejecting: ResearchRegistryLike = { register: () => { throw new Error('duplicate'); } };
  const warnings: string[] = [];
  assert.equal(registerResearchTool(rejecting, search, fetchPage, { warn: (message) => warnings.push(message) }), undefined);
  assert.match(warnings[0] ?? '', /research registration skipped/);
  assert.equal(pickResearchToolName({ register: () => undefined }), RESEARCH_TOOL_NAME);
});

test('the pack lists rows that were found but not fetched', async () => {
  const value: ResearchValue = await definition().execute({ query: 'x', maxSources: 1 }, {});
  assert.ok(value.sources.length > 0);
  const text = formatResearchValue(value);
  assert.ok(text.includes('Found but not fetched'));
  const failures: ResearchFetchFailure[] = value.failures;
  assert.ok(Array.isArray(failures));
});

test('a failed page is replaced by the next candidate instead of shrinking the pack', async () => {
  const urls = [
    'https://broken.example/one',
    'https://ok.example/two',
    'https://ok.example/three',
    'https://ok.example/four',
  ];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: urls.map((url) => source(url)), failures: [] }),
    async (url) => {
      if (url.includes('broken')) throw new Error('timed out');
      return { url, status: 200, text: `content of ${url}`, truncated: false };
    },
  ).execute({ query: 'x', maxSources: 2 }, {});
  assert.equal(value.pages.length, 2);
  assert.deepEqual(value.pages.map((page) => page.url), ['https://ok.example/two', 'https://ok.example/three']);
  assert.equal(value.failures.length, 1);
  assert.equal(value.failures[0]?.url, urls[0]);
  assert.ok(!value.sources.some((row) => row.url === urls[0]), 'a failed URL is not advertised as unfetched');
});

test('rows that share no query token are skipped when enough relevant rows exist', async () => {
  const rows = [
    source('https://recipe.example/pasta', 'Cooking recipes', 'pasta and tomato sauce'),
    source('https://k8s.example/networking', 'Kubernetes networking guide', 'services and pods'),
    source('https://k8s.example/service', 'Kubernetes service networking', 'cluster DNS'),
  ];
  const fetched: string[] = [];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: rows, failures: [] }),
    async (url) => {
      fetched.push(url);
      return { url, status: 200, text: `readable prose about ${url}`, truncated: false };
    },
  ).execute({ query: 'kubernetes service networking', maxSources: 2 }, {});
  assert.deepEqual(fetched, ['https://k8s.example/service', 'https://k8s.example/networking']);
  assert.equal(value.pages.length, 2);
  assert.ok(!value.pages.some((page) => page.url.includes('recipe')));
  assert.deepEqual(value.sources.map((row) => row.url), ['https://recipe.example/pasta']);
});
