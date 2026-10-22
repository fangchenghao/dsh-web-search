/**
 * `read_page`: real continuation, not a bigger `web_fetch` budget.
 *
 * The host's `WebFetchRequest` carries only `url`, which is why
 * `fetch-paging.test.ts` can prove that an `offset` sent to `web_fetch` is
 * inert. A plugin-owned tool has no such limit. These tests pin down the two
 * properties that make continuation trustworthy:
 *
 * 1. concatenating the `content` of every chunk reproduces the complete body
 *    **character for character** (`assert.equal(joined, full)`, not `includes`);
 * 2. walking a page issues exactly one internal provider fetch, counted by the
 *    injected provider, because the complete converted body is cached.
 *
 * Failures are values (`failures: string[]`), matching `domain_search` and
 * `search_many`; argument mistakes are throws, matching those tools too.
 *
 * The live test touches the real network only when `READ_PAGE_LIVE=1`, so the
 * default suite stays deterministic. Its assertions are just as strict as the
 * offline ones.
 *
 * @module dsh-web-search-bing/test/read-page
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_PAGE_CACHE_ENTRIES,
  READ_PAGE_DEFAULT_LENGTH,
  READ_PAGE_INTERNAL_MAX_CHARS,
  READ_PAGE_MAX_LENGTH,
  READ_PAGE_MIN_LENGTH,
  READ_PAGE_TOOL_FALLBACK_NAME,
  READ_PAGE_TOOL_NAME,
  createReadPageDefinition,
  formatReadPageValue,
  pickReadPageToolName,
  registerReadPageTool,
} from '../src/read-page.ts';
import type {
  ReadPageDefinition,
  ReadPageRegistryLike,
  ReadPageSettings,
  ReadPageValue,
} from '../src/read-page.ts';
import type { FetchProvider } from '../src/fetch.ts';
import type { FetchFormat } from '../src/markdown.ts';
import { renderFetchText } from '../src/markdown.ts';
import type { RenderReport } from '../src/render.ts';
import { apply } from '../src/index.ts';
import type { PluginContext, SearchProvider } from '../src/index.ts';

/** A page the fake provider can answer with, or a failure it can throw. */
interface StubPage {
  content?: string;
  /** Simulate a provider that converts per format; falls back to `content`. */
  byFormat?: Partial<Record<FetchFormat, string>>;
  statusCode?: number;
  truncated?: boolean;
  render?: RenderReport;
  error?: Error;
}

/** The recorder returned by {@link recorder}. */
interface Recorder {
  factory: (format: FetchFormat) => FetchProvider;
  /** One entry per actual provider fetch. */
  calls: { url: string; format: FetchFormat }[];
  /** One entry per provider the tool built. */
  formats: FetchFormat[];
}

