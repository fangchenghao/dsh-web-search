/**
 * The early-release rule after the Chinese fan-out tail fix.
 *
 * A slow lead engine must not keep a query open once enough rows arrived from
 * other engines; one engine with eight rows is still not a fused answer.
 *
 * @module dsh-web-search-bing/test/tier-release
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierReleaseReady } from '../src/engines.ts';

test('releases when enough rows come from enough distinct engines', () => {
  assert.equal(tierReleaseReady(8, 2, 8, 2), true);
  assert.equal(tierReleaseReady(8, 1, 8, 2), false, 'one engine is not a fused answer');
  assert.equal(tierReleaseReady(7, 3, 8, 2), false, 'the result budget still has to be filled');
  assert.equal(tierReleaseReady(20, 3, 8, 3), true);
});

test('a single-engine query can still release with one contributor', () => {
  assert.equal(tierReleaseReady(8, 1, 8, 1), true);
});
