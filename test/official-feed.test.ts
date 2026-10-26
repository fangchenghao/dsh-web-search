import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chromeChannel,
  chromeFeedNote,
  chromeSecuritySummary,
  chromeWindow,
  filterChromeChannel,
  hasNonStableChromePosts,
  isChromeSecurityQuery,
  parseChromeReleases,
} from '../src/official-feed.ts';

const payload = JSON.stringify({
  feed: {
    entry: [
      {
        title: { $t: 'Stable Channel Update for Desktop' },
        published: { $t: '2026-10-23T10:00:00.000-07:00' },
        content: { $t: '<p>Security fixes and stability improvements.</p>' },
        link: [
          { rel: 'replies', href: 'https://chromereleases.googleblog.com/feeds/1/comments/default' },
          { rel: 'alternate', href: 'https://chromereleases.googleblog.com/2026/10/stable.html' },
        ],
      },
      {
        title: { $t: 'Chrome Dev for Android Update' },
        published: { $t: '2026-09-20T10:00:00.000-07:00' },
        summary: { $t: 'A &amp; B release.' },
        link: [{ rel: 'alternate', href: 'https://chromereleases.googleblog.com/2026/09/dev.html' }],
      },
    ],
  },
});

test('parses Chrome Releases with real publication dates', () => {
  const sources = parseChromeReleases(payload);
  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.url, 'https://chromereleases.googleblog.com/2026/10/stable.html');
  assert.equal(sources[0]?.publishedAt, '2026-10-23T17:00:00.000Z');
  assert.match(sources[0]?.snippet ?? '', /Security fixes/);
  assert.equal(sources[1]?.snippet, 'A & B release.');
});

test('parses malformed and empty feed payloads as no results', () => {
  assert.deepEqual(parseChromeReleases('not json'), []);
  assert.deepEqual(parseChromeReleases('{"feed":{}}'), []);
  assert.deepEqual(parseChromeReleases(''), []);
});

test('filters feed posts to the requested publication window', () => {
  const sources = parseChromeReleases(payload);
  const week = chromeWindow(sources, 'week', Date.parse('2026-10-25T00:00:00Z'));
  assert.deepEqual(week.map((source) => source.title), ['Stable Channel Update for Desktop']);
  assert.equal(chromeWindow(sources, 'off').length, 2);
});

test('describes a zero-day-free official feed honestly', () => {
  const sources = parseChromeReleases(payload);
  const note = chromeFeedNote(sources, 'week', 'Chrome zero-day security posts last week');
  assert.match(note, /2 post\(s\)/);
  assert.match(note, /no title or summary mentions zero-day/);
});

test('counts zero-day mentions when they exist', () => {
  const source = {
    url: 'https://chromereleases.googleblog.com/2026/10/zero.html',
    title: 'Chrome zero-day security update',
    snippet: 'A zero-day was fixed.',
    publishedAt: '2026-10-23T17:00:00.000Z',
  };
  const note = chromeFeedNote([source], 'week', 'Chrome zero-day');
  assert.match(note, /1 mention zero-day/);
});

test('recognizes only Chrome security/release queries', () => {
  assert.equal(isChromeSecurityQuery('Chrome zero-day announcements in the last 7 days'), true);
  assert.equal(isChromeSecurityQuery('过去 7 天 Chrome 官方安全博客的零日公告'), true);
  assert.equal(isChromeSecurityQuery('Chrome 158 release date'), true);
  assert.equal(isChromeSecurityQuery('how to center a div'), false);
  assert.equal(isChromeSecurityQuery('Chromium build instructions'), false);
});

test('classifies release channels from feed titles', () => {
  const sources = parseChromeReleases(JSON.stringify({
    feed: {
      entry: [
        { title: { $t: 'Stable Channel Update for Desktop' }, published: { $t: '2026-10-23T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/stable' }] },
        { title: { $t: 'Chrome Beta for Android Update' }, published: { $t: '2026-10-22T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/beta' }] },
        { title: { $t: 'Chrome Dev for Desktop Update' }, published: { $t: '2026-10-21T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/dev' }] },
        { title: { $t: 'Early Stable Update for Desktop' }, published: { $t: '2026-10-20T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/early' }] },
        { title: { $t: 'Chrome for Android Update' }, published: { $t: '2026-10-19T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/android' }] },
      ],
    },
  }));
  assert.deepEqual(sources.map(chromeChannel), ['stable', 'beta', 'dev', 'other', 'stable']);
  const stable = filterChromeChannel(sources, 'Chrome 稳定版过去两周发布');
  assert.deepEqual(stable.map((source) => source.title), ['Stable Channel Update for Desktop', 'Chrome for Android Update']);
  assert.equal(filterChromeChannel(sources, 'Chrome security releases').length, 5);
  assert.equal(hasNonStableChromePosts(sources, 'Chrome stable releases'), true);
});

test('extracts version, fix count and severity distribution from a release body', () => {
  const plain = [
    'The Stable channel has been updated to 156.0.8078.47 for Windows.',
    'This update includes 3 security fixes.',
    'Critical CVE-2026-113341: Memory corruption in Skia.',
    'High CVE-2026-113101: Use after free in SiteIsolation.',
    'High CVE-2026-113097: Use after free in FileSystem.',
    'Medium CVE-2026-110916: Improper input validation in Desktop.',
  ].join(' ');
  assert.deepEqual(chromeSecuritySummary(plain), {
    version: '156.0.8078.47',
    total: 3,
    critical: 1,
    high: 2,
    medium: 1,
  });
  const parsed = parseChromeReleases(JSON.stringify({
    feed: {
      entry: [{
        title: { $t: 'Stable Channel Update for Desktop' },
        published: { $t: '2026-10-20T10:00:00Z' },
        content: { $t: `<p>${plain}</p>` },
        link: [{ rel: 'alternate', href: 'https://example.test/stable' }],
      }],
    },
  }));
  assert.match(parsed[0]?.snippet ?? '', /^version 156\.0\.8078\.47; 3 security fix\(es\); listed severity: Critical 1 \/ High 2 \/ Medium 1\./);
});

test('keeps Early and Extended Stable out of a Stable-only result', () => {
  const sources = parseChromeReleases(JSON.stringify({
    feed: {
      entry: [
        { title: { $t: 'Early Stable Update for Desktop' }, published: { $t: '2026-10-22T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/early' }] },
        { title: { $t: 'Extended Stable Update for Desktop' }, published: { $t: '2026-10-21T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/extended' }] },
        { title: { $t: 'Stable Channel Update for Desktop' }, published: { $t: '2026-10-20T10:00:00Z' }, link: [{ rel: 'alternate', href: 'https://example.test/stable' }] },
      ],
    },
  }));
  assert.deepEqual(filterChromeChannel(sources, 'Chrome 稳定版').map((source) => source.title), ['Stable Channel Update for Desktop']);
});
