/**
 * `advanced_search` is a thin per-call window over the normal engine path. The
 * tests keep it thin: argument validation, the effective window, budget
 * truncation, the untrusted boundary and the fail-safe registration.
 *
 * @module dsh-web-search-bing/test/advanced-search
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCED_SEARCH_DEFAULT_LIMIT,
  ADVANCED_SEARCH_FALLBACK_NAME,
  ADVANCED_SEARCH_MAX_LIMIT,
  ADVANCED_SEARCH_TOOL_NAME,
  createAdvancedSearchDefinition,
  formatAdvancedSearchValue,
  pickAdvancedSearchToolName,
  registerAdvancedSearchTool,
  stripRelativeWindow,
  undatedWindowNote,
} from '../src/advanced-search.ts';
import type {
  AdvancedSearchDefinition,
  AdvancedSearchOutcome,
  AdvancedSearchRegistryLike,
  AdvancedSearchRunner,
} from '../src/advanced-search.ts';
import type { Source, TimeRange } from '../src/types.ts';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../src/untrusted.ts';

/** One source with a stable shape. */
function source(url: string, extra: Partial<Source> = {}): Source {
  return { url, title: 'Title', snippet: 'snippet', ...extra };
}

/** One successful outcome. */
function outcome(overrides: Partial<AdvancedSearchOutcome> = {}): AdvancedSearchOutcome {
  return {
    sources: [source('https://example.com/')],
    failures: [],
    truncated: false,
    timeRange: 'off',
    ...overrides,
  };
}

/** A recording runner. */
function runner(result: AdvancedSearchOutcome = outcome()): {
  run: AdvancedSearchRunner;
  calls: { query: string; limit: number; timeRange: TimeRange | undefined; signal?: AbortSignal }[];
} {
  const calls: { query: string; limit: number; timeRange: TimeRange | undefined; signal?: AbortSignal }[] = [];
  return {
    calls,
    run: async (query, limit, timeRange, signal) => {
      calls.push({ query, limit, timeRange, ...(signal === undefined ? {} : { signal }) });
      return result;
    },
  };
}

/** A recording registry. */
function registry(options: { taken?: boolean; reject?: boolean } = {}): {
  tools: AdvancedSearchRegistryLike;
  definitions: AdvancedSearchDefinition[];
} {
  const definitions: AdvancedSearchDefinition[] = [];
  const tools: AdvancedSearchRegistryLike = {
    register(definition) {
      if (options.reject === true) throw new Error('registry rejected the definition');
      definitions.push(definition);
      return () => {
        definitions.splice(definitions.indexOf(definition), 1);
      };
    },
    get(name) {
      return options.taken === true && name === ADVANCED_SEARCH_TOOL_NAME ? { name } : undefined;
    },
  };
  return { tools, definitions };
}

test('the definition uses the registry raw JSON-Schema dialect', () => {
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, runner().run);
  assert.equal(definition.name, ADVANCED_SEARCH_TOOL_NAME);
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.required, ['query']);
  assert.deepEqual(
    definition.parameters.properties?.['timeRange']?.enum,
    ['off', 'day', 'week', 'month', 'year'],
  );
  assert.deepEqual(definition.output.schema.required, ['query', 'timeRange', 'sources', 'failures', 'truncated']);
  assert.equal(definition.timeoutMs, 30_000);
});

test('execute passes the default budget and leaves the window to the deployment', async () => {
  const fake = runner();
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, fake.run);
  const value = await definition.execute({ query: '  postgres  ' }, {});
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.query, 'postgres');
  assert.equal(fake.calls[0]?.limit, ADVANCED_SEARCH_DEFAULT_LIMIT);
  assert.equal(fake.calls[0]?.timeRange, undefined, 'undefined means the global setting');
  assert.equal(value.query, 'postgres');
  assert.equal(value.timeRange, 'off');
  assert.equal(value.sources.length, 1);
  assert.equal(value.truncated, false);
});

test('execute forwards an explicit window and result count', async () => {
  const fake = runner(outcome({ timeRange: 'week' }));
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, fake.run);
  const value = await definition.execute({ query: 'release notes', maxResults: 3, timeRange: 'week' }, {});
  assert.equal(fake.calls[0]?.limit, 3);
  assert.equal(fake.calls[0]?.timeRange, 'week');
  assert.equal(value.timeRange, 'week');
});

