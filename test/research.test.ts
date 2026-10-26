/**
 * Tests for the `research` tool: search -> fetch -> evidence pack.
 *
 * The stubs replace both seams, so the assertions are about the contract the
 * model depends on: one section per fetched page, a citation under every
 * excerpt, URLs de-duplicated across queries, a failed page reported by URL and
 * reason instead of aborting the pack, and a registration path that falls back
 * instead of breaking plugin loading.
 *
 * @module dsh-web-search-bing/test/research
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_DEFAULT_SOURCES,
  RESEARCH_MAX_SOURCES,
  RESEARCH_TOOL_FALLBACK_NAME,
  RESEARCH_TOOL_NAME,
  authorityScore,
  canonicalKey,
  createResearchDefinition,
  formatResearchValue,
  pickResearchToolName,
  registerResearchTool,
  selectExcerpt,
} from '../src/research.ts';
import type { ResearchDefinition, ResearchFetchFailure, ResearchFetcher, ResearchRegistryLike, ResearchValue } from '../src/research.ts';
import type { Source } from '../src/types.ts';

function source(url: string, title = ''): Source {
  return { url, ...(title ? { title } : {}), snippet: `snippet for ${url}` };
}

/** A search stub that answers each query with the same two rows, one shared. */
const search = async (query: string) => ({
  sources: [
    source(`https://example.com/${encodeURIComponent(query)}/a`, `A for ${query}`),
    source('https://shared.example/docs/', 'Shared doc'),
  ],
  failures: [],
});

/** A fetch stub: every URL reads back its own path, except the broken one. */
const fetchPage: ResearchFetcher = async (url) => {
  if (url.includes('broken')) throw new Error('timed out');
  return { url, status: 200, text: `Readable text for ${url}. `.repeat(20), truncated: false };
};

function definition(): ResearchDefinition {
  return createResearchDefinition(RESEARCH_TOOL_NAME, search, fetchPage);
}

test('a research call fetches the leading pages and cites each excerpt', async () => {
  const value = await definition().execute({ query: 'kubernetes' }, {});
  // One query yields two distinct rows (the per-query page and the shared doc).
  assert.equal(value.pages.length, 2);
  assert.equal(value.pages.length <= RESEARCH_DEFAULT_SOURCES, true);
  assert.ok(value.pages.every((page) => page.excerpt.length > 0));
  assert.ok(value.pages.every((page) => value.queries.includes('kubernetes')));
  const text = formatResearchValue(value);
  for (const page of value.pages) {
    assert.ok(text.includes(page.url), `missing citation ${page.url}`);
    assert.ok(text.includes(page.excerpt.slice(0, 40)));
  }
});

test('a boilerplate-only page is reported, not counted as evidence', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://thin.example/')], failures: [] }),
    async (url) => ({ url, status: 200, text: 'Please enable JavaScript to continue.', truncated: false }),
  ).execute({ query: 'thin' }, {});
  assert.equal(value.pages.length, 0);
  assert.equal(value.failures.length, 1);
  assert.match(value.failures[0]?.reason ?? '', /too little readable text/u);
});

test('a raw HTML page is reported instead of being cited as prose', async () => {
  const html = '<!doctype html><html><script>var challenge = true;</script><body>Sorry</body></html>';
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://shell.example/'), source('https://ok.example/')], failures: [] }),
    async (url) => ({
      url,
      status: 200,
      text: url.includes('shell') ? html : `Readable text for ${url}. `.repeat(20),
      truncated: false,
    }),
  ).execute({ query: 'shell' }, {});
  assert.equal(value.pages.length, 1);
  assert.equal(value.pages[0]?.url, 'https://ok.example/');
  assert.equal(value.failures.length, 1);
  assert.match(value.failures[0]?.reason ?? '', /raw HTML document/u);
});

test('a bot challenge is reported instead of being quoted as evidence', async () => {
  const challenge = `Making sure you're not a bot! Anubis Proof-of-Work Loading... ${'x'.repeat(300)}`;
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://challenge.example/')], failures: [] }),
    async (url) => ({ url, status: 200, text: challenge, truncated: false }),
  ).execute({ query: 'bot' }, {});
  assert.equal(value.pages.length, 0);
  assert.equal(value.failures.length, 1);
  assert.match(value.failures[0]?.reason ?? '', /bot challenge/u);
});

