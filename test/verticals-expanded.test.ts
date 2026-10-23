/**
 * Offline contract tests for the expanded key-free vertical sources.
 *
 * Each fixture under `test/fixtures/verticals/` is a real response from the
 * live endpoint, trimmed to the fields the parser reads and kept under 20 KB.
 * Nothing here touches the network: the orchestration tests replace `fetch`
 * with a router, exactly like `verticals.test.ts` does for the original eight
 * sources.
 *
 * Coverage per expanded source: a real capture parses into citable sources, an
 * empty body and unrelated JSON parse to `[]` without throwing, and `build()`
 * encodes the query and carries the row budget (or is documented as cap-only).
 * The structural tests pin the default set: a bare `domain_search` must keep
 * issuing the original eight requests and must not fan out to every registry.
 *
 * @module dsh-web-search-bing/test/verticals-expanded
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import {
  DEFAULT_VERTICAL_IDS,
  VERTICALS,
  VERTICAL_IDS,
  searchVerticals,
  verticalById,
} from '../src/verticals.ts';
import type { FetchLike } from '../src/verticals.ts';

/** Fixture size ceiling: a trimmed capture, not a saved response. */
const FIXTURE_BUDGET = 20 * 1024;

/** Sources whose endpoint has no row parameter; their parser caps the answer. */
const CAP_ONLY = new Set(['rubygems', 'packagist', 'pubdev', 'coingecko']);

/** Every source added by the expansion. */
const EXPANDED_IDS = VERTICAL_IDS.filter((id) => !DEFAULT_VERTICAL_IDS.includes(id));

/** Read one captured fixture. */
async function fixtureBody(id: string): Promise<string> {
  return readFile(new URL(`./fixtures/verticals/${id}.json`, import.meta.url), 'utf8');
}

/** Source URL of the fixture file. */
function fixtureUrl(id: string): URL {
  return new URL(`./fixtures/verticals/${id}.json`, import.meta.url);
}

test('the expansion adds at least twenty opt-in sources without disturbing the default eight', () => {
  assert.ok(EXPANDED_IDS.length >= 20, `only ${EXPANDED_IDS.length} expanded source(s)`);
  assert.ok(VERTICAL_IDS.length >= 30, `only ${VERTICAL_IDS.length} sources in total`);
  assert.equal(VERTICALS.length, VERTICAL_IDS.length);
  assert.deepEqual(VERTICALS.map((spec) => spec.id), [...VERTICAL_IDS]);
  assert.equal(new Set(VERTICAL_IDS).size, VERTICAL_IDS.length, 'duplicate source id');
  assert.deepEqual(
    [...DEFAULT_VERTICAL_IDS],
    ['github', 'npm', 'pypi', 'arxiv', 'wikipedia', 'hn', 'stackexchange', 'crates'],
    'the historical default set and its order must not change',
  );
  for (const id of VERTICAL_IDS) {
    assert.ok(verticalById(id) !== undefined, `${id} has no adapter`);
  }
  for (const id of EXPANDED_IDS) {
    assert.equal(verticalById(id)?.defaultOn, false, `${id} must be opt-in`);
  }
  for (const id of DEFAULT_VERTICAL_IDS) {
    assert.notEqual(verticalById(id)?.defaultOn, false, `${id} must stay on by default`);
  }
});

test('every expanded fixture is a trimmed real capture under the 20 KB budget', async () => {
  for (const id of EXPANDED_IDS) {
    const info = await stat(fixtureUrl(id));
    assert.ok(info.size > 0, `${id} fixture is empty`);
    assert.ok(info.size <= FIXTURE_BUDGET, `${id} fixture is ${info.size} bytes`);
    const payload = await fixtureBody(id);
    assert.doesNotThrow(() => JSON.parse(payload), `${id} fixture is not JSON`);
  }
});

