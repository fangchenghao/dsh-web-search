/**
 * The arXiv query router, URL mapper and merge order.
 *
 * @module dsh-web-search-bing/test/arxiv
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { arxivLookup, arxivQueryText, mergeArxiv } from '../src/arxiv.ts';
import { arxivHtmlUrl, arxivReadableUrl, parseArxivUrl } from '../src/arxiv-url.ts';

test('explicit arXiv paper queries are routed, ordinary arXiv questions are not', () => {
  assert.equal(arxivQueryText('retrieval augmented generation survey arXiv'), 'retrieval augmented generation survey');
  assert.equal(arxivQueryText('arXiv:1706.03762'), '1706.03762');
  assert.equal(arxivQueryText('latest arxiv papers on RAG'), 'latest papers on RAG');
  assert.equal(arxivQueryText('arxiv.org 论文 综述'), '论文 综述');
  assert.equal(arxivQueryText('what is arxiv?'), undefined);
  assert.equal(arxivQueryText('how to use arxiv'), undefined);
  assert.equal(arxivQueryText('Rust tutorial'), undefined);
  assert.equal(arxivQueryText(''), undefined);
});

test('arXiv URLs keep their version and old-style archive prefix', () => {
  assert.deepEqual(parseArxivUrl('https://arxiv.org/pdf/2506.06962v3.pdf'), { id: '2506.06962', kind: 'pdf', version: '3' });
  assert.deepEqual(parseArxivUrl('https://export.arxiv.org/abs/hep-th/9901001'), { id: 'hep-th/9901001', kind: 'abs' });
  assert.equal(parseArxivUrl('https://example.com/abs/2506.06962'), undefined);
  assert.equal(arxivReadableUrl('https://arxiv.org/pdf/2506.06962'), 'https://arxiv.org/html/2506.06962');
  assert.equal(arxivReadableUrl('https://arxiv.org/abs/2506.06962'), 'https://arxiv.org/abs/2506.06962');
  assert.equal(arxivHtmlUrl({ id: '2506.06962', kind: 'pdf', version: '3' }), 'https://arxiv.org/html/2506.06962v3');
});

test('arXiv rows lead and duplicates do not repeat', () => {
  const ordinary = [
    { url: 'https://example.test/other', title: 'Other', snippet: 'other' },
    { url: 'https://arxiv.org/abs/2506.06962', title: 'Duplicate', snippet: 'duplicate' },
  ];
  const papers = [
    { url: 'https://arxiv.org/abs/2506.06962', title: 'Paper', snippet: 'paper' },
    { url: 'https://arxiv.org/abs/2506.06962v3', title: 'Version', snippet: 'version' },
  ];
  assert.deepEqual(mergeArxiv(ordinary, papers), [papers[0], papers[1], ordinary[0]]);
  assert.deepEqual(mergeArxiv(ordinary, []), ordinary);
});

test('arxivLookup is a no-op for a query without arXiv intent', async () => {
  assert.deepEqual(await arxivLookup('ordinary web search'), []);
});
