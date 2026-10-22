/**
 * Offline replay determinism: the freshness boost must be evaluated at the
 * fixture's recording instant, not at the wall clock of the replay. Otherwise a
 * benchmark re-run weeks later would change its score with no code change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegions } from '../src/rank.ts';

const host = {
  id: 'fixture-engine',
  tier: 'primary',
  region: 'global',
  build: () => 'https://fixture.test/search',
  parse: () => [],
};
const oldPage = { url: 'https://old.example/page', publishedAt: '2020-01-01T00:00:00Z' };
const freshPage = { url: 'https://fresh.example/page', publishedAt: '2025-01-01T00:00:00Z' };
const answer = { host, sources: [oldPage, freshPage] };
const options = (now) => ({
  authorityBoost: 0,
  freshnessBoost: 0.2,
  freshnessDays: 30,
  now: Date.parse(now),
});

test('a pinned evaluation instant makes a replay independent of wall-clock age', () => {
  const atRecording = mergeRegions([answer], 'global', 2, options('2025-01-02T00:00:00Z'));
  assert.deepEqual(atRecording.map((source) => source.url), [freshPage.url, oldPage.url]);

  // Replaying the same fixture much later must still use the recording date.
  const replay = mergeRegions([answer], 'global', 2, options('2025-01-02T00:00:00Z'));
  assert.deepEqual(replay.map((source) => source.url), [freshPage.url, oldPage.url]);

  // With a genuinely later evaluation instant, both pages are stale and the
  // rank order falls back to the engine's own order.
  const muchLater = mergeRegions([answer], 'global', 2, options('2026-10-22T00:00:00Z'));
  assert.deepEqual(muchLater.map((source) => source.url), [oldPage.url, freshPage.url]);
});
