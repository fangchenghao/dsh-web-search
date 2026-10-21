/**
 * Regression tests for the engine parsers.
 *
 * The fixtures under `test/fixtures/` are real captured responses wherever the
 * live endpoint still serves the markup under test; the two synthetic files are
 * marked as such and are built only from shapes the old code was measured
 * against (DuckDuckGo's `/l/?uddg=` wrapper and Bing's rate-limited feed).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '../src/types.ts';
import {
  echoesQuery,
  parseAnySearch,
  parseBing,
  parseDdgHtml,
  parseDdgLite,
  parseSo,
  resolveHref,
} from '../src/parsers.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Read one fixture by file name. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Build a Bing click-tracker href the way the served markup encodes it. */
function bingTracker(target: string): string {
  const payload = Buffer.from(target, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return `https://www.bing.com/ck/a?!&amp;&amp;p=deadbeef&amp;ptn=3&amp;u=a1${payload}&amp;ntb=1`;
}

/** Every URL must be an absolute http(s) one. */
function assertAbsoluteHttp(sources: Source[]): void {
  for (const source of sources) {
    const url = new URL(source.url);
    assert.ok(url.protocol === 'http:' || url.protocol === 'https:', `not http(s): ${source.url}`);
  }
}

describe('resolveHref', () => {
  test('decodes Bing u=a1 base64url tracker payloads (live fixture shape)', () => {
    const target = 'https://www.postgresql.org/docs/current/logical-replication.html';
    assert.equal(resolveHref(bingTracker(target), 'https://www.bing.com/search'), target);
    // The `&#38;` spelling of the same ampersand must decode too.
    const numeric = bingTracker(target).replace(/&amp;/g, '&#38;');
    assert.equal(resolveHref(numeric, 'https://www.bing.com/search'), target);
  });

  test('unwraps DuckDuckGo /l/?uddg= links and keeps their query string', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Fstep%3D1%26lang%3Den&rut=abc';
    assert.equal(resolveHref(href, 'https://html.duckduckgo.com/html/'), 'https://example.com/guide?step=1&lang=en');
  });

  test('rejects javascript:, data:, mailto: and unusable values', () => {
    const base = 'https://example.com/search';
    assert.equal(resolveHref('javascript:alert(1)', base), undefined);
    assert.equal(resolveHref('data:text/html,<h1>x</h1>', base), undefined);
    assert.equal(resolveHref('mailto:person@example.com', base), undefined);
    assert.equal(resolveHref(undefined, base), undefined);
    assert.equal(resolveHref('', base), undefined);
  });

  test('resolves a genuinely relative path against the page', () => {
    assert.equal(resolveHref('/docs/current/', 'https://example.com/search?q=x'), 'https://example.com/docs/current/');
  });
});

describe('parseBing', () => {
  test('regression: &amp;u=a1 tracker link decodes to the real target, not bing.com/ck/a', () => {
    const sources = parseBing(fixture('bing-global.html'), 'https://www.bing.com/search');
    assert.ok(sources.length >= 3, `expected >= 3 sources, got ${sources.length}`);
    assertAbsoluteHttp(sources);
    for (const source of sources) {
      assert.ok(!source.url.includes('bing.com/ck/'), `tracker leaked as a result URL: ${source.url}`);
    }
    assert.ok(sources.some((source) => source.url.startsWith('https://www.postgresql.org/')));
  });

  test('omits empty title and snippet fields instead of emitting an empty string', () => {
    const html =
      '<li class="b_algo"><h2><a href="https://example.com/a"> </a></h2></li>' +
      '<li class="b_algo"><h2><a href="https://example.com/b">Has title</a></h2><p> </p></li>';
    const sources = parseBing(html, 'https://www.bing.com/search');
    assert.equal(sources.length, 2);
    assert.ok(!('title' in sources[0]!));
    assert.ok(!('snippet' in sources[0]!));
    assert.equal(sources[1]?.title, 'Has title');
    assert.ok(!('snippet' in sources[1]!));
  });
});

