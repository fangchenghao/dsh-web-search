/**
 * Tests for the keyless provider adapters added in 0.15: Exa's MCP endpoint and
 * Firecrawl's search API.
 *
 * Both parsers read a wire format that is not documented as stable: an SSE
 * frame carrying `Title:/URL:/Highlights:` blocks, and a `{success,data}`
 * envelope whose `description` is extracted Markdown rather than a snippet.
 * The fixtures are trimmed real responses; the drift cases assert the parsers
 * degrade to an empty list instead of throwing.
 *
 * @module dsh-web-search-bing/test/providers
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExaMcp, parseFirecrawl } from '../src/parsers.ts';
import { HOSTS } from '../src/engines.ts';

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/providers/${name}`, import.meta.url), 'utf8');
}

test('the Firecrawl envelope becomes titled, URL-addressable sources', async () => {
  const sources = parseFirecrawl(await fixture('firecrawl-search.json'), 'https://api.firecrawl.dev/v1/search');
  assert.ok(sources.length >= 2);
  for (const source of sources) {
    assert.match(source.url, /^https:\/\//);
    assert.ok((source.title ?? '').length > 0);
    assert.ok((source.snippet ?? '').length > 0);
    assert.ok((source.snippet ?? '').length <= 241);
  }
});

test('a failed or drifted Firecrawl payload is empty, not an exception', () => {
  for (const payload of ['', '{}', '{"success":false}', '{"success":true,"data":"nope"}', 'not json']) {
    assert.deepEqual(parseFirecrawl(payload, 'https://api.firecrawl.dev/v1/search'), []);
  }
});

test('the Exa SSE frame becomes one source per Title/URL block', async () => {
  const payload = await fixture('exa-mcp.txt');
  const sources = parseExaMcp(payload, 'https://mcp.exa.ai/mcp');
  assert.ok(sources.length >= 2);
  assert.match(sources[0]?.url ?? '', /^https:\/\//);
  assert.ok((sources[0]?.title ?? '').length > 0);
  assert.ok((sources[0]?.snippet ?? '').length > 0);
});

test('an Exa answer without data frames, or with junk frames, is empty', () => {
  assert.deepEqual(parseExaMcp('', 'https://mcp.exa.ai/mcp'), []);
  assert.deepEqual(parseExaMcp('event: message\ndata: [DONE]\n\n', 'https://mcp.exa.ai/mcp'), []);
  assert.deepEqual(parseExaMcp('event: message\ndata: {oops}\n\n', 'https://mcp.exa.ai/mcp'), []);
  assert.deepEqual(
    parseExaMcp('data: {"result":{"content":[{"type":"text","text":"no url here"}]}}\n\n', 'https://mcp.exa.ai/mcp'),
    [],
  );
});

test('the providers are registered with the tier their measurement earned', () => {
  const exa = HOSTS.find((entry) => entry.id === 'exa');
  const firecrawl = HOSTS.find((entry) => entry.id === 'firecrawl');
  assert.ok(exa && firecrawl);
  // Exa led the fusion to 0.8071 MRR@8 on the recorded fixtures; Firecrawl
  // diluted it when it led (0.7208) and ships as the fallback/opt-in.
  assert.equal(exa.tier, 'primary');
  assert.equal(firecrawl.tier, 'fallback');
  for (const host of [exa, firecrawl]) {
    assert.equal(host.method, 'POST');
    assert.equal(host.region, host.id === 'exa' ? 'global' : 'both');
    assert.ok(typeof host.body === 'function' && host.body('kubernetes').includes('kubernetes'));
  }
});