/** Replace `globalThis.fetch` for one test and restore it afterwards. */
function stubGlobalFetch(body: string, contentType = 'text/html; charset=utf-8', status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A provider factory that records fetches and answers from a fixed map. */
function recorder(pages: Record<string, StubPage>): Recorder {
  const calls: { url: string; format: FetchFormat }[] = [];
  const formats: FetchFormat[] = [];
  return {
    calls,
    formats,
    factory(format) {
      formats.push(format);
      return {
        id: `stub-${format}`,
        available: () => true,
        async fetch(request) {
          calls.push({ url: request.url, format });
          const page = pages[request.url];
          if (page === undefined) throw new Error(`no stub page for ${request.url}`);
          if (page.error !== undefined) throw page.error;
          return {
            url: request.url,
            statusCode: page.statusCode ?? 200,
            body: { kind: 'text' as const, content: page.byFormat?.[format] ?? page.content ?? '' },
            truncated: page.truncated ?? false,
            ...(page.render === undefined ? {} : { render: page.render }),
          };
        },
      };
    },
  };
}

/** Settings a real deployment would read from `fetchMaxLength`/`fetchFormat`. */
const BASE_SETTINGS: ReadPageSettings = {
  maxLength: READ_PAGE_MIN_LENGTH,
  format: 'markdown',
  renderJs: 'off',
};

/** Build a definition over the fake provider. */
function setup(pages: Record<string, StubPage>, settings: ReadPageSettings = { ...BASE_SETTINGS }): {
  definition: ReadPageDefinition;
  settings: ReadPageSettings;
  recorder: Recorder;
} {
  const fake = recorder(pages);
  return {
    definition: createReadPageDefinition(READ_PAGE_TOOL_NAME, () => settings, { createProvider: fake.factory }),
    settings,
    recorder: fake,
  };
}

/** A deterministic ASCII document of exactly `length` code units. */
function asciiDocument(length: number): string {
  const line = '0123456789abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
  let text = '';
  while (text.length < length) text += line;
  return text.slice(0, length);
}

/** A tiny registry double with the host's schema projection and disposer. */
function registry(options: { taken?: boolean; reject?: boolean } = {}): {
  tools: ReadPageRegistryLike;
  definitions: Map<string, ReadPageDefinition>;
  schemas: () => { name: string; parameters: unknown; output: unknown }[];
} {
  const definitions = new Map<string, ReadPageDefinition>();
  const tools: ReadPageRegistryLike = {
    register(definition) {
      if (options.reject === true) throw new Error('registry rejected the definition');
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
    get(name) {
      if (options.taken === true && name === READ_PAGE_TOOL_NAME) return { name };
      return definitions.get(name);
    },
  };
  return {
    tools,
    definitions,
    schemas: () => [...definitions.values()].map((definition) => ({
      name: definition.name,
      parameters: definition.parameters,
      output: definition.output.schema,
    })),
  };
}

test('chunks walked by nextOffset concatenate to the exact full body', async () => {
  const url = 'https://example.com/long';
  const full = asciiDocument(10_000);
  const { definition, recorder: fake } = setup({ [url]: { content: full } });

  const values: ReadPageValue[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const value = await definition.execute({ url, offset, maxLength: 3_000 }, {});
    values.push(value);
    assert.deepEqual(value.failures, [], 'a complete body has no failures');
    assert.equal(value.offset, offset);
    assert.equal(value.totalLength, full.length);
    assert.equal(value.content, full.slice(offset, offset + value.content.length), 'each chunk is the exact slice');
    assert.equal(value.truncated, false);
    if (value.nextOffset === null) break;
    assert.ok(value.nextOffset > offset);
    offset = value.nextOffset;
  }

  assert.equal(values.length, 4);
  assert.deepEqual(values.map((value) => value.chunk.index), [1, 2, 3, 4]);
  assert.deepEqual(values.map((value) => value.chunk.count), [4, 4, 4, 4]);
  assert.deepEqual(values.map((value) => value.nextOffset), [3_000, 6_000, 9_000, null]);
  assert.equal(values.map((value) => value.content).join(''), full);
  assert.equal(fake.calls.length, 1, 'all four chunks reused the one complete body');
  const last = values[3];
  assert.ok(last !== undefined);
  assert.equal(formatReadPageValue(last), `${last.content}\n\n[end of page: 10000 characters total]`);
});

test('an adjusted chunk boundary never splits a surrogate pair, and still joins exactly', async () => {
  const url = 'https://example.com/unicode';
  // 999 'a', one emoji (two code units) at the 1000-code-unit boundary, 1000 'b'.
  const full = `${'a'.repeat(999)}🚀${'b'.repeat(1_000)}`;
  assert.equal(full.length, 2_001);
  const { definition, recorder: fake } = setup({ [url]: { content: full } });

  const first = await definition.execute({ url, offset: 0, maxLength: 1_000 }, {});
  assert.equal(first.content, 'a'.repeat(999), 'the high surrogate is left for the next chunk');
  assert.equal(first.content.length, 999);
  assert.equal(first.nextOffset, 999);

  const second = await definition.execute({ url, offset: first.nextOffset as number, maxLength: 1_000 }, {});
  assert.equal(second.content.codePointAt(0), 0x1F680, 'the pair begins the next chunk');
  assert.equal(second.content.length, 1_000);
  assert.equal(second.nextOffset, 1_999);

  const third = await definition.execute({ url, offset: second.nextOffset as number, maxLength: 1_000 }, {});
  assert.equal(third.content, 'bb');
  assert.equal(third.nextOffset, null);

  assert.equal(first.content + second.content + third.content, full);
  assert.equal(fake.calls.length, 1);
});

test('offset and maxLength default from the live settings on every call', async () => {
  const url = 'https://example.com/defaults';
  const full = asciiDocument(2_500);
  const { definition, settings, recorder: fake } = setup({ [url]: { content: full } });

  const first = await definition.execute({ url }, {});
  assert.equal(first.offset, 0);
  assert.equal(first.content.length, READ_PAGE_MIN_LENGTH);
  assert.equal(first.nextOffset, READ_PAGE_MIN_LENGTH);
  assert.equal(first.chunk.count, 3);

  // The old settings are not frozen at mount time.
  settings.maxLength = 2_000;
  const second = await definition.execute({ url }, {});
  assert.equal(second.content.length, 2_000);
  assert.equal(second.nextOffset, 2_000);
  assert.deepEqual(second.chunk, { index: 1, count: 2 });
  assert.equal(fake.calls.length, 1, 'a default change does not refetch the page');
});

test('format defaults live, and an explicit format overrides it', async () => {
  const url = 'https://example.com/formats';
  const other = 'https://example.com/formats-second';
  const { definition, settings, recorder: fake } = setup({
    [url]: { byFormat: { markdown: '# Title\n\nBody', text: 'Title\n\nBody' } },
    [other]: { byFormat: { markdown: '# Other', text: 'Other' } },
  });

  const markdown = await definition.execute({ url }, {});
  assert.equal(markdown.content, '# Title\n\nBody');

  const text = await definition.execute({ url, format: 'text' }, {});
  assert.equal(text.content, 'Title\n\nBody');

  settings.format = 'text';
  const liveText = await definition.execute({ url: other }, {});
  assert.equal(liveText.content, 'Other');

  assert.deepEqual(fake.calls.map((call) => call.format), ['markdown', 'text', 'text']);
  assert.equal(fake.calls.length, 3, 'each format keeps its own converted body');
});

test('offset exactly at totalLength is the end: empty content and nextOffset null', async () => {
  const url = 'https://example.com/end';
  const full = asciiDocument(2_500);
  const { definition, recorder: fake } = setup({ [url]: { content: full } });

  const value = await definition.execute({ url, offset: full.length, maxLength: 1_000 }, {});
  assert.equal(value.content, '');
  assert.equal(value.offset, 2_500);
  assert.equal(value.nextOffset, null);
  assert.equal(value.totalLength, 2_500);
  assert.equal(value.truncated, false);
  assert.deepEqual(value.chunk, { index: 3, count: 3 });
  assert.equal(formatReadPageValue(value), '[end of page: 2500 characters total]');
  assert.equal(fake.calls.length, 1);
});

test('an offset past totalLength is a clear validation error', async () => {
  const url = 'https://example.com/past';
  const { definition, recorder: fake } = setup({ [url]: { content: asciiDocument(2_500) } });

  await assert.rejects(
    definition.execute({ url, offset: 2_501 }, {}),
    /offset 2501 is past the end of https:\/\/example\.com\/past \(totalLength 2500\)/,
  );
  assert.equal(fake.calls.length, 1, 'the page was fetched before bounds could be checked');
});

test('an empty page is a valid page, not a failure', async () => {
  const url = 'https://example.com/empty';
  const { definition, recorder: fake } = setup({ [url]: { content: '' } });

  const value = await definition.execute({ url }, {});
  assert.equal(value.content, '');
  assert.equal(value.offset, 0);
  assert.equal(value.nextOffset, null);
  assert.equal(value.totalLength, 0);
  assert.equal(value.truncated, false);
  assert.deepEqual(value.chunk, { index: 1, count: 1 });
  assert.deepEqual(value.failures, []);
  assert.equal(formatReadPageValue(value), '[the page has no readable text]');

  const again = await definition.execute({ url, offset: 0 }, {});
  assert.equal(again.totalLength, 0);
  assert.equal(fake.calls.length, 1, 'the empty body is cached too');

  await assert.rejects(definition.execute({ url, offset: 1 }, {}), /offset 1 is past the end/);
});

test('maxLength enforces the documented 1000–200000 range', async () => {
  const url = 'https://example.com/range';
  const { definition, recorder: fake } = setup({ [url]: { content: 'body' } });

  for (const value of [999, 0, -1, READ_PAGE_MAX_LENGTH + 1, 1_500.5, '2000']) {
    await assert.rejects(
      definition.execute({ url, maxLength: value }, {}),
      new RegExp(`maxLength must be an integer between ${READ_PAGE_MIN_LENGTH} and ${READ_PAGE_MAX_LENGTH}`),
      `maxLength ${JSON.stringify(value)} must be rejected`,
    );
  }
  assert.equal(fake.calls.length, 0, 'argument validation happens before any fetch');
});

test('url must be an absolute http(s) URL', async () => {
  const { definition, recorder: fake } = setup({});

  await assert.rejects(definition.execute(null, {}), /requires arguments/);
  await assert.rejects(definition.execute({}, {}), /requires a url string/);
  await assert.rejects(definition.execute({ url: '   ' }, {}), /requires a non-empty url/);
  await assert.rejects(definition.execute({ url: 'not a url' }, {}), /not a valid absolute URL/);
  await assert.rejects(definition.execute({ url: 'ftp://example.com/x' }, {}), /must use http or https/);
  await assert.rejects(definition.execute({ url: 'file:///etc/passwd' }, {}), /must use http or https/);
  assert.equal(fake.calls.length, 0);
});

test('offset must be a safe non-negative integer', async () => {
  const url = 'https://example.com/offset';
  const { definition, recorder: fake } = setup({ [url]: { content: 'body' } });

  for (const value of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      definition.execute({ url, offset: value }, {}),
      /offset must be a safe integer >= 0/,
      `offset ${JSON.stringify(value)} must be rejected`,
    );
  }
  assert.equal(fake.calls.length, 0);
});

test('format accepts only markdown and text', async () => {
  const url = 'https://example.com/format';
  const { definition, recorder: fake } = setup({ [url]: { content: 'body' } });

  await assert.rejects(
    definition.execute({ url, format: 'html' }, {}),
    /format must be "markdown" or "text"/,
  );
  assert.equal(fake.calls.length, 0);
});

test('HTTP failures are structured values with the domain_search/search_many shape', async () => {
  const missing = 'https://example.com/missing';
  const broken = 'https://example.com/broken';
  const { definition } = setup({
    [missing]: { content: 'not found page', statusCode: 404 },
    [broken]: { content: 'server error page', statusCode: 500 },
  });

  for (const [url, status] of [[missing, 404], [broken, 500]] as const) {
    const value = await definition.execute({ url, offset: 7 }, {});
    assert.equal(value.content, '');
    assert.equal(value.offset, 7);
    assert.equal(value.nextOffset, null);
    assert.equal(value.totalLength, 0);
    assert.equal(value.truncated, false);
    assert.deepEqual(value.chunk, { index: 1, count: 1 });
    assert.deepEqual(value.failures, [`read_page: HTTP ${status} for ${url}`]);
    const text = formatReadPageValue(value);
    assert.equal(text, `read_page could not read ${url}.\n- read_page: HTTP ${status} for ${url}`);
  }
});

test('a network throw becomes a failure value, never a rejected tool call', async () => {
  const url = 'https://example.com/down';
  const { definition } = setup({ [url]: { error: new Error('ECONNREFUSED 127.0.0.1:443') } });

  const value = await definition.execute({ url }, {});
  assert.equal(value.content, '');
  assert.equal(value.nextOffset, null);
  assert.equal(value.totalLength, 0);
  assert.deepEqual(value.failures, ['read_page: ECONNREFUSED 127.0.0.1:443']);
  assert.match(formatReadPageValue(value), /could not read/);
});

test('a 500 from the real fetch ladder is a structured failure, not a thrown error', async () => {
  const url = 'https://example.com/error-page';
  const restore = stubGlobalFetch('<html><body><h1>Server error</h1></body></html>', 'text/html', 500);
  try {
    const definition = createReadPageDefinition(READ_PAGE_TOOL_NAME, () => ({
      maxLength: 1_000,
      format: 'markdown',
      renderJs: 'off',
    }));
    const value = await definition.execute({ url }, {});
    assert.deepEqual(value.failures, [`read_page: HTTP 500 for ${url}`]);
    assert.equal(value.content, '');
    assert.equal(value.nextOffset, null);
    assert.equal(value.totalLength, 0);
  } finally {
    restore();
  }
});

test('the render report rides along when the provider supplies one', async () => {
  const report: RenderReport = {
    mode: 'always',
    attempted: true,
    applied: true,
    reason: 'stub renderer produced 42 readable characters',
  };
  const rendered = setup({ 'https://example.com/rendered': { content: 'Body', render: report } });
  const value = await rendered.definition.execute({ url: 'https://example.com/rendered' }, {});
  assert.deepEqual(value.render, report);

  const plain = setup({ 'https://example.com/plain': { content: 'Body' } });
  const without = await plain.definition.execute({ url: 'https://example.com/plain' }, {});
  assert.equal(Object.hasOwn(without, 'render'), false);
});

test('the 2,000,000-character safety cap is applied once, to the whole body', async () => {
  const url = 'https://example.com/huge';
  const full = 'z'.repeat(READ_PAGE_INTERNAL_MAX_CHARS + 50);
  const { definition, recorder: fake } = setup({ [url]: { content: full } });

  const first = await definition.execute({ url, maxLength: READ_PAGE_MAX_LENGTH }, {});
  assert.equal(first.totalLength, READ_PAGE_INTERNAL_MAX_CHARS);
  assert.equal(first.truncated, true);
  assert.equal(first.content.length, READ_PAGE_MAX_LENGTH);
  assert.equal(first.nextOffset, READ_PAGE_MAX_LENGTH);
  assert.equal(first.chunk.count, READ_PAGE_INTERNAL_MAX_CHARS / READ_PAGE_MAX_LENGTH);
  assert.match(formatReadPageValue(first), /truncated at the 2000000-character safety cap/);

  const end = await definition.execute({ url, offset: READ_PAGE_INTERNAL_MAX_CHARS }, {});
  assert.equal(end.content, '');
  assert.equal(end.nextOffset, null);
  assert.equal(end.truncated, true);
  assert.equal(
    formatReadPageValue(end),
    '[end of page at the 2000000-character safety cap: 2000000 characters total]',
  );
  assert.equal(fake.calls.length, 1);
});

test('consecutive reads of one URL and format call the provider exactly once', async () => {
  const url = 'https://example.com/cache';
  const other = 'https://example.com/cache-other';
  const full = asciiDocument(2_500);
  const { definition, recorder: fake } = setup({
    [url]: { content: full },
    [other]: { content: full },
  });

  const first = await definition.execute({ url, offset: 0, maxLength: 1_000 }, {});
  const second = await definition.execute({ url, offset: first.nextOffset as number, maxLength: 1_000 }, {});
  assert.equal(first.content + second.content, full.slice(0, first.content.length + second.content.length));
  assert.equal(fake.calls.length, 1, 'the complete body is cached per URL and format');
  assert.deepEqual(fake.calls.map((call) => call.url), [url]);

  // A different format is a different conversion, so it gets its own fetch.
  await definition.execute({ url, format: 'text' }, {});
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map((call) => call.format), ['markdown', 'text']);

  // A different URL is a different body.
  await definition.execute({ url: other }, {});
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.formats, ['markdown', 'text']);
});

