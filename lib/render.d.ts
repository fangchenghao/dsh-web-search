/**
 * The optional JavaScript-rendering half of `web_fetch`.
 *
 * Some pages answer a bare request with a shell: a framework marker, a mount
 * point and a few hundred characters of navigation, while the article appears
 * only after the page's own scripts run. No amount of proxy tuning fixes that,
 * because the bytes are correct and the browser work is simply missing.
 *
 * A real browser can do that work, but Playwright is a large optional install
 * and a hard dependency would make this plugin fail to load wherever it is
 * absent. So the renderer is discovered at runtime, by a guarded dynamic
 * `import()`, and never named in `package.json`. Nothing here runs at module
 * load: importing this file is always safe.
 *
 * The renderer's surface is declared structurally rather than imported from
 * Playwright's types, so this module compiles and runs with the package
 * missing. Tests inject the same shapes with plain objects.
 *
 * @module @fangchenghao/dsh-web-search/render
 */
/** What the user asked for in `renderJs`. */
export type RenderMode = 'auto' | 'always' | 'off';
/** What one fetch reports about the optional render rung. */
export interface RenderReport {
    /** The mode the request resolved to. */
    readonly mode: RenderMode;
    /** Whether a browser launch was tried. */
    readonly attempted: boolean;
    /** Whether the returned body came from the browser. */
    readonly applied: boolean;
    /** Safe, content-free explanation for the decision. */
    readonly reason: string;
}
/** Default browser-render deadline, in milliseconds. */
export declare const DEFAULT_RENDER_TIMEOUT_MS = 15000;
/** Extra time allowed for `networkidle` after the DOM is ready. */
export declare const NETWORK_IDLE_EXTRA_MS = 2000;
/** Below this many readable characters an HTML page is treated as a shell. */
export declare const SHELL_READABLE_LIMIT = 500;
/** With a client-render marker, the shell limit rises to this many characters. */
export declare const SHELL_MARKER_READABLE_LIMIT = 1200;
/** The parts of a page the shell heuristic looks at. */
export interface ShellInput {
    readonly statusCode: number;
    readonly body: {
        readonly kind: 'html' | 'text' | 'binary';
        readonly content: string;
    };
}
/** A shell decision plus the numbers and reason behind it. */
export interface ShellVerdict {
    /** Whether a browser render is worth attempting. */
    readonly shell: boolean;
    /** Characters of visible text, tags and script bodies removed. */
    readonly readableChars: number;
    /** Short, content-free explanation, safe to surface in a report. */
    readonly reason: string;
}
/** The page handle this module needs; Playwright's `Page` satisfies it. */
export interface RendererPage {
    goto(url: string, options: {
        readonly waitUntil: 'domcontentloaded';
        readonly timeout: number;
    }): Promise<{
        status(): number;
    } | null>;
    waitForLoadState(state: 'networkidle', options: {
        readonly timeout: number;
    }): Promise<unknown>;
    content(): Promise<string>;
    url(): string;
    close(): Promise<unknown>;
}
/** The browser handle this module needs; Playwright's `Browser` satisfies it. */
export interface RendererBrowser {
    newPage(): Promise<RendererPage>;
    close(): Promise<unknown>;
}
/** The module surface this module needs; `playwright` satisfies it. */
export interface RendererModule {
    readonly chromium: {
        launch(options: {
            readonly headless: boolean;
        }): Promise<RendererBrowser>;
    };
}
/** Result of the guarded dynamic import. */
export type RendererLoad = {
    readonly ok: true;
    readonly renderer: RendererModule;
    readonly moduleName: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** What one successful render hands back. */
export interface RenderedPage {
    /** Serialised DOM, after its scripts have run. */
    readonly html: string;
    /** HTTP status of the main navigation, or 200 when there was no response. */
    readonly statusCode: number;
    /** Final URL after redirects. */
    readonly url: string;
}
/**
 * Approximate the visible text of an HTML document.
 *
 * The browser is not available at this point (that is the whole question), so
 * this is deliberately a heuristic: drop `head`, script/style/template bodies,
 * comments and tags, then count the characters that remain. It never throws on
 * malformed markup because it only strips.
 *
 * @param html - the document markup.
 * @returns the number of visible characters.
 */
export declare function readableTextLength(html: string): number;
/**
 * Decide whether a fetched page is probably a script-rendered shell.
 *
 * The rules, in order:
 * 1. a body that is not HTML is never a shell (JSON and plain text are final);
 * 2. an HTML body with no readable text is a shell;
 * 3. a 403/429 that still carries readable text is a block page a browser may
 *    get past, so it is a shell;
 * 4. fewer than {@link SHELL_READABLE_LIMIT} readable characters is a shell;
 * 5. below {@link SHELL_MARKER_READABLE_LIMIT} with a client-render marker
 *    (`__NEXT_DATA__`, `id="root"`, `__NUXT__`, …) is a shell.
 *
 * A non-2xx other than 403/429 is an error page, not a shell: rendering it
 * would only repeat the error more slowly.
 *
 * @param page - status and body of the best outcome so far.
 * @returns the verdict, including the readable length and a safe reason.
 */
export declare function detectShellPage(page: ShellInput): ShellVerdict;
/**
 * Scrub a diagnostic string before it leaves this module.
 *
 * Render errors can carry a target URL (and therefore a token in its query) or
 * a credential-looking assignment. None of that belongs in a tool result, so
 * query strings are blanked, credential keys are redacted and the text is
 * capped. The renderer's own message is never interpolated by callers, which
 * is the stronger guard; this is the second one.
 *
 * @param text - the raw diagnostic.
 * @returns a single-line, redacted, bounded string.
 */
export declare function redactRenderReason(text: string): string;
/**
 * Try `playwright`, then `playwright-core`.
 *
 * Both imports are guarded: a missing package is a supported deployment and
 * yields `{ ok: false }` with a reason, never a thrown error. Nothing is cached
 * here; the fetch provider caches the verdict for its own lifetime.
 *
 * @returns the renderer module, or the reason neither could be loaded.
 */
export declare function loadPlaywrightRenderer(): Promise<RendererLoad>;
/**
 * Render one URL in a headless Chromium and return its serialised DOM.
 *
 * Shape of the attempt: launch, navigate with `domcontentloaded` under the
 * configured budget, give `networkidle` at most {@link NETWORK_IDLE_EXTRA_MS}
 * more (a page that never idles is not an error), then read `content()`.
 *
 * Both the page and the browser are closed in `finally` on every path. An
 * abortion closes them immediately through one listener and rejects with an
 * `AbortError`; a launch that is still in flight when the caller aborts is
 * closed as soon as it resolves, so a cancelled fetch cannot leave a browser
 * behind.
 *
 * @param renderer - a loaded Playwright-shaped module.
 * @param url - the page to open.
 * @param timeoutMs - navigation deadline in milliseconds.
 * @param signal - the caller's cancellation signal, when present.
 * @returns the rendered page.
 */
export declare function renderWithPlaywright(renderer: RendererModule, url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RenderedPage>;
/**
 * Classify a render failure without echoing its message.
 *
 * The message can contain the target URL, a selector, or page text, so only
 * the error *name* is used. A timeout is recognised by name or by the word in
 * the message and reported with the configured budget.
 *
 * @param error - the thrown value.
 * @param timeoutMs - the budget the render was given.
 * @returns a safe reason and whether the renderer reported an abort.
 */
export declare function describeRenderError(error: unknown, timeoutMs: number): {
    readonly reason: string;
    readonly aborted: boolean;
};
