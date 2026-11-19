/**
 * Cross-agent MCP transport contract.
 *
 * These tests exercise the published stdio server as a separate process, not
 * the TypeScript modules behind it: a real MCP client must be able to
 * initialize, list the four tools and fetch a page without a DSH context.
 *
 * @module dsh-web-search-bing/test/mcp
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

type RequestId = number | string;

async function startRpc(
  t: TestContext,
  envFor = (url: string): NodeJS.ProcessEnv => ({ DSH_WEB_SEARCH_PROXY: url }),
  nodeArgs: string[] = [],
) {
  const page = createServer();
  page.listen(0, '127.0.0.1');
  await once(page, 'listening');
  t.after(() => {
    page.close();
    page.closeAllConnections();
  });
  const address = page.address();
  assert.ok(address !== null && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  const child = spawn(process.execPath, [...nodeArgs, resolve('mcp/server.mjs')], {
    env: envFor(url),
  });
  const closed = once(child, 'close');
  t.after(() => { child.kill(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

  function send(id: RequestId | undefined, method: string, params?: unknown) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }
  async function reply(id: RequestId) {
    const line = await output.next();
    assert.ok(!line.done, `stdout closed before the reply to ${id}`);
    const message = JSON.parse(line.value) as Record<string, unknown>;
    assert.equal(message['id'], id);
    return message;
  }
  return {
    page, url, child, send, reply,
    request(id: RequestId, method: string, params?: unknown) {
      send(id, method, params);
      return reply(id);
    },
    async holdFetch(id: RequestId) {
      const incoming = once(page, 'request', { signal: t.signal });
      send(id, 'tools/call', { name: 'fetch', arguments: { url } });
      const [, response] = await incoming;
      return response as ServerResponse;
    },
    async expectExit() {
      assert.deepEqual(await closed, [0, null]);
      assert.equal((await output.next()).done, true, 'unexpected trailing JSON-RPC reply');
    },
  };
}

test('MCP server initializes, lists four tools, and fetches a local page', { timeout: 8_000 }, async (t) => {
  const rpc = await startRpc(t);
  rpc.page.on('request', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><h1>MCP Test Page</h1><p>Hello from the local fixture.</p></body></html>');
  });
  const init = await rpc.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal((init['result'] as Record<string, unknown>)['protocolVersion'], '2024-11-05');
  const list = await rpc.request(2, 'tools/list', {});
  const tools = (list['result'] as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['search', 'fetch', 'research', 'domain_search']);
  const result = await rpc.request(3, 'tools/call', { name: 'fetch', arguments: { url: rpc.url, maxLength: 5_000 } });
  const value = result['result'] as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(value.isError, false);
  assert.match(value.content[0]?.text ?? '', /MCP Test Page/u);
  assert.match(value.content[0]?.text ?? '', /HTTP 200/u);
});

test('ping succeeds during a slow fetch and cancellation disconnects only its request', { timeout: 8_000 }, async (t) => {
  const rpc = await startRpc(t);
  const discarded = await rpc.holdFetch(0);
  const kept = await rpc.holdFetch('0');
  assert.deepEqual((await rpc.request(1, 'ping'))['result'], {});

  const disconnected = once(discarded, 'close', { signal: AbortSignal.timeout(2_000) });
  rpc.send(undefined, 'notifications/cancelled', { requestId: 0, reason: 'client stopped waiting' });
  await assert.doesNotReject(disconnected, 'cancel should close the pending HTTP response before its transport deadline');
  assert.equal(kept.destroyed, false);
  rpc.send(undefined, 'notifications/cancelled', { requestId: 0 });
  kept.end('independent page');
  const value = (await rpc.reply('0'))['result'] as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(value.isError, false);
  assert.match(value.content[0]?.text ?? '', /independent page/u);
  rpc.send(undefined, 'notifications/cancelled', { requestId: '0' });
  rpc.child.stdin.end();
  await rpc.expectExit();
});

test('tool admission is bounded and notifications and duplicate active ids stay silent', { timeout: 8_000 }, async (t) => {
  const rpc = await startRpc(t);
  const held: ServerResponse[] = [];
  for (let id = 1; id <= 4; id++) held.push(await rpc.holdFetch(id));
  let extraStarts = 0;
  rpc.page.on('request', (_request, response) => {
    extraStarts++;
    response.end('another page');
  });
  const params = { name: 'fetch', arguments: { url: rpc.url } };
  const busy = await rpc.request(5, 'tools/call', params);
  assert.equal(extraStarts, 0, 'a fifth tool opened an HTTP request while four were running');
  const result = busy['result'] as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /busy/i);

  rpc.send(1, 'tools/call', params);
  rpc.send(undefined, 'ping');
  rpc.send(undefined, 'tools/call', params);
  assert.deepEqual((await rpc.request(6, 'ping'))['result'], {});
  for (const [index, response] of held.entries()) {
    response.end('requested page');
    assert.equal(((await rpc.reply(index + 1))['result'] as { isError: boolean }).isError, false);
  }
  assert.equal(((await rpc.request(7, 'tools/call', params))['result'] as { isError: boolean }).isError, false);
  assert.equal(extraStarts, 1);
  rpc.child.stdin.end();
  await rpc.expectExit();
});

for (const closing of ['stdin EOF', 'shutdown'] as const) {
  test(`${closing} aborts an outstanding fetch and closes stdio cleanly`, { timeout: 8_000 }, async (t) => {
    const rpc = await startRpc(t);
    const response = await rpc.holdFetch('slow');
    const disconnected = once(response, 'close', { signal: AbortSignal.timeout(2_000) });
    if (closing === 'stdin EOF') rpc.child.stdin.end();
    else rpc.send(1, 'shutdown');
    await assert.doesNotReject(disconnected, `${closing} should release the pending HTTP connection`);
    if (closing === 'shutdown') {
      assert.equal((await rpc.reply(1))['result'], null);
      rpc.send(undefined, 'exit');
    }
    await rpc.expectExit();
  });
}

for (const [setting, envFor, expectedConnects] of [
  ['NO_PROXY=*', (url: string) => ({ HTTPS_PROXY: url, NO_PROXY: '*' }), 0],
  ['https_proxy', (url: string) => ({ https_proxy: url }), 1],
  ['no proxy', () => ({}), 0],
] as const) {
  test(`MCP domain_search route with ${setting}`, { timeout: 8_000 }, async (t) => {
    const direct = "globalThis.fetch = async () => Response.json({ objects: [{ package: { name: 'direct-fixture' } }] })";
    const rpc = await startRpc(t, envFor, ['--import', `data:text/javascript,${encodeURIComponent(direct)}`]);
    let connects = 0;
    rpc.page.on('connect', (_request, socket) => {
      connects++;
      socket.end('HTTP/1.1 503 Local fixture\r\n\r\n');
    });
    const reply = await rpc.request(1, 'tools/call', { name: 'domain_search', arguments: { query: 'package', ids: ['npm'] } });
    const result = reply['result'] as { content: Array<{ text: string }> };
    assert.equal(connects, expectedConnects);
    assert.equal(result.content[0]?.text.includes('direct-fixture'), expectedConnects === 0);
  });
}