test('the production default provider is the fetch ladder, sliced into chunks', async () => {
  const url = 'https://example.com/production';
  const words = 'w'.repeat(2_600);
  const page = `<html><body><article><h1>Long</h1><p>${words}</p></article></body></html>`;
  const restore = stubGlobalFetch(page);
  try {
    const expected = renderFetchText(page, {
      format: 'markdown',
      maxLength: Number.MAX_SAFE_INTEGER,
      baseUrl: url,
    }).content;
    assert.equal(expected, `# Long\n\n${words}`);

    // No createProvider seam: this exercises createFetchProvider end to end.
    const definition = createReadPageDefinition(READ_PAGE_TOOL_NAME, () => ({
      maxLength: 1_000,
      format: 'markdown',
      renderJs: 'off',
    }));

    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 10; guard += 1) {
      const value = await definition.execute({ url, offset, maxLength: 1_000 }, {});
      assert.deepEqual(value.failures, []);
      assert.equal(value.totalLength, expected.length);
      assembled += value.content;
      if (value.nextOffset === null) break;
      offset = value.nextOffset;
    }
    assert.equal(assembled, expected, 'the tool slices exactly the body the ladder produced');
  } finally {
    restore();
  }
});

test('the production default provider honours format=text', async () => {
  const url = 'https://example.com/text-page';
  const page = '<html><body><h2>Title</h2><p><strong>Bold</strong> <a href="/x">Link</a></p></body></html>';
  const restore = stubGlobalFetch(page);
  try {
    const definition = createReadPageDefinition(READ_PAGE_TOOL_NAME, () => ({
      maxLength: 1_000,
      format: 'text',
      renderJs: 'off',
    }));
    const value = await definition.execute({ url }, {});
    assert.deepEqual(value.failures, []);
    assert.equal(value.content, 'Title\n\nBold Link (https://example.com/x)');
    assert.equal(value.nextOffset, null);
    assert.equal(value.totalLength, value.content.length);
  } finally {
    restore();
  }
});