test('a login redirect is reported instead of being quoted as evidence', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://login.example/')], failures: [] }),
    async (url) => ({
      url,
      status: 302,
      text: 'Redirecting to <https://accounts.example/login?next=doc>. ' + 'x'.repeat(180),
      truncated: false,
    }),
  ).execute({ query: 'login' }, {});
  assert.equal(value.pages.length, 0);
  assert.equal(value.failures.length, 1);
  assert.match(value.failures[0]?.reason ?? '', /redirect/u);
});

test('queries are merged and their shared URL is fetched once', async () => {
  const value = await definition().execute({ query: 'alpha', queries: ['beta', 'alpha'] }, {});
  assert.deepEqual(value.queries, ['alpha', 'beta']);
  const urls = value.pages.map((page) => page.url.toLowerCase());
  assert.equal(new Set(urls).size, urls.length);
  // Three distinct rows exist after folding the shared URL; the default budget
  // is three, so nothing is cut.
  assert.equal(value.found, 3);
  assert.equal(value.truncated, false);
});

test('a broken page is reported, and the rest of the pack still arrives', async () => {
  const url = 'https://broken.example/page';
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source(url), source('https://ok.example/page')], failures: [] }),
    fetchPage,
  ).execute({ query: 'x' }, {});
  assert.equal(value.pages.length, 1);
  assert.equal(value.failures.length, 1);
  assert.equal(value.failures[0]?.url, url);
  assert.match(value.failures[0]?.reason ?? '', /timed out/);
  assert.ok(formatResearchValue(value).includes('Fetch failures'));
});

test('a page with no readable text is a reported failure, not an empty citation', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://blank.example/')], failures: [] }),
    async (url) => ({ url, status: 200, text: '   \n\n  ', truncated: false }),
  ).execute({ query: 'x' }, {});
  assert.equal(value.pages.length, 0);
  assert.match(value.failures[0]?.reason ?? '', /no readable text/);
});

test('search failures do not stop the other queries', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async (query) => {
      if (query === 'bad') throw new Error('engine exploded');
      return { sources: [source('https://ok.example/')], failures: [] };
    },
    fetchPage,
  ).execute({ query: 'bad', queries: ['good'] }, {});
  assert.equal(value.queries.length, 2);
  assert.equal(value.pages.length, 1);
});

test('maxSources is clamped and bad arguments are rejected', async () => {
  const value = await definition().execute({ query: 'x', maxSources: 99 }, {});
  assert.ok(value.pages.length <= RESEARCH_MAX_SOURCES);
  await assert.rejects(() => definition().execute({}, {}), /non-empty query/);
  await assert.rejects(() => definition().execute({ query: 'x', queries: 'nope' }, {}), /array of strings/);
  await assert.rejects(() => definition().execute({ query: 'x', queries: ['a', 'b', 'c', 'd'] }, {}), /at most 3/);
  await assert.rejects(() => definition().execute({ query: 'x', maxSources: 1.5 }, {}), /integer/);
});

test('canonicalKey folds the differences engines disagree about', () => {
  assert.equal(canonicalKey('https://www.example.com/docs/'), canonicalKey('https://example.com/docs'));
  assert.equal(canonicalKey('https://example.com/a?x=1#top'), canonicalKey('https://example.com/a?x=1'));
  assert.equal(canonicalKey('ftp://example.com/a'), undefined);
});

