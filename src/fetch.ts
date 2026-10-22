/**
 * The fetch half: `web_fetch` for a network where a direct request is not
 * always enough.
 *
 * The shipped `http` provider issues one direct request. That is enough on an
 * open network, but on a restricted one it is not: measured here, a direct
 * request to `github.com` or `html.duckduckgo.com` times out while the same URL
 * answers through the local tunnel in one to three seconds. Searching therefore
 * found pages the agent could never read.
 *
 * This provider closes that loop with a four-step ladder:
 *
 * 1. direct, which is what the shipped provider already does and stays first so
 *    an open network pays no tunnel round trip;
 * 2. the tunnel, using the same proxy resolution the search side uses (explicit
 *    option, then the environment, then the macOS system proxy);
 * 3. an optional headless-browser render, for a page whose bytes are a shell
 *    and whose text only appears after its scripts run. It runs before the
 *    extraction endpoint because it is local (no credential, no third-party
 *    request) and because `renderJs: 'always'` must actually mean a browser;
 * 4. AnySearch's extraction endpoint, when a key is configured — it renders the
 *    page server-side, so it also rescues a page that answers 403 to a bare
 *    request and remains the last resort when no browser is installed.
 *
 * Playwright is not a dependency and is never imported at module load: the
 * renderer is discovered by a guarded dynamic `import()` and its absence is
 * recorded in the result, never thrown.
 *
 * A non-2xx response is a result, not a failure, and a failure on one rung is
 * not fatal: the ladder only throws when every rung is unavailable or failed.
 * A render failure specifically keeps the earlier rung's page.
 *
 * @module @fangchenghao/dsh-web-search/fetch
 */
import { SearchError } from './errors.ts';
import { DEFAULT_FETCH_MAX_LENGTH, renderFetchText, truncateFetchText } from './markdown.ts';
import type { FetchFormat } from './markdown.ts';
import { proxyGet, resolveProxy } from './proxy.ts';
import {
  DEFAULT_RENDER_TIMEOUT_MS,
  describeRenderError,
  detectShellPage,
  loadPlaywrightRenderer,
  readableTextLength,
  redactRenderReason,
  renderWithPlaywright,
} from './render.ts';
import type {
  RenderMode,
  RenderReport,
  RenderedPage,
  RendererLoad,
  RendererModule,
} from './render.ts';

/** One retrieval outcome, mirroring the Host's `WebFetchResult`. */
export interface FetchOutcome {
  readonly url: string;
  readonly statusCode: number;
  readonly body: { readonly kind: 'html' | 'text'; readonly content: string };
  readonly truncated: boolean;
  /**
   * How the optional render rung decided, when this provider produced the
   * result. The Host ignores the extra field; it is here so a caller (and a
   * test) can see why a shell page was or was not rendered, including that
   * Playwright is absent.
   */
  readonly render?: RenderReport;
}

/** What `ctx.web.registerFetchProvider` expects. */
export interface FetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<FetchOutcome>;
}

/** Construction options for the provider. */
export interface FetchProviderOptions {
  /** Provider id, registered under `fetchProvider` in the Host config. */
  id?: string;
  /** Per-attempt deadline in milliseconds. */
  timeoutMs?: number;
  /** Explicit tunnel URL, overriding detection. Empty means detect. */
  proxy?: string;
  /** `false` disables the tunnel rung entirely. */
  useProxy?: boolean;
  /** AnySearch key; enables the extraction rung when present. */
  anysearchApiKey?: string;
  /** Bytes kept from a response; the Host applies its own cap too. */
  maxBytes?: number;
  /** Output style for an HTML body; `markdown` keeps structure. */
  /** Renderer, or a reader for it so a Settings edit applies without a remount. */
  format?: FetchFormat | (() => FetchFormat);
  /** Character budget for the returned text. */
  /** Character budget, or a reader for it. */
  maxLength?: number | (() => number);
  /**
   * Optional browser rendering: `auto` renders only a suspected shell page,
   * `always` renders every fetch, `off` never does. A reader keeps a Settings
   * edit live. Defaults to `auto`; without Playwright it silently does nothing.
   */
  renderJs?: RenderMode | (() => RenderMode);
  /** Browser-render deadline, or a reader for it. Defaults to 15000 ms. */
  renderTimeoutMs?: number | (() => number);
  /** User agent sent on every rung. */
  userAgent?: string;
}