test('the definition exposes the registry JSON-Schema dialect', () => {
  const { definition } = setup({});
  assert.equal(definition.name, READ_PAGE_TOOL_NAME);
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.required, ['url']);
  assert.deepEqual(definition.parameters.properties?.format?.enum, ['markdown', 'text']);
  assert.equal(definition.parameters.properties?.offset?.type, 'integer');
  assert.deepEqual(definition.output.schema.required, [
    'url',
    'content',
    'offset',
    'nextOffset',
    'totalLength',
    'truncated',
    'chunk',
    'failures',
  ]);
  assert.equal(definition.timeoutMs, 60_000);
});

test('registration is visible to the projected schemas and disposal removes it', async () => {
  const url = 'https://example.com/registered';
  const { tools, definitions, schemas } = registry();
  const fake = recorder({ [url]: { content: 'Registered body' } });
  const registration = registerReadPageTool(tools, () => ({ ...BASE_SETTINGS }), { createProvider: fake.factory });
  assert.ok(registration);
  assert.equal(registration.name, READ_PAGE_TOOL_NAME);
  assert.deepEqual(schemas().map((schema) => schema.name), [READ_PAGE_TOOL_NAME]);

  const registered = definitions.get(READ_PAGE_TOOL_NAME);
  assert.ok(registered);
  const value = await registered.execute({ url }, {});
  assert.equal(value.content, 'Registered body');

  registration.dispose();
  assert.equal(definitions.size, 0);
  assert.deepEqual(schemas(), []);
  registration.dispose(); // idempotent
});

