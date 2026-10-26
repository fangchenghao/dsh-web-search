/**
 * The unified tool surface: one registry entry, eight actions.
 *
 * The adapter is tested with synthetic sub-definitions so these tests stay
 * about dispatch, envelope validation and fallback naming rather than network
 * or engine behaviour.
 *
 * @module dsh-web-search-bing/test/tool-suite
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIFIED_ACTIONS,
  UNIFIED_TOOL_FALLBACK_NAME,
  UNIFIED_TOOL_NAME,
  createUnifiedToolDefinition,
  isUnifiedAction,
  pickUnifiedToolName,
  registerUnifiedTool,
} from '../src/tool-suite.ts';
import type { SubToolDefinition, UnifiedToolDefinition, UnifiedToolRegistryLike } from '../src/tool-suite.ts';

/** A sub-definition that echoes its arguments and reports its action name. */
function sub(action: string, calls: string[]): SubToolDefinition {
  return {
    name: action,
    description: `${action} description`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `${action}:${JSON.stringify(args)}:${JSON.stringify(value)}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: (args) => (args as { query?: string }).query === 'safe',
    execute: async (args) => {
      calls.push(action);
      return { action, args };
    },
  };
}

/** Build all eight synthetic actions. */
function allSubs(calls: string[] = []): SubToolDefinition[] {
  return UNIFIED_ACTIONS.map((action) => sub(action, calls));
}

/** A registry double recording definitions and optional taken names. */
function registry(taken: string[] = []): {
  tools: UnifiedToolRegistryLike;
  definitions: UnifiedToolDefinition[];
} {
  const definitions: UnifiedToolDefinition[] = [];
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition);
        return () => undefined;
      },
      get(name) {
        return taken.includes(name) ? { name } : undefined;
      },
    },
  };
}

test('the unified schema exposes one action discriminator and the shared fields', () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, allSubs());
  assert.equal(definition.name, UNIFIED_TOOL_NAME);
  assert.deepEqual(definition.parameters.required, ['action']);
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.properties?.action?.enum, [...UNIFIED_ACTIONS]);
  assert.equal(definition.parameters.properties?.query?.type, 'string');
  assert.equal(definition.parameters.properties?.url?.type, 'string');
  assert.equal(definition.parameters.properties?.maxResults?.type, 'integer');
  assert.equal(definition.timeoutMs, 120_000);
});

test('execute strips action, dispatches to the matching handler and wraps the value', async () => {
  const calls: string[] = [];
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, allSubs(calls));
  const value = await definition.execute({ action: 'domain_search', query: 'react', sources: ['github'] }, {});
  assert.deepEqual(calls, ['domain_search']);
  assert.equal(value.action, 'domain_search');
  assert.deepEqual(value.result, { action: 'domain_search', args: { query: 'react', sources: ['github'] } });
});

test('render delegates to the sub-tool with the envelope removed', async () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, allSubs());
  const value = await definition.execute({ action: 'search_many', queries: ['a', 'b'] }, {});
  const blocks = definition.output.render({ action: 'search_many', queries: ['a', 'b'] }, value);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]?.text ?? '', /^search_many:/u);
  assert.match(blocks[0]?.text ?? '', /"queries":\["a","b"\]/u);
  assert.match(blocks[0]?.text ?? '', /^search_many:\{"queries":\["a","b"\]\}:/u);
});

test('unknown and missing actions are rejected before dispatch', async () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, allSubs());
  await assert.rejects(definition.execute({ action: 'bogus', query: 'x' }, {}), /action must be one of/u);
  await assert.rejects(definition.execute({ query: 'x' }, {}), /action must be one of/u);
  assert.equal(isUnifiedAction('research'), true);
  assert.equal(isUnifiedAction('nope'), false);
});

test('a missing action definition is named, not silently ignored', async () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, [sub('research', [])]);
  await assert.rejects(definition.execute({ action: 'engine_test' }, {}), /not registered/u);
});

test('isConcurrencySafe follows the selected sub-tool', () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_NAME, allSubs());
  assert.equal(definition.isConcurrencySafe?.({ action: 'domain_search', query: 'safe' }), true);
  assert.equal(definition.isConcurrencySafe?.({ action: 'domain_search', query: 'busy' }), false);
  assert.equal(definition.isConcurrencySafe?.({ action: 'bogus' }), false);
});

test('the preferred name falls back only when web_tools is taken', () => {
  assert.equal(pickUnifiedToolName(registry().tools), UNIFIED_TOOL_NAME);
  assert.equal(pickUnifiedToolName(registry([UNIFIED_TOOL_NAME]).tools), UNIFIED_TOOL_FALLBACK_NAME);
  assert.equal(pickUnifiedToolName({ register: () => undefined }), UNIFIED_TOOL_NAME);
});

test('registration records exactly one definition and can be skipped on rejection', () => {
  const ok = registry();
  assert.equal(registerUnifiedTool(ok.tools, allSubs()), UNIFIED_TOOL_NAME);
  assert.equal(ok.definitions.length, 1);
  assert.equal(ok.definitions[0]?.name, UNIFIED_TOOL_NAME);

  const warnings: string[] = [];
  const rejecting: UnifiedToolRegistryLike = {
    register() {
      throw new Error('duplicate');
    },
  };
  assert.equal(registerUnifiedTool(rejecting, allSubs(), { warn: (line) => warnings.push(line) }), undefined);
  assert.ok(warnings.some((line) => line.includes('web_tools registration skipped')));
});

test('the fallback name is exported and used in the definition name', () => {
  const definition = createUnifiedToolDefinition(UNIFIED_TOOL_FALLBACK_NAME, allSubs());
  assert.equal(definition.name, UNIFIED_TOOL_FALLBACK_NAME);
});
