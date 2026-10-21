import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineHealth } from '../src/health.ts';
import { SearchError } from '../src/errors.ts';
import type { SearchErrorCode } from '../src/types.ts';

const failure = (code: SearchErrorCode, retryAfterMs?: number): SearchError =>
  new SearchError(code, code, true, retryAfterMs);

test('health: the first failure cools down for the default five minutes', () => {
  const health = new EngineHealth();
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000_000);
  assert.equal(health.isCooling('bing', 1_000_000), true);
  assert.equal(health.isCooling('bing', 1_299_999), true);
  assert.equal(health.isCooling('bing', 1_300_000), false);
});

test('health: a configured base cooldown is used for the first failure', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 0);
  assert.equal(health.isCooling('bing', 999), true);
  assert.equal(health.isCooling('bing', 1_000), false);
});

test('health: a second consecutive failure doubles the cooldown', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 0);
  assert.deepEqual(health.snapshot(0), { bing: 1_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000);
  assert.deepEqual(health.snapshot(1_000), { bing: 2_000 });
});

test('health: the third consecutive failure quadruples the base cooldown', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_BLOCKED'), 0);
  health.noteFailure('bing', failure('SEARCH_BLOCKED'), 1_000);
  health.noteFailure('bing', failure('SEARCH_BLOCKED'), 3_000);
  assert.deepEqual(health.snapshot(3_000), { bing: 4_000 });
});

test('health: the exponential cooldown is clamped to the ceiling', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000, maxCooldownMs: 2_500 });
  health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 0);
  health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 1_000);
  assert.deepEqual(health.snapshot(1_000), { bing: 2_000 });
  health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 3_000);
  assert.deepEqual(health.snapshot(3_000), { bing: 2_500 });
  // Overflow-proof: a long streak still stops at the ceiling.
  for (let index = 0; index < 200; index += 1) {
    health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 3_000);
  }
  assert.deepEqual(health.snapshot(3_000), { bing: 2_500 });
});

test('health: a Retry-After hint wins over the exponential cooldown', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000, maxCooldownMs: 30_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 0);
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000);
  health.noteFailure('bing', failure('SEARCH_THROTTLED', 7_000), 2_000);
  assert.deepEqual(health.snapshot(2_000), { bing: 7_000 });
});

test('health: a Retry-After hint is clamped to the ceiling', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000, maxCooldownMs: 2_500 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED', 60_000), 0);
  assert.deepEqual(health.snapshot(0), { bing: 2_500 });
});

test('health: a non-positive or non-finite Retry-After falls back to the exponential', () => {
  const zero = new EngineHealth({ baseCooldownMs: 1_000 });
  zero.noteFailure('bing', failure('SEARCH_THROTTLED', 0), 0);
  assert.deepEqual(zero.snapshot(0), { bing: 1_000 });

  const negative = new EngineHealth({ baseCooldownMs: 1_000 });
  negative.noteFailure('bing', failure('SEARCH_THROTTLED', -5_000), 0);
  assert.deepEqual(negative.snapshot(0), { bing: 1_000 });

  const nan = new EngineHealth({ baseCooldownMs: 1_000 });
  nan.noteFailure('bing', failure('SEARCH_THROTTLED', Number.NaN), 0);
  assert.deepEqual(nan.snapshot(0), { bing: 1_000 });
});

test('health: noteSuccess resets the failure streak and lifts the cooldown', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 0);
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000);
  health.noteSuccess('bing');
  assert.equal(health.isCooling('bing', 1_000), false);
  assert.deepEqual(health.snapshot(1_000), {});
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 2_000);
  assert.deepEqual(health.snapshot(2_000), { bing: 1_000 });
});

test('health: SEARCH_PARSE is permanent and never cools down', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('ddg', failure('SEARCH_PARSE'), 0);
  health.noteFailure('ddg', failure('SEARCH_PARSE'), 0);
  assert.equal(health.isCooling('ddg', 0), false);
  assert.equal(health.skipped('ddg', 0), undefined);
  assert.deepEqual(health.snapshot(0), {});
});

test('health: SEARCH_ABORTED is the caller cancelling and never cools down', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('ddg', failure('SEARCH_ABORTED'), 0);
  assert.equal(health.isCooling('ddg', 0), false);
  assert.equal(health.skipped('ddg', 0), undefined);
  assert.deepEqual(health.snapshot(0), {});
});