test('a taken name falls back to web_read_page', () => {
  const { tools } = registry({ taken: true });
  assert.equal(pickReadPageToolName(tools), READ_PAGE_TOOL_FALLBACK_NAME);
  assert.equal(READ_PAGE_TOOL_FALLBACK_NAME, 'web_read_page');
  const registration = registerReadPageTool(tools, () => ({ ...BASE_SETTINGS }), {
    createProvider: recorder({}).factory,
  });
  assert.equal(registration?.name, READ_PAGE_TOOL_FALLBACK_NAME);
});

test('a registry rejection is reported and swallowed', () => {
  const warnings: string[] = [];
  const { tools } = registry({ reject: true });
  const registration = registerReadPageTool(tools, () => ({ ...BASE_SETTINGS }), {
    createProvider: recorder({}).factory,
    warn: (line) => warnings.push(line),
  });
  assert.equal(registration, undefined);
  assert.ok(warnings.some((line) => line.includes('read_page') && line.includes('rejected')), JSON.stringify(warnings));
});

test('apply registers read_page with the host tools service and disposes it', () => {
  const { tools, definitions } = registry();
  const cleanups: (() => void)[] = [];
  const providers: SearchProvider[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: () => undefined,
    },
    get: (name: string) => (name === 'tools' ? tools : undefined),
    effect: (execute) => {
      const cleanup = execute();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };

  apply(ctx, { cachePersist: false });
  assert.equal(providers.length, 1, 'web_search is still registered');
  assert.equal(definitions.has(READ_PAGE_TOOL_NAME), true);
  assert.equal(definitions.has('search_many'), true, 'all optional tools share the registry');

  for (const cleanup of cleanups) cleanup();
  assert.equal(definitions.has(READ_PAGE_TOOL_NAME), false, 'dispose removed read_page');
});

