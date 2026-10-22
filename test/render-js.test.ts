/**
 * The optional JavaScript-rendering rung.
 *
 * Playwright is not a dependency of this plugin, so no test here may need it:
 * the loader and the browser are both injected. What is exercised is the
 * decision (off / auto / always, shell heuristic), the failure policy (a render
 * failure keeps the earlier page), cancellation and cleanup, and the Markdown
 * budget applied to what the browser returns. The real `renderWithPlaywright`
 * driver is run against a fake Playwright-shaped module so its `finally` blocks
 * and abort handling are proven without a download.
 *
 * @module dsh-web-search-bing/test/render-js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchProvider } from '../src/fetch.ts';
import type { FetchDependencies, FetchOutcome } from '../src/fetch.ts';
import { renderFetchText } from '../src/markdown.ts';
import {
  detectShellPage,
  loadPlaywrightRenderer,
  readableTextLength,
  renderWithPlaywright,
  SHELL_READABLE_LIMIT,
} from '../src/render.ts';
import type { RenderMode, RendererBrowser, RendererModule, RendererPage } from '../src/render.ts';

/** The URL every fake transport answers. */
const TARGET = 'https://docs.example.com/app';

/** A page whose only content is a mount point and a loading note. */
const SHELL_HTML = '<html><head><title>App</title></head><body><div id="root"></div>'
  + '<noscript>Loading the application…</noscript><p>Loading the application…</p>'
  + '<script src="/app.js"></script></body></html>';

/** A page with plenty of readable text and no client-render marker. */
const RICH_HTML = `<html><body><article><h1>Long article</h1><p>${'word '.repeat(200)}</p></article></body></html>`;

/** What the browser returns for a shell page: the article the scripts fetched. */
const RENDERED_HTML = `<html><body><article><h1>Rendered title</h1><p>${'rendered '.repeat(100)}</p></article></body></html>`;

/** A renderer stand-in that is never launched by injected `render` fakes. */
const FAKE_RENDERER: RendererModule = {
  chromium: { launch: () => Promise.reject(new Error('the fake renderer must not launch')) },
};

/** Build one outcome from markup. */
function outcome(content: string, statusCode = 200, kind: 'html' | 'text' = 'html'): FetchOutcome {
  return { url: TARGET, statusCode, body: { kind, content }, truncated: false };
}

/** Transport rungs that succeed at `direct` and must not reach the others. */
function directOnly(result: FetchOutcome): Pick<FetchDependencies, 'direct' | 'tunnel' | 'extract' | 'detectProxy'> {
  return {
    direct: () => Promise.resolve(result),
    tunnel: () => Promise.reject(new Error('tunnel must not run')),
    extract: () => Promise.reject(new Error('extract must not run')),
    detectProxy: () => Promise.resolve(undefined),
  };
}

/** The expected Markdown for a page, so fallback bodies are asserted exactly. */
function expectedMarkdown(html: string): string {
  return renderFetchText(html, { format: 'markdown', maxLength: 20000, baseUrl: TARGET }).content;
}

/** A loader that reports the package as absent. */
function missingLoader(): () => Promise<{ ok: false; reason: string }> {
  return () => Promise.resolve({
    ok: false,
    reason: 'no JS renderer is installed (playwright: not installed; playwright-core: not installed)',
  });
}

/** A loader that hands over the fake renderer. */
function fakeLoader(calls: string[] = []): () => Promise<{ ok: true; renderer: RendererModule; moduleName: string }> {
  return () => {
    calls.push('load');
    return Promise.resolve({ ok: true, renderer: FAKE_RENDERER, moduleName: 'fake-playwright' });
  };
}

