/**
 * Route memory at the transport boundary.
 *
 * A direct 403 followed by a tunnel success must not make every later request
 * pay for the same 403. This test uses a target that always answers 403 and a
 * fake CONNECT proxy that answers with a valid page; the second call must go
 * straight to the proxy.
 *
 * @module dsh-web-search-bing/test/transport-route
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { searchHost } from '../src/transport.ts';
import { EngineHealth } from '../src/health.ts';
import type { HostSpec } from '../src/types.ts';

test('a successful proxy detour is remembered for the next request', async () => {
  let directHits = 0;
  const target = createServer((_request, response) => {
    directHits += 1;
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('<html><body>blocked</body></html>');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetAddress = target.address();
  assert.ok(targetAddress !== null && typeof targetAddress === 'object');
  const targetPort = targetAddress.port;

  const proxy = createServer();
  proxy.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Wait for the tunnel's GET before responding; proxyGet opens the tunnel
    // and then writes the request on the same socket.
    socket.once('data', () => {
      const body = '<html><body><h1>proxy page</h1></body></html>';
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress !== null && typeof proxyAddress === 'object');
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

  const host: HostSpec = {
    id: 'route-fixture',
    tier: 'primary',
    region: 'global',
    build: () => `http://127.0.0.1:${targetPort}/page`,
    skipEcho: true,
    parse: () => [{ title: 'proxy page', url: 'https://example.test/page' }],
  };
  const health = new EngineHealth();
  try {
    const first = await searchHost(host, 'route test', undefined, 5_000, proxyUrl, undefined, undefined, health);
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.route : undefined, 'proxy');
    assert.equal(directHits, 1);
    assert.equal(health.preferProxy(host.id), true);

    const second = await searchHost(host, 'route test', undefined, 5_000, proxyUrl, undefined, undefined, health);
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.route : undefined, 'proxy');
    assert.equal(directHits, 1, 'the second run should not touch the blocked direct route');
  } finally {
    target.close();
    proxy.close();
  }
});