/** Injected transports, so the ladder is testable without a network. */
export interface FetchDependencies {
  /** Direct request. */
  direct: (url: string, timeoutMs: number, signal: AbortSignal | undefined, userAgent: string, maxBytes: number) => Promise<FetchOutcome>;
  /** Tunnelled request. */
  tunnel: (url: string, proxy: string, timeoutMs: number, signal: AbortSignal | undefined, userAgent: string, maxBytes: number) => Promise<FetchOutcome>;
  /** AnySearch extraction. */
  extract: (url: string, apiKey: string, timeoutMs: number, signal: AbortSignal | undefined) => Promise<FetchOutcome>;
  /** Proxy discovery. */
  detectProxy: (explicit: string | undefined) => Promise<string | undefined>;
  /**
   * Load the optional renderer. The default dynamically imports Playwright and
   * reports absence instead of throwing; tests inject a fake here.
   */
  loadRenderer: () => Promise<RendererLoad>;
  /**
   * Render one page with a loaded renderer. The default is the real
   * headless-Chromium implementation; tests inject a fake browser.
   */
  render: (renderer: RendererModule, url: string, timeoutMs: number, signal: AbortSignal | undefined) => Promise<RenderedPage>;
}

/** Default user agent; kept in step with the search side. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** One mebibyte: enough for a documentation page, cheap enough to hold. */
const DEFAULT_MAX_BYTES = 1_048_576;

/** Deadline for the direct rung, which must not eat the tunnel's budget. */
const DIRECT_DEADLINE_MS = 5_000;

/** Default per-attempt deadline. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Pick the body kind from the content type, defaulting to text. */
function kindOf(contentType: string | null): 'html' | 'text' {
  if (contentType === null) return 'text';
  const value = contentType.toLowerCase();
  if (value.includes('html') || value.includes('xml')) return 'html';
  return 'text';
}

/**
 * Cut a body at the byte budget without splitting a surrogate pair.
 * @param text - the decoded body.
 * @param maxBytes - the byte budget.
 * @returns the body and whether it was cut.
 */
