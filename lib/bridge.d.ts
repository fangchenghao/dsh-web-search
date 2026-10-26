import type { EngineTestRunner } from './engine-test.ts';
import type { InjectableHost, ServiceContext } from './inject.ts';
/** Route prefix the client fetches; kept stable for the shipped settings page. */
export declare const ENGINE_TEST_BRIDGE_PATH = "/api/dsh-web-search/engine-test";
/** Settings-page update button; the only package it may install is this one. */
export declare const UPDATE_BRIDGE_PATH = "/api/dsh-web-search/update";
/** Exact package this bridge is allowed to install. */
export declare const OWN_PACKAGE_NAME = "@fffangchenghao/dsh-web-search";
/** The injected services this bridge needs; `webServer` may be absent. */
export type BridgeContext = ServiceContext;
/** A context that can inject the web server and may look up the plugin manager. */
export type UpdateContext = InjectableHost & Pick<InjectableHost, 'get'>;
/** A context that may support `inject`; test hosts often do not. */
export type InjectableContext = InjectableHost;
export type { WebServerLike } from './inject.ts';
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
export declare function registerUpdateBridge(ctx: UpdateContext): (() => void) | undefined;
/**
 * Register the engine-test endpoint.
 * @param ctx - injectable plugin context.
 * @param runTest - engine test runner shared with the model tool.
 * @returns a disposer, or `undefined` when the host has no injectable server.
 */
export declare function registerEngineTestBridge(ctx: InjectableContext, runTest: EngineTestRunner): (() => void) | undefined;
