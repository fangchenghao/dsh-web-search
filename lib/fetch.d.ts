import type { FetchFormat } from './markdown.ts';
import type { RenderMode, RenderReport, RenderedPage, RendererLoad, RendererModule } from './render.ts';
/** One retrieval outcome, mirroring the Host's `WebFetchResult`. */
export interface FetchOutcome {
    readonly url: string;
    readonly statusCode: number;
    readonly body: {
        readonly kind: 'html' | 'text' | 'binary';
        readonly content: string;
    };
    readonly truncated: boolean;
    /** The response's mime type, kept so a rejection can name what it refused. */
    readonly contentType?: string;
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
    fetch(request: {
        readonly url: string;
    }, signal?: AbortSignal): Promise<FetchOutcome>;
}
/** Construction options for the provider. */
export interface FetchProviderOptions {
    /** Provider id, registered under `fetchProvider` in the Host config. */
    id?: string;
    /** Per-attempt deadline in milliseconds. */
    timeoutMs?: number;
    /** Budget for the whole ladder; later rungs get only what is left. */
    overallMs?: number;
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
/**
 * Find the target of an HTML-level redirect.
 *
 * Some documentation sites keep old URLs alive with a page whose only content
 * is `<meta http-equiv="refresh">` plus a JavaScript `location.replace`. The
 * HTTP status is 200, so `fetch` reports success and the model receives a page
 * that says "Redirecting…" and nothing else. PyTorch's `stable` docs do this
 * for every moved page. Following the declaration once turns that into the page
 * the browser would have shown.
 *
 * Only an explicit `<meta refresh>` or a page whose `<title>` says it is a
 * redirect is followed. A normal page that happens to mention `location.href`
 * in a script is left alone.
 * @param html - raw HTML body.
 * @param baseUrl - URL the body came from, for resolving relative targets.
 * @returns absolute target URL, or `undefined` when this is a normal page.
 */
export declare function documentRedirect(html: string, baseUrl: string): string | undefined;
/**
 * Direct request used by the first rung.
 *
 * Follows up to {@link REDIRECT_HOPS} HTML-level redirects inside the same
 * deadline, which is what makes a moved docs URL readable instead of a page
 * that only says "Redirecting…".
 */
export declare function directFetch(url: string, timeoutMs: number, signal: AbortSignal | undefined, userAgent: string, maxBytes: number): Promise<FetchOutcome>;
/**
 * Build the fetch provider.
 * @param options - timeouts, tunnel and extraction settings.
 * @param overrides - transport overrides, for tests.
 * @returns a provider suitable for `ctx.web.registerFetchProvider`.
 */
export declare function createFetchProvider(options?: FetchProviderOptions, overrides?: Partial<FetchDependencies>): FetchProvider;
