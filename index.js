/**
 * `dsh-web-search-bing` — a key-free search provider for the `ctx.web` seam.
 *
 * Why this exists: the shipped DeepSeek search provider needs a credential
 * because it delegates searching to DeepSeek's server-side `web_search` tool.
 * That tool only runs on a DeepSeek-hosted Messages endpoint; pointing the
 * provider at another compatible base cannot work, because the search happens
 * server-side and the endpoint simply ignores the tool declaration. This
 * provider does the searching itself against public result pages, so
 * `web_search` works with no provider API key at all.
 *
 * @module dsh-web-search-bing
 */
import { search as searchWeb } from './engines.js';

export const name = 'dsh-web-search-bing';

/** The `ctx.web` service this plugin registers a search provider with. */
export const inject = ['web'];

/** Provider id referenced by `web.searchProvider`. */
export const PROVIDER_ID = 'bing';

/**
 * Register the search provider.
 *
 * @param ctx - plugin context carrying the `web` service.
 * @param config - optional section: `hosts` (engine ids to allow), `timeoutMs`
 *   (per-engine deadline), `wait` (`auto` | `all` | `fast`) and `proxy` (an
 *   `http://host:port` tunnel URL).
 */
export function apply(ctx, config = {}) {
  const hostIds = Array.isArray(config?.hosts) && config.hosts.length > 0 ? config.hosts : undefined;
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const proxy = typeof config?.proxy === 'string' && config.proxy.length > 0 ? config.proxy : undefined;
  const wait = ['auto', 'all', 'fast'].includes(config?.wait) ? config.wait : undefined;

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const query = request?.query;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('web search requires a non-empty query');
      }
      if (signal?.aborted) throw new Error('web search was cancelled');
      const limit = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : undefined;
      const { sources, failures } = await searchWeb(query, signal, { hostIds, timeoutMs, proxy, limit, wait });
      if (sources.length === 0) {
        throw new Error(`no search engine returned results for ${JSON.stringify(query)} (${failures.join('; ')})`);
      }
      if (limit === undefined || sources.length <= limit) return { sources, truncated: false };
      return { sources: sources.slice(0, limit), truncated: true };
    },
  });
}