test('an explicit window strips a redundant relative-time phrase from the engine query', async () => {
  const recording = runner(outcome({ timeRange: 'week' }));
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, recording.run);
  const value = await definition.execute({ query: '过去 7 天内 Chrome 官方安全博客的零日公告', timeRange: 'week' }, {});
  assert.equal(recording.calls[0]?.query, 'Chrome 官方安全博客的零日公告');
  assert.equal(value.query, '过去 7 天内 Chrome 官方安全博客的零日公告');
  assert.equal(value.timeRange, 'week');
});

test('stripRelativeWindow keeps a query that has no other words', () => {
  assert.equal(stripRelativeWindow('过去 7 天内'), '过去 7 天内');
  assert.equal(stripRelativeWindow('last 30 days TypeScript'), 'TypeScript');
});

test('the result is capped at the caller budget and reports truncation', async () => {
  const fake = runner(outcome({
    sources: [
      source('https://example.com/1'),
      source('https://example.com/2'),
      source('https://example.com/3'),
    ],
  }));
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, fake.run);
  const value = await definition.execute({ query: 'x', maxResults: 2 }, {});
  assert.equal(value.sources.length, 2);
  assert.equal(value.truncated, true, 'three returned rows exceed the requested two');
});

test('execute rejects malformed arguments before running a search', async () => {
  const fake = runner();
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, fake.run);
  await assert.rejects(definition.execute({}, {}), /non-empty query/u);
  await assert.rejects(definition.execute({ query: '   ' }, {}), /non-empty query/u);
  await assert.rejects(definition.execute({ query: 'x', maxResults: 0 }, {}), /maxResults/u);
  await assert.rejects(definition.execute({ query: 'x', maxResults: ADVANCED_SEARCH_MAX_LIMIT + 1 }, {}), /maxResults/u);
  await assert.rejects(definition.execute({ query: 'x', maxResults: 1.5 }, {}), /maxResults/u);
  await assert.rejects(definition.execute({ query: 'x', timeRange: 'fortnight' }, {}), /timeRange/u);
  assert.equal(fake.calls.length, 0);
});

test('the render text carries the untrusted boundary and the published date', () => {
  const definition = createAdvancedSearchDefinition(ADVANCED_SEARCH_TOOL_NAME, runner().run);
  const value = {
    query: 'release notes',
    timeRange: 'day' as const,
    sources: [source('https://example.com/', { publishedAt: '2026-07-01' })],
    failures: ['cn.bing: HTTP 429'],
    note: 'fallback skipped: bot-wall is not enabled in fallbackOn.',
    truncated: false,
  };
  const text = definition.output.render({}, value)[0]?.text ?? '';
  assert.equal(text.startsWith(UNTRUSTED_OPEN), true);
  assert.equal(text.endsWith(UNTRUSTED_CLOSE), true);
  assert.match(text, /timeRange=day/u);
  assert.match(text, /2026-07-01/u);
  assert.match(text, /Note: fallback skipped/u);
  assert.match(text, /HTTP 429/u);
  assert.match(formatAdvancedSearchValue(value), /Search: "release notes"/u);
});

test('an active window never silently presents an undated row as in-window', () => {
  const dated = source('https://example.com/dated', { publishedAt: '2026-07-01' });
  const undated = source('https://example.com/undated');
  assert.equal(undatedWindowNote([dated, undated], 'off'), undefined);
  assert.equal(undatedWindowNote([dated], 'week'), undefined);
  assert.match(undatedWindowNote([dated, undated], 'week') ?? '', /1 of 2/u);
  assert.match(undatedWindowNote([dated, undated], 'week') ?? '', /not proven/u);
});

test('pickAdvancedSearchToolName falls back only when the name is taken', () => {
  assert.equal(pickAdvancedSearchToolName(registry().tools), ADVANCED_SEARCH_TOOL_NAME);
  assert.equal(pickAdvancedSearchToolName(registry({ taken: true }).tools), ADVANCED_SEARCH_FALLBACK_NAME);
  assert.equal(pickAdvancedSearchToolName({ register: () => undefined }), ADVANCED_SEARCH_TOOL_NAME);
});

test('registerAdvancedSearchTool registers, disposes and swallows rejection', () => {
  const { tools, definitions } = registry();
  const registration = registerAdvancedSearchTool(tools, runner().run);
  assert.equal(registration?.name, ADVANCED_SEARCH_TOOL_NAME);
  assert.equal(definitions.length, 1);
  registration?.dispose();
  assert.equal(definitions.length, 0);

  const warnings: string[] = [];
  assert.equal(
    registerAdvancedSearchTool(registry({ reject: true }).tools, runner().run, { warn: (line) => warnings.push(line) }),
    undefined,
  );
  assert.ok(warnings.some((line) => line.includes('registry rejected')));
});
