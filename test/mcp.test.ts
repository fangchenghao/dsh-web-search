/**
 * Cross-agent MCP transport contract.
 *
 * These tests exercise the published stdio server as a separate process, not
 * the TypeScript modules behind it: a real MCP client must be able to
 * initialize, list the four tools and fetch a page without a DSH context.
 *
 * @module dsh-web-search-bing/test/mcp
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function startRpc(child: ChildProcessWithoutNullStreams): {
  request: (id: number, method: string, params?: unknown) => Promise<Record<string, unknown>>;
  close: () => void;
} {
  let buffer = '';
  let next = 0;
  const pending = new Map<number, Pending>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message['id'] !== 'number') continue;
      const waiting = pending.get(message['id']);
      if (waiting === undefined) continue;
      pending.delete(message['id']);
      if (message['error'] !== undefined) waiting.reject(new Error(JSON.stringify(message['error'])));
      else waiting.resolve(message);
    }
  });
  return {
    request(id, method, params) {
      next = Math.max(next, id);
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() {
      child.kill();
    },
  };
}

test('MCP server initializes, lists four tools, and fetches a local page', async () => {
  const page = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><h1>MCP Test Page</h1><p>Hello from the local fixture.</p></body></html>');
  });
  page.listen(0, '127.0.0.1');
  await once(page, 'listening');
  const address = page.address();
  assert.ok(address !== null && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  const child = spawn(process.execPath, [resolve('mcp/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_WEB_SEARCH_PROXY: '', ANYSEARCH_API_KEY: '' },
  }) as ChildProcessWithoutNullStreams;
  const rpc = startRpc(child);
  try {
    const init = await rpc.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal((init['result'] as Record<string, unknown>)['protocolVersion'], '2024-11-05');
    const list = await rpc.request(2, 'tools/list', {});
    const tools = (list['result'] as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['search', 'fetch', 'research', 'domain_search']);
    const result = await rpc.request(3, 'tools/call', { name: 'fetch', arguments: { url, maxLength: 5_000 } });
    const value = result['result'] as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(value.isError, false);
    assert.match(value.content[0]?.text ?? '', /MCP Test Page/u);
    assert.match(value.content[0]?.text ?? '', /HTTP 200/u);
  } finally {
    rpc.close();
    page.close();
  }
});
