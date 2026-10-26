/**
 * The optional Cordis services this plugin reaches through `ctx.inject`.
 *
 * None of these are hard dependencies: `web` is the only required service, and
 * a deployment without a tool registry, web server or system-prompt service
 * still mounts the search provider. The interfaces live in one module so the
 * bridge and the prompt section agree on the injected shape, and so the plugin
 * context can expose the hook without importing a feature module.
 *
 * @module @fangchenghao/dsh-web-search/inject
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The slice of the host web server the Settings bridge needs. */
export interface WebServerLike {
  register(route: {
    kind: 'exact';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): unknown;
}

/** One section the host's system prompt accepts. */
export interface SystemPromptSectionOptions {
  /** Stable identifier used by the host to replace or remove the section. */
  name: string;
  /** Ordering hint; lower values appear earlier. */
  order?: number;
  /** The text inserted into the model's system prompt. */
  text: string;
}

/** The slice of the host system-prompt service this plugin needs. */
export interface SystemPromptLike {
  section(options: SystemPromptSectionOptions): unknown;
}

/** The slice of the host plugin manager the Settings update button needs. */
export interface PluginManagerLike {
  /** Profile bundles, used to refuse a link:/file: install before replacing it. */
  listBundles(): Promise<Array<{
    name: string;
    installed?: boolean;
    source?: string;
    version?: string;
  }>>;
  /** Install one exact bundle spec; the host persists it in the profile. */
  installBundle(spec: string, options?: { saveExact?: boolean }): Promise<{
    changed: boolean;
    application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
    version?: string;
    error?: { code?: string; diagnostic?: string };
  }>;
}

/** Services that may arrive through one `ctx.inject` callback. */
export interface ServiceContext {
  webServer?: WebServerLike;
  systemPrompt?: SystemPromptLike;
  pluginManager?: PluginManagerLike;
  effect?: (execute: () => (() => void) | void) => unknown;
}

/** A context that may support Cordis's dynamic dependency injection. */
export interface InjectableHost {
  inject?: (dependencies: string[], callback: (context: ServiceContext) => unknown) => unknown;
  /** Optional service lookup for hosts that expose a manager outside inject. */
  get?: (name: string) => unknown;
}
