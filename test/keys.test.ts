/**
 * Tests for credential rotation: parsing, round-robin, and the three rests.
 *
 * @module dsh-web-search-bing/test/keys
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, keyFailureKind, keyPoolFor, parseApiKeys, resetKeyPools } from '../src/keys.ts';

test('keys are split on commas, spaces and newlines, without duplicates', () => {
  assert.deepEqual(parseApiKeys('a, b\nc  a'), ['a', 'b', 'c']);
  assert.deepEqual(parseApiKeys(''), []);
  assert.deepEqual(parseApiKeys(undefined), []);
  assert.deepEqual(parseApiKeys('your-key, token'), []);
});

test('a single key still works exactly as before', () => {
  const pool = new KeyPool(['k1']);
  assert.equal(pool.pick(), 'k1');
  assert.equal(pool.pick(), 'k1');
  assert.equal(pool.size, 1);
});

test('the pool rotates round-robin and skips a resting key', () => {
  let now = 1_000;
  const pool = new KeyPool(['a', 'b', 'c'], { now: () => now });
  assert.equal(pool.pick(), 'a');
  assert.equal(pool.pick(), 'b');
  pool.penalize('c', 'throttled');
  assert.equal(pool.pick(), 'a', 'the resting key is skipped');
  assert.equal(pool.allCooling(), false);
  now += 60_000;
  assert.equal(pool.pick(), 'b');
  assert.equal(pool.pick(), 'c', 'and comes back once its rest is over');
});

test('throttling doubles the rest up to the ceiling', () => {
  let now = 0;
  const pool = new KeyPool(['a'], {
    now: () => now,
    throttleBaseMs: 1_000,
    throttleMaxMs: 3_000,
  });
  assert.equal(pool.penalize('a', 'throttled'), 1_000);
  now += 1_000;
  assert.equal(pool.pick(), 'a');
  assert.equal(pool.penalize('a', 'throttled'), 2_000);
  now += 2_000;
  assert.equal(pool.pick(), 'a');
  assert.equal(pool.penalize('a', 'throttled'), 3_000);
  assert.equal(pool.pick(), undefined);
  assert.equal(pool.allCooling(), true);
  now += 3_000;
  assert.equal(pool.pick(), 'a');
});

test('a 401 retires the key for a day, a 403 for ten minutes', () => {
  let now = 0;
  const pool = new KeyPool(['bad', 'good'], { now: () => now });
  pool.penalize('bad', 'unauthorized');
  assert.equal(pool.pick(), 'good');
  assert.equal(pool.pick(), 'good');
  now += 600_000;
  assert.equal(pool.pick(), 'good');
  const blocked = new KeyPool(['x'], { now: () => now });
  blocked.penalize('x', 'blocked');
  assert.equal(blocked.pick(), undefined);
  now += 600_000;
  assert.equal(blocked.pick(), 'x');
});

test('a rewarded key clears its strikes', () => {
  let now = 0;
  const pool = new KeyPool(['a'], { now: () => now });
  pool.penalize('a', 'throttled');
  now += 60_000;
  pool.reward('a');
  assert.equal(pool.penalize('a', 'throttled'), 60_000);
});

test('key failures are classified by code and message', () => {
  assert.equal(keyFailureKind({ code: 'SEARCH_THROTTLED', message: 'x: HTTP 429' }), 'throttled');
  assert.equal(keyFailureKind({ message: 'x: HTTP 401' }), 'unauthorized');
  assert.equal(keyFailureKind({ message: 'x: HTTP 403' }), 'blocked');
  assert.equal(keyFailureKind({ code: 'SEARCH_TIMEOUT', message: 'x: timed out' }), undefined);
  assert.equal(keyFailureKind(undefined), undefined);
});

test('pools are cached per key list and reset on edit', () => {
  resetKeyPools();
  const a = keyPoolFor('k1,k2');
  assert.equal(keyPoolFor('k1,k2'), a);
  assert.notEqual(keyPoolFor('k1'), a);
  assert.equal(keyPoolFor('').size, 0);
  resetKeyPools();
  assert.notEqual(keyPoolFor('k1,k2'), a);
});