/** A Playwright-shaped module that records navigation and cleanup. */
function recordingRenderer(timeoutNote: { idle?: number } = {}): {
  module: RendererModule;
  log: { goto: { url: string; waitUntil: string; timeout: number }[]; contentCalls: number; pageClosed: boolean; browserClosed: boolean };
} {
  const log = {
    goto: [] as { url: string; waitUntil: string; timeout: number }[],
    contentCalls: 0,
    pageClosed: false,
    browserClosed: false,
  };
  const page: RendererPage = {
    goto: (url, options) => {
      log.goto.push({ url, waitUntil: options.waitUntil, timeout: options.timeout });
      return Promise.resolve({ status: () => 200 });
    },
    waitForLoadState: (_state, options) => {
      log.contentCalls += 0;
      if (timeoutNote !== undefined) timeoutNote.idle = options.timeout;
      return Promise.resolve();
    },
    content: () => {
      log.contentCalls += 1;
      return Promise.resolve('<html><body>ready</body></html>');
    },
    url: () => 'https://docs.example.com/final',
    close: () => {
      log.pageClosed = true;
      return Promise.resolve();
    },
  };
  const browser: RendererBrowser = {
    newPage: () => Promise.resolve(page),
    close: () => {
      log.browserClosed = true;
      return Promise.resolve();
    },
  };
  return {
    module: { chromium: { launch: () => Promise.resolve(browser) } },
    log,
  };
}

// ---------------------------------------------------------------------------
// Decision policy
// ---------------------------------------------------------------------------

test('renderJs=off never loads or calls a renderer, even for a shell page', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'off' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: () => {
        calls.push('load');
        return Promise.resolve({ ok: false, reason: 'must not load' });
      },
      render: () => {
        calls.push('render');
        return Promise.reject(new Error('must not render'));
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, []);
  assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  assert.equal(result.render?.mode, 'off');
  assert.equal(result.render?.attempted, false);
  assert.equal(result.render?.applied, false);
  assert.equal(result.render?.reason, 'renderJs is off');
});

test('auto leaves a page with real content alone', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(RICH_HTML)),
      loadRenderer: fakeLoader(calls),
      render: () => {
        calls.push('render');
        return Promise.reject(new Error('must not render'));
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, []);
  assert.equal(result.body.content, expectedMarkdown(RICH_HTML));
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /readable characters look like real content/);
});

test('auto renders a shell page and converts the browser DOM to Markdown', async () => {
  const calls: string[] = [];
  const seen: { url: string; timeout: number }[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(calls),
      render: (_renderer, url, timeout) => {
        calls.push('render');
        seen.push({ url, timeout });
        return Promise.resolve({ html: RENDERED_HTML, statusCode: 200, url: 'https://docs.example.com/final' });
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, ['load', 'render']);
  assert.deepEqual(seen, [{ url: TARGET, timeout: 15000 }]);
  assert.equal(result.url, 'https://docs.example.com/final');
  assert.equal(result.body.kind, 'text');
  assert.ok(result.body.content.startsWith('# Rendered title\n\n'));
  assert.ok(result.body.content.includes('rendered rendered'));
  assert.equal(result.render?.attempted, true);
  assert.equal(result.render?.applied, true);
  assert.match(result.render?.reason ?? '', /fake-playwright rendered \d+ readable characters/);
});

test('always renders even a page that looks complete', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'always' },
    {
      ...directOnly(outcome(RICH_HTML)),
      loadRenderer: fakeLoader(calls),
      render: () => {
        calls.push('render');
        return Promise.resolve({ html: RENDERED_HTML, statusCode: 200, url: TARGET });
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, ['load', 'render']);
  assert.ok(result.body.content.startsWith('# Rendered title'));
  assert.equal(result.render?.mode, 'always');
  assert.equal(result.render?.applied, true);
});

test('always renders a non-HTML body too, because the mode is unconditional', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'always' },
    {
      ...directOnly(outcome('{"ok":true}', 200, 'text')),
      loadRenderer: fakeLoader(calls),
      render: () => {
        calls.push('render');
        return Promise.resolve({ html: '<html><body><p>Browser view</p></body></html>', statusCode: 200, url: TARGET });
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, ['load', 'render']);
  assert.equal(result.body.content, 'Browser view');
  assert.equal(result.render?.applied, true);
});

test('auto does not render an ordinary 404 error page', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome('<html><body><p>Not found</p></body></html>', 404)),
      loadRenderer: fakeLoader(calls),
      render: () => {
        calls.push('render');
        return Promise.reject(new Error('must not render'));
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, []);
  assert.equal(result.statusCode, 404);
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /HTTP 404 is an error response/);
});

