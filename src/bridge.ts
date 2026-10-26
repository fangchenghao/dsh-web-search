/**
 * A tiny same-origin bridge for the Settings page's "Test engines" button.
 *
 * The settings surface is ordinary browser JavaScript: it cannot call a model
 * tool, and the plugin has no other way to start a search from a click. This
 * route is deliberately narrow — one POST endpoint, loopback only, no settings
 * writes, no arbitrary query execution beyond the engine test.
 *
 * @module @fangchenghao/dsh-web-search/bridge
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runEngineTestValue } from './engine-test.ts';
import type { EngineTestRunner } from './engine-test.ts';
import { HOSTS } from './engines.ts';
import type { InjectableHost, PluginManagerLike, ServiceContext } from './inject.ts';

/** Route prefix the client fetches; kept stable for the shipped settings page. */
export const ENGINE_TEST_BRIDGE_PATH = '/api/dsh-web-search/engine-test';
/** Settings-page update button; the only package it may install is this one. */
export const UPDATE_BRIDGE_PATH = '/api/dsh-web-search/update';
/** Exact package this bridge is allowed to install. */
export const OWN_PACKAGE_NAME = '@fffangchenghao/dsh-web-search';

/** The injected services this bridge needs; `webServer` may be absent. */
export type BridgeContext = ServiceContext;
/** A context that can inject the web server and may look up the plugin manager. */
export type UpdateContext = InjectableHost & Pick<InjectableHost, 'get'>;

/** A context that may support `inject`; test hosts often do not. */
export type InjectableContext = InjectableHost;

export type { WebServerLike } from './inject.ts';

/** Largest request body the bridge will read. */
const MAX_BODY_BYTES = 16 * 1024;