describe('parseDdgHtml', () => {
  test('regression: DuckDuckGo /l/?uddg=<urlencoded> unwraps to the target', () => {
    const sources = parseDdgHtml(fixture('ddg-uddg-synthetic.html'), 'https://html.duckduckgo.com/html/');
    assert.equal(sources.length, 3);
    assertAbsoluteHttp(sources);
    assert.equal(sources[0]?.url, 'https://www.postgresql.org/docs/current/logical-replication.html');
    // Percent-encoded query separators must survive the unwrap intact.
    assert.equal(sources[1]?.url, 'https://example.com/guide?step=1&lang=en');
    for (const source of sources) {
      assert.ok(!source.url.includes('duckduckgo.com/l/'), `wrapper leaked: ${source.url}`);
    }
  });

  test('parses the live DuckDuckGo HTML fixture', () => {
    const sources = parseDdgHtml(fixture('ddg-html.html'), 'https://html.duckduckgo.com/html/');
    assert.ok(sources.length >= 3, `expected >= 3 sources, got ${sources.length}`);
    assertAbsoluteHttp(sources);
    assert.ok(sources.every((source) => source.title !== undefined && source.title.length > 0));
  });
});

describe('parseDdgLite', () => {
  test("regression: single-quoted class='result-link' attribute is still parsed", () => {
    const sources = parseDdgLite(fixture('ddg-lite.html'), 'https://lite.duckduckgo.com/lite/');
    assert.ok(sources.length >= 3, `expected >= 3 sources, got ${sources.length}`);
    assertAbsoluteHttp(sources);
    for (const source of sources) {
      assert.ok(!source.url.includes('duckduckgo.com'), `wrapper leaked: ${source.url}`);
    }
    assert.ok(sources.some((source) => source.url.startsWith('https://www.postgresql.org/')));
  });

  test('reads the snippet from the following sibling row, not the next hit', () => {
    const html =
      "<a class='result-link' href='https://example.com/one'>One</a>" +
      "<td class='result-snippet'>Snippet one</td>" +
      "<a class='result-link' href='https://example.com/two'>Two</a>" +
      "<td class='result-snippet'>Snippet two</td>";
    const sources = parseDdgLite(html, 'https://lite.duckduckgo.com/lite/');
    assert.deepEqual(sources, [
      { url: 'https://example.com/one', title: 'One', snippet: 'Snippet one' },
      { url: 'https://example.com/two', title: 'Two', snippet: 'Snippet two' },
    ]);
  });
});

describe('parseSo', () => {
  test('regression: the anchor data-mdurl yields the real URL, never the 360 tracker', () => {
    const sources = parseSo(fixture('so.html'), 'https://www.so.com/s');
    assert.ok(sources.length >= 3, `expected >= 3 sources, got ${sources.length}`);
    assertAbsoluteHttp(sources);
    for (const source of sources) {
      assert.ok(!source.url.includes('so.com/link'), `click tracker leaked: ${source.url}`);
      assert.ok(!source.url.includes('so.com/link?'), `click tracker leaked: ${source.url}`);
    }
  });

  test('skips a heading that carries only the tracker href (no data-mdurl)', () => {
    const html =
      '<li class="res-list"><h3   class="res-title"><a href="https://www.so.com/link?m=tracker">Tracker only</a></h3></li>' +
      '<li class="res-list"><h3 class="res-title " > <a  href="https://www.so.com/link?m=t" data-mdurl="https://example.com/real">Real</a></h3>' +
      '<span class="res-list-summary">Summary text</span></li>';
    const sources = parseSo(html, 'https://www.so.com/s');
    assert.deepEqual(sources, [{ url: 'https://example.com/real', title: 'Real', snippet: 'Summary text' }]);
  });
});

