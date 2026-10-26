/**
 * The batch tool's contract: one query per entry, failures isolated, at most
 * three searches in flight, and a registration that the host's schema
 * projection can see and dispose.
 *
 * The registry double records definitions and exposes the same projected shape
 * the host's `schemas()` returns; the real `ToolRuntime` acceptance is proven
 * separately by `scripts/verify-tool-registration.mjs`.
 *
 * @module dsh-web-search-bing/test/search-many
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_MANY_CONCURRENCY,
  SEARCH_MANY_DEFAULT_LIMIT,
  SEARCH_MANY_FALLBACK_NAME,
  SEARCH_MANY_TOOL_NAME,
  createSearchManyDefinition,
  formatSearchManyValue,
  pickSearchManyToolName,
  registerSearchManyTool,
} from '../src/search-many.ts';
import type {
  SearchManyDefinition,
  SearchManyRegistryLike,
  SearchManyRunner,
} from '../src/search-many.ts';
import { apply } from '../src/index.ts';
import type { PluginContext, SearchProvider } from '../src/index.ts';
import type { Source } from '../src/types.ts';

/** One source with a stable shape. */
function source(url: string, title = 'Title'): Source {
  return { url, title, snippet: 'snippet' };
}

/** A runner backed by a plain map, recording the limits it was asked for. */
function runnerFrom(
  answers: Record<string, Source[] | Error>,
  calls?: { query: string; limit: number }[],
): SearchManyRunner {
  return async (query, limit) => {
    calls?.push({ query, limit });
    const answer = answers[query];
    if (answer instanceof Error) throw answer;
    return {
      sources: (answer ?? []).map((item) => ({ ...item })),
      failures: [],
      truncated: false,
    };
  };
}

/** A recording registry that also mirrors the host's schema projection. */
function registry(options: { taken?: boolean; reject?: boolean } = {}): {
  tools: SearchManyRegistryLike;
  definitions: Map<string, SearchManyDefinition>;
  schemas: () => { name: string; parameters: unknown; output: unknown }[];
} {
  const definitions = new Map<string, SearchManyDefinition>();
  const tools: SearchManyRegistryLike = {
    register(definition) {
      if (options.reject === true) throw new Error('registry rejected the definition');
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
    get(name) {
      if (options.taken === true && name === SEARCH_MANY_TOOL_NAME) return { name };
      return definitions.get(name);
    },
  };
  return {
    tools,
    definitions,
    schemas: () => [...definitions.values()].map((definition) => ({
      name: definition.name,
      parameters: definition.parameters,
      output: definition.output.schema,
    })),
  };
}

test('the definition uses the registry raw JSON-Schema dialect', () => {
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, runnerFrom({}));
  assert.equal(definition.name, SEARCH_MANY_TOOL_NAME);
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.required, ['queries']);
  const queries = definition.parameters.properties?.['queries'];
  assert.equal(queries?.type, 'array');
  assert.deepEqual(queries?.items, { type: 'string' });
  assert.equal(definition.parameters.properties?.['limit']?.type, 'integer');
  assert.equal(definition.parameters.properties?.['withSites']?.type, 'boolean');
  assert.deepEqual(definition.output.schema.required, ['results', 'truncated']);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
  assert.equal(definition.timeoutMs, 30_000);
});

test('three queries run independently and keep their order and shape', async () => {
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, runnerFrom({
    alpha: [source('https://example.com/a1'), source('https://example.com/a2')],
    beta: [source('https://example.com/b1')],
    gamma: [source('https://example.com/g1')],
  }));
  const value = await definition.execute({ queries: ['alpha', '  beta ', 'gamma'] }, {});
  assert.deepEqual(value.results.map((result) => result.query), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(value.results.map((result) => result.sources.map((item) => item.url)), [
    ['https://example.com/a1', 'https://example.com/a2'],
    ['https://example.com/b1'],
    ['https://example.com/g1'],
  ]);
  assert.deepEqual(value.results.map((result) => result.failures), [[], [], []]);
  assert.equal(value.truncated, false);
  assert.equal('site' in (value.results[0]?.sources[0] ?? {}), false, 'site is opt-in');
  assert.match(formatSearchManyValue(value), /Batch search: 3 queries, 4 result\(s\)\./);
});

