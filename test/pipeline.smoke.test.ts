import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError, parseRetryAfter } from '../src/errors.ts';

test('SearchError carries code, retryable flag and wait hint', () => {
  const error = new SearchError('boom', 'SEARCH_THROTTLED', true, 1500);
  assert.equal(error.code, 'SEARCH_THROTTLED');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 1500);
  assert.equal(error.name, 'SearchError');
});

test('parseRetryAfter reads delta-seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('   '), undefined);
  const date = new Date(1_700_000_000_000).toUTCString();
  assert.equal(parseRetryAfter(date, 1_699_999_940_000), 60_000);
  assert.equal(parseRetryAfter('nonsense'), undefined);
});