test('auto does render a 403 block page that still carries readable text', async () => {
  const calls: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome('<html><body><p>Please verify you are human.</p></body></html>', 403)),
      loadRenderer: fakeLoader(calls),
      render: () => {
        calls.push('render');
        return Promise.resolve({ html: RENDERED_HTML, statusCode: 200, url: TARGET });
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(calls, ['load', 'render']);
  assert.equal(result.render?.applied, true);
  assert.ok(result.body.content.startsWith('# Rendered title'));
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

test('a missing renderer is skipped silently and the earlier page is returned', async () => {
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: missingLoader(),
      render: () => Promise.reject(new Error('must not render')),
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  assert.equal(result.render?.attempted, false);
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /^no JS renderer is installed/);
  assert.match(result.render?.reason ?? '', /playwright/);
});

test('a loader that throws is caught, cached and never leaks its message', async () => {
  let loads = 0;
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: () => {
        loads += 1;
        throw new Error('secret-token-abc123 exploded');
      },
      render: () => Promise.reject(new Error('must not render')),
    },
  );
  const first = await provider.fetch({ url: TARGET });
  const second = await provider.fetch({ url: TARGET });
  assert.equal(loads, 1, 'the failed load is cached for the provider lifetime');
  for (const result of [first, second]) {
    assert.equal(result.render?.attempted, false);
    assert.match(result.render?.reason ?? '', /the renderer could not be loaded \(Error\)/);
    assert.ok(!(result.render?.reason ?? '').includes('secret-token-abc123'));
    assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  }
});

test('a render timeout falls back to the earlier page and names the budget', async () => {
  const seen: number[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto', renderTimeoutMs: 2500 },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: (_renderer, _url, timeout) => {
        seen.push(timeout);
        return Promise.reject(new DOMException('deadline reached', 'TimeoutError'));
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(seen, [2500]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  assert.equal(result.render?.attempted, true);
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /the render timed out after 2500 ms/);
  assert.ok(!(result.render?.reason ?? '').includes('deadline reached'));
});

test('an empty browser document is not accepted as the page', async () => {
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: () => Promise.resolve({ html: '   \n  ', statusCode: 200, url: TARGET }),
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /returned an empty page/);
});

test('a render failure after extraction was not needed keeps the transport page', async () => {
  const failures: string[] = [];
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: () => Promise.reject(new Error('Target crashed')),
      extract: () => {
        failures.push('extract');
        return Promise.reject(new Error('extract must not run'));
      },
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.deepEqual(failures, []);
  assert.equal(result.body.content, expectedMarkdown(SHELL_HTML));
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /the render failed \(Error\); the earlier rung's result was kept/);
});

test('a failed render can still be rescued by extraction, and says so', async () => {
  const provider = createFetchProvider(
    { renderJs: 'auto', anysearchApiKey: 'test-key' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: () => Promise.reject(new Error('Target crashed')),
      extract: () => Promise.resolve({
        url: TARGET,
        statusCode: 200,
        body: { kind: 'text', content: '# Extracted article\n\nBody from the server.' },
        truncated: false,
      }),
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.match(result.body.content, /^# Extracted article/);
  assert.equal(result.render?.applied, false);
  assert.match(result.render?.reason ?? '', /the result came from AnySearch extraction/);
});

test('render diagnostics never contain a secret from an error or a URL', async () => {
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: () => Promise.resolve({
        ok: false,
        reason: 'no renderer at https://user:pass@example.com/x?token=SECRETVALUE#frag; api_key=SECOND',
      }),
      render: () => Promise.reject(
        new Error('secret-token-abc123 https://user:pass@example.com/x?token=SECRETVALUE'),
      ),
    },
  );
  const result = await provider.fetch({ url: TARGET });
  const serialised = JSON.stringify(result);
  for (const secret of ['SECRETVALUE', 'SECOND', 'secret-token-abc123', 'user:pass']) {
    assert.ok(!serialised.includes(secret), `the result leaked ${secret}: ${result.render?.reason}`);
  }
  assert.match(result.render?.reason ?? '', /\[redacted\]/);
});

// ---------------------------------------------------------------------------
// Live configuration
// ---------------------------------------------------------------------------

test('renderJs and renderTimeoutMs are read per request, not at construction', async () => {
  let mode: RenderMode = 'off';
  let timeout = 15000;
  const loads: string[] = [];
  const seen: number[] = [];
  const provider = createFetchProvider(
    { renderJs: () => mode, renderTimeoutMs: () => timeout },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(loads),
      render: (_renderer, _url, budget) => {
        seen.push(budget);
        return Promise.resolve({ html: RENDERED_HTML, statusCode: 200, url: TARGET });
      },
    },
  );

  const off = await provider.fetch({ url: TARGET });
  assert.equal(off.render?.mode, 'off');
  assert.deepEqual(loads, []);

  mode = 'auto';
  timeout = 4321;
  const auto = await provider.fetch({ url: TARGET });
  assert.deepEqual(loads, ['load']);
  assert.deepEqual(seen, [4321]);
  assert.equal(auto.render?.mode, 'auto');
  assert.equal(auto.render?.applied, true);
});

