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
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/** Default browser-render deadline, in milliseconds. */
export const DEFAULT_RENDER_TIMEOUT_MS = 15_000;
/** Extra time allowed for `networkidle` after the DOM is ready. */
export const NETWORK_IDLE_EXTRA_MS = 2_000;
/** Below this many readable characters an HTML page is treated as a shell. */
export const SHELL_READABLE_LIMIT = 500;
/** With a client-render marker, the shell limit rises to this many characters. */
export const SHELL_MARKER_READABLE_LIMIT = 1_200;
/**
 * Markers that only occur on pages whose content is mounted by JavaScript.
 * They are lower-cased because the haystack is lower-cased once.
 */
const SHELL_MARKERS = [
    '__next_data__',
    'id="root"',
    "id='root'",
    'id="app"',
    "id='app'",
    'id="__next"',
    "id='__next'",
    '__nuxt__',
    'ng-version=',
    'data-reactroot',
];
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
export function readableTextLength(html) {
    if (html.length === 0)
        return 0;
    return html
        .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
        .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*$/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;
}
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
export function detectShellPage(page) {
    if (page.body.kind !== 'html') {
        return { shell: false, readableChars: 0, reason: 'the body is not HTML' };
    }
    const readable = readableTextLength(page.body.content);
    const status = page.statusCode;
    const renderableStatus = (status >= 200 && status < 300) || status === 403 || status === 429;
    if (!renderableStatus) {
        return { shell: false, readableChars: readable, reason: `HTTP ${status} is an error response, not a page shell` };
    }
    if (readable === 0) {
        return { shell: true, readableChars: 0, reason: 'the HTML carries no readable text' };
    }
    if (status === 403 || status === 429) {
        return {
            shell: true,
            readableChars: readable,
            reason: `HTTP ${status} still answered with ${readable} readable characters`,
        };
    }
    if (readable < SHELL_READABLE_LIMIT) {
        return {
            shell: true,
            readableChars: readable,
            reason: `only ${readable} readable characters, below the ${SHELL_READABLE_LIMIT}-character shell limit`,
        };
    }
    if (readable < SHELL_MARKER_READABLE_LIMIT) {
        const haystack = page.body.content.toLowerCase();
        const marker = SHELL_MARKERS.find((candidate) => haystack.includes(candidate));
        if (marker !== undefined) {
            return {
                shell: true,
                readableChars: readable,
                reason: `${readable} readable characters with the client-render marker ${marker}`,
            };
        }
    }
    return { shell: false, readableChars: readable, reason: `${readable} readable characters look like real content` };
}
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
export function redactRenderReason(text) {
    const redacted = text
        .replace(/https?:\/\/[^\s]*/gi, (url) => url.replace(/[?#].*$/, '?[redacted]'))
        .replace(/\/\/[^/\s@]+@/g, '//[redacted]@')
        .replace(/\b(token|api[-_]?key|secret|password|passwd|authorization|cookie)\s*=\s*[^\s&;,]+/gi, '$1=[redacted]')
        .replace(/\s+/g, ' ')
        .trim();
    return redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted;
}
/** The module names tried, in order; `playwright-core` is the smaller install. */
const PLAYWRIGHT_MODULES = ['playwright', 'playwright-core'];
/**
 * Read an imported module's `chromium.launch`, accepting a default export.
 * @param loaded - whatever `import()` returned.
 * @returns the module surface, or `undefined` when it is not a renderer.
 */
function pickRendererModule(loaded) {
    if (loaded === null || typeof loaded !== 'object')
        return undefined;
    const record = loaded;
    for (const candidate of [record, record.default]) {
        if (candidate === null || typeof candidate !== 'object')
            continue;
        const chromium = candidate.chromium;
        if (chromium !== undefined && typeof chromium.launch === 'function') {
            return candidate;
        }
    }
    return undefined;
}
/**
 * Why an `import()` failed, without echoing a path or a message.
 * @param error - the thrown value.
 * @returns `not installed` for a missing package, otherwise the error name.
 */
function importFailure(error) {
    if (error !== null
        && typeof error === 'object'
        && error.code === 'ERR_MODULE_NOT_FOUND') {
        return 'not installed';
    }
    return error instanceof Error ? error.name : 'import failed';
}
/**
 * Try `playwright`, then `playwright-core`.
 *
 * Both imports are guarded: a missing package is a supported deployment and
 * yields `{ ok: false }` with a reason, never a thrown error. Nothing is cached
 * here; the fetch provider caches the verdict for its own lifetime.
 *
 * @returns the renderer module, or the reason neither could be loaded.
 */
export async function loadPlaywrightRenderer() {
    const failures = [];
    // The specifier is a variable on purpose: TypeScript must not try to resolve
    // an optional package that is absent by design, and the import stays dynamic.
    for (const moduleName of PLAYWRIGHT_MODULES) {
        try {
            const loaded = await import(__rewriteRelativeImportExtension(moduleName));
            const renderer = pickRendererModule(loaded);
            if (renderer !== undefined)
                return { ok: true, renderer, moduleName };
            failures.push(`${moduleName}: no chromium.launch export`);
        }
        catch (error) {
            failures.push(`${moduleName}: ${importFailure(error)}`);
        }
    }
    return {
        ok: false,
        reason: redactRenderReason(`no JS renderer is installed (${failures.join('; ')})`),
    };
}
/** The abort rejection this module uses, matching `fetch`'s convention. */
function abortError() {
    return new DOMException('The page render was aborted', 'AbortError');
}
/**
 * Read an optional signal without letting control-flow narrowing lie.
 *
 * The first check throws, after which TypeScript narrows `signal.aborted` to
 * `false` for the rest of the function; an await can still change it in reality,
 * so every later check goes through this function.
 */
function isAborted(signal) {
    return signal !== undefined && signal.aborted;
}
/** Close a handle without letting cleanup mask the render's real outcome. */
async function closeQuietly(target) {
    if (target === undefined)
        return;
    try {
        await target.close();
    }
    catch {
        // A close that fails is not the interesting failure.
    }
}
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
export async function renderWithPlaywright(renderer, url, timeoutMs, signal) {
    if (isAborted(signal))
        throw abortError();
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : DEFAULT_RENDER_TIMEOUT_MS;
    let browser;
    let page;
    let resolveAbort;
    const aborted = new Promise((resolve) => {
        resolveAbort = resolve;
    });
    const onAbort = () => {
        resolveAbort?.();
        // Requirement, not optimisation: a cancelled render must not keep a
        // browser or a page alive while the caller has already moved on.
        void closeQuietly(page);
        void closeQuietly(browser);
    };
    let listening = false;
    if (signal !== undefined) {
        if (signal.aborted) {
            onAbort();
        }
        else {
            signal.addEventListener('abort', onAbort, { once: true });
            listening = true;
        }
    }
    try {
        const launching = renderer.chromium.launch({ headless: true });
        const winner = await Promise.race([
            launching.then((value) => ({ browser: value })),
            aborted.then(() => ({ browser: undefined })),
        ]);
        if (winner.browser === undefined) {
            // The launch may still complete after the caller is gone; close it then.
            void launching.then((late) => closeQuietly(late)).catch(() => undefined);
            throw abortError();
        }
        browser = winner.browser;
        if (isAborted(signal))
            throw abortError();
        page = await browser.newPage();
        if (isAborted(signal))
            throw abortError();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: budget });
        const idleBudget = Math.min(NETWORK_IDLE_EXTRA_MS, budget);
        try {
            await page.waitForLoadState('networkidle', { timeout: idleBudget });
        }
        catch {
            // A page that never goes idle still has a DOM; carry on.
        }
        if (isAborted(signal))
            throw abortError();
        const html = await page.content();
        if (isAborted(signal))
            throw abortError();
        return {
            html,
            statusCode: response === null ? 200 : response.status(),
            url: page.url(),
        };
    }
    finally {
        if (listening && signal !== undefined)
            signal.removeEventListener('abort', onAbort);
        await closeQuietly(page);
        await closeQuietly(browser);
    }
}
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
export function describeRenderError(error, timeoutMs) {
    const name = error instanceof Error ? error.name : 'unknown error';
    if (name === 'AbortError')
        return { reason: 'the render was aborted', aborted: true };
    const message = error instanceof Error ? error.message : '';
    if (name === 'TimeoutError' || /timeout|timed out/i.test(message)) {
        return { reason: `the render timed out after ${timeoutMs} ms`, aborted: false };
    }
    return { reason: `the render failed (${name})`, aborted: false };
}
