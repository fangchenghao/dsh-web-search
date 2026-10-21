/**
 * Ranking tests: dedupe, weighted interleave, RRF fusion and the bilingual
 * region merge.
 *
 * Every case is written against fixed URLs and ranks so a failure points at one
 * formula rather than at network luck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineAnswer, HostSpec, Region, Source } from '../src/types.ts';
import {
  DEFAULT_AUTHORITY_DOMAINS,
  dedupe,
  fuse,
  interleave,
  mergeRegions,
} from '../src/rank.ts';

const DAY = 86_400_000;

/**
 * Build a minimal engine.
 * @param id - engine id, also used as the fake hostname.
 * @param region - configured region.
 * @param weight - optional configured weight.
 * @returns the engine spec.
 */
function host(id: string, region: Region, weight?: number): HostSpec {
  return {
    id,
    tier: 'primary',
    region,
    build: (query: string) => `https://${id}.test/search?q=${encodeURIComponent(query)}`,
    parse: () => [],
    ...(weight === undefined ? {} : { weight }),
  };
}

/**
 * Build a source, omitting optional fields the test did not set.
 * @param url - source URL.
 * @param publishedAt - optional publication date.
 * @param title - optional title.
 * @returns the source.
 */
function src(url: string, publishedAt?: string, title?: string): Source {
  return {
    url,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(title === undefined ? {} : { title }),
  };
}

/**
 * Build one engine answer.
 * @param engine - the engine.
 * @param sources - its rows.
 * @returns the answer.
 */
function answer(engine: HostSpec, sources: Source[]): EngineAnswer {
  return { host: engine, sources };
}

/**
 * A list of distinct fake sources.
 * @param name - fake hostname.
 * @param count - how many.
 * @returns the sources.
 */
function numbered(name: string, count: number): Source[] {
  return Array.from({ length: count }, (_unused, index) => src(`https://${name}.test/${index + 1}`));
}

/**
 * Map sources to their URLs.
 * @param sources - ranked sources.
 * @returns the URL list.
 */
function urls(sources: Source[]): string[] {
  return sources.map((source) => source.url);
}

test('dedupe collapses www. and a trailing slash while keeping the first row', () => {
  const first = src('https://www.example.com/docs/', undefined, 'first');
  const out = dedupe([
    first,
    src('https://example.com/docs'),
    src('http://www.other.test/'),
    src('http://other.test'),
    src('https://example.com/docs/'),
  ]);
  assert.deepEqual(urls(out), ['https://www.example.com/docs/', 'http://www.other.test/']);
  assert.equal(out[0], first, 'the original object is kept, not a rewritten copy');
});

test('dedupe keeps first-seen order instead of sorting', () => {
  const out = dedupe([
    src('https://b.test/'),
    src('https://a.test/'),
    src('https://c.test/'),
    src('https://a.test'),
  ]);
  assert.deepEqual(urls(out), ['https://b.test/', 'https://a.test/', 'https://c.test/']);
});

test('interleave takes one row from each list per round', () => {
  const merged = interleave([numbered('a', 3), numbered('b', 2)]);
  assert.deepEqual(urls(merged), [
    'https://a.test/1',
    'https://b.test/1',
    'https://a.test/2',
    'https://b.test/2',
    'https://a.test/3',
  ]);
});

test('interleave gives a weight-2 list roughly twice the slots of a weight-1 list', () => {
  const merged = interleave([numbered('heavy', 8), numbered('light', 8)], [2, 1]);
  const head = merged.slice(0, 12);
  assert.equal(head.filter((source) => source.url.includes('heavy.test')).length, 8);
  assert.equal(head.filter((source) => source.url.includes('light.test')).length, 4);
  assert.deepEqual(urls(head.slice(0, 3)), [
    'https://heavy.test/1',
    'https://heavy.test/2',
    'https://light.test/1',
  ]);
});

test('interleave drains ragged lists without losing rows', () => {
  const merged = interleave([numbered('a', 2), [], numbered('c', 4)]);
  assert.deepEqual(urls(merged), [
    'https://a.test/1',
    'https://c.test/1',
    'https://a.test/2',
    'https://c.test/2',
    'https://c.test/3',
    'https://c.test/4',
  ]);
});

test('interleave returns nothing for no lists and for only empty lists', () => {
  assert.deepEqual(interleave([]), []);
  assert.deepEqual(interleave([[], []]), []);
  assert.deepEqual(interleave([[], []], [3, 1]), []);
});