test('the registered read_page from apply pages a real provider response', async () => {
  const { tools, definitions } = registry();
  const cleanups: (() => void)[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: () => undefined,
      registerFetchProvider: () => undefined,
    },
    get: (name: string) => (name === 'tools' ? tools : undefined),
    effect: (execute) => {
      const cleanup = execute();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  apply(ctx, { cachePersist: false, fetchMaxLength: 1_000, fetchFormat: 'markdown', renderJs: 'off' });

  const registered = definitions.get(READ_PAGE_TOOL_NAME);
  assert.ok(registered);
  const words = 'q'.repeat(1_500);
  const page = `<html><body><article><h1>Applied</h1><p>${words}</p></article></body></html>`;
  const restore = stubGlobalFetch(page);
  try {
    const first = await registered.execute({ url: 'https://example.com/applied' }, {});
    assert.deepEqual(first.failures, []);
    assert.equal(first.totalLength, `# Applied\n\n${words}`.length);
    assert.equal(first.content.length, 1_000);
    assert.equal(first.nextOffset, 1_000);
    const second = await registered.execute({ url: 'https://example.com/applied', offset: first.nextOffset }, {});
    assert.equal(first.content + second.content, `# Applied\n\n${words}`);
    assert.equal(second.nextOffset, null);
  } finally {
    restore();
    for (const cleanup of cleanups) cleanup();
  }
});

test('apply without a tools service still mounts web_search and skips read_page', () => {
  const providers: SearchProvider[] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: () => undefined,
    },
    // Cordis throws for an un-injected service; the plugin must treat that as
    // "no tool registry" rather than failing to mount.
    get: () => {
      throw new Error('cannot get property "tools" without inject');
    },
  };
  assert.doesNotThrow(() => apply(ctx, { cachePersist: false }));
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, 'bing');
});

