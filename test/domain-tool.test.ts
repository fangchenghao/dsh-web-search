/**
 * Tests for the model-facing `domain_search` tool and its fail-safe mount.
 *
 * The registry here is a recording double, not the host's `ToolRuntime`; the
 * real registration shape is exercised separately by
 * `scripts/verify-tool-registration.mjs` against `@deepseek-ai/dsh-tools`. What
 * these tests pin down is the part this package owns: the definition must be
 * registry-shaped, execution must use the live config, and a deployment without
 * `ctx.tools` must still load `web_search`.
 *
 * @module dsh-web-search-bing/test/domain-tool
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DOMAIN_TOOL_FALLBACK_NAME,
  DOMAIN_TOOL_NAME,
  createDomainToolDefinition,
  pickDomainToolName,
  registerDomainTool,
} from '../src/domain-tool.ts';
import type { DomainToolDefinition, DomainToolSettings, ToolRegistryLike } from '../src/domain-tool.ts';
import { apply } from '../src/index.ts';
import { UNIFIED_TOOL_NAME, UNIFIED_TOOL_FALLBACK_NAME } from '../src/tool-suite.ts';
import type { PluginContext, SearchProvider } from '../src/index.ts';

/** Read a captured GitHub response. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** Settings a mounted plugin would read from the live config. */
function settings(overrides: Partial<DomainToolSettings> = {}): DomainToolSettings {
  return { sourceIds: ['github'], limit: 5, timeoutMs: 1000, ...overrides };
}

/** A recording registry. */
function registry(options: { taken?: boolean; reject?: boolean } = {}): {
  tools: ToolRegistryLike;
  definitions: DomainToolDefinition[];
} {
  const definitions: DomainToolDefinition[] = [];
  const tools: ToolRegistryLike = {
    register(definition) {
      if (options.reject === true) throw new Error('registry rejected the definition');
      definitions.push(definition);
      return () => undefined;
    },
    get(name) {
      return options.taken === true && name === DOMAIN_TOOL_NAME ? { name } : undefined;
    },
  };
  return { tools, definitions };
}

/** A `web` double plus the optional tool registry Cordis would expose via get(). */
function pluginContext(tools?: ToolRegistryLike): {
  ctx: PluginContext;
  providers: SearchProvider[];
  fetchProviders: unknown[];
} {
  const providers: SearchProvider[] = [];
  const fetchProviders: unknown[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: (provider) => fetchProviders.push(provider),
    },
    ...(tools === undefined ? {} : { get: (name: string) => (name === 'tools' ? tools : undefined) }),
  };
  return { ctx, providers, fetchProviders };
}

test('the definition uses the registry raw JSON-Schema dialect', () => {
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings());
  assert.equal(definition.name, DOMAIN_TOOL_NAME);
  assert.deepEqual(definition.parameters.required, ['query'], 'required is an array at object level');
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.output.schema.required, ['sources', 'failures', 'truncated']);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
  assert.equal(definition.timeoutMs, 30_000);
});

test('execute searches the requested source and returns registry-shaped output', async () => {
  const payload = await fixture('verticals-github.json');
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings(), {
    fetch: async () => new Response(payload, { status: 200 }),
    detectProxy: async () => undefined,
  });
  const value = await definition.execute({ query: 'react', sources: ['github'], limit: 1 }, {});
  assert.equal(value.sources.length, 1);
  assert.equal(value.sources[0]?.url, 'https://github.com/react/react');
  assert.deepEqual(value.failures, []);
  assert.equal(value.truncated, false);
  const blocks = definition.output.render({ query: 'react' }, value);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]?.text ?? '', /react\/react/);
  assert.match(blocks[0]?.text ?? '', /github\.com\/react\/react/);
});

test('execute reads the live settings for every call', async () => {
  const payload = await fixture('verticals-github.json');
  let limit = 1;
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings({ limit }), {
    fetch: async () => new Response(payload, { status: 200 }),
    detectProxy: async () => undefined,
  });
  const first = await definition.execute({ query: 'react' }, {});
  assert.equal(first.sources.length, 1, 'settings.limit is the default budget');
  limit = 2;
  const second = await definition.execute({ query: 'react' }, {});
  assert.equal(second.sources.length, 2, 'a settings edit applies without remount');
});

test('execute caps the caller limit at 20 and rejects an empty query', async () => {
  const payload = await fixture('verticals-github.json');
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings({ sourceIds: ['github'] }), {
    fetch: async () => new Response(payload, { status: 200 }),
    detectProxy: async () => undefined,
  });
  const value = await definition.execute({ query: 'react', limit: 999 }, {});
  assert.equal(value.sources.length, 2, 'the fixture only has two rows');
  await assert.rejects(definition.execute({ query: '  ' }, {}), /non-empty query/);
});

test('an empty sources array means the deployment default', async () => {
  const payload = await fixture('verticals-github.json');
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings(), {
    fetch: async () => new Response(payload, { status: 200 }),
    detectProxy: async () => undefined,
  });
  const value = await definition.execute({ query: 'react', sources: [] }, {});
  assert.equal(value.sources.length, 2, 'settings.sourceIds (github) is the fallback');
});

