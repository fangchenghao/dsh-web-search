/**
 * Date-stamp parsing and rolling time-window tests.
 *
 * The clocks are injected everywhere (`now`), so none of these cases depends on
 * the machine's timezone or on when the suite runs. Absolute dates are checked
 * through their UTC components, which is the only representation the rest of
 * the code sees.
 *
 * @module dsh-web-search-bing/test/freshness
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source, TimeRange } from '../src/types.ts';
import { MS_PER_DAY, TIME_RANGE_MS, extractPublishedAt, filterByTimeRange, isWithinTimeRange, parsePublishedAt, preferWindow, publishedTimestamp } from '../src/freshness.ts';
import { HOSTS } from '../src/engines.ts';
import { cacheKey } from '../src/cache.ts';
import { parseAnySearch, parseBing, parseDdgHtml, parseSo } from '../src/parsers.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Read one captured fixture. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** A fixed evaluation instant: 2026-10-22T12:00:00Z. */
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0, 0);

/** The ISO form of an offset from {@link NOW}. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/** A minimal source. */
function src(url: string, publishedAt?: string): Source {
  return { url, ...(publishedAt === undefined ? {} : { publishedAt }) };
}

/** The engine with a given id; fails the test rather than returning undefined. */
function host(id: string): (typeof HOSTS)[number] {
  const found = HOSTS.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing engine ${id}`);
  return found;
}

test('absolute dates parse to noon UTC in every accepted notation', () => {
  const expected = '2024-05-01T12:00:00.000Z';
  for (const text of ['2024-05-01', '2024/5/1', '2024年5月1日', '2024年5月1号', 'May 1, 2024', '1 May 2024']) {
    assert.equal(parsePublishedAt(text, NOW), expected, text);
  }
  assert.equal(parsePublishedAt('Sept 25, 2025', NOW), '2025-09-25T12:00:00.000Z');
  assert.equal(parsePublishedAt('Oct 3rd, 2025', NOW), '2025-10-03T12:00:00.000Z');
  assert.equal(parsePublishedAt('Postgres 18 is out 2025-09-25', NOW), '2025-09-25T12:00:00.000Z');
});

test('absolute dates are timezone independent: UTC components never shift', () => {
  const iso = parsePublishedAt('2024-05-01', NOW);
  assert.ok(iso !== undefined);
  const date = new Date(iso);
  assert.equal(date.getUTCFullYear(), 2024);
  assert.equal(date.getUTCMonth(), 4);
  assert.equal(date.getUTCDate(), 1);
  assert.equal(date.getUTCHours(), 12, 'date-only values are anchored at noon UTC');
  assert.equal(Date.parse(iso), Date.UTC(2024, 4, 1, 12));
});

test('relative stamps in English and Chinese roll back from the injected clock', () => {
  assert.equal(parsePublishedAt('3 days ago', NOW), ago(3 * MS_PER_DAY));
  assert.equal(parsePublishedAt('2 天前', NOW), ago(2 * MS_PER_DAY));
  assert.equal(parsePublishedAt('10 小时之前', NOW), ago(10 * 3_600_000));
  assert.equal(parsePublishedAt('2 years ago', NOW), ago(2 * 365 * MS_PER_DAY));
  assert.equal(parsePublishedAt('昨天', NOW), ago(MS_PER_DAY));
  assert.equal(parsePublishedAt('今天', NOW), new Date(NOW).toISOString());
  assert.equal(parsePublishedAt('刚刚', NOW), new Date(NOW).toISOString());
});

test('the AnySearch "date:" marker wins over other numbers in the content', () => {
  assert.equal(
    parsePublishedAt('See the 2020 benchmark and the 2023 rewrite. date: Oct 3, 2025', NOW),
    '2025-10-03T12:00:00.000Z',
  );
  assert.equal(
    parsePublishedAt('Release notes for 2015. date: 22 hours ago', NOW),
    ago(22 * 3_600_000),
  );
});

test('missing and unparsable values never produce a date', () => {
  for (const text of ['', '   ', 'no date here', 'PostgreSQL 10.1', 'v18.3', '2024年2月30日', 'May 40, 2024']) {
    assert.equal(parsePublishedAt(text, NOW), undefined, JSON.stringify(text));
  }
  assert.equal(extractPublishedAt([undefined, '', 'no date']), undefined);
});

test('relative words inside prose are not mistaken for a stamp', () => {
  // Captured 360 snippet: the word 今天 is part of the sentence, not a date.
  assert.equal(parsePublishedAt('但是我们今天讲的逻辑复制, 考虑的就...', NOW), undefined);
  assert.equal(parsePublishedAt('The 2024 release is still supported', NOW), undefined);
});

test('extractPublishedAt prefers the first fragment that carries a date', () => {
  assert.equal(
    extractPublishedAt([undefined, '2 天之前 文章', '2024-05-01'], NOW),
    ago(2 * MS_PER_DAY),
  );
  assert.equal(extractPublishedAt([undefined, 'no date'], NOW), undefined);
});

test('time-window boundaries include exactly N days and reject one millisecond more', () => {
  const windows: readonly [TimeRange, number][] = [
    ['day', MS_PER_DAY],
    ['week', 7 * MS_PER_DAY],
    ['month', 30 * MS_PER_DAY],
    ['year', 365 * MS_PER_DAY],
  ];
  for (const [range, span] of windows) {
    assert.equal(isWithinTimeRange(ago(span), range, NOW), true, `${range}: exactly N days is inside`);
    assert.equal(isWithinTimeRange(ago(span + 1), range, NOW), false, `${range}: N days + 1ms is outside`);
    assert.equal(isWithinTimeRange(ago(0), range, NOW), true, `${range}: now is inside`);
  }
});

test('today and yesterday sit inside a day, yesterday+1ms does not', () => {
  assert.equal(isWithinTimeRange(parsePublishedAt('今天', NOW), 'day', NOW), true);
  assert.equal(isWithinTimeRange(parsePublishedAt('昨天', NOW), 'day', NOW), true);
  assert.equal(isWithinTimeRange(ago(MS_PER_DAY + 1), 'day', NOW), false);
});

test('missing, invalid and future dates are kept; off keeps everything', () => {
  assert.equal(isWithinTimeRange(undefined, 'day', NOW), true);
  assert.equal(isWithinTimeRange('not a date', 'day', NOW), true);
  assert.equal(isWithinTimeRange(new Date(NOW + MS_PER_DAY).toISOString(), 'day', NOW), true);
  for (const range of ['off', 'day', 'week', 'month', 'year'] as const) {
    assert.equal(isWithinTimeRange('1999-01-01T12:00:00.000Z', range, NOW), range === 'off');
  }
});

test('filterByTimeRange drops only known-stale rows and leaves the input alone', () => {
  const fresh = src('https://example.com/fresh', ago(2 * 3_600_000));
  const stale = src('https://example.com/stale', ago(10 * MS_PER_DAY));
  const undated = src('https://example.com/undated');
  const invalid = src('https://example.com/invalid', 'not a date');
  const input = [fresh, stale, undated, invalid];
  const kept = filterByTimeRange(input, 'day', NOW);
  // An undated row is held back when a dated row is already inside the window:
  // answering "last 24 hours" with pages of unknown age would be a lie.
  assert.deepEqual(kept.map((source) => source.url), [fresh.url]);
  const undatedOnly = filterByTimeRange([stale, undated, invalid], 'day', NOW);
  // Nothing dated falls inside the window, so the undated rows are the fallback
  // rather than an empty answer.
  assert.deepEqual(undatedOnly.map((source) => source.url), [undated.url, invalid.url]);
  assert.equal(input.length, 4, 'the input array is not mutated');
  assert.equal(filterByTimeRange(input, 'off', NOW).length, 4);
});

test('publishedTimestamp accepts ISO values and rejects missing or junk ones', () => {
  assert.equal(publishedTimestamp('2024-05-01T12:00:00.000Z'), Date.UTC(2024, 4, 1, 12));
  assert.equal(publishedTimestamp(undefined), undefined);
  assert.equal(publishedTimestamp(''), undefined);
  assert.equal(publishedTimestamp('junk'), undefined);
});

test('parseSo reads 发贴时间 and ignores 今天 inside the summary prose', () => {
  const payload = [
    '<div class="res-list">',
    '<h3 class="res-title "><a data-mdurl="https://example.com/dated">Dated</a></h3>',
    '<span class="res-list-summary">但是我们今天讲的逻辑复制</span>',
    '<span class="g-c-gray">发贴时间：2024年7月1日 - </span>',
    '</div>',
    '<div class="res-list">',
    '<h3 class="res-title "><a data-mdurl="https://example.com/undated">Undated</a></h3>',
    '<span class="res-list-summary">今天我们讲的逻辑复制</span>',
    '</div>',
  ].join('');
  const sources = parseSo(payload, 'https://www.so.com/s');
  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.publishedAt, '2024-07-01T12:00:00.000Z');
  assert.equal(sources[1]?.publishedAt, undefined, 'prose 今天 must not become a date');
});

test('parseBing reads the caption date prefix and leaves an undated caption alone', () => {
  const payload = [
    '<li class="b_algo"><h2><a href="https://example.com/dated">Dated</a></h2>',
    '<div class="b_caption"><p>2 天之前&ensp;&#0183;&ensp;A dated result</p></div></li>',
    '<li class="b_algo"><h2><a href="https://example.com/undated">Undated</a></h2>',
    '<div class="b_caption"><p>No stamp in this caption</p></div></li>',
  ].join('');
  const sources = parseBing(payload, 'https://www.bing.com/search');
  assert.equal(sources.length, 2);
  assert.ok(sources[0]?.publishedAt !== undefined);
  assert.ok(Math.abs((publishedTimestamp(sources[0]?.publishedAt) ?? 0) - (Date.now() - 2 * MS_PER_DAY)) < 5_000);
  assert.equal(sources[1]?.publishedAt, undefined);
});

test('parseDdgHtml uses a timestamp span when one is present', () => {
  const payload = [
    '<a class="result__a" href="https://example.com/a">A</a>',
    '<a class="result__snippet" href="https://example.com/a">Snippet body</a>',
    '<span class="result__timestamp">Sep 25, 2025</span>',
  ].join('');
  const sources = parseDdgHtml(payload, 'https://html.duckduckgo.com/html/');
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.publishedAt, '2025-09-25T12:00:00.000Z');
});

test('parseAnySearch reads the content date marker and the optional top-level date', () => {
  const payload = JSON.stringify({
    code: 0,
    data: {
      results: [
        { title: 'Marked', url: 'https://example.com/marked', snippet: 's', content: 'body date: Oct 3, 2025' },
        { title: 'Top', url: 'https://example.com/top', snippet: 's', content: 'body', date: 'May 1, 2024' },
        { title: 'None', url: 'https://example.com/none', snippet: 's', content: 'Retrieved June 2, 2024' },
      ],
    },
  });
  const sources = parseAnySearch(payload, 'https://api.anysearch.com/');
  assert.equal(sources.length, 3);
  assert.equal(sources[0]?.publishedAt, '2025-10-03T12:00:00.000Z');
  assert.equal(sources[1]?.publishedAt, '2024-05-01T12:00:00.000Z');
  assert.equal(sources[2]?.publishedAt, undefined, 'prose dates in content are not publication stamps');
});

test('the captured 360 page parses at least two publication dates', () => {
  const sources = parseSo(fixture('so.html'), 'https://www.so.com/s');
  const dated = sources.filter((source) => source.publishedAt !== undefined);
  assert.ok(dated.length >= 2, `expected dates from the fixture, got ${dated.length}`);
  for (const source of dated) {
    assert.ok(!Number.isNaN(Date.parse(source.publishedAt ?? '')), `not ISO: ${source.publishedAt}`);
  }
});

test('DuckDuckGo is the only engine whose window is pushed into the request URL', () => {
  const html = host('ddg-html');
  const lite = host('ddg-lite');
  const expected: Record<Exclude<TimeRange, 'off'>, string> = {
    day: 'd',
    week: 'w',
    month: 'm',
    year: 'y',
  };
  for (const [range, code] of Object.entries(expected) as [Exclude<TimeRange, 'off'>, string][]) {
    assert.match(html.build('a b', range), new RegExp(`[?&]df=${code}$`), `ddg-html ${range}`);
    assert.match(lite.build('a b', range), new RegExp(`[?&]df=${code}$`), `ddg-lite ${range}`);
  }
  assert.ok(!html.build('a b', 'off').includes('df='));
  assert.ok(!html.build('a b').includes('df='));

  // Measured no-op: Bing accepts `filters=ex1:"ez…"` but returns the same rows,
  // so the plugin must not pretend it pushed the window down.
  for (const id of ['cn.bing', 'www.bing']) {
    for (const range of ['off', 'day', 'week', 'month', 'year'] as const) {
      assert.ok(!host(id).build('a b', range).includes('filters='), `${id} ${range}`);
    }
  }
});

test('the cache key separates an active window from an unfiltered search', () => {
  const base = { query: 'postgres', limit: 8, wait: 'auto', lead: 'global', engines: ['cn.bing'] };
  assert.equal(cacheKey({ ...base, timeRange: 'off' }), cacheKey(base));
  assert.notEqual(cacheKey({ ...base, timeRange: 'week' }), cacheKey(base));
  assert.notEqual(cacheKey({ ...base, timeRange: 'day' }), cacheKey({ ...base, timeRange: 'week' }));
});

test('TIME_RANGE_MS matches the documented windows', () => {
  assert.equal(TIME_RANGE_MS.day, MS_PER_DAY);
  assert.equal(TIME_RANGE_MS.week, 7 * MS_PER_DAY);
  assert.equal(TIME_RANGE_MS.month, 30 * MS_PER_DAY);
  assert.equal(TIME_RANGE_MS.year, 365 * MS_PER_DAY);
});

test('preferWindow keeps only dated rows inside the window, and the list when none is', () => {
  const fresh = src('https://example.com/fresh', ago(2 * 3_600_000));
  const stale = src('https://example.com/stale', ago(10 * MS_PER_DAY));
  const undated = src('https://example.com/undated');
  const invalid = src('https://example.com/invalid', 'not a date');
  const merged = [fresh, stale, undated, invalid];
  assert.deepEqual(preferWindow(merged, 'day', NOW).map((s) => s.url), [fresh.url]);
  assert.equal(preferWindow(merged, 'off', NOW).length, 4);
  // Nothing dated inside: the caller gets the list rather than nothing.
  assert.equal(preferWindow([stale, undated], 'day', NOW).length, 2);
});
