/**
 * Failure classes are the contract between the engine layer and the fallback
 * policy: a 402 means "the key is out of quota", a 403 means "the engine put up
 * a wall", and a timeout means "try again later". These tests pin that mapping
 * so a retry-policy change cannot silently turn a quota error into a bot wall.
 *
 * @module dsh-web-search-bing/test/failure-classification
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError, classifyFailure } from '../src/errors.ts';

test('a timeout is transient, never permanent', () => {
  assert.equal(classifyFailure(new SearchError('timed out', 'SEARCH_TIMEOUT')), 'transient');
});

test('network failures and 429s are transient', () => {
  assert.equal(classifyFailure(new SearchError('offline', 'SEARCH_NETWORK')), 'transient');
  assert.equal(classifyFailure(new SearchError('too many requests', 'SEARCH_THROTTLED', true, 1000, 429)), 'transient');
});

test('a 401 is an auth failure and a 402 is a quota failure', () => {
  assert.equal(classifyFailure(new SearchError('unauthorized', 'SEARCH_BLOCKED', false, undefined, 401)), 'auth');
  assert.equal(classifyFailure(new SearchError('payment required', 'SEARCH_BLOCKED', false, undefined, 402)), 'quota');
});

test('a 403 is a bot wall unless the message names quota or auth', () => {
  assert.equal(classifyFailure(new SearchError('forbidden', 'SEARCH_BLOCKED', false, undefined, 403)), 'bot-wall');
  assert.equal(classifyFailure(new SearchError('quota exhausted', 'SEARCH_BLOCKED', false, undefined, 403)), 'quota');
  assert.equal(classifyFailure(new SearchError('invalid api key', 'SEARCH_BLOCKED', false, undefined, 403)), 'auth');
});

test('a 5xx is transient; other statuses without a message clue are walls', () => {
  assert.equal(classifyFailure(new SearchError('bad gateway', 'SEARCH_HTTP_STATUS', true, undefined, 502)), 'transient');
  assert.equal(classifyFailure(new SearchError('not found', 'SEARCH_HTTP_STATUS', false, undefined, 404)), 'bot-wall');
});

test('parse and empty answers are invalid responses, not network failures', () => {
  assert.equal(classifyFailure(new SearchError('unparsable', 'SEARCH_PARSE', false)), 'invalid-response');
  assert.equal(classifyFailure(new SearchError('empty', 'SEARCH_EMPTY', false)), 'invalid-response');
  assert.equal(classifyFailure(new SearchError('unsupported', 'SEARCH_UNSUPPORTED', false)), 'invalid-response');
});

test('an aborted search is reported as unknown rather than a retryable class', () => {
  assert.equal(classifyFailure(new SearchError('cancelled', 'SEARCH_ABORTED', false)), 'unknown');
});

test('a message-only quota or auth clue is honoured without a status', () => {
  assert.equal(classifyFailure(new SearchError('daily quota exceeded', 'SEARCH_BLOCKED', false)), 'quota');
  assert.equal(classifyFailure(new SearchError('authentication failed', 'SEARCH_BLOCKED', false)), 'auth');
});