// ---------------------------------------------------------------------------
// Shell heuristic
// ---------------------------------------------------------------------------

test('readable text ignores head, scripts, styles and comments', () => {
  const html = '<html><head><title>Hidden title</title><script>var leak = 1;</script></head>'
    + '<body><!-- comment --><style>.x{color:red}</style><p>Hi</p></body></html>';
  assert.equal(readableTextLength(html), 2);
  assert.equal(readableTextLength(''), 0);
});

test('the shell heuristic uses readable length, markers, 403/429 and skips error pages', () => {
  const verdict = (html: string, statusCode = 200, kind: 'html' | 'text' = 'html') =>
    detectShellPage({ statusCode, body: { kind, content: html } });

  const below = verdict(`<html><body><p>${'x'.repeat(SHELL_READABLE_LIMIT - 1)}</p></body></html>`);
  assert.equal(below.shell, true);
  assert.equal(below.readableChars, SHELL_READABLE_LIMIT - 1);
  assert.match(below.reason, /below the 500-character shell limit/);

  const markerShort = verdict(`<html><body><div id="root"></div><p>${'y'.repeat(700)}</p></body></html>`);
  assert.equal(markerShort.shell, true);
  assert.match(markerShort.reason, /client-render marker id="root"/);

  const markerLong = verdict(`<html><body><div id="root"></div><p>${'y'.repeat(1300)}</p></body></html>`);
  assert.equal(markerLong.shell, false);

  const rich = verdict(`<html><body><article><p>${'word '.repeat(200)}</p></article></body></html>`);
  assert.equal(rich.shell, false);
  assert.match(rich.reason, /look like real content/);

  assert.equal(verdict('<html><body></body></html>').shell, true);
  assert.equal(verdict('<html><body><p>Checking your browser…</p></body></html>', 403).shell, true);
  assert.equal(verdict('<html><body><p>Checking your browser…</p></body></html>', 429).shell, true);
  assert.equal(verdict('<html><body><p>Not found</p></body></html>', 404).shell, false);
  assert.equal(verdict('{"ok":true}', 200, 'text').shell, false);
});

// ---------------------------------------------------------------------------
// The real driver, against a Playwright-shaped fake module
// ---------------------------------------------------------------------------

test('renderWithPlaywright navigates, waits at most 2 s for idle, reads content and closes both handles', async () => {
  const idle: { idle?: number } = {};
  const { module, log } = recordingRenderer(idle);
  const rendered = await renderWithPlaywright(module, 'https://docs.example.com/start', 15000, undefined);
  assert.deepEqual(rendered, {
    html: '<html><body>ready</body></html>',
    statusCode: 200,
    url: 'https://docs.example.com/final',
  });
  assert.deepEqual(log.goto, [{ url: 'https://docs.example.com/start', waitUntil: 'domcontentloaded', timeout: 15000 }]);
  assert.equal(idle.idle, 2000, 'networkidle gets at most two extra seconds');
  assert.equal(log.contentCalls, 1);
  assert.equal(log.pageClosed, true);
  assert.equal(log.browserClosed, true);
});