test('the registration falls back when the name is taken and survives rejection', () => {
  const definitions: ResearchDefinition[] = [];
  const registry: ResearchRegistryLike = {
    register: (definition) => {
      definitions.push(definition);
      return () => undefined;
    },
    get: (name) => (name === RESEARCH_TOOL_NAME ? {} : undefined),
  };
  const registration = registerResearchTool(registry, search, fetchPage);
  assert.equal(registration?.name, RESEARCH_TOOL_FALLBACK_NAME);
  assert.equal(definitions[0]?.name, RESEARCH_TOOL_FALLBACK_NAME);

  const rejecting: ResearchRegistryLike = { register: () => { throw new Error('duplicate'); } };
  const warnings: string[] = [];
  assert.equal(registerResearchTool(rejecting, search, fetchPage, { warn: (message) => warnings.push(message) }), undefined);
  assert.match(warnings[0] ?? '', /research registration skipped/);
  assert.equal(pickResearchToolName({ register: () => undefined }), RESEARCH_TOOL_NAME);
});

test('the pack lists rows that were found but not fetched', async () => {
  const value: ResearchValue = await definition().execute({ query: 'x', maxSources: 1 }, {});
  assert.ok(value.sources.length > 0);
  const text = formatResearchValue(value);
  assert.ok(text.includes('Found but not fetched'));
  const failures: ResearchFetchFailure[] = value.failures;
  assert.ok(Array.isArray(failures));
});

test('authority scores recognise government, academic and official documentation', () => {
  assert.equal(authorityScore('https://www.ndrc.gov.cn/fzggw/jgsj/'), 5);
  assert.equal(authorityScore('https://cs.example.edu/paper'), 5);
  assert.equal(authorityScore('https://docs.python.org/3/library/'), 4);
  assert.equal(authorityScore('https://example.com/docs/guide'), 1);
  assert.equal(authorityScore('https://example.com/blog/post'), 0);
  assert.equal(authorityScore('not a url'), 0);
});

test('authority breaks a relevance tie, but an unrelated official page still stays behind', async () => {
  const rows = [
    { url: 'https://blog.example/ai-act', title: 'AI Act obligations', snippet: 'AI Act obligations explained' },
    {
      url: 'https://digital-strategy.ec.europa.eu/en/faqs/general-purpose-ai-models-ai-act-questions-answers',
      title: 'AI Act obligations',
      snippet: 'AI Act obligations from the Commission',
    },
    { url: 'https://independent.example/analysis', title: 'AI Act obligations', snippet: 'AI Act obligations analysis' },
  ];
  const tie = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: rows, failures: [] }),
    async (url) => ({ url, status: 200, text: `Readable prose for ${url}. `.repeat(10), truncated: false }),
  ).execute({ query: 'AI Act obligations', maxSources: 3 }, {});
  assert.deepEqual(tie.pages.map((page) => page.url), [
    'https://digital-strategy.ec.europa.eu/en/faqs/general-purpose-ai-models-ai-act-questions-answers',
    'https://blog.example/ai-act',
    'https://independent.example/analysis',
  ]);

  const priority = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({
      sources: [
        { url: 'https://www.gov.uk/unrelated', title: 'Unrelated notice', snippet: 'nothing to do with the query' },
        { url: 'https://blog.example/kubernetes', title: 'Kubernetes networking guide', snippet: 'services and pods' },
        { url: 'https://docs.example/kubernetes', title: 'Kubernetes overview', snippet: 'cluster' },
      ],
      failures: [],
    }),
    async (url) => ({ url, status: 200, text: `Readable prose for ${url}. `.repeat(10), truncated: false }),
  ).execute({ query: 'kubernetes networking', maxSources: 3 }, {});
  assert.deepEqual(priority.pages.map((page) => page.url), [
    'https://blog.example/kubernetes',
    'https://docs.example/kubernetes',
    'https://www.gov.uk/unrelated',
  ]);
});

test('a credible official page leads even when a generic page repeats more query words', async () => {
  const rows = [
    {
      url: 'https://docs.python.org/3/',
      title: 'Python documentation',
      snippet: 'The official Python documentation',
    },
    {
      url: 'https://blog.example/python-313-release',
      title: 'Python 3.13 release: what changed',
      snippet: 'A summary of the new features',
    },
  ];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: rows, failures: [] }),
    async (url) => ({ url, status: 200, text: `Readable prose for ${url}. `.repeat(10), truncated: false }),
  ).execute({ query: 'python 3.13', maxSources: 2 }, {});
  assert.deepEqual(value.pages.map((page) => page.url), [
    'https://docs.python.org/3/',
    'https://blog.example/python-313-release',
  ]);
});