test('interleave dedupes rows two engines both returned', () => {
  const merged = interleave([[src('https://www.same.test/x/')], [src('https://same.test/x')]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.url, 'https://www.same.test/x/');
});

test('fuse returns no sources for no answers', () => {
  assert.deepEqual(fuse([], 8), []);
  assert.deepEqual(fuse([answer(host('empty', 'global'), [])], 8), []);
});

test('fuse ranks an authoritative domain above a non-authoritative one at equal rank', () => {
  const blog = answer(host('blog', 'global'), [
    src('https://seo-farm.test/postgres-logical-replication'),
  ]);
  const docs = answer(host('docs', 'global'), [
    src('https://www.postgresql.org/docs/current/logical-replication.html'),
  ]);
  assert.deepEqual(urls(fuse([blog, docs], 2)), [
    'https://www.postgresql.org/docs/current/logical-replication.html',
    'https://seo-farm.test/postgres-logical-replication',
  ]);
});

test('fuse treats a subdomain of an authority domain as authoritative', () => {
  const outside = answer(host('outside', 'global'), [src('https://medium.test/kubernetes-entry')]);
  const inside = answer(host('inside', 'global'), [src('https://blog.kubernetes.io/2024/entry')]);
  assert.deepEqual(urls(fuse([outside, inside], 2)), [
    'https://blog.kubernetes.io/2024/entry',
    'https://medium.test/kubernetes-entry',
  ]);
});

test('fuse honours a custom authorityDomains list and an empty one disables the boost', () => {
  const answers = [
    answer(host('docs', 'global'), [src('https://www.postgresql.org/docs/')]),
    answer(host('guide', 'global'), [src('https://example.org/guide')]),
  ];
  assert.deepEqual(urls(fuse(answers, 2, { authorityDomains: ['example.org'] })), [
    'https://example.org/guide',
    'https://www.postgresql.org/docs/',
  ]);
  assert.deepEqual(urls(fuse(answers, 2, { authorityDomains: [] })), [
    'https://www.postgresql.org/docs/',
    'https://example.org/guide',
  ]);
});

test('fuse ranks a freshly published result above a stale one at equal rank', () => {
  const stale = answer(host('stale', 'global'), [
    src('https://stale.test/post', new Date(Date.now() - 400 * DAY).toISOString()),
  ]);
  const fresh = answer(host('fresh', 'global'), [
    src('https://fresh.test/post', new Date(Date.now() - 2 * DAY).toISOString()),
  ]);
  assert.deepEqual(urls(fuse([stale, fresh], 2)), ['https://fresh.test/post', 'https://stale.test/post']);
});

test('fuse lets freshnessDays decide whether a ten-day-old result is still fresh', () => {
  const plain = answer(host('plain', 'global'), [src('https://plain.test/post')]);
  const dated = answer(host('dated', 'global'), [
    src('https://dated.test/post', new Date(Date.now() - 10 * DAY).toISOString()),
  ]);
  assert.deepEqual(urls(fuse([plain, dated], 2)), ['https://dated.test/post', 'https://plain.test/post']);
  assert.deepEqual(urls(fuse([plain, dated], 2, { freshnessDays: 5 })), [
    'https://plain.test/post',
    'https://dated.test/post',
  ]);
});

test('fuse ignores an unparsable publishedAt instead of penalising it', () => {
  const broken = answer(host('broken', 'global'), [src('https://broken.test/post', 'not a date')]);
  const absent = answer(host('absent', 'global'), [src('https://absent.test/post')]);
  assert.deepEqual(urls(fuse([broken, absent], 2)), ['https://broken.test/post', 'https://absent.test/post']);
  assert.deepEqual(urls(fuse([absent, broken], 2)), ['https://absent.test/post', 'https://broken.test/post']);
});

test('fuse ranks a result two engines agree on above a single-engine result', () => {
  const consensus = src('https://consensus.test/answer');
  const first = answer(host('one', 'global'), [src('https://single.test/answer'), consensus]);
  const second = answer(host('two', 'global'), [consensus, ...numbered('other', 2)]);
  const fused = fuse([first, second], 8);
  assert.equal(fused[0]?.url, 'https://consensus.test/answer');
  assert.equal(fused.length, 4);
});

test('fuse takes engine weights from the options before the host default', () => {
  const light = answer(host('light', 'global'), [src('https://light.test/1')]);
  const heavy = answer(host('heavy', 'global', 1), [
    src('https://heavy.test/1'),
    src('https://heavy.test/2'),
  ]);
  // Unweighted, the heavy engine's rank-2 row loses to the light rank-1 row.
  assert.deepEqual(urls(fuse([light, heavy], 3)), [
    'https://light.test/1',
    'https://heavy.test/1',
    'https://heavy.test/2',
  ]);
  // At weight 3 the heavy engine takes both top slots and pushes the light row down.
  assert.deepEqual(urls(fuse([light, heavy], 3, { weights: [1, 3] })), [
    'https://heavy.test/1',
    'https://heavy.test/2',
    'https://light.test/1',
  ]);
});

test('fuse falls back to the host weight when no per-engine weight is given', () => {
  const plain = answer(host('plain', 'global'), [src('https://plain.test/1')]);
  const boosted = answer(host('boosted', 'global', 2), [src('https://boosted.test/1')]);
  assert.deepEqual(urls(fuse([plain, boosted], 2)), ['https://boosted.test/1', 'https://plain.test/1']);
});

test('fuse breaks exact ties by engine order, then rank, and repeats identically', () => {
  const answers = ['e0', 'e1', 'e2', 'e3'].map((id) =>
    answer(host(id, 'global'), [src(`https://${id}.test/only`)]),
  );
  const expected = ['https://e0.test/only', 'https://e1.test/only', 'https://e2.test/only', 'https://e3.test/only'];
  assert.deepEqual(urls(fuse(answers, 4)), expected);
  assert.deepEqual(urls(fuse(answers, 4)), expected);
  assert.deepEqual(urls(fuse([...answers].reverse(), 4)), [...expected].reverse());
});

test('fuse slices to the limit and leaves the input untouched', () => {
  const sources = numbered('x', 6);
  const list = answer(host('only', 'global'), sources);
  assert.deepEqual(urls(fuse([list], 3)), ['https://x.test/1', 'https://x.test/2', 'https://x.test/3']);
  assert.equal(list.sources.length, 6);
  assert.deepEqual(fuse([list], 0), []);
  assert.deepEqual(fuse([list], -2), []);
});

test('mergeRegions fills an ASCII-style budget from global and both engines only', () => {
  const answers = [
    answer(host('anysearch', 'both', 2), numbered('any', 10)),
    answer(host('ddg', 'global'), numbered('ddg', 10)),
    answer(host('cnbing', 'cn'), numbered('cnbing', 10)),
    answer(host('so', 'cn'), numbered('so', 10)),
  ];
  const merged = mergeRegions(answers, 'global', 8);
  assert.equal(merged.length, 8);
  for (const source of merged) assert.match(source.url, /^https:\/\/(any|ddg)\.test\//);
});

test('mergeRegions fills a CJK-style budget from cn and both engines only', () => {
  const answers = [
    answer(host('anysearch', 'both', 2), numbered('any', 10)),
    answer(host('ddg', 'global'), numbered('ddg', 10)),
    answer(host('cnbing', 'cn'), numbered('cnbing', 10)),
    answer(host('so', 'cn'), numbered('so', 10)),
  ];
  const merged = mergeRegions(answers, 'cn', 8);
  assert.equal(merged.length, 8);
  for (const source of merged) assert.match(source.url, /^https:\/\/(any|cnbing|so)\.test\//);
});

test('mergeRegions appends the tail only to fill a short head and never reorders it', () => {
  const head = [
    answer(host('anysearch', 'both'), [src('https://any.test/1'), src('https://any.test/2')]),
    answer(host('ddg', 'global'), [src('https://ddg.test/1')]),
  ];
  const tail = [answer(host('cnbing', 'cn'), numbered('cnbing', 4))];
  const headOnly = mergeRegions(head, 'global', 8);
  const merged = mergeRegions([...head, ...tail], 'global', 5);
  assert.deepEqual(urls(merged.slice(0, headOnly.length)), urls(headOnly));
  assert.deepEqual(urls(merged), [
    'https://any.test/1',
    'https://ddg.test/1',
    'https://any.test/2',
    'https://cnbing.test/1',
    'https://cnbing.test/2',
  ]);
});

test('mergeRegions never reaches past a full head group', () => {
  const head = [answer(host('ddg', 'global'), numbered('ddg', 12))];
  const tail = [answer(host('so', 'cn'), numbered('so', 12))];
  const merged = mergeRegions([...head, ...tail], 'global', 8);
  assert.equal(merged.length, 8);
  assert.ok(merged.every((source) => source.url.includes('ddg.test')));
});

test('mergeRegions lets a both engine lead either side', () => {
  const answers = [
    answer(host('anysearch', 'both'), [src('https://any.test/pg')]),
    answer(host('ddg', 'global'), [src('https://ddg.test/pg')]),
    answer(host('so', 'cn'), [src('https://so.test/pg')]),
  ];
  assert.deepEqual(urls(mergeRegions(answers, 'global', 2)), ['https://any.test/pg', 'https://ddg.test/pg']);
  assert.deepEqual(urls(mergeRegions(answers, 'cn', 2)), ['https://any.test/pg', 'https://so.test/pg']);
});

test('mergeRegions drops tail rows the head already returned', () => {
  const head = [answer(host('ddg', 'global'), [src('https://www.shared.test/doc/')])];
  const tail = [
    answer(host('so', 'cn'), [src('https://shared.test/doc'), src('https://so.test/extra')]),
  ];
  assert.deepEqual(urls(mergeRegions([...head, ...tail], 'global', 4)), [
    'https://www.shared.test/doc/',
    'https://so.test/extra',
  ]);
});

test('mergeRegions returns nothing when nothing answered', () => {
  assert.deepEqual(mergeRegions([], 'global', 8), []);
  assert.deepEqual(mergeRegions([answer(host('x', 'global'), [])], 'cn', 8), []);
  assert.deepEqual(mergeRegions([], 'global', 0), []);
});

test('the default authority list covers the documented hosts without duplicates', () => {
  assert.ok(DEFAULT_AUTHORITY_DOMAINS.includes('postgresql.org'));
  assert.ok(DEFAULT_AUTHORITY_DOMAINS.includes('developer.mozilla.org'));
  assert.ok(DEFAULT_AUTHORITY_DOMAINS.includes('rfc-editor.org'));
  assert.equal(new Set(DEFAULT_AUTHORITY_DOMAINS).size, DEFAULT_AUTHORITY_DOMAINS.length);
});