for (const id of EXPANDED_IDS) {
  test(`${id} parses a real capture into citable sources`, async () => {
    const spec = verticalById(id);
    assert.ok(spec !== undefined);
    const payload = await fixtureBody(id);
    const url = spec.build('kubernetes', 5);
    const sources = spec.parse(payload, url, 5);
    assert.ok(sources.length >= 1, `${id} parsed no rows from its fixture`);
    for (const source of sources) {
      assert.match(source.url, /^https:\/\//, `${id} produced a non-https URL`);
      assert.ok((source.title ?? '').length > 0, `${id} produced an untitled row`);
      assert.ok((source.snippet ?? '').length <= 401, `${id} produced an unbounded snippet`);
      if (source.publishedAt !== undefined) {
        assert.ok(source.publishedAt.length > 0, `${id} produced an empty publishedAt`);
      }
    }
    assert.equal(sources.length, spec.parse(payload, url, sources.length).length);
    assert.equal(spec.parse(payload, url, 1).length, 1, `${id} ignored limit=1`);
  });

  test(`${id} parses empty and unrelated bodies to [] without throwing`, () => {
    const spec = verticalById(id);
    assert.ok(spec !== undefined);
    const url = spec.build('react', 5);
    assert.deepEqual(spec.parse('', url, 5), []);
    assert.deepEqual(spec.parse('{"unexpected":true}', url, 5), []);
    assert.deepEqual(spec.parse('<html>rate limited</html>', url, 5), []);
  });

  test(`${id} builds an encoded URL and carries the row budget`, () => {
    const spec = verticalById(id);
    assert.ok(spec !== undefined);
    const url = spec.build('a b&c', 7);
    assert.match(url, /^https:\/\//, `${id} must use https`);
    assert.doesNotMatch(url, /\s/, `${id} left a raw space in ${url}`);
    assert.ok(url.includes('a%20b%26c'), `${id} left the query unencoded: ${url}`);
    if (CAP_ONLY.has(id)) {
      assert.equal(spec.build('a b&c', 3), url, `${id} has no limit parameter`);
      assert.equal(spec.build('a b&c', 9), url, `${id} has no limit parameter`);
    } else {
      assert.match(url, /=7(?:&|$)/, `${id} dropped the row budget: ${url}`);
    }
  });
}

test('openalex maps DOI, title, abstract and date', async () => {
  const spec = verticalById('openalex');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('openalex'), spec.build('kubernetes', 5), 5);
  assert.equal(sources[0]?.url, 'https://doi.org/10.1145/2890784');
  assert.equal(sources[0]?.title, 'Borg, Omega, and Kubernetes');
  assert.match(sources[0]?.snippet ?? '', /container-management/);
  assert.equal(sources[0]?.publishedAt, '2016-04-26');
});

test('crossref reads message.items and builds the DOI URL', async () => {
  const spec = verticalById('crossref');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('crossref'), spec.build('kubernetes', 5), 5);
  assert.equal(sources[0]?.title, 'Kubernetes API Introduction');
  assert.equal(sources[0]?.url, 'https://doi.org/10.1007/978-1-4842-9026-2_1');
  assert.equal(sources[0]?.publishedAt, '2022-12-25');
});

