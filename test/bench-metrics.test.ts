/**
 * Benchmark metrics: fixed-k precision, distinct-domain recall, reciprocal
 * rank, subdomain matching, and engine attribution. These are the scoring
 * rules the offline evaluation depends on, so they are pinned independently of
 * any recorded fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateScores,
  consensusSummary,
  contributionRows,
  domainMatches,
  engineStats,
  evaluateResults,
  meanReciprocalRank,
  normaliseDomain,
  precisionAt,
  recallAt,
  reciprocalRankAt,
} from '../scripts/lib/metrics.mjs';

const PY = 'https://docs.python.org/3/';
const NODE = 'https://nodejs.org/en/';
const RUST = 'https://doc.rust-lang.org/book/';
const MISS = 'https://example.com/unrelated';

test('domain matching accepts subdomains in one direction only', () => {
  assert.equal(domainMatches('docs.python.org', 'python.org'), true);
  assert.equal(domainMatches(PY, 'python.org'), true);
  assert.equal(domainMatches('python.org', 'docs.python.org'), false);
  assert.equal(domainMatches('https://www.python.org/', 'python.org'), true);
  assert.equal(domainMatches('https://notpython.org/', 'python.org'), false);
  assert.equal(domainMatches('https://docs.python.org.evil.com/', 'python.org'), false);
  assert.equal(domainMatches('https://DOCS.PYTHON.ORG/3/', 'PYTHON.ORG'), true);
  assert.equal(domainMatches(MISS, 'python.org'), false);
  assert.equal(domainMatches('not a url', 'python.org'), false);
});

test('expected domains normalise URLs, www, ports and wildcard spelling', () => {
  assert.equal(normaliseDomain('https://www.python.org:443/docs/'), 'python.org');
  assert.equal(normaliseDomain('*.python.org'), 'python.org');
  assert.equal(normaliseDomain('  Python.ORG.  '), 'python.org');
  assert.equal(normaliseDomain(''), '');
});

test('all eight results hit: P@8=1, R@8=1, MRR=1', () => {
  const results = Array.from({ length: 8 }, (_unused, index) => `https://docs.python.org/3/page-${index + 1}`);
  const score = evaluateResults(results, ['python.org']);
  assert.equal(score.resultCount, 8);
  assert.equal(score.hits, 8);
  assert.equal(score.precision, 1);
  assert.equal(score.recall, 1);
  assert.equal(score.firstHitRank, 1);
  assert.equal(score.rr, 1);
  assert.deepEqual(score.matchedDomains, ['python.org']);
});

test('all eight results miss: every metric is zero', () => {
  const results = Array.from({ length: 8 }, (_unused, index) => `https://example.com/page-${index + 1}`);
  const score = evaluateResults(results, ['python.org', 'nodejs.org']);
  assert.equal(score.hits, 0);
  assert.equal(score.precision, 0);
  assert.equal(score.recall, 0);
  assert.equal(score.firstHitRank, 0);
  assert.equal(score.rr, 0);
  assert.deepEqual(score.matchedDomains, []);
});

test('partial hits: precision counts rows, recall counts distinct domains', () => {
  const results = [MISS, PY, MISS, NODE, MISS, MISS, MISS, MISS];
  const score = evaluateResults(results, ['python.org', 'nodejs.org', 'rust-lang.org']);
  assert.equal(score.hits, 2);
  assert.equal(score.precision, 2 / 8);
  assert.equal(score.recall, 2 / 3);
  assert.equal(score.firstHitRank, 2);
  assert.equal(score.rr, 0.5);
  assert.deepEqual(score.matchedDomains, ['python.org', 'nodejs.org']);
});

test('precision@8 uses a fixed denominator for short result lists', () => {
  const score = evaluateResults([PY, PY, PY, PY], ['python.org']);
  assert.equal(score.hits, 4);
  assert.equal(score.precision, 0.5);
  assert.equal(score.recall, 1);
  assert.equal(precisionAt([PY, PY, PY, PY], ['python.org'], 8), 0.5);
  assert.equal(precisionAt([PY], ['python.org'], 1), 1);
  assert.equal(precisionAt([PY], ['python.org'], 0), 0);
});

test('empty results score zero without NaN', () => {
  const score = evaluateResults([], ['python.org']);
  assert.equal(score.resultCount, 0);
  assert.equal(score.hits, 0);
  assert.equal(score.precision, 0);
  assert.equal(score.recall, 0);
  assert.equal(score.firstHitRank, 0);
  assert.equal(score.rr, 0);
  assert.equal(precisionAt([], ['python.org']), 0);
  assert.equal(recallAt([], ['python.org']), 0);
  assert.equal(reciprocalRankAt([], ['python.org']), 0);
  assert.equal(recallAt([PY], []), 0);
});

test('MRR ties average reciprocal ranks, and duplicate domains do not double count recall', () => {
  // Two queries both first hit at rank 2, one miss: (0.5 + 0.5 + 0) / 3.
  assert.equal(meanReciprocalRank([0.5, 0.5, 0]), 1 / 3);
  const a = evaluateResults([MISS, PY], ['python.org']);
  const b = evaluateResults([MISS, NODE], ['nodejs.org']);
  const c = evaluateResults([MISS, MISS], ['rust-lang.org']);
  const aggregate = aggregateScores([a, b, c]);
  assert.equal(aggregate.queries, 3);
  assert.equal(aggregate.mrr, 1 / 3);
  assert.equal(aggregate.zeroHit, 1);
  assert.equal(aggregate.anyHit, 2);

  // The same expected domain twice: rows both count for precision, recall is 1.
  const duplicate = evaluateResults([PY, 'https://python.org/downloads/'], ['python.org']);
  assert.equal(duplicate.hits, 2);
  assert.equal(duplicate.precision, 2 / 8);
  assert.equal(duplicate.recall, 1);
  assert.equal(duplicate.firstHitRank, 1);
});

test('duplicate and equivalent expected domains collapse before recall', () => {
  const score = evaluateResults([PY], ['python.org', 'https://www.python.org/', '*.python.org']);
  assert.equal(score.precision, 1 / 8);
  assert.equal(score.recall, 1);
  assert.equal(score.matchedDomains.length, 1);
});

test('only the top k rows count', () => {
  const results = [MISS, MISS, MISS, MISS, MISS, MISS, MISS, MISS, PY, NODE, RUST];
  assert.deepEqual(evaluateResults(results, ['python.org'], 8), {
    k: 8,
    resultCount: 8,
    hits: 0,
    precision: 0,
    recall: 0,
    firstHitRank: 0,
    rr: 0,
    matchedDomains: [],
    expectedDomains: ['python.org'],
  });
  assert.equal(evaluateResults(results, ['python.org'], 9).hits, 1);
});

test('engine contributions and consensus votes attribute every final row', () => {
  const u1 = 'https://example.com/a';
  const u2 = 'https://example.com/b';
  const u3 = 'https://example.com/c';
  const answers = [
    { id: 'alpha', sources: [{ url: u1 }, { url: u2 }] },
    // The same document with a www prefix and trailing slash is one vote, not two.
    { id: 'beta', sources: [{ url: 'https://www.example.com/a/' }, { url: u3 }] },
  ];
  const rows = contributionRows(answers, [u1, u2, u3]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.votes), [2, 1, 1]);
  assert.deepEqual(rows.map((row) => row.engines), [['alpha', 'beta'], ['alpha'], ['beta']]);
  assert.deepEqual(rows.map((row) => row.firstEngine), ['alpha', 'alpha', 'beta']);

  const stats = engineStats(answers, [u1, u2, u3]);
  assert.deepEqual(stats.totals, { rows: 3, votes: 4, averageVotes: 4 / 3 });
  assert.deepEqual(stats.engines, {
    alpha: { returned: 2, contributed: 2, first: 2 },
    beta: { returned: 2, contributed: 2, first: 1 },
  });
  assert.deepEqual(consensusSummary(rows), {
    rows: 3,
    votes: 4,
    averageVotes: 4 / 3,
    histogram: { '1': 2, '2': 1 },
  });
});