describe('parseAnySearch', () => {
  test('regression: an envelope with code !== 0 yields []', () => {
    assert.deepEqual(parseAnySearch(fixture('anysearch-error.json'), 'https://api.anysearch.com/'), []);
    assert.deepEqual(parseAnySearch('{"code":1,"message":"nope"}', 'https://api.anysearch.com/'), []);
    assert.deepEqual(parseAnySearch('{"code":-1,"data":{"results":[{"url":"https://example.com/"}]}}', 'https://api.anysearch.com/'), []);
  });

  test('parses the live AnySearch JSON fixture', () => {
    const sources = parseAnySearch(fixture('anysearch.json'), 'https://api.anysearch.com/');
    assert.ok(sources.length >= 3, `expected >= 3 sources, got ${sources.length}`);
    assertAbsoluteHttp(sources);
    assert.ok(sources.every((source) => typeof source.title === 'string' && source.title.length > 0));
  });

  test('drops rows without a usable URL and omits empty fields', () => {
    const payload = JSON.stringify({
      code: 0,
      data: {
        results: [
          { title: '  ', url: 'https://example.com/a', snippet: '' },
          { title: 'No url' },
          { url: 'javascript:alert(1)' },
          null,
          'garbage',
          { title: 'Keep', url: 'https://example.com/b', snippet: ' Snippet ' },
        ],
      },
    });
    const sources = parseAnySearch(payload, 'https://api.anysearch.com/');
    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], { url: 'https://example.com/a' });
    assert.deepEqual(sources[1], { url: 'https://example.com/b', title: 'Keep', snippet: 'Snippet' });
  });

  test('malformed JSON and a missing results array yield []', () => {
    for (const payload of ['', 'not json', 'null', '42', '"x"', '{"code":0}', '{"code":0,"data":{}}', '{"code":0,"data":{"results":"nope"}}']) {
      assert.deepEqual(parseAnySearch(payload, 'https://api.anysearch.com/'), [], `payload: ${payload}`);
    }
  });
});

describe('garbage input', () => {
  test("every parser returns [] for 'not html', '' and '{\"code\":0}'", () => {
    const parsers = [
      ['parseDdgHtml', parseDdgHtml],
      ['parseDdgLite', parseDdgLite],
      ['parseBing', parseBing],
      ['parseSo', parseSo],
      ['parseAnySearch', parseAnySearch],
    ] as const;
    for (const [name, parse] of parsers) {
      for (const payload of ['not html', '', '{"code":0}']) {
        assert.deepEqual(parse(payload, 'https://example.com/'), [], `${name} on ${JSON.stringify(payload)}`);
      }
    }
  });

  test('truncated result markup does not throw', () => {
    for (const payload of ['<li class="b_algo"><h2><a href="', '<li class="res-list"><h3 class="res-title">', "<a class='result-link' href='"]) {
      assert.doesNotThrow(() => parseBing(payload, 'https://www.bing.com/search'));
      assert.doesNotThrow(() => parseSo(payload, 'https://www.so.com/s'));
      assert.doesNotThrow(() => parseDdgLite(payload, 'https://lite.duckduckgo.com/lite/'));
    }
  });
});

describe('echoesQuery', () => {
  test('regression: rejects a rate-limit/captcha payload for a different query', () => {
    const payload = fixture('bing-ratelimit-synthetic.html');
    assert.equal(echoesQuery(payload, 'postgres logical replication'), false);
    // The same payload does echo the query it actually belongs to.
    assert.equal(echoesQuery(payload, 'jigsaw puzzle'), true);
  });

  test('accepts a live result page that echoes the query', () => {
    assert.equal(echoesQuery(fixture('bing-global.html'), 'postgres logical replication'), true);
    assert.equal(echoesQuery(fixture('ddg-html.html'), 'postgres logical replication'), true);
    assert.equal(echoesQuery(fixture('so.html'), 'postgres 逻辑复制'), true);
  });

  test('returns true when the query has no token of length >= 3', () => {
    assert.equal(echoesQuery('anything', 'a b'), true);
    assert.equal(echoesQuery('', ''), true);
    assert.equal(echoesQuery('', '!!!'), true);
  });

  test('matches case-insensitively', () => {
    assert.equal(echoesQuery('POSTGRES LOGICAL REPLICATION', 'postgres'), true);
  });
});

describe('live fixtures', () => {
  test('every captured result page parses to >= 3 absolute http(s) sources', () => {
    const cases = [
      ['ddg-html.html', parseDdgHtml, 'https://html.duckduckgo.com/html/'],
      ['ddg-lite.html', parseDdgLite, 'https://lite.duckduckgo.com/lite/'],
      ['bing-global.html', parseBing, 'https://www.bing.com/search'],
      ['so.html', parseSo, 'https://www.so.com/s'],
      ['anysearch.json', parseAnySearch, 'https://api.anysearch.com/'],
    ] as const;
    for (const [name, parse, base] of cases) {
      const sources = parse(fixture(name), base);
      assert.ok(sources.length >= 3, `${name}: expected >= 3 sources, got ${sources.length}`);
      assertAbsoluteHttp(sources);
      for (const source of sources) {
        assert.ok(source.url.length > 0, `${name}: empty url`);
      }
    }
  });
});