test('githubissues keeps the issue URL and the created time', async () => {
  const spec = verticalById('githubissues');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('githubissues'), spec.build('kubernetes', 5), 5);
  assert.match(sources[0]?.url ?? '', /^https:\/\/github\.com\/.+\/(?:issues|pull)\//);
  assert.match(sources[0]?.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('maven and nuget name the version and link the canonical package page', async () => {
  const maven = verticalById('maven');
  const nuget = verticalById('nuget');
  assert.ok(maven !== undefined && nuget !== undefined);
  const mavenSources = maven.parse(await fixtureBody('maven'), maven.build('kubernetes', 5), 5);
  assert.match(mavenSources[0]?.url ?? '', /^https:\/\/central\.sonatype\.com\/artifact\//);
  assert.match(mavenSources[0]?.title ?? '', /^[\w.-]+:kubernetes \d/);
  assert.match(mavenSources[0]?.snippet ?? '', /versions?$/);
  const nugetSources = nuget.parse(await fixtureBody('nuget'), nuget.build('kubernetes', 5), 5);
  assert.equal(nugetSources[0]?.url, 'https://www.nuget.org/packages/KubernetesClient');
  assert.equal(nugetSources[0]?.title, 'KubernetesClient 21.0.8');
});

test('hugging face datasets link the dataset page, not the model page', async () => {
  const spec = verticalById('hfdatasets');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('hfdatasets'), spec.build('kubernetes', 5), 5);
  assert.match(sources[0]?.url ?? '', /^https:\/\/huggingface\.co\/datasets\//);
});

test('wordpress strips markup entities from plugin names', async () => {
  const spec = verticalById('wordpress');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('wordpress'), spec.build('kubernetes', 5), 5);
  assert.ok(sources.length > 1);
  for (const source of sources) {
    assert.doesNotMatch(source.title ?? '', /&#?\w+;/);
    assert.match(source.url, /^https:\/\/wordpress\.org\/plugins\/[a-z0-9-]+\/$/);
  }
});

test('nominatim links the OSM object rather than a search page', async () => {
  const spec = verticalById('nominatim');
  assert.ok(spec !== undefined);
  const sources = spec.parse(await fixtureBody('nominatim'), spec.build('paris', 5), 5);
  assert.match(sources[0]?.url ?? '', /^https:\/\/www\.openstreetmap\.org\/[a-z]+\/\d+$/);
  assert.match(sources[0]?.snippet ?? '', /Paris/);
});

test('nvd and clinicaltrials expose stable record URLs', async () => {
  const nvd = verticalById('nvd');
  const trials = verticalById('clinicaltrials');
  assert.ok(nvd !== undefined && trials !== undefined);
  const nvdSources = nvd.parse(await fixtureBody('nvd'), nvd.build('kubernetes', 5), 5);
  assert.match(nvdSources[0]?.url ?? '', /^https:\/\/nvd\.nist\.gov\/vuln\/detail\/CVE-\d{4}-\d+$/);
  assert.match(nvdSources[0]?.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const trialSources = trials.parse(await fixtureBody('clinicaltrials'), trials.build('cancer', 5), 5);
  assert.match(trialSources[0]?.url ?? '', /^https:\/\/clinicaltrials\.gov\/study\/NCT\d+$/);
});

/** A fetch stub that answers every URL with an empty JSON document. */
function emptyFetch(calls: string[]): FetchLike {
  return async (input) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  };
}

test('a bare domain search issues the original eight requests, not thirty-four', async () => {
  const calls: string[] = [];
  const outcome = await searchVerticals('react', { fetch: emptyFetch(calls), limit: 5 });
  assert.equal(calls.length, DEFAULT_VERTICAL_IDS.length);
  assert.deepEqual(Object.keys(outcome.counts), [...DEFAULT_VERTICAL_IDS]);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(outcome.sources, []);
});

test('naming expanded sources queries only the named adapters', async () => {
  const calls: string[] = [];
  const routes: Record<string, string> = {
    'api.openalex.org': await fixtureBody('openalex'),
    'services.nvd.nist.gov': await fixtureBody('nvd'),
    'registry.npmjs.org': '{"objects":[]}',
  };
  const fetch: FetchLike = async (input) => {
    const host = new URL(String(input)).hostname;
    calls.push(host);
    const body = routes[host];
    if (body === undefined) throw new Error(`unexpected host ${host}`);
    return new Response(body, { status: 200 });
  };
  const outcome = await searchVerticals('kubernetes', {
    ids: ['openalex', 'nvd', 'npm'],
    fetch,
    limit: 5,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(outcome.counts).sort(), ['npm', 'nvd', 'openalex']);
  assert.equal(outcome.counts.openalex, 2);
  assert.equal(outcome.counts.nvd, 2);
  assert.equal(outcome.counts.npm, 0);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.sources.length, 4);
});

test('unknown ids alone fall back to the default set', async () => {
  const calls: string[] = [];
  const outcome = await searchVerticals('react', { ids: ['not-a-source'], fetch: emptyFetch(calls), limit: 5 });
  assert.equal(calls.length, DEFAULT_VERTICAL_IDS.length);
  assert.deepEqual(Object.keys(outcome.counts), [...DEFAULT_VERTICAL_IDS]);
});
