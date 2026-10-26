/**
 * Contract tests for `platform_search`: arguments, rendering, fallback naming
 * and registration. The network lives in `platforms.ts` and is stubbed here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_DEFAULT_LIMIT,
  PLATFORM_TOOL_FALLBACK_NAME,
  PLATFORM_TOOL_NAME,
  createPlatformToolDefinition,
  parsePlatformArgs,
  pickPlatformToolName,
  registerPlatformTool,
} from '../src/platform-tool.ts';
import type { PlatformRunner, PlatformToolDefinition } from '../src/platform-tool.ts';
import type { Source } from '../src/types.ts';

function source(url: string, title: string): Source {
  return { url, title, snippet: `snippet ${title}` };
}

function runner(sources: Source[] = [source('https://www.bilibili.com/video/BV1', 'Bilibili')]): PlatformRunner {
  return async () => ({ sources, failures: [], via: { bilibili: 'api' as const }, truncated: false });
}

function definition(run: PlatformRunner = runner()): PlatformToolDefinition {
  return createPlatformToolDefinition(PLATFORM_TOOL_NAME, run);
}

test('the definition validates arguments and documents every platform', () => {
  const value = parsePlatformArgs({ query: '  deepseek  ', platforms: ['zhihu', 'juejin'], limit: 2 });
  assert.equal(value.query, 'deepseek');
  assert.deepEqual(value.ids, ['zhihu', 'juejin']);
  assert.equal(value.limit, 2);
  assert.deepEqual(parsePlatformArgs({ query: 'x' }).ids.length, 6);
  assert.equal(parsePlatformArgs({ query: 'x' }).limit, PLATFORM_DEFAULT_LIMIT);
  assert.throws(() => parsePlatformArgs({ query: 'x', platforms: ['nope'] }), /subset/u);
  assert.throws(() => parsePlatformArgs({ query: 'x', platforms: [] }), /not be empty/u);
  assert.throws(() => parsePlatformArgs({ query: 'x', limit: 11 }), /between 1 and 10/u);
  assert.throws(() => parsePlatformArgs({}), /non-empty query/u);
});

test('execute forwards the selected platforms and renders an untrusted pack', async () => {
  let seen: { query: string; ids: readonly string[]; limit: number } | undefined;
  const run: PlatformRunner = async (query, ids, limit) => {
    seen = { query, ids, limit };
    return runner()(query, ids, limit);
  };
  const tool = definition(run);
  const value = await tool.execute({ query: 'deepseek', platforms: ['bilibili'], limit: 1 }, {});
  assert.deepEqual(seen, { query: 'deepseek', ids: ['bilibili'], limit: 1 });
  assert.equal(value.platforms[0], 'bilibili');
  assert.equal(value.sources[0]?.url, 'https://www.bilibili.com/video/BV1');
  const rendered = tool.output.render({}, value)[0]?.text ?? '';
  assert.match(rendered, /<untrusted-web-content>/u);
  assert.match(rendered, /Bilibili/u);
});

test('a name collision uses the documented fallback and registration is contained', () => {
  const definitions: string[] = [];
  const tools = {
    register(definition: PlatformToolDefinition) { definitions.push(definition.name); return () => {}; },
    get(name: string) { return name === PLATFORM_TOOL_NAME ? {} : undefined; },
  };
  assert.equal(pickPlatformToolName(tools), PLATFORM_TOOL_FALLBACK_NAME);
  const warnings: string[] = [];
  assert.equal(registerPlatformTool(tools, runner(), { warn: (line) => warnings.push(line) }), PLATFORM_TOOL_FALLBACK_NAME);
  assert.deepEqual(definitions, [PLATFORM_TOOL_FALLBACK_NAME]);

  const rejecting = {
    register() { throw new Error('registry rejected'); },
  };
  assert.equal(registerPlatformTool(rejecting, runner(), { warn: (line) => warnings.push(line) }), undefined);
  assert.ok(warnings.some((line) => line.includes('registry rejected')));
});

test('the merged result respects the requested limit even when the runner overreturns', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => source(`https://example.com/${index}`, `row ${index}`));
  const value = await definition(runner(rows)).execute({ query: 'x', limit: 2 }, {});
  assert.equal(value.sources.length, 2);
  assert.equal(value.truncated, true);
});