test('one failed query does not stop the others', async () => {
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, runnerFrom({
    first: [source('https://example.com/first')],
    broken: new Error('engine exploded'),
    last: [source('https://example.com/last')],
  }));
  const value = await definition.execute({ queries: ['first', 'broken', 'last'] }, {});
  assert.deepEqual(value.results.map((result) => result.query), ['first', 'broken', 'last']);
  assert.deepEqual(value.results[0]?.sources.map((item) => item.url), ['https://example.com/first']);
  assert.deepEqual(value.results[1]?.sources, []);
  assert.deepEqual(value.results[1]?.failures, ['engine exploded']);
  assert.deepEqual(value.results[2]?.sources.map((item) => item.url), ['https://example.com/last']);
});

test('a fallback policy note is kept per query and rendered', async () => {
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, async (query) => ({
    sources: query === 'good' ? [source('https://example.com/')] : [],
    failures: [],
    note: query === 'good' ? undefined : 'fallback skipped: bot-wall is not enabled in fallbackOn.',
    truncated: false,
  }));
  const value = await definition.execute({ queries: ['good', 'blocked'] }, {});
  assert.equal(value.results[0]?.note, undefined);
  assert.match(value.results[1]?.note ?? '', /fallback skipped/u);
  assert.match(formatSearchManyValue(value), /Note: fallback skipped/u);
});

test('per-query failures from the search layer are preserved verbatim', async () => {
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, async (query) => ({
    sources: query === 'good' ? [source('https://example.com/good')] : [],
    failures: query === 'good' ? [] : ['bing: HTTP 503', 'ddg: timeout'],
    truncated: false,
  }));
  const value = await definition.execute({ queries: ['good', 'bad'] }, {});
  assert.deepEqual(value.results[1]?.failures, ['bing: HTTP 503', 'ddg: timeout']);
  assert.deepEqual(value.results[1]?.sources, []);
});

