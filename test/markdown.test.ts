/**
 * The HTML → Markdown conversion, tested against real page excerpts.
 *
 * The fixtures are trimmed captures of the pages the plugin actually fetches
 * (see `fixtures/markdown-sources.json` for URLs and exact character ranges),
 * not hand-written markup. Assertions compare whole blocks and their order, so
 * a renderer that keeps the words but loses structure fails here.
 *
 * @module dsh-web-search-bing/test/markdown
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_FETCH_MAX_LENGTH,
  decodeEntities,
  htmlToMarkdown,
  renderFetchText,
  truncateFetchText,
} from '../src/markdown.ts';

/** Read one fixture through its real bytes. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

test('the Wikipedia excerpt loses its navigation and keeps the section in order', async () => {
  const html = await fixture('wikipedia-markdown.html');
  const markdown = htmlToMarkdown(html, { baseUrl: 'https://en.wikipedia.org/wiki/Markdown' });

  // The captured nav carries visible site text and a numeric entity; neither
  // may survive, and the fixture's own provenance comment must not either.
  assert.ok(!markdown.includes('Appearance'), 'the captured nav text leaked into the body');
  assert.ok(!markdown.includes('Change the appearance'), 'the nav tooltip leaked into the body');
  assert.ok(!markdown.includes('live excerpt'), 'the fixture comment leaked into the body');

  assert.equal(
    markdown,
    '## Implementations\n'
      + '\n'
      + 'Implementations of Markdown are available for over a dozen '
      + '[programming languages](https://en.wikipedia.org/wiki/Programming_language); in addition, many '
      + '[applications](https://en.wikipedia.org/wiki/Application_software), platforms and '
      + '[frameworks](https://en.wikipedia.org/wiki/Software_framework) support Markdown.'
      + '[[53]](https://en.wikipedia.org/wiki/Markdown#cite_note-54) For example, Markdown '
      + '[plugins](https://en.wikipedia.org/wiki/Plug-in_(computing)) exist for every major '
      + '[blogging](https://en.wikipedia.org/wiki/Blog) platform.'
      + '[[13]](https://en.wikipedia.org/wiki/Markdown#cite_note-ArsTechnica2014-13)',
  );
  assert.ok(markdown.indexOf('## Implementations') < markdown.indexOf('Implementations of Markdown'));
});

test('the MDN excerpt renders its heading, code block and table with markup', async () => {
  const html = await fixture('mdn-table.html');
  const markdown = htmlToMarkdown(html, {
    baseUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table',
  });

  // `&lt;`/`&gt;` decode inside the heading's inline code.
  assert.ok(markdown.startsWith('# `<table>` HTML table element\n\n'), markdown.slice(0, 80));
  assert.ok(!markdown.includes('&lt;'), 'an escaped entity survived conversion');
  assert.ok(!markdown.includes('&gt;'), 'an escaped entity survived conversion');

  // The code block is fenced with the `brush: html` language hint and keeps
  // blank lines and indentation, including the escaped markup.
  assert.ok(markdown.includes('```html\n<table>\n  <caption>\n'), 'the fenced code block is missing or reflowed');
  assert.ok(markdown.includes('      <th scope="col">Person</th>\n'), 'code indentation was lost');
  assert.ok(markdown.includes('    <tr>\n      <th scope="row" colspan="2">Average age</th>\n'), 'the footer row was lost');
  assert.ok(markdown.includes('\n</table>\n```\n'), 'the code fence did not close after the code');

  // The specs table becomes a Markdown table: header, separator, then body.
  const table = '| Specification |\n'
    + '| --- |\n'
    + '| [HTML # the-table-element](https://html.spec.whatwg.org/multipage/tables.html#the-table-element) |';
  assert.ok(markdown.includes(table), markdown.slice(-400));

  // Structure survives in document order.
  assert.ok(markdown.indexOf('# `<table>`') < markdown.indexOf('```html'));
  assert.ok(markdown.indexOf('```html') < markdown.indexOf('| Specification |'));
});

test('the Python docs excerpt drops the mobile nav and keeps prose, links and a rule', async () => {
  const html = await fixture('python-urllib.html');
  const markdown = htmlToMarkdown(html, {
    baseUrl: 'https://docs.python.org/3/library/urllib.parse.html',
  });

  for (const noise of ['Quick search', 'Theme', 'Python logo', 'main navigation']) {
    assert.ok(!markdown.includes(noise), `nav text survived: ${noise}`);
  }
  assert.equal(
    markdown,
    '# `urllib.parse` — Parse URLs into components\n'
      + '\n'
      + '**Source code:** [Lib/urllib/parse.py](https://github.com/python/cpython/tree/3.15/Lib/urllib/parse.py)\n'
      + '\n'
      + '---\n'
      + '\n'
      + 'This module defines a standard interface to break Uniform Resource Locator (URL) strings up in '
      + 'components (addressing scheme, network location, path etc.), to combine the components back into '
      + 'a URL string, and to convert a “relative URL” to an absolute URL given a “base URL.”',
  );

  // Plain text mode removes the syntax but keeps the same reading order.
  const plain = htmlToMarkdown(html, {
    format: 'text',
    baseUrl: 'https://docs.python.org/3/library/urllib.parse.html',
  });
  assert.ok(!/^#/m.test(plain), 'text mode leaked a heading marker');
  assert.ok(!plain.includes('`'), 'text mode leaked inline-code backticks');
  assert.ok(!plain.includes('**'), 'text mode leaked strong markers');
  assert.ok(!plain.includes(']('), 'text mode leaked link syntax');
  assert.ok(plain.startsWith('urllib.parse — Parse URLs into components¶ ('), plain.slice(0, 80));
  assert.ok(plain.includes('\n\nThis module defines a standard interface'));
});

test('a mixed document converts headings, lists, quotes, code, tables and links in order', () => {
  const html = '<html><body>'
    + '<header><nav><a href="/x">Menu Link</a></nav></header>'
    + '<article>'
    + '<h1>Hello &amp; welcome</h1>'
    + '<p>First <strong>bold</strong> and <em>italic</em> and <code>a &lt; b</code>.</p>'
    + '<h2>Steps</h2>'
    + '<ol start="2"><li>One</li><li>Two<ul><li>Nested</li></ul></li></ol>'
    + '<blockquote><p>Quoted line</p></blockquote>'
    + '<hr>'
    + '<h3>Code</h3>'
    + '<pre><code class="language-ts">const x = 1;\n\nif (x &lt; 2) {}</code></pre>'
    + '<table><thead><tr><th>Name</th><th>Age</th></tr></thead>'
    + '<tbody><tr><td>A|B</td><td>3</td></tr></tbody></table>'
    + '<p><a href="https://example.com/a?x=1&amp;y=2">Link</a> <img src="/img.png" alt="Pic"></p>'
    + '</article>'
    + '<footer>Footer text</footer>'
    + '</body></html>';
  const markdown = htmlToMarkdown(html, { baseUrl: 'https://example.com/base/' });
  assert.equal(
    markdown,
    '# Hello & welcome\n'
      + '\n'
      + 'First **bold** and *italic* and `a < b`.\n'
      + '\n'
      + '## Steps\n'
      + '\n'
      + '2. One\n'
      + '3. Two\n'
      + '   - Nested\n'
      + '\n'
      + '> Quoted line\n'
      + '\n'
      + '---\n'
      + '\n'
      + '### Code\n'
      + '\n'
      + '```ts\n'
      + 'const x = 1;\n'
      + '\n'
      + 'if (x < 2) {}\n'
      + '```\n'
      + '\n'
      + '| Name | Age |\n'
      + '| --- | --- |\n'
      + '| A\\|B | 3 |\n'
      + '\n'
      + '[Link](https://example.com/a?x=1&y=2) ![Pic](https://example.com/img.png)',
  );
  // The header/footer chrome is gone even though it wraps no landmark role.
  assert.ok(!markdown.includes('Menu Link'));
  assert.ok(!markdown.includes('Footer text'));
  assert.ok(!markdown.includes('onclick'));
});

test('when there is no article or main, the densest container wins', () => {
  const prose = 'word '.repeat(80);
  const html = '<html><body>'
    + '<div class="promo"><a href="/buy">Buy now</a></div>'
    + `<div id="content"><h1>Picked</h1><p>${prose}</p></div>`
    + '</body></html>';
  const markdown = htmlToMarkdown(html);
  assert.ok(markdown.startsWith('# Picked\n\nword word'), markdown.slice(0, 40));
  assert.ok(!markdown.includes('Buy now'));
});

test('comments, scripts, hidden nodes and inline handlers never reach the output', () => {
  const html = '<html><body>'
    + '<!-- a secret comment -->'
    + '<div style="display: none">hidden div</div>'
    + '<div hidden>hidden attribute</div>'
    + '<p onclick="alert(1)">Visible <a href="/go" onmouseover="steal()">link</a>.</p>'
    + '<script>const leak = "script text";</script>'
    + '<style>.x { color: red }</style>'
    + '</body></html>';
  assert.equal(htmlToMarkdown(html), 'Visible [link](/go).');
});

test('empty and contentless documents convert to an empty string', () => {
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToMarkdown('   \n\t '), '');
  assert.equal(htmlToMarkdown('<!-- only a comment -->'), '');
  assert.equal(
    htmlToMarkdown('<html><head><title>Title</title></head><body><script>alert(1)</script><nav>menu</nav><footer>foot</footer></body></html>'),
    '',
  );
  assert.equal(htmlToMarkdown('<html><body><p> </p><div></div></body></html>'), '');
});

test('entities decode by name, decimal and hex without eating unknown names', () => {
  assert.equal(
    decodeEntities('&amp; &lt; &gt; &quot; &#39; &#x27; &nbsp; &mdash; &unknown; &copy;'),
    '& < > " \' \'   — &unknown; ©',
  );
  assert.equal(decodeEntities('&amp;amp;'), '&amp;');
  assert.equal(decodeEntities('&#x1F600;'), '😀');
  // Invalid numeric references stay visible instead of becoming replacement runes.
  assert.equal(decodeEntities('&#0; &#x110000;'), '&#0; &#x110000;');
});

test('table cells flatten block content and a headerless first row becomes the header', () => {
  const html = '<table><tr><td><p>one</p><p>two</p></td><td>3</td></tr><tr><td>x</td><td>y</td></tr></table>';
  assert.equal(
    htmlToMarkdown(html),
    '| one two | 3 |\n| --- | --- |\n| x | y |',
  );
  assert.equal(htmlToMarkdown(html, { format: 'text' }), 'one two | 3\nx | y');
});

test('the character budget cuts at the limit and names the original length', () => {
  const content = 'x'.repeat(1500);
  const cut = truncateFetchText(content, 1000);
  assert.equal(cut.truncated, true);
  assert.equal(
    cut.content,
    `${'x'.repeat(1000)}\n\n[truncated at 1000 chars; original length 1500 chars; the rest is not shown]`,
  );

  const exact = truncateFetchText('y'.repeat(1000), 1000);
  assert.deepEqual(exact, { content: 'y'.repeat(1000), truncated: false });

  const shorter = truncateFetchText('short', 1000);
  assert.deepEqual(shorter, { content: 'short', truncated: false });
});

test('renderFetchText reports the converted length, not the HTML length', () => {
  const html = `<html><body><article><h1>Title</h1><p>${'z'.repeat(1200)}</p></article></body></html>`;
  const rendered = renderFetchText(html, { maxLength: 1000 });
  assert.equal(rendered.originalLength, 1209); // "# Title\n\n" + 1200 z
  assert.equal(rendered.truncated, true);
  assert.ok(rendered.content.endsWith('[truncated at 1000 chars; original length 1209 chars; the rest is not shown]'));

  const whole = renderFetchText(html, { maxLength: DEFAULT_FETCH_MAX_LENGTH });
  assert.equal(whole.originalLength, 1209);
  assert.equal(whole.truncated, false);
  assert.equal(whole.content, `# Title\n\n${'z'.repeat(1200)}`);
});