test('execute names the unknown source instead of silently querying everything', async () => {
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings(), {
    fetch: async () => new Response('{}', { status: 200 }),
    detectProxy: async () => undefined,
  });
  await assert.rejects(
    definition.execute({ query: 'react', sources: ['nope'] }, {}),
    /no known source/,
  );
});

test('execute reports per-source failures without throwing', async () => {
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings({ sourceIds: ['github', 'npm'] }), {
    fetch: async (input) => {
      if (String(input).includes('api.github.com')) return new Response('', { status: 500 });
      return new Response('{"objects":[]}', { status: 200 });
    },
    detectProxy: async () => undefined,
  });
  const value = await definition.execute({ query: 'react' }, {});
  assert.deepEqual(value.sources, []);
  assert.ok(value.failures.some((failure) => failure === 'github: HTTP 500'), JSON.stringify(value.failures));
});

test('execute can apply a publication window and explains the result', async () => {
  const payload = await fixture('verticals-arxiv.xml');
  const definition = createDomainToolDefinition(DOMAIN_TOOL_NAME, () => settings({ sourceIds: ['arxiv'] }), {
    fetch: async () => new Response(payload, { status: 200 }),
    detectProxy: async () => undefined,
  });
  const value = await definition.execute({ query: 'transformers', sources: ['arxiv'], timeRange: 'year' }, {});
  assert.deepEqual(value.sources, []);
  assert.equal(value.timeRange, 'year');
  assert.match(value.note ?? '', /No result was dated inside the year window/u);
  await assert.rejects(
    definition.execute({ query: 'transformers', timeRange: 'decade' }, {}),
    /timeRange must be one of/u,
  );
});

test('pickDomainToolName uses the fallback only when domain_search is taken', () => {
  assert.equal(pickDomainToolName(registry().tools), DOMAIN_TOOL_NAME);
  assert.equal(pickDomainToolName(registry({ taken: true }).tools), DOMAIN_TOOL_FALLBACK_NAME);
  assert.equal(pickDomainToolName({ register: () => undefined } as ToolRegistryLike), DOMAIN_TOOL_NAME);
});

test('registerDomainTool registers the definition and returns its name', () => {
  const { tools, definitions } = registry();
  assert.equal(registerDomainTool(tools, () => settings()), DOMAIN_TOOL_NAME);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.name, DOMAIN_TOOL_NAME);
});

test('a registry rejection is reported and swallowed', () => {
  const warnings: string[] = [];
  const { tools } = registry({ reject: true });
  assert.equal(registerDomainTool(tools, () => settings(), { warn: (line) => warnings.push(line) }), undefined);
  assert.ok(warnings.some((line) => line.includes('registry rejected')));
});

test('apply loads without a tool service and still registers web_search', () => {
  const { ctx, providers, fetchProviders } = pluginContext();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, 'bing');
  assert.equal(fetchProviders.length, 1);
});

test('apply registers one unified web_tools entry when the host exposes ctx.get("tools")', () => {
  const { tools, definitions } = registry();
  const { ctx, providers } = pluginContext(tools);
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(providers.length, 1, 'web_search is registered either way');
  assert.equal(definitions.length, 1, 'the eight capabilities are actions, not eight registry entries');
  assert.equal(definitions[0]?.name, UNIFIED_TOOL_NAME);
  assert.deepEqual(definitions[0]?.parameters.required, ['action']);
  assert.ok((definitions[0]?.parameters.properties?.action?.enum ?? []).includes('domain_search'));
});

test('apply uses the unified fallback name when another plugin owns web_tools', () => {
  const { tools, definitions } = registry();
  tools.get = (name) => (name === UNIFIED_TOOL_NAME ? { name } : undefined);
  const { ctx } = pluginContext(tools);
  apply(ctx, {});
  assert.equal(definitions[0]?.name, UNIFIED_TOOL_FALLBACK_NAME);
});

test('legacy mode keeps the original eight names for old prompts', () => {
  const { tools, definitions } = registry();
  const { ctx } = pluginContext(tools);
  apply(ctx, { toolSurface: 'legacy' });
  assert.equal(definitions.length, 8);
  assert.equal(definitions[0]?.name, DOMAIN_TOOL_NAME);
  assert.equal(definitions[7]?.name, 'engine_test');
});
test('the unified entry dispatches a captured action without touching another one', async () => {
  const { tools, definitions } = registry();
  const { ctx } = pluginContext(tools);
  apply(ctx, { cachePersist: false });
  const unified = definitions[0];
  assert.ok(unified, 'web_tools was registered');
  const value = await unified.execute({ action: 'cache_search', query: 'no such text' }, {});
  assert.equal(value.action, 'cache_search');
  assert.deepEqual(value.result, { query: 'no such text', matches: [], failures: [] });
  await assert.rejects(unified.execute({ action: 'not_an_action' }, {}), /action must be one of/u);
});

test('a throwing tool registry never breaks plugin loading', () => {
  const warnings: string[] = [];
  const { tools } = registry({ reject: true });
  const { ctx, providers } = pluginContext(tools);
  const original = console.warn;
  console.warn = (line: string) => warnings.push(line);
  try {
    assert.doesNotThrow(() => apply(ctx, {}));
  } finally {
    console.warn = original;
  }
  assert.equal(providers.length, 1);
  assert.ok(warnings.some((line) => line.includes('web_tools')), JSON.stringify(warnings));
});