function clamp(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { content: text, truncated: false };
  return { content: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * Combine a caller signal with the per-attempt deadline.
 * @param timeoutMs - the deadline.
 * @param signal - the caller signal, when present.
 * @returns the signal to pass to `fetch`.
 */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}

/**
 * Turn a cancelled request into a rejection instead of a partial result.
 * @param signal - the caller signal that is already aborted.
 */
function abortFetch(signal: AbortSignal): never {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('The fetch was aborted', 'AbortError');
}

/** Direct request used by the first rung. */
async function directFetch(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  userAgent: string,
  maxBytes: number,
): Promise<FetchOutcome> {
  const response = await fetch(url, {
    signal: deadline(timeoutMs, signal),
    redirect: 'follow',
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
  });
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  const { content, truncated } = clamp(text, maxBytes);
  return { url: response.url === '' ? url : response.url, statusCode: response.status, body: { kind: kindOf(contentType), content }, truncated };
}

/** Tunnelled request used by the second rung. */
async function tunnelFetch(
  url: string,
  proxy: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  userAgent: string,
  maxBytes: number,
): Promise<FetchOutcome> {
  const response = await proxyGet(url, {
    proxy,
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  const { content, truncated } = clamp(response.text, maxBytes);
  return {
    url,
    statusCode: response.status,
    body: { kind: kindOf(response.headers?.['content-type'] ?? null), content },
    truncated,
  };
}

/** Server-side extraction used by the third rung. */
async function extractFetch(
  url: string,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const response = await fetch('https://api.anysearch.com/v1/extract', {
    method: 'POST',
    signal: deadline(timeoutMs, signal),
    headers: { 'user-agent': USER_AGENT, 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new SearchError(`anysearch extract: HTTP ${response.status}`, 'SEARCH_BLOCKED', true);
  const payload = (await response.json()) as { code?: number; message?: string; data?: { title?: string; content?: string } };
  if (payload.code !== 0 || typeof payload.data?.content !== 'string') {
    throw new SearchError(`anysearch extract: ${payload.message ?? 'no content'}`, 'SEARCH_BLOCKED', true);
  }
  const title = typeof payload.data.title === 'string' && payload.data.title.length > 0 ? `# ${payload.data.title}\n\n` : '';
  return { url, statusCode: 200, body: { kind: 'text', content: `${title}${payload.data.content}` }, truncated: false };
}

/**
 * Build the fetch provider.
 * @param options - timeouts, tunnel and extraction settings.
 * @param overrides - transport overrides, for tests.
 * @returns a provider suitable for `ctx.web.registerFetchProvider`.
 */
export function createFetchProvider(options: FetchProviderOptions = {}, overrides: Partial<FetchDependencies> = {}): FetchProvider {
  const deps: FetchDependencies = {
    direct: directFetch,
    tunnel: tunnelFetch,
    extract: extractFetch,
    detectProxy: (explicit) => resolveProxy(explicit),
    loadRenderer: loadPlaywrightRenderer,
    render: renderWithPlaywright,
    ...overrides,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? USER_AGENT;
  const apiKey = (options.anysearchApiKey ?? '').trim();
  /**
   * Resolve the two volatile Settings fields per request. Reading them here
   * rather than at construction is what lets a saved edit apply without a
   * remount; caching them made the Settings page lie.
   */
  const liveFormat = (): FetchFormat =>
    typeof options.format === 'function' ? options.format() : (options.format ?? 'markdown');
  const liveMaxLength = (): number => {
    const raw = typeof options.maxLength === 'function' ? options.maxLength() : options.maxLength;
    return raw ?? DEFAULT_FETCH_MAX_LENGTH;
  };
  /** `renderJs` is volatile too: read it per request, never at construction. */
  const liveRenderMode = (): RenderMode => {
    const raw = typeof options.renderJs === 'function' ? options.renderJs() : options.renderJs;
    return raw === 'always' || raw === 'off' ? raw : 'auto';
  };
  const liveRenderTimeout = (): number => {
    const raw = typeof options.renderTimeoutMs === 'function' ? options.renderTimeoutMs() : options.renderTimeoutMs;
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
      ? Math.floor(raw)
      : DEFAULT_RENDER_TIMEOUT_MS;
  };
  /**
   * Load the renderer at most once per provider. A missing package is a
   * supported deployment, and caching the verdict keeps a shell page from
   * paying a failed module resolution on every fetch; installing Playwright
   * later needs a plugin restart, which is the same rule the other imports
   * follow.
   */
  let rendererLoad: Promise<RendererLoad> | undefined;
  const loadRendererOnce = (): Promise<RendererLoad> => {
    if (rendererLoad === undefined) {
      rendererLoad = Promise.resolve()
        .then(() => deps.loadRenderer())
        .catch((error: unknown) => ({
          ok: false as const,
          reason: redactRenderReason(
            `the renderer could not be loaded (${error instanceof Error ? error.name : 'unknown error'})`,
          ),
        }));
    }
    return rendererLoad;
  };

  // Every rung funnels through here: an HTML body becomes Markdown (or plain
  // text), a text body keeps its content, and both obey the character budget.
  // The Host's own renderer then sees `kind: 'text'`, so it does not convert the
  // same page a second time. The render report rides along as an optional field.
  const finalize = (outcome: FetchOutcome, render: RenderReport): FetchOutcome => {
    const format = liveFormat();
    const maxLength = liveMaxLength();
    if (outcome.body.kind === 'html') {
      const rendered = renderFetchText(outcome.body.content, { format, maxLength, baseUrl: outcome.url });
      return {
        ...outcome,
        body: { kind: 'text', content: rendered.content },
        truncated: outcome.truncated || rendered.truncated,
        render,
      };
    }
    const limited = truncateFetchText(outcome.body.content, maxLength);
    return {
      ...outcome,
      body: { kind: 'text', content: limited.content },
      truncated: outcome.truncated || limited.truncated,
      render,
    };
  };

  return {
    id: options.id ?? 'http-proxy',
    available: () => true,
    async fetch(request, signal) {
      const target = request.url;
      if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
        throw new SearchError(`not an http(s) URL: ${String(target)}`, 'SEARCH_PARSE', false);
      }

      const failures: string[] = [];
      /** True once the caller cancelled; a cancellation must not be retried. */
      const cancelled = (): boolean => signal !== undefined && signal.aborted;
      /** Reject with the caller's own abort reason when they cancelled. */
      const stopIfCancelled = (): void => {
        if (signal !== undefined && signal.aborted) abortFetch(signal);
      };
      /** Best page from a transport rung, kept if rendering cannot improve it. */
      let fallback: FetchOutcome | undefined;
      /** The last render decision, attached to whatever result wins. */
      let lastReport: RenderReport | undefined;

      const makeReport = (
        mode: RenderMode,
        attempted: boolean,
        applied: boolean,
        reason: string,
      ): RenderReport => ({ mode, attempted, applied, reason: redactRenderReason(reason) });

      /**
       * Decide whether to render, and render when warranted.
       *
       * `done: false` means the ladder should continue to extraction while the
       * candidate stays as the fallback. A render never throws its own failure
       * into the ladder: only a caller cancellation, or an AbortError raised by
       * the renderer itself, rejects.
       */
      const renderStep = async (
        candidate: FetchOutcome | undefined,
      ): Promise<{ readonly done: boolean; readonly outcome?: FetchOutcome; readonly report: RenderReport }> => {
        const mode = liveRenderMode();
        if (mode === 'off') {
          return candidate === undefined
            ? { done: false, report: makeReport(mode, false, false, 'renderJs is off') }
            : { done: true, outcome: candidate, report: makeReport(mode, false, false, 'renderJs is off') };
        }
        if (candidate === undefined && mode === 'auto') {
          // `auto` needs a body to judge. When every transport failed there is
          // no shell verdict to make, so it must not launch a browser blindly.
          return { done: false, report: makeReport(mode, false, false, 'no page body to judge as a shell') };
        }
        if (candidate !== undefined && mode === 'auto') {
          const verdict = detectShellPage(candidate);
          if (!verdict.shell) {
            return { done: true, outcome: candidate, report: makeReport(mode, false, false, verdict.reason) };
          }
        }
        stopIfCancelled();

        const loaded = await loadRendererOnce();
        if (!loaded.ok) {
          // Silent skip: no banner, no thrown error, just a recorded reason.
          return { done: false, report: makeReport(mode, false, false, loaded.reason) };
        }

        try {
          const rendered = await deps.render(loaded.renderer, target, liveRenderTimeout(), signal);
          stopIfCancelled();
          if (rendered.html.trim().length === 0) {
            return {
              done: false,
              report: makeReport(mode, true, false, `${loaded.moduleName} returned an empty page`),
            };
          }
          const { content, truncated } = clamp(rendered.html, maxBytes);
          const outcome: FetchOutcome = {
            url: rendered.url.length > 0 ? rendered.url : target,
            statusCode: rendered.statusCode,
            body: { kind: 'html', content },
            truncated,
          };
          return {
            done: true,
            outcome,
            report: makeReport(
              mode,
              true,
              true,
              `${loaded.moduleName} rendered ${readableTextLength(rendered.html)} readable characters`,
            ),
          };
        } catch (error) {
          stopIfCancelled();
          const failure = describeRenderError(error, liveRenderTimeout());
          if (failure.aborted) {
            // Even without the caller's signal, the renderer's abort is a
            // cancellation rather than a page to fall back to.
            throw error instanceof Error ? error : new DOMException('The page render was aborted', 'AbortError');
          }
          // Timeout, launch failure, navigation failure: keep the earlier page.
          return { done: false, report: makeReport(mode, true, false, failure.reason) };
        }
      };

      /** Run the render step for a transport result; `undefined` means keep going. */
      const settle = async (candidate: FetchOutcome): Promise<FetchOutcome | undefined> => {
        const step = await renderStep(candidate);
        lastReport = step.report;
        if (step.done) return step.outcome ?? candidate;
        fallback = candidate;
        failures.push(`render: ${step.report.reason}`);
        stopIfCancelled();
        return undefined;
      };

      /** Report for a result that never reached the render step. */
      const reportFor = (): RenderReport =>
        lastReport ?? makeReport(liveRenderMode(), false, false, 'the render rung did not run');

      // A blocked host usually fails by timing out, so the direct rung gets a
      // shorter deadline than the tunnel: spending the whole budget on a request
      // that cannot work would leave the rung that can work with nothing.
      let direct: FetchOutcome | undefined;
      try {
        direct = await deps.direct(target, Math.min(timeoutMs, DIRECT_DEADLINE_MS), signal, userAgent, maxBytes);
      } catch (error) {
        if (cancelled()) throw error;
        failures.push(`direct: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (direct !== undefined) {
        const rendered = await settle(direct);
        if (rendered !== undefined) return finalize(rendered, reportFor());
      }

      let proxy: string | undefined;
      if (options.useProxy !== false) {
        try {
          proxy = options.proxy !== undefined && options.proxy.length > 0 ? options.proxy : await deps.detectProxy(options.proxy);
        } catch (error) {
          failures.push(`proxy: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (proxy !== undefined && proxy.length > 0) {
        let tunneled: FetchOutcome | undefined;
        try {
          tunneled = await deps.tunnel(target, proxy, timeoutMs, signal, userAgent, maxBytes);
        } catch (error) {
          if (cancelled()) throw error;
          failures.push(`tunnel: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (tunneled !== undefined) {
          const rendered = await settle(tunneled);
          if (rendered !== undefined) return finalize(rendered, reportFor());
        }
      }

      // `always` is also a standalone rescue: a transport that returns 403 or
      // times out may still answer a real browser, and there is no earlier page
      // to fall back to in that branch.
      if (fallback === undefined && liveRenderMode() === 'always') {
        const step = await renderStep(undefined);
        lastReport = step.report;
        if (step.done && step.outcome !== undefined) return finalize(step.outcome, step.report);
        if (!step.done) failures.push(`render: ${step.report.reason}`);
      }

      if (apiKey.length > 0) {
        try {
          const extracted = await deps.extract(target, apiKey, timeoutMs, signal);
          // Say where the body came from when the browser was tried first.
          const report = lastReport !== undefined && lastReport.attempted && !lastReport.applied
            ? makeReport(
              lastReport.mode,
              true,
              false,
              `${lastReport.reason}; the result came from AnySearch extraction`,
            )
            : reportFor();
          return finalize(extracted, report);
        } catch (error) {
          if (cancelled()) throw error;
          failures.push(`extract: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // A failed render is not a failed fetch: hand back the page an earlier
      // rung already produced, with the reason attached.
      if (fallback !== undefined) {
        const report = lastReport !== undefined && lastReport.attempted && !lastReport.applied
          ? makeReport(
            lastReport.mode,
            true,
            false,
            `${lastReport.reason}; the earlier rung's result was kept`,
          )
          : reportFor();
        return finalize(fallback, report);
      }

      throw new SearchError(`cannot fetch ${target} (${failures.join('; ')})`, 'SEARCH_NETWORK', true);
    },
  };
}
