/**
 * The `engine_test` tool turns diagnostics into a model-readable table. These
 * tests keep the shape stable: one row per engine, a failure class instead of an
 * opaque error string, and a registry-safe name when `engine_test` is taken.
 *
 * @module dsh-web-search-bing/test/engine-test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_TEST_DEFAULT_QUERY,
  ENGINE_TEST_FALLBACK_NAME,
  ENGINE_TEST_TOOL_NAME,
  createEngineTestDefinition,
  formatEngineTestValue,
  pickEngineTestToolName,
  registerEngineTestTool,
  runEngineTestValue,
} from '../src/engine-test.ts';
import type { EngineTestOutcome, EngineTestRegistryLike, EngineTestRunner } from '../src/engine-test.ts';
import { HOSTS } from '../src/engines.ts';
import type { EngineFailure } from '../src/types.ts';

/** A successful outcome with one source. */
function success(): EngineTestOutcome {
  return {
    sources: [{ url: 'https://example.com/page', title: 'Example page' }],
    failureDetails: [],
    failures: [],
  };
}

/** A failed outcome with one structured detail. */
function failure(kind: EngineFailure['kind'], code: EngineFailure['code'], reason: string): EngineTestOutcome {
  return {
    sources: [],
    failureDetails: [{ id: 'x', reason, kind, ...(code === undefined ? {} : { code }) }],
    failures: [reason],
  };
}

test('runEngineTestValue reports one ordered row per engine and a sample title', async () => {
  const seen: string[] = [];
  const runner: EngineTestRunner = async (engine) => {
    seen.push(engine);
    return success();
  };
  const value = await runEngineTestValue(runner, ['anysearch', 'exa', 'so'], 'probe');
  assert.deepEqual(seen, ['anysearch', 'exa', 'so']);
  assert.equal(value.query, 'probe');
  assert.equal(value.ok, 3);
  assert.equal(value.failed, 0);
  assert.deepEqual(value.results.map((row) => row.sample), ['Example page', 'Example page', 'Example page']);
});

test('a failed engine carries its failure class, code and reason', async () => {
  const runner: EngineTestRunner = async (engine) => {
    if (engine === 'exa') return failure('quota', 'SEARCH_BLOCKED', 'quota exhausted');
    return success();
  };
  const value = await runEngineTestValue(runner, ['anysearch', 'exa'], 'probe');
  const exa = value.results.find((row) => row.engine === 'exa');
  assert.ok(exa !== undefined);
  assert.equal(exa.ok, false);
  assert.equal(exa.failureKind, 'quota');
  assert.equal(exa.code, 'SEARCH_BLOCKED');
  assert.equal(exa.reason, 'quota exhausted');
});

test('a thrown runner becomes an unknown failure instead of rejecting the whole test', async () => {
  const runner: EngineTestRunner = async () => {
    throw new Error('boom');
  };
  const value = await runEngineTestValue(runner, ['anysearch'], 'probe');
  assert.equal(value.results[0]?.ok, false);
  assert.equal(value.results[0]?.failureKind, 'unknown');
  assert.equal(value.results[0]?.reason, 'boom');
});

test('the default probe is used when the caller offers no query, and one engine can be tested alone', async () => {
  const seen: Array<[string, string]> = [];
  const runner: EngineTestRunner = async (engine, query) => {
    seen.push([engine, query]);
    return success();
  };
  const definition = createEngineTestDefinition(ENGINE_TEST_TOOL_NAME, runner);
  const value = await definition.execute({ engine: 'exa' }, {});
  assert.deepEqual(seen, [['exa', ENGINE_TEST_DEFAULT_QUERY]]);
  assert.deepEqual(value.results.map((row) => row.engine), ['exa']);
});

test('without an engine the definition walks the full catalogue in order', async () => {
  const seen: string[] = [];
  const runner: EngineTestRunner = async (engine) => {
    seen.push(engine);
    return success();
  };
  const definition = createEngineTestDefinition(ENGINE_TEST_TOOL_NAME, runner);
  const value = await definition.execute({}, {});
  assert.deepEqual(seen, HOSTS.map((host) => host.id));
  assert.equal(value.ok, HOSTS.length);
});

test('an unknown engine is rejected before any request', async () => {
  let called = false;
  const runner: EngineTestRunner = async () => {
    called = true;
    return success();
  };
  const definition = createEngineTestDefinition(ENGINE_TEST_TOOL_NAME, runner);
  await assert.rejects(() => definition.execute({ engine: 'made-up' }, {}), /unknown engine/u);
  assert.equal(called, false);
});

test('the model-facing text names failures and their class', () => {
  const text = formatEngineTestValue({
    query: 'probe',
    ok: 1,
    failed: 1,
    results: [
      { engine: 'anysearch', ok: true, latencyMs: 12, count: 1, sample: 'Example' },
      { engine: 'exa', ok: false, latencyMs: 34, count: 0, failureKind: 'bot-wall', reason: 'HTTP 403' },
    ],
  });
  assert.match(text, /1 OK, 1 failed/u);
  assert.match(text, /anysearch: OK \(12ms, 1 result\(s\)\) — Example/u);
  assert.match(text, /exa: FAIL \[bot-wall\] \(34ms\) HTTP 403/u);
});

test('the fallback tool name is chosen only when engine_test is taken', () => {
  const empty: EngineTestRegistryLike = {
    register: () => () => {},
    get: () => undefined,
  };
  assert.equal(pickEngineTestToolName(empty), ENGINE_TEST_TOOL_NAME);
  const taken: EngineTestRegistryLike = {
    register: () => () => {},
    get: (name) => (name === ENGINE_TEST_TOOL_NAME ? { name } : undefined),
  };
  assert.equal(pickEngineTestToolName(taken), ENGINE_TEST_FALLBACK_NAME);
});

test('registerEngineTestTool returns a disposer and a registry rejection is swallowed', () => {
  let disposed = false;
  const definitions: string[] = [];
  const tools: EngineTestRegistryLike = {
    register: (definition) => {
      definitions.push(definition.name);
      return () => {
        disposed = true;
      };
    },
    get: () => undefined,
  };
  const registration = registerEngineTestTool(tools, async () => success());
  assert.equal(registration?.name, ENGINE_TEST_TOOL_NAME);
  assert.deepEqual(definitions, [ENGINE_TEST_TOOL_NAME]);
  registration?.dispose();
  assert.equal(disposed, true);

  const refusing: EngineTestRegistryLike = {
    register: () => {
      throw new Error('registry full');
    },
  };
  const warnings: string[] = [];
  const refused = registerEngineTestTool(refusing, async () => success(), { warn: (message) => warnings.push(message) });
  assert.equal(refused, undefined);
  assert.match(warnings[0] ?? '', /registry full/u);
});