test('renderWithPlaywright never lets the idle wait exceed the configured budget', async () => {
  const idle: { idle?: number } = {};
  const { module, log } = recordingRenderer(idle);
  await renderWithPlaywright(module, 'https://docs.example.com/start', 1200, undefined);
  assert.equal(log.goto[0]?.timeout, 1200);
  assert.equal(idle.idle, 1200);
});

test('renderWithPlaywright closes page and browser as soon as the signal aborts', async () => {
  let rejectGoto: ((reason: unknown) => void) | undefined;
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const log = { pageClosed: false, browserClosed: false };
  const page: RendererPage = {
    goto: () => new Promise((_resolve, reject) => {
      rejectGoto = reject;
    }),
    waitForLoadState: () => Promise.resolve(),
    content: () => Promise.resolve('<html></html>'),
    url: () => 'https://docs.example.com/slow',
    close: () => {
      log.pageClosed = true;
      rejectGoto?.(new DOMException('closed by abort', 'AbortError'));
      return Promise.resolve();
    },
  };
  const browser: RendererBrowser = {
    newPage: () => {
      readyResolve?.();
      return Promise.resolve(page);
    },
    close: () => {
      log.browserClosed = true;
      return Promise.resolve();
    },
  };
  const module: RendererModule = { chromium: { launch: () => Promise.resolve(browser) } };
  const controller = new AbortController();
  const pending = renderWithPlaywright(module, 'https://docs.example.com/slow', 15000, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(log.pageClosed, true);
  assert.equal(log.browserClosed, true);
});

test('renderWithPlaywright closes both handles when navigation times out', async () => {
  const log = { pageClosed: false, browserClosed: false };
  const page: RendererPage = {
    goto: () => Promise.reject(new DOMException('navigation timeout', 'TimeoutError')),
    waitForLoadState: () => Promise.resolve(),
    content: () => Promise.resolve(''),
    url: () => 'https://docs.example.com/timeout',
    close: () => {
      log.pageClosed = true;
      return Promise.resolve();
    },
  };
  const browser: RendererBrowser = {
    newPage: () => Promise.resolve(page),
    close: () => {
      log.browserClosed = true;
      return Promise.resolve();
    },
  };
  const module: RendererModule = { chromium: { launch: () => Promise.resolve(browser) } };
  await assert.rejects(
    () => renderWithPlaywright(module, 'https://docs.example.com/timeout', 3000, undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TimeoutError');
      return true;
    },
  );
  assert.equal(log.pageClosed, true);
  assert.equal(log.browserClosed, true);
});

test('an aborted fetch rejects instead of returning the shell page', async () => {
  const controller = new AbortController();
  const provider = createFetchProvider(
    { renderJs: 'auto' },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: (_renderer, _url, _timeout, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        setTimeout(() => controller.abort(), 1);
      }),
    },
  );
  await assert.rejects(
    () => provider.fetch({ url: TARGET }, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
});

test('the rendered body still obeys fetchMaxLength and reports truncation', async () => {
  const provider = createFetchProvider(
    { renderJs: 'auto', maxLength: 1000 },
    {
      ...directOnly(outcome(SHELL_HTML)),
      loadRenderer: fakeLoader(),
      render: () => Promise.resolve({
        html: `<html><body><article><h1>Deep</h1><p>${'x'.repeat(5000)}</p></article></body></html>`,
        statusCode: 200,
        url: TARGET,
      }),
    },
  );
  const result = await provider.fetch({ url: TARGET });
  assert.equal(result.truncated, true);
  assert.ok(result.body.content.startsWith('# Deep\n\n'));
  assert.ok(result.body.content.endsWith(
    '[truncated at 1000 chars; original length 5008 chars; the rest is not shown]',
  ));
});

// ---------------------------------------------------------------------------
// Default loader in this deployment
// ---------------------------------------------------------------------------

test('the default loader either finds a chromium export or reports absence without throwing', async () => {
  const result = await loadPlaywrightRenderer();
  if (result.ok) {
    assert.equal(typeof result.renderer.chromium.launch, 'function');
    assert.ok(result.moduleName === 'playwright' || result.moduleName === 'playwright-core');
  } else {
    assert.match(result.reason, /^no JS renderer is installed/);
    assert.match(result.reason, /playwright/);
  }
});