/** Whether an address is loopback. */
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Parse a Host header without throwing. */
function hostOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return new URL(`http://${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Refuse cross-site and non-loopback callers.
 *
 * The Host already authenticates its own `/api` surface; this guard keeps the
 * plugin from widening it. A remote settings page therefore cannot use the
 * button, but it also cannot reach a search runner with no authentication.
 */
function isAllowed(request: IncomingMessage): boolean {
  if (!isLoopback(request.socket.remoteAddress)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostOf(request.headers.host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Send one JSON response. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
}

/** Read a bounded JSON body. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse and validate the request body. */
function parseBody(body: unknown): { engine?: string; query?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const engine = record['engine'];
  const query = record['query'];
  if (engine !== undefined && (typeof engine !== 'string' || engine.trim().length === 0)) {
    throw new Error('engine must be a non-empty string');
  }
  if (query !== undefined && (typeof query !== 'string' || query.trim().length === 0)) {
    throw new Error('query must be a non-empty string');
  }
  if (engine !== undefined && !HOSTS.some((host) => host.id === engine.trim())) {
    throw new Error(`unknown engine ${JSON.stringify(engine)}`);
  }
  return {
    ...(engine === undefined ? {} : { engine: engine.trim() }),
    ...(query === undefined ? {} : { query: query.trim() }),
  };
}

/** A local checkout must never be replaced by the registry package. */
function isLocalSource(source: string | undefined): boolean {
  return typeof source === 'string' && /(?:^|@)(?:link|file|workspace):/iu.test(source);
}

/** Read the plugin manager from the injected context or the service registry. */
function managerOf(
  ctx: UpdateContext,
  services: ServiceContext,
): PluginManagerLike | undefined {
  const injected = services.pluginManager;
  if (injected !== undefined) return injected;
  if (typeof ctx.get !== 'function') return undefined;
  try {
    const candidate = ctx.get('pluginManager');
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const manager = candidate as PluginManagerLike;
    return typeof manager.listBundles === 'function' && typeof manager.installBundle === 'function'
      ? manager
      : undefined;
  } catch {
    return undefined;
  }
}

/** Human-readable failure from a manager result. */
function failureText(error: { code?: string; diagnostic?: string } | undefined): string {
  if (error === undefined) return 'the plugin manager rejected the update';
  return error.diagnostic ?? error.code ?? 'the plugin manager rejected the update';
}

/**
 * The Settings page's update button.
 *
 * It deliberately does not run a package manager itself: the host's own
 * `pluginManager` owns the profile lock and the pnpm invocation. The bridge
 * only accepts this package, refuses a local link/file install, and reports
 * that a restart is required. The model tool path is untouched.
 *
 * @param ctx - injectable plugin context.
 * @returns a disposer, or `undefined` when the host has no injectable server.
 */
export function registerUpdateBridge(ctx: UpdateContext): (() => void) | undefined {
  if (typeof ctx.inject !== 'function') return undefined;
  try {
    ctx.inject(['webServer'], (services) => {
      const webServer = services?.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      const mount = () => {
        const off = webServer.register({
          kind: 'exact',
          path: UPDATE_BRIDGE_PATH,
          async handler(request, response) {
            if (request.method !== 'POST') {
              writeJson(response, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' });
              return;
            }
            if (!isAllowed(request)) {
              writeJson(response, 403, { ok: false, code: 'forbidden', message: 'loopback settings only' });
              return;
            }
            const body = await readJson(request);
            if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
              writeJson(response, 400, { ok: false, code: 'invalid-json', message: 'body must be a JSON object' });
              return;
            }
            const manager = managerOf(ctx, services);
            if (manager === undefined) {
              writeJson(response, 503, {
                ok: false,
                code: 'manager-unavailable',
                message: 'this deployment has no plugin manager; use the profile package manager instead',
              });
              return;
            }
            try {
              const bundles = await manager.listBundles();
              const own = bundles.find((bundle) => bundle.name === OWN_PACKAGE_NAME && bundle.installed !== false);
              if (own === undefined) {
                writeJson(response, 409, {
                  ok: false,
                  code: 'not-installed',
                  message: 'this package is not an installed profile bundle',
                });
                return;
              }
              if (isLocalSource(own.source)) {
                writeJson(response, 409, {
                  ok: false,
                  code: 'local-install',
                  message: 'link:/file: installs are not replaced by the button; install from npm first',
                });
                return;
              }
              const result = await manager.installBundle(`${OWN_PACKAGE_NAME}@latest`, { saveExact: true });
              if (result.application === 'failed' || result.application === 'cancelled') {
                writeJson(response, 502, {
                  ok: false,
                  code: result.application,
                  message: failureText(result.error),
                });
                return;
              }
              writeJson(response, 200, {
                ok: true,
                changed: result.changed,
                application: result.application,
                version: result.version ?? null,
                restartRequired: result.application === 'restart-required',
                message: result.changed
                  ? result.application === 'restart-required'
                    ? 'update installed; restart DeepSeek Harness to load it'
                    : 'update installed'
                  : 'already at the latest version',
              });
            } catch (error) {
              writeJson(response, 502, {
                ok: false,
                code: 'install-failed',
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        });
        return typeof off === 'function' ? (off as () => void) : undefined;
      };
      if (typeof services.effect === 'function') services.effect(mount);
      else mount();
    });
    return () => {
      // The injected disposer owns the route; nothing else to release here.
    };
  } catch {
    return undefined;
  }
}

/**
 * Register the engine-test endpoint.
 * @param ctx - injectable plugin context.
 * @param runTest - engine test runner shared with the model tool.
 * @returns a disposer, or `undefined` when the host has no injectable server.
 */
export function registerEngineTestBridge(
  ctx: InjectableContext,
  runTest: EngineTestRunner,
): (() => void) | undefined {
  if (typeof ctx.inject !== 'function') return undefined;
  try {
    ctx.inject(['webServer'], (services) => {
      const webServer = services?.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      const mount = () => {
        const off = webServer.register({
          kind: 'exact',
          path: ENGINE_TEST_BRIDGE_PATH,
          async handler(request, response) {
            if (request.method !== 'POST') {
              writeJson(response, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' });
              return;
            }
            if (!isAllowed(request)) {
              writeJson(response, 403, { ok: false, code: 'forbidden', message: 'loopback settings only' });
              return;
            }
            const body = await readJson(request);
            if (body === undefined) {
              writeJson(response, 400, { ok: false, code: 'invalid-json', message: 'malformed or oversized JSON body' });
              return;
            }
            try {
              const parsed = parseBody(body);
              const query = parsed.query ?? 'DeepSeek Harness';
              const engines = parsed.engine === undefined ? HOSTS.map((host) => host.id) : [parsed.engine];
              const result = await runEngineTestValue(runTest, engines, query);
              writeJson(response, 200, { ok: true, value: result });
            } catch (error) {
              writeJson(response, 400, {
                ok: false,
                code: 'test-failed',
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        });
        return typeof off === 'function' ? (off as () => void) : undefined;
      };
      if (typeof services.effect === 'function') services.effect(mount);
      else mount();
    });
    return () => {
      // The injected disposer owns the route; nothing else to release here.
    };
  } catch {
    return undefined;
  }
}