test('at most three searches run at the same time', async () => {
  let active = 0;
  let peak = 0;
  const started: string[] = [];
  const runner: SearchManyRunner = async (query) => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(query);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { sources: [], failures: [], truncated: false };
  };
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, runner);
  await definition.execute({ queries: ['a', 'b', 'c', 'd', 'e'] }, {});
  assert.equal(SEARCH_MANY_CONCURRENCY, 3);
  assert.equal(peak, 3, `peak concurrency was ${peak}`);
  assert.equal(started.length, 5, 'every query still ran');
  assert.deepEqual([...started].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('queries that are empty or too long are rejected before any search', async () => {
  let calls = 0;
  const definition = createSearchManyDefinition(SEARCH_MANY_TOOL_NAME, async () => {
    calls += 1;
    return { sources: [], failures: [], truncated: false };
  });
  await assert.rejects(definition.execute({}, {}), /queries array/);
  await assert.rejects(definition.execute({ queries: [] }, {}), /1–5 queries, got 0/);
  await assert.rejects(
    definition.execute({ queries: ['a', 'b', 'c', 'd', 'e', 'f'] }, {}),
    /1–5 queries, got 6/,
  );
  await assert.rejects(definition.execute({ queries: ['ok', '   '] }, {}), /non-empty string/);
  await assert.rejects(definition.execute({ queries: ['ok', 7] }, {}), /non-empty string/);
  assert.equal(calls, 0, 'validation must not spend an engine request');
});

test('limit and withSites are validated and applied', async () => {
  const calls: { query: string; limit: number }[] = [];
  const many = Array.from({ length: 6 }, (_, index) => source(`https://www.example.com/${index}`, `R${index}`));
  const definition = createSearchManyDefinition(
    SEARCH_MANY_TOOL_NAME,
    runnerFrom({ defaulted: many, limited: many, invalid: [source('not a url')] }, calls),
  );

  const byDefault = await definition.execute({ queries: ['defaulted'] }, {});
  assert.deepEqual(calls[0], { query: 'defaulted', limit: SEARCH_MANY_DEFAULT_LIMIT });
  assert.equal(byDefault.results[0]?.sources.length, 5, 'the default budget is 5');
  assert.equal(byDefault.truncated, true, 'six answers for five slots is a truncation');

  const narrowed = await definition.execute({ queries: ['limited'], limit: 2, withSites: true }, {});
  assert.deepEqual(calls[1], { query: 'limited', limit: 2 });
  assert.equal(narrowed.results[0]?.sources.length, 2);
  assert.deepEqual(narrowed.results[0]?.sources.map((item) => item.site), [
    'www.example.com',
    'www.example.com',
  ]);

  const unparsable = await definition.execute({ queries: ['invalid'], withSites: true }, {});
  assert.equal('site' in (unparsable.results[0]?.sources[0] ?? {}), false, 'a non-URL gets no site');

  await assert.rejects(definition.execute({ queries: ['limited'], limit: 0 }, {}), /limit must be an integer/);
  await assert.rejects(definition.execute({ queries: ['limited'], limit: 21 }, {}), /limit must be an integer/);
  await assert.rejects(definition.execute({ queries: ['limited'], limit: 2.5 }, {}), /limit must be an integer/);
  await assert.rejects(definition.execute({ queries: ['limited'], withSites: 'yes' }, {}), /withSites must be a boolean/);
});

test('registration is visible to the projected schemas and disposal removes it', async () => {
  const { tools, definitions, schemas } = registry();
  const registration = registerSearchManyTool(tools, runnerFrom({ x: [source('https://example.com/x')] }));
  assert.ok(registration);
  assert.equal(registration.name, SEARCH_MANY_TOOL_NAME);
  assert.deepEqual(schemas().map((schema) => schema.name), [SEARCH_MANY_TOOL_NAME]);
  assert.deepEqual(
    (schemas()[0]?.parameters as { required?: string[] } | undefined)?.required,
    ['queries'],
  );

  const registered = definitions.get(SEARCH_MANY_TOOL_NAME);
  assert.ok(registered);
  const value = await registered.execute({ queries: ['x'] }, {});
  assert.equal(value.results[0]?.sources[0]?.url, 'https://example.com/x');

  registration.dispose();
  assert.equal(definitions.size, 0);
  assert.deepEqual(schemas(), []);
  registration.dispose(); // idempotent
});

test('a taken name falls back to web_search_many', () => {
  const { tools } = registry({ taken: true });
  assert.equal(pickSearchManyToolName(tools), SEARCH_MANY_FALLBACK_NAME);
  const registration = registerSearchManyTool(tools, runnerFrom({}));
  assert.equal(registration?.name, SEARCH_MANY_FALLBACK_NAME);
});

test('a registry rejection is reported and swallowed', () => {
  const warnings: string[] = [];
  const { tools } = registry({ reject: true });
  const registration = registerSearchManyTool(tools, runnerFrom({}), { warn: (line) => warnings.push(line) });
  assert.equal(registration, undefined);
  assert.ok(warnings.some((line) => line.includes('search_many') && line.includes('rejected')), JSON.stringify(warnings));
});

test('apply registers search_many with the host tools service and disposes it', () => {
  const { tools, definitions } = registry();
  const cleanups: (() => void)[] = [];
  const providers: SearchProvider[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: () => undefined,
    },
    get: (name: string) => (name === 'tools' ? tools : undefined),
    effect: (execute) => {
      const cleanup = execute();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };

  apply(ctx, { cachePersist: false, toolSurface: 'legacy' });
  assert.equal(providers.length, 1, 'web_search is still registered');
  assert.equal(definitions.has(SEARCH_MANY_TOOL_NAME), true);
  assert.equal(definitions.has('domain_search'), true, 'both optional tools share the registry');

  for (const cleanup of cleanups) cleanup();
  assert.equal(definitions.has(SEARCH_MANY_TOOL_NAME), false, 'dispose removed the batch tool');
});

test('apply without a tools service still mounts web_search', () => {
  const providers: SearchProvider[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: () => undefined,
    },
  };
  assert.doesNotThrow(() => apply(ctx, { cachePersist: false }));
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, 'bing');
});