test('a bounded official-site query is added when the open result set lacks the issuer', async () => {
  const seen: string[] = [];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async (query) => {
      seen.push(query);
      return {
        sources: [source(query.startsWith('site:europa.eu') ? 'https://digital-strategy.ec.europa.eu/en/policies' : 'https://aggregator.example/ai-act', 'row')],
        failures: [],
      };
    },
    async (url) => ({ url, status: 200, text: 'Official readable prose. '.repeat(20), truncated: false }),
  ).execute({ query: '欧盟 AI Act 的 GPAI 义务是什么' }, {});
  assert.ok(seen.some((query) => query.startsWith('site:europa.eu ')));
  assert.ok(value.queries.some((query) => query.startsWith('site:europa.eu ')));
  assert.equal(value.pages[0]?.url, 'https://digital-strategy.ec.europa.eu/en/policies');
});

test('an official landing page is not promoted over a relevant official article', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({
      sources: [
        { url: 'https://europa.eu/', title: 'European Commission', snippet: 'Official website' },
        { url: 'https://digital-strategy.ec.europa.eu/en/policies/gpai', title: 'AI Act GPAI obligations', snippet: 'The official obligations timeline' },
      ],
      failures: [],
    }),
    async (url) => ({ url, status: 200, text: `Readable official prose about GPAI obligations. `.repeat(10), truncated: false }),
  ).execute({ query: 'AI Act GPAI obligations', maxSources: 2 }, {});
  assert.equal(value.pages[0]?.url, 'https://digital-strategy.ec.europa.eu/en/policies/gpai');
});

test('one issuer cannot fill every page slot when another host is available', async () => {
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({
      sources: [
        { url: 'https://www.cac.gov.cn/2023-07/13/a.htm', title: '生成式人工智能 训练数据', snippet: '透明度' },
        { url: 'https://www.cac.gov.cn/2023-07/13/b.htm', title: '生成式人工智能 训练数据', snippet: '透明度' },
        { url: 'https://www.cac.gov.cn/2023-07/13/c.htm', title: '生成式人工智能 训练数据', snippet: '透明度' },
        { url: 'https://digital-strategy.ec.europa.eu/en/policies/gpai', title: 'AI Act GPAI transparency', snippet: 'obligations' },
      ],
      failures: [],
    }),
    async (url) => ({ url, status: 200, text: `Long readable policy prose about the query. `.repeat(20), truncated: false }),
  ).execute({ query: '生成式人工智能 训练数据 透明度 AI Act', maxSources: 3 }, {});
  const cac = value.pages.filter((page) => new URL(page.url).hostname.endsWith('cac.gov.cn')).length;
  const eu = value.pages.filter((page) => new URL(page.url).hostname.endsWith('europa.eu')).length;
  assert.equal(cac, 2);
  assert.equal(eu, 1);
});

test('a deep fact is selected from the body, not assumed to be in the opening', async () => {
  const filler = 'This section explains unrelated background material. '.repeat(250);
  const body = `Introduction\n\n${filler}\n\nPod spec fields\n\nterminationGracePeriodSeconds controls how long the kubelet waits before force-killing the container. The default is 30 seconds.\n\nClosing notes.`;
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: [source('https://deep.example/')], failures: [] }),
    async (url) => ({ url, status: 200, text: body, truncated: false }),
  ).execute({ query: 'terminationGracePeriodSeconds default' }, {});
  assert.equal(value.pages.length, 1);
  assert.match(value.pages[0]?.excerpt ?? '', /terminationGracePeriodSeconds/u);
  assert.match(value.pages[0]?.excerpt ?? '', /default is 30 seconds/u);
});

