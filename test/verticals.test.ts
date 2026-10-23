/**
 * Offline contract tests for the key-free vertical sources.
 *
 * Every normal and empty body below is a real response from the live endpoint,
 * trimmed to the fields the parser reads and kept under 3 KB so the suite stays
 * fast and self-contained. `fetch` is replaced with a router, so these tests
 * cover parsing, orchestration, HTTP classification, timeouts and failure
 * isolation without touching the network.
 *
 * @module dsh-web-search-bing/test/verticals
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import {
  DEFAULT_VERTICAL_IDS,
  MAX_VERTICAL_LIMIT,
  VERTICALS,
  VERTICAL_IDS,
  parseArxiv,
  parseCrates,
  parseGithub,
  parseHn,
  parseNpm,
  parsePypi,
  parseStackExchange,
  parseWikipedia,
  searchVerticals,
} from '../src/verticals.ts';
import type { FetchLike, VerticalId } from '../src/verticals.ts';

/** Read one captured fixture. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** The fixture pair and parsed row count for each source. */
const CASES: Record<VerticalId, { normal: string; empty: string; rows: number }> = {
  github: { normal: 'verticals-github.json', empty: 'verticals-github-empty.json', rows: 2 },
  npm: { normal: 'verticals-npm.json', empty: 'verticals-npm-empty.json', rows: 2 },
  pypi: { normal: 'verticals-pypi.json', empty: 'verticals-pypi-empty.json', rows: 1 },
  arxiv: { normal: 'verticals-arxiv.xml', empty: 'verticals-arxiv-empty.xml', rows: 1 },
  wikipedia: { normal: 'verticals-wikipedia.json', empty: 'verticals-wikipedia-empty.json', rows: 2 },
  hn: { normal: 'verticals-hn.json', empty: 'verticals-hn-empty.json', rows: 2 },
  stackexchange: { normal: 'verticals-stackexchange.json', empty: 'verticals-stackexchange-empty.json', rows: 2 },
  crates: { normal: 'verticals-crates.json', empty: 'verticals-crates-empty.json', rows: 2 },
};

/** One HTTP answer the stub serves. */
type Reply = { status?: number; body: string } | { error: Error };

/** The parser for each source. */
const PARSERS: Record<VerticalId, (payload: string, url: string, limit?: number) => ReturnType<typeof parseGithub>> = {
  github: parseGithub,
  npm: parseNpm,
  pypi: parsePypi,
  arxiv: parseArxiv,
  wikipedia: parseWikipedia,
  hn: parseHn,
  stackexchange: parseStackExchange,
  crates: parseCrates,
};

/** Route a request by hostname, recording each URL. */
function routed(
  routes: Partial<Record<string, Reply>>,
  calls: string[] = [],
): FetchLike {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    const reply = routes[host];
    if (reply === undefined) throw new Error(`unexpected host ${host}`);
    if ('error' in reply) throw reply.error;
    return new Response(reply.body, { status: reply.status ?? 200 });
  };
}

/** The normal replies, keyed by host. */
async function normalRoutes(): Promise<Record<string, Reply>> {
  return {
    'api.github.com': { body: await fixture(CASES.github.normal) },
    'registry.npmjs.org': { body: await fixture(CASES.npm.normal) },
    'pypi.org': { body: await fixture(CASES.pypi.normal) },
    'export.arxiv.org': { body: await fixture(CASES.arxiv.normal) },
    'en.wikipedia.org': { body: await fixture(CASES.wikipedia.normal) },
    'hn.algolia.com': { body: await fixture(CASES.hn.normal) },
    'api.stackexchange.com': { body: await fixture(CASES.stackexchange.normal) },
    'crates.io': { body: await fixture(CASES.crates.normal) },
  };
}

/** The empty replies, keyed by host. */
async function emptyRoutes(): Promise<Record<string, Reply>> {
  return {
    'api.github.com': { body: await fixture(CASES.github.empty) },
    'registry.npmjs.org': { body: await fixture(CASES.npm.empty) },
    'pypi.org': { body: await fixture(CASES.pypi.empty) },
    'export.arxiv.org': { body: await fixture(CASES.arxiv.empty) },
    'en.wikipedia.org': { body: await fixture(CASES.wikipedia.empty) },
    'hn.algolia.com': { body: await fixture(CASES.hn.empty) },
    'api.stackexchange.com': { body: await fixture(CASES.stackexchange.empty) },
    'crates.io': { body: await fixture(CASES.crates.empty) },
  };
}