test('health: permanent failures do not advance the service-failure streak', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 0);
  health.noteFailure('bing', failure('SEARCH_PARSE'), 500);
  health.noteFailure('bing', failure('SEARCH_ABORTED'), 500);
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000);
  // Second service failure, not fourth: still the 2x step.
  assert.deepEqual(health.snapshot(1_000), { bing: 2_000 });
});

test('health: every non-permanent code cools down', () => {
  const codes = [
    'SEARCH_THROTTLED',
    'SEARCH_BLOCKED',
    'SEARCH_TIMEOUT',
    'SEARCH_NETWORK',
    'SEARCH_NETWORK_BLOCKED_BY_POLICY',
  ] as const;
  for (const code of codes) {
    const health = new EngineHealth({ baseCooldownMs: 1_000 });
    health.noteFailure('engine', failure(code), 0);
    assert.equal(health.isCooling('engine', 0), true, code);
    assert.match(health.skipped('engine', 0) ?? '', new RegExp(code));
  }
});

test('health: isCooling is false for unknown engines and at the expiry boundary', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  assert.equal(health.isCooling('never-seen', 0), false);
  health.noteFailure('bing', failure('SEARCH_BLOCKED'), 500);
  assert.equal(health.isCooling('bing', 1_499), true);
  assert.equal(health.isCooling('bing', 1_500), false);
  assert.equal(health.skipped('bing', 1_500), undefined);
});

test('health: skipped states the remaining time and the failure code', () => {
  const health = new EngineHealth({ baseCooldownMs: 300_000 });
  health.noteFailure('ddg', failure('SEARCH_THROTTLED'), 0);
  assert.equal(health.skipped('ddg', 170_000), 'cooling down for another 2m 10s after SEARCH_THROTTLED');
  assert.equal(health.skipped('ddg', 0), 'cooling down for another 5m after SEARCH_THROTTLED');
  assert.equal(health.skipped('ddg', 299_999), 'cooling down for another 1s after SEARCH_THROTTLED');
  assert.equal(health.skipped('ddg', 300_000), undefined);
  assert.equal(health.skipped('usable'), undefined);
});

test('health: skipped rounds the remaining milliseconds up to whole seconds', () => {
  const first = new EngineHealth({ baseCooldownMs: 1_000 });
  first.noteFailure('ddg', failure('SEARCH_TIMEOUT'), 0);
  assert.equal(first.skipped('ddg', 999), 'cooling down for another 1s after SEARCH_TIMEOUT');

  const second = new EngineHealth({ baseCooldownMs: 2_000 });
  second.noteFailure('ddg', failure('SEARCH_TIMEOUT'), 0);
  assert.equal(second.skipped('ddg', 999), 'cooling down for another 2s after SEARCH_TIMEOUT');
});

test('health: a Retry-After cooldown reports the overriding code', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000, maxCooldownMs: 1_800_000 });
  health.noteFailure('anysearch', failure('SEARCH_THROTTLED', 1_800_000), 0);
  assert.equal(health.skipped('anysearch', 0), 'cooling down for another 30m after SEARCH_THROTTLED');
});

test('health: snapshot reports remaining milliseconds only for cooling engines', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_TIMEOUT'), 0);
  health.noteFailure('ddg', failure('SEARCH_BLOCKED'), 0);
  assert.deepEqual(health.snapshot(250), { bing: 750, ddg: 750 });
  health.noteSuccess('ddg');
  assert.deepEqual(health.snapshot(250), { bing: 750 });
  assert.deepEqual(health.snapshot(1_000), {});
  assert.deepEqual(health.snapshot(), {});
});

test('health: clear forgets cooldowns and failure streaks', () => {
  const health = new EngineHealth({ baseCooldownMs: 1_000 });
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 0);
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 1_000);
  health.clear();
  assert.equal(health.isCooling('bing', 1_000), false);
  assert.deepEqual(health.snapshot(1_000), {});
  health.noteFailure('bing', failure('SEARCH_THROTTLED'), 2_000);
  assert.deepEqual(health.snapshot(2_000), { bing: 1_000 });
});