test('the page cache is bounded and evicts the oldest body', async () => {
  const pages: Record<string, StubPage> = {};
  for (let index = 0; index <= READ_PAGE_CACHE_ENTRIES; index += 1) {
    pages[`https://example.com/page-${index}`] = { content: `body ${index}` };
  }
  const { definition, recorder: fake } = setup(pages);

  for (let index = 0; index <= READ_PAGE_CACHE_ENTRIES; index += 1) {
    const value = await definition.execute({ url: `https://example.com/page-${index}` }, {});
    assert.equal(value.content, `body ${index}`);
  }
  assert.equal(fake.calls.length, READ_PAGE_CACHE_ENTRIES + 1);

  // The first body was evicted, so reading it again must fetch it again.
  await definition.execute({ url: 'https://example.com/page-0' }, {});
  assert.equal(fake.calls.length, READ_PAGE_CACHE_ENTRIES + 2);

  // The newest body is still cached.
  await definition.execute({ url: `https://example.com/page-${READ_PAGE_CACHE_ENTRIES}` }, {});
  assert.equal(fake.calls.length, READ_PAGE_CACHE_ENTRIES + 2);
});

test('live: offset=0 plus nextOffset reproduces the complete converted page', {
  skip: process.env['READ_PAGE_LIVE'] !== '1',
  timeout: 120_000,
}, async () => {
  const url = 'https://docs.python.org/3/library/asyncio-task.html';
  const definition = createReadPageDefinition(READ_PAGE_TOOL_NAME, () => ({
    maxLength: READ_PAGE_DEFAULT_LENGTH,
    format: 'markdown',
    renderJs: 'off',
  }));

  const whole = await definition.execute({ url, offset: 0, maxLength: READ_PAGE_MAX_LENGTH }, {});
  assert.deepEqual(whole.failures, [], JSON.stringify(whole.failures));
  assert.equal(whole.nextOffset, null, 'the page fits in one maximum-size chunk');
  assert.ok(whole.totalLength > READ_PAGE_DEFAULT_LENGTH, `expected a long page, got ${whole.totalLength}`);

  let offset = 0;
  let assembled = '';
  let chunks = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const value = await definition.execute({ url, offset, maxLength: READ_PAGE_DEFAULT_LENGTH }, {});
    assert.deepEqual(value.failures, [], JSON.stringify(value.failures));
    assert.equal(value.totalLength, whole.totalLength);
    assert.equal(value.content, whole.content.slice(value.offset, value.offset + value.content.length));
    assembled += value.content;
    chunks += 1;
    if (value.nextOffset === null) break;
    offset = value.nextOffset;
  }

  assert.equal(assembled.length, whole.totalLength);
  assert.equal(assembled, whole.content, 'the joined chunks must equal the one-shot body exactly');

  console.log(
    `[read_page live] url=${url} totalLength=${whole.totalLength} chunks=${chunks} `
      + `assembledLength=${assembled.length} first80=${JSON.stringify(whole.content.slice(0, 80))}`,
  );
});