test('all eight default fixtures are real, non-empty captures under the 3 KB budget', async () => {
  assert.equal(DEFAULT_VERTICAL_IDS.length, 8);
  assert.deepEqual(VERTICALS.map((spec) => spec.id), [...VERTICAL_IDS]);
  for (const id of DEFAULT_VERTICAL_IDS) {
    const normal = CASES[id].normal;
    const info = await stat(new URL(`./fixtures/${normal}`, import.meta.url));
    assert.ok(info.size > 0, `${normal} is empty`);
    assert.ok(info.size <= 3072, `${normal} is ${info.size} bytes, over the 3 KB budget`);
    const body = await fixture(normal);
    assert.ok(body.length > 0);
  }
});

test('every expanded source is present and opt-in', () => {
  const expanded = VERTICAL_IDS.filter((id) => !DEFAULT_VERTICAL_IDS.includes(id));
  assert.ok(expanded.length >= 20, `only ${expanded.length} expanded source(s)`);
  for (const id of expanded) {
    const spec = VERTICALS.find((candidate) => candidate.id === id);
    assert.ok(spec !== undefined, `${id} is missing from VERTICALS`);
    assert.equal(spec.defaultOn, false, `${id} must not be on by default`);
  }
});

for (const id of DEFAULT_VERTICAL_IDS) {
  test(`${id} parses a real response into citable sources`, async () => {
    const spec = VERTICALS.find((candidate) => candidate.id === id);
    assert.ok(spec !== undefined);
    const payload = await fixture(CASES[id].normal);
    const url = spec.build('react requests', 5);
    const sources = PARSERS[id](payload, url, 5);
    assert.equal(sources.length, CASES[id].rows, `${id} should yield ${CASES[id].rows} row(s)`);
    for (const source of sources) {
      assert.match(source.url, /^https?:\/\//, `${id} produced a non-http URL`);
      assert.ok((source.title ?? '').length > 0, `${id} produced an untitled row`);
    }
  });

  test(`${id} parses an empty response to an empty list`, async () => {
    const spec = VERTICALS.find((candidate) => candidate.id === id);
    assert.ok(spec !== undefined);
    const payload = await fixture(CASES[id].empty);
    assert.deepEqual(PARSERS[id](payload, spec.build('react', 5), 5), []);
  });

  test(`${id} parser survives markup drift without throwing`, () => {
    assert.deepEqual(PARSERS[id]('<html>rate limited</html>', 'https://example.com/', 5), []);
  });
}

test('GitHub keeps real repository metadata and the published time', async () => {
  const sources = parseGithub(await fixture(CASES.github.normal), 'https://api.github.com/', 5);
  assert.equal(sources[0]?.url, 'https://github.com/react/react');
  assert.equal(sources[0]?.title, 'react/react');
  assert.match(sources[0]?.snippet ?? '', /web and native user interfaces/);
  assert.match(sources[0]?.publishedAt ?? '', /^2026-/);
});

test('npm reports package@version and the npm package URL', async () => {
  const sources = parseNpm(await fixture(CASES.npm.normal), 'https://registry.npmjs.org/', 5);
  assert.equal(sources[0]?.url, 'https://www.npmjs.com/package/react');
  assert.equal(sources[0]?.title, 'react@19.3.1');
});

test('PyPI asks for the exact package name and keeps its upload time', async () => {
  const spec = VERTICALS.find((candidate) => candidate.id === 'pypi');
  assert.ok(spec !== undefined);
  assert.equal(spec.build('requests http client', 5), 'https://pypi.org/pypi/requests/json');
  assert.equal(spec.notFoundIsEmpty, true);
  const sources = parsePypi(await fixture(CASES.pypi.normal), spec.build('requests', 5), 5);
  assert.equal(sources[0]?.url, 'https://pypi.org/project/requests/');
  assert.equal(sources[0]?.title, 'requests 2.34.2');
  assert.equal(sources[0]?.publishedAt, '2026-05-14T19:25:26.443000Z');
});

test('arXiv reads the Atom feed and upgrades the id to https', async () => {
  const sources = parseArxiv(await fixture(CASES.arxiv.normal), 'https://export.arxiv.org/api/query', 5);
  assert.match(sources[0]?.url ?? '', /^https:\/\/arxiv\.org\/abs\//);
  assert.match(sources[0]?.title ?? '', /electronic structure of cuprates/);
  assert.ok((sources[0]?.publishedAt ?? '').length > 0);
});

test('Wikipedia chooses zh for a CJK query and en otherwise', () => {
  const spec = VERTICALS.find((candidate) => candidate.id === 'wikipedia');
  assert.ok(spec !== undefined);
  assert.match(spec.build('如何配置 postgres', 5), /^https:\/\/zh\.wikipedia\.org\//);
  assert.match(spec.build('react hooks', 5), /^https:\/\/en\.wikipedia\.org\//);
});

test('Wikipedia strips search highlighting from the excerpt and builds the page URL', async () => {
  const sources = parseWikipedia(
    await fixture(CASES.wikipedia.normal),
    'https://en.wikipedia.org/w/rest.php/v1/search/page?q=React',
    5,
  );
  assert.equal(sources[0]?.url, 'https://en.wikipedia.org/wiki/React');
  assert.equal(sources[0]?.title, 'React');
  assert.doesNotMatch(sources[0]?.snippet ?? '', /<span|searchmatch/);
  assert.match(sources[0]?.snippet ?? '', /may refer to/);
});

test('Hacker News falls back to the item URL when a story has no outbound link', () => {
  const payload = JSON.stringify({
    hits: [{ objectID: '42', title: 'Ask HN: anything', created_at: '2026-01-01T00:00:00Z' }],
  });
  const sources = parseHn(payload, 'https://hn.algolia.com/api/v1/search', 5);
  assert.equal(sources[0]?.url, 'https://news.ycombinator.com/item?id=42');
  assert.equal(sources[0]?.publishedAt, '2026-01-01T00:00:00Z');
});

test('Stack Exchange converts unix seconds and drops HTML tags', async () => {
  const sources = parseStackExchange(
    await fixture(CASES.stackexchange.normal),
    'https://api.stackexchange.com/2.3/search/advanced',
    5,
  );
  assert.match(sources[0]?.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.match(sources[0]?.snippet ?? '', /React Router/);
  assert.doesNotMatch(sources[0]?.snippet ?? '', /<p>|<a /);
});

test('crates reports name + version and the crate page', async () => {
  const sources = parseCrates(await fixture(CASES.crates.normal), 'https://crates.io/api/v1/crates', 5);
  assert.equal(sources[0]?.url, 'https://crates.io/crates/serde');
  assert.equal(sources[0]?.title, 'serde 1.0.229');
});

test('build URLs encode the query and carry the requested limit', () => {
  for (const id of DEFAULT_VERTICAL_IDS) {
    const spec = VERTICALS.find((candidate) => candidate.id === id);
    assert.ok(spec !== undefined);
    const url = spec.build('a b&c', 7);
    assert.match(url, /^https:\/\//, `${spec.id} must use https`);
    assert.doesNotMatch(url, / /, `${spec.id} left a raw space in ${url}`);
    if (spec.id !== 'pypi') assert.match(url, /7/, `${spec.id} must carry the limit`);
  }
  assert.equal(MAX_VERTICAL_LIMIT, 20);
});

test('a normal run queries every source, interleaves them and reports counts', async () => {
  const calls: string[] = [];
  const outcome = await searchVerticals('react', {
    fetch: routed(await normalRoutes(), calls),
    limit: 2,
  });
  assert.deepEqual(outcome.failures, []);
  assert.equal(calls.length, 8);
  assert.equal(outcome.counts.github, 2);
  assert.equal(outcome.counts.pypi, 1);
  assert.equal(outcome.sources.length, 2);
  assert.equal(outcome.truncated, true);
  // Round one takes one row from each source in registry order.
  assert.equal(outcome.sources[0]?.url, 'https://github.com/react/react');
  assert.equal(outcome.sources[1]?.url, 'https://www.npmjs.com/package/react');
});

test('a large budget returns every row and marks the run untruncated', async () => {
  const outcome = await searchVerticals('react', {
    fetch: routed(await normalRoutes()),
    limit: 20,
  });
  assert.equal(outcome.failures.length, 0);
  assert.equal(outcome.sources.length, 14, '2+2+1+1+2+2+2+2 rows');
  assert.equal(outcome.truncated, false);
  assert.equal(new Set(outcome.sources.map((source) => source.url)).size, outcome.sources.length);
});

test('all-empty answers produce no sources and no failures', async () => {
  const outcome = await searchVerticals('nothing at all', {
    fetch: routed(await emptyRoutes()),
    limit: 5,
  });
  assert.deepEqual(outcome.sources, []);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(Object.values(outcome.counts), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('an HTTP 500 on one source is isolated and the other seven still answer', async () => {
  const routes = await normalRoutes();
  routes['api.github.com'] = { status: 500, body: '' };
  const outcome = await searchVerticals('react', { fetch: routed(routes), limit: 20 });
  assert.equal(outcome.counts.github, 0);
  assert.ok(outcome.failures.some((failure) => failure === 'github: HTTP 500'), JSON.stringify(outcome.failures));
  assert.equal(outcome.sources.length, 12, 'the other seven contributed 2+1+1+2+2+2+2 rows');
});

test('a hung source times out without holding the others back', async () => {
  const routes = await normalRoutes();
  const hang: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined) {
      reject(new Error('test stub needs a signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
  });
  const grounded = routed(routes);
  const fetch: FetchLike = (input, init) => String(input).includes('api.github.com') ? hang(input, init) : grounded(input, init);
  const started = Date.now();
  const outcome = await searchVerticals('react', { fetch, limit: 20, timeoutMs: 25 });
  assert.ok(Date.now() - started < 2000, 'the dead source must not block the run');
  assert.equal(outcome.counts.github, 0);
  assert.ok(
    outcome.failures.some((failure) => failure.startsWith('github:') && /timeout|aborted|timed out/i.test(failure)),
    JSON.stringify(outcome.failures),
  );
  assert.ok(outcome.sources.length > 0, 'the healthy sources must still answer');
});

test('a thrown network failure on one source does not fail the run', async () => {
  const routes = await normalRoutes();
  routes['crates.io'] = { error: new Error('socket closed') };
  const outcome = await searchVerticals('react', { fetch: routed(routes), limit: 20 });
  assert.ok(outcome.failures.includes('crates: socket closed'), JSON.stringify(outcome.failures));
  assert.equal(outcome.counts.crates, 0);
  assert.ok(outcome.sources.some((source) => source.url.includes('github.com')));
});

test('a PyPI 404 is an empty answer, not a broken source', async () => {
  const routes = await normalRoutes();
  routes['pypi.org'] = { status: 404, body: await fixture(CASES.pypi.empty) };
  const outcome = await searchVerticals('definitely-not-a-package', { fetch: routed(routes), limit: 20 });
  assert.equal(outcome.counts.pypi, 0);
  assert.deepEqual(outcome.failures, []);
});

test('sources restricts the run to the requested adapters', async () => {
  const calls: string[] = [];
  const outcome = await searchVerticals('react', {
    fetch: routed(await normalRoutes(), calls),
    ids: ['github', 'arxiv'],
    limit: 5,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(outcome.counts).sort(), ['arxiv', 'github']);
  assert.equal(outcome.sources.length, 3, '2 GitHub + 1 arXiv');
});

test('a cancelled run reports SEARCH_ABORTED instead of partial success', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchVerticals('react', {
      fetch: routed(await normalRoutes()),
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

test('an empty query never touches the network', async () => {
  const calls: string[] = [];
  const outcome = await searchVerticals('   ', { fetch: routed(await normalRoutes(), calls) });
  assert.deepEqual(outcome.sources, []);
  assert.equal(calls.length, 0);
});