test('a failed page is replaced by the next candidate instead of shrinking the pack', async () => {
  const urls = [
    'https://broken.example/one',
    'https://ok.example/two',
    'https://ok.example/three',
    'https://ok.example/four',
  ];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: urls.map((url) => source(url)), failures: [] }),
    async (url) => {
      if (url.includes('broken')) throw new Error('timed out');
      return { url, status: 200, text: `content of ${url}. `.repeat(20), truncated: false };
    },
  ).execute({ query: 'x', maxSources: 2 }, {});
  assert.equal(value.pages.length, 2);
  assert.deepEqual(value.pages.map((page) => page.url), ['https://ok.example/two', 'https://ok.example/three']);
  assert.equal(value.failures.length, 1);
  assert.equal(value.failures[0]?.url, urls[0]);
  assert.ok(!value.sources.some((row) => row.url === urls[0]), 'a failed URL is not advertised as unfetched');
});

test('rows that share no query token are skipped when enough relevant rows exist', async () => {
  const rows = [
    source('https://recipe.example/pasta', 'Cooking recipes', 'pasta and tomato sauce'),
    source('https://k8s.example/networking', 'Kubernetes networking guide', 'services and pods'),
    source('https://k8s.example/service', 'Kubernetes service networking', 'cluster DNS'),
  ];
  const fetched: string[] = [];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({ sources: rows, failures: [] }),
    async (url) => {
      fetched.push(url);
      return { url, status: 200, text: `readable prose about ${url}. `.repeat(20), truncated: false };
    },
  ).execute({ query: 'kubernetes service networking', maxSources: 2 }, {});
  assert.deepEqual(fetched, ['https://k8s.example/service', 'https://k8s.example/networking']);
  assert.equal(value.pages.length, 2);
  assert.ok(!value.pages.some((page) => page.url.includes('recipe')));
  assert.deepEqual(value.sources.map((row) => row.url), ['https://recipe.example/pasta']);
});


test('keeps a regulation effective date at the end of a long excerpt', () => {
  const paragraphs = Array.from({ length: 120 }, (_, index) => `第${index + 1}段 ${'说明文字。'.repeat(30)}`);
  const text = `第一条 目的。\n\n${paragraphs.join('\n\n')}\n\n第十四条 本办法自2025年9月1日起施行。`;
  const excerpt = selectExcerpt(text, ['显式', '隐式', '施行', '标识'], 1_800);
  assert.match(excerpt, /第一条/u);
  assert.match(excerpt, /2025年9月1日起施行/u);
  assert.ok(excerpt.length <= 2_600, `excerpt too long: ${excerpt.length}`);
});

test('selects the operative legal date clause instead of article navigation', () => {
  const navigation = Array.from(
    { length: 80 },
    (_, index) => `- [Article ${index + 1}: navigation item](https://example.eu/article-${index + 1})`,
  ).join('\n');
  const body = [
    'Article 113',
    'Entry into force and application',
    '',
    '(b) Chapter III Section 4, Chapter V and Article 78 shall apply from 2 August 2025,',
    'with the exception of Article 101.',
  ].join('\n');
  const text = `Recitals\n\n${navigation}\n\n${'background paragraph. '.repeat(300)}\n\n${body}`;
  const excerpt = selectExcerpt(text, ['article', '113', 'apply', '2025', 'gpai'], 1_800);
  assert.match(excerpt, /shall apply from 2 August 2025/u);
  assert.doesNotMatch(excerpt, /^Recitals$/u);
});

test('a clause/date question adds the official article directly', async () => {
  const fetched: string[] = [];
  const value = await createResearchDefinition(
    RESEARCH_TOOL_NAME,
    async () => ({
      sources: [{ url: 'https://aggregator.example/ai-act', title: 'AI Act summary', snippet: 'GPAI obligations' }],
      failures: [],
    }),
    async (url) => {
      fetched.push(url);
      return {
        url,
        status: 200,
        text: `Article 113\n\nChapter III Section 4 and Article 78 shall apply from 2 August 2025. `.repeat(20),
        truncated: false,
      };
    },
  ).execute({ query: '欧盟 AI Act 的 GPAI 义务从哪一天开始适用？依据是哪一条？', maxSources: 1 }, {});
  assert.ok(fetched.includes('https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-113'));
  assert.match(value.pages[0]?.excerpt ?? '', /2 August 2025/u);
});
