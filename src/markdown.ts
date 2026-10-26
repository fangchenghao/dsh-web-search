/**
 * Dependency-free HTML → readable Markdown for `web_fetch`.
 *
 * A fetched page is mostly furniture: site chrome, a table of contents, ad
 * slots, scripts. Handing that markup to a model wastes its budget on
 * navigation and makes it parse tags instead of reading prose. This module
 * keeps the parts a reader would keep and renders them as Markdown:
 *
 * 1. a tolerant tokenizer and tree builder, because real pages are not XML;
 * 2. a pruning pass that drops chrome tags, comments and hidden nodes;
 * 3. a body selection pass that prefers `<article>`, then `<main>`/`role=main`,
 *    then the densest text container;
 * 4. a renderer for headings, paragraphs, lists, code, quotes, links, images,
 *    rules and tables, with entities decoded and URLs made absolute.
 *
 * It deliberately has no runtime dependency: the plugin ships as plain ESM and
 * a parser package would be the first thing to break on a Node upgrade.
 *
 * @module @fangchenghao/dsh-web-search/markdown
 */

/** Output style selected by `fetchFormat`. */
export type FetchFormat = 'markdown' | 'text';

/** Options shared by the Markdown and plain-text renderers. */
export interface RenderOptions {
  /** `markdown` keeps syntax; `text` keeps only the words. */
  readonly format?: FetchFormat | undefined;
  /** Page URL, used to make relative links absolute. */
  readonly baseUrl?: string | undefined;
}

/** Result of applying the configured character budget. */
export interface TruncatedText {
  readonly content: string;
  readonly truncated: boolean;
}

/** A converted page plus the numbers a truncation notice reports. */
export interface RenderedFetchText {
  /** Converted content, cut to the budget when necessary. */
  readonly content: string;
  /** Length of the converted page before truncation. */
  readonly originalLength: number;
  /** Whether the character budget cut the page. */
  readonly truncated: boolean;
}

/** Default `fetchMaxLength`: about 20k characters of prose. */
export const DEFAULT_FETCH_MAX_LENGTH = 20_000;

/** Named entities that appear in real prose; unknown names are left alone. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hairsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  sup2: '²',
  sup3: '³',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  permil: '‰',
  micro: 'µ',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  minus: '−',
};

/**
 * Decode named and numeric HTML entities.
 *
 * Unknown named entities are preserved verbatim: dropping them would silently
 * delete text, and guessing a codepoint would corrupt it.
 *
 * @param value - text or an attribute value.
 * @returns the decoded text.
 */
export function decodeEntities(value: string): string {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#X[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const hexadecimal = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A text node. */
interface TextNode {
  readonly kind: 'text';
  value: string;
}

/** An element node; `children` stays mutable for the pruning pass. */
interface ElementNode {
  readonly kind: 'element';
  readonly tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

type HtmlNode = TextNode | ElementNode;

/** Tags whose entire subtree is never page content. */
const DROP_TAGS = new Set([
  'script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'iframe',
  'noscript', 'template', 'svg', 'canvas', 'object', 'embed', 'button',
  'select', 'option', 'optgroup', 'input', 'textarea', 'head', 'link',
  'meta', 'base', 'title',
]);

/** Structural roots whose class list may mention chrome without being chrome. */
const NOISE_EXEMPT_TAGS = new Set(['#root', 'html', 'body', 'main', 'article']);

/** ARIA landmark roles that mark chrome rather than content. */
const DROP_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu',
  'menubar', 'toolbar', 'dialog', 'alertdialog',
]);

/** Class/id fragments that mark site furniture on pages without landmarks. */
const NOISE_PATTERN = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|sidebar|side-bar|breadcrumb|footer|header|advert|advertisement|ads?|cookie|consent|banner|social|share|comment|comments|related|recommend|popup|modal|editsection)(?:$|[\s_-])/i;

/** Elements that render inline; everything else is treated as a block. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'strike',
]);

/** Containers the density fallback may pick from. */
const CONTAINER_TAGS = new Set(['body', 'div', 'section', 'article', 'main', 'td', 'center']);

/** HTML void elements, which never take a closing tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Elements whose contents are raw text, not markup. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);

/** Tags that implicitly close an open paragraph. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dt',
  'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
]);

/** Build an element node. */
function element(tag: string, attrs: Record<string, string>): ElementNode {
  return { kind: 'element', tag, attrs, children: [] };
}

/** Find the `>` that ends an opening tag, ignoring quoted attribute values. */
function findTagEnd(html: string, from: number): number {
  let quote = '';
  for (let index = from; index < html.length; index += 1) {
    const char = html.charAt(index);
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

/** Parse attributes, dropping inline event handlers. */
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null = pattern.exec(raw);
  while (match !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (name.length > 0 && !name.startsWith('on')) {
      attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    }
    match = pattern.exec(raw);
  }
  return attrs;
}

/**
 * Parse a document into a tolerant tree.
 *
 * The builder is deliberately forgiving: unknown tags become containers, stray
 * closing tags are ignored, and implicit closes for `p`, `li`, table parts and
 * `option` keep real-world markup in the shape a browser would produce.
 *
 * @param html - the document or fragment.
 * @returns the synthetic `#root` element.
 */
function parseHtml(html: string): ElementNode {
  const root = element('#root', {});
  const stack: ElementNode[] = [root];

  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    const previous = top.children[top.children.length - 1];
    if (previous !== undefined && previous.kind === 'text') previous.value += value;
    else top.children.push({ kind: 'text', value });
  };

  const closeNearest = (names: readonly string[], boundaries: readonly string[]): void => {
    for (let index = stack.length - 1; index >= 1; index -= 1) {
      const open = stack[index];
      if (open === undefined) continue;
      if (names.includes(open.tag)) {
        stack.length = index;
        return;
      }
      if (boundaries.includes(open.tag)) return;
    }
  };

  const closeTag = (name: string): void => {
    for (let index = stack.length - 1; index >= 1; index -= 1) {
      const open = stack[index];
      if (open === undefined) continue;
      if (open.tag === name) {
        stack.length = index;
        return;
      }
      if (open.tag === 'body' || open.tag === 'html') return;
    }
  };

  const openTag = (name: string, attrs: Record<string, string>, selfClosing: boolean): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    if (top.tag === 'p' && BLOCK_TAGS.has(name)) stack.pop();
    if (name === 'li') closeNearest(['li'], ['ul', 'ol']);
    else if (name === 'dt' || name === 'dd') closeNearest(['dt', 'dd'], ['dl']);
    else if (name === 'tr') closeNearest(['tr'], ['table', 'tbody', 'thead', 'tfoot']);
    else if (name === 'td' || name === 'th') closeNearest(['td', 'th'], ['tr', 'table']);
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeNearest(['thead', 'tbody', 'tfoot'], ['table']);
    else if (name === 'option') closeNearest(['option'], ['select', 'datalist', 'optgroup']);

    const parent = stack[stack.length - 1];
    if (parent === undefined) return;
    const node = element(name, attrs);
    parent.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node);
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      pushText(html.slice(index));
      break;
    }
    if (lt > index) pushText(html.slice(index, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      // CDATA is text in XML feeds, not markup to discard.
      pushText(html.slice(lt + 9, end === -1 ? html.length : end));
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt + 2);
      const name = html
        .slice(lt + 2, end === -1 ? html.length : end)
        .trim()
        .toLowerCase();
      if (name.length > 0) closeTag(name);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = findTagEnd(html, lt + 1);
    if (end === -1) {
      pushText(html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, end);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const match = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(body);
    if (match === null) {
      pushText(html.slice(lt, end + 1));
      index = end + 1;
      continue;
    }
    const name = (match[0] ?? '').toLowerCase();
    index = end + 1;

    if (RAW_TEXT_TAGS.has(name)) {
      const closeAt = html.toLowerCase().indexOf(`</${name}`, index);
      if (closeAt === -1) {
        index = html.length;
        continue;
      }
      const closeEnd = html.indexOf('>', closeAt);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }

    openTag(name, parseAttributes(body.slice(match[0].length)), selfClosing);
  }

  return root;
}

/** Decode all visible text below a node, without Markdown syntax. */
function textOf(node: HtmlNode): string {
  if (node.kind === 'text') return decodeEntities(node.value);
  if (node.tag === 'br') return '\n';
  if (node.tag === 'img') return node.attrs['alt'] ?? '';
  if (DROP_TAGS.has(node.tag)) return '';
  let text = '';
  for (const child of node.children) text += textOf(child);
  return text;
}

/** Count element descendants, used by the density fallback. */
function elementCount(node: ElementNode): number {
  let count = 0;
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    count += 1 + elementCount(child);
  }
  return count;
}

/** Visit every descendant element, children first order. */
function walkElements(node: ElementNode, visit: (child: ElementNode) => void): void {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    visit(child);
    walkElements(child, visit);
  }
}

/** First descendant matching a predicate. */
function findElement(node: ElementNode, predicate: (child: ElementNode) => boolean): ElementNode | undefined {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (predicate(child)) return child;
    const found = findElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Prune chrome, hidden nodes and noise class/id containers in place. */
function prune(node: ElementNode): void {
  const kept: HtmlNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'text') {
      kept.push(child);
      continue;
    }
    if (DROP_TAGS.has(child.tag)) continue;
    // A wrapper whose class says "footer" may still contain the page's main
    // article. arXiv currently wraps its whole document in
    // `div.flex-wrap-footer`; dropping that wrapper removed every readable
    // character from the abstract page. Chrome inside the wrapper is still
    // pruned by its own tag/attributes.
    if (!NOISE_EXEMPT_TAGS.has(child.tag) && isNoise(child) && !containsLandmark(child)) continue;
    prune(child);
    kept.push(child);
  }
  node.children = kept;
}

/** Whether a subtree contains a real content landmark. */
function containsLandmark(node: ElementNode): boolean {
  let found = false;
  walkElements(node, (child) => {
    if (child.tag === 'main' || child.tag === 'article') found = true;
  });
  return found;
}

/** Whether an element is hidden or named like site furniture. */
function isNoise(node: ElementNode): boolean {
  const role = (node.attrs['role'] ?? '').toLowerCase();
  if (DROP_ROLES.has(role)) return true;
  if (node.attrs['hidden'] !== undefined) return true;
  const style = node.attrs['style'];
  if (style !== undefined && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  const marker = `${node.attrs['class'] ?? ''} ${node.attrs['id'] ?? ''}`;
  return marker.trim().length > 0 && NOISE_PATTERN.test(marker);
}

/** Visible character count with whitespace collapsed. */
function characterCount(node: ElementNode): number {
  return textOf(node).replace(/\s+/g, ' ').trim().length;
}

/** Score a container by how much prose it holds per unit of markup. */
function density(node: ElementNode): number {
  const characters = characterCount(node);
  return characters === 0 ? 0 : characters / (1 + elementCount(node));
}

/** True when most of a container's text is one <pre> block (an appendix, not prose). */
function codeDominated(node: ElementNode): boolean {
  const pre = findElement(node, (child) => child.tag === 'pre');
  if (pre === undefined) return false;
  const characters = characterCount(node);
  return characters > 0 && characterCount(pre) >= characters * 0.6;
}

/** Highest-density container, favouring the one that carries the most text. */
function densestContainer(body: ElementNode): ElementNode {
  let best = body;
  let bestScore = density(body);
  let bestCharacters = characterCount(body);
  walkElements(body, (node) => {
    if (!CONTAINER_TAGS.has(node.tag)) return;
    const characters = characterCount(node);
    if (characters < 120) return;
    // An appendix that is one huge ABNF/code block has a very high text/markup
    // ratio, but it is not the page's prose. Skipping it lets the body or a
    // prose section win; the body fallback still keeps the code.
    if (codeDominated(node)) return;
    const score = density(node);
    if (score > bestScore || (score === bestScore && characters > bestCharacters)) {
      best = node;
      bestScore = score;
      bestCharacters = characters;
    }
  });
  return best;
}

/** Largest container by visible text, used when density picks a stub. */
function largestContainer(body: ElementNode): ElementNode {
  let best = body;
  let bestCharacters = characterCount(body);
  walkElements(body, (node) => {
    if (!CONTAINER_TAGS.has(node.tag)) return;
    const characters = characterCount(node);
    if (characters > bestCharacters) {
      best = node;
      bestCharacters = characters;
    }
  });
  return best;
}

/** Pick the reading root: article, main, then the densest container. */
function pickMain(root: ElementNode): ElementNode {
  const body = findElement(root, (node) => node.tag === 'body') ?? root;

  let article: ElementNode | undefined;
  let articleCharacters = -1;
  walkElements(body, (node) => {
    if (node.tag !== 'article') return;
    const characters = characterCount(node);
    if (characters > articleCharacters) {
      article = node;
      articleCharacters = characters;
    }
  });
  const main = findElement(
    body,
    (node) => node.tag === 'main' || (node.attrs['role'] ?? '').toLowerCase() === 'main',
  );
  const densest = densestContainer(body);

  // A `<main>` or `<article>` that holds almost nothing is a layout shell, not
  // the reading root: github.com returns half a megabyte of HTML whose `main`
  // is a sidebar, which used to convert to zero characters and look like a
  // network failure. Only trust a landmark that keeps a real share of the text.
  const bodyCharacters = characterCount(body);
  const floor = Math.min(2_000, Math.max(120, Math.round(bodyCharacters * 0.25)));
  const landmarks: ReadonlyArray<ElementNode | undefined> = [article, main];
  for (const landmark of landmarks) {
    if (landmark !== undefined && characterCount(landmark) >= floor) return landmark;
  }
  // A single section can be denser than the whole body on long documents with
  // no <article>/<main> (RFC 9110 has dozens of sections). Choosing it makes
  // the rest of the document unreachable; only trust density when it carries
  // at least half the page's text.
  if (characterCount(densest) >= floor && characterCount(densest) * 2 > bodyCharacters) return densest;
  // Density alone can crown a short, dense stub — a comment form or a footer —
  // while the prose sits in a container with more markup and fewer characters
  // per tag. Prefer a container that still holds a real share of the page text,
  // then fall back to the body when every candidate is a fragment.
  const largest = largestContainer(body);
  if (characterCount(largest) >= floor) return largest;
  const ranked = [article, main, densest, largest].filter((node): node is ElementNode => node !== undefined);
  ranked.sort((left, right) => characterCount(right) - characterCount(left));
  const best = ranked[0] ?? body;
  return characterCount(best) * 2 < characterCount(body) ? body : best;
}

/** Rendering context: output style, base URL and protected code fragments. */
interface RenderContext {
  readonly format: FetchFormat;
  readonly baseUrl: string | undefined;
  readonly stash: string[];
}

/** Replace a code fragment with a placeholder so clean-up cannot touch it. */
function stashCode(ctx: RenderContext, text: string): string {
  ctx.stash.push(text);
  return `\uE000${ctx.stash.length - 1}\uE001`;
}

/** Put stashed code fragments back after whitespace clean-up. */
function restoreCode(text: string, ctx: RenderContext): string {
  let out = text;
  for (let index = 0; index < ctx.stash.length; index += 1) {
    out = out.split(`\uE000${index}\uE001`).join(ctx.stash[index] ?? '');
  }
  return out;
}

/** Collapse source whitespace inside prose, leaving block separators alone. */
function collapseInline(value: string): string {
  return value.replace(/[\t\n\r\f ]+/g, ' ');
}

/** Normalise block output: line endings, trailing spaces, blank runs. */
function cleanup(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** Longest run of one character, used to pick a safe code fence. */
function longestRun(value: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === character) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Make a link target absolute and reject script-bearing schemes. */
function absoluteUrl(raw: string, baseUrl: string | undefined): string {
  const value = raw.trim();
  if (value.length === 0) return '';
  if (/^(?:javascript|data|vbscript):/i.test(value)) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^(?:https?|mailto|ftp):/i.test(value)) return '';
  if (baseUrl === undefined) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

/** Wrap inline content in a Markdown marker, keeping surrounding spaces. */
function wrapInline(inner: string, marker: string, format: FetchFormat): string {
  if (format === 'text') return inner;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (match === null) return inner;
  const leading = match[1] ?? '';
  const core = match[2] ?? '';
  const trailing = match[3] ?? '';
  return core.length === 0 ? inner : `${leading}${marker}${core}${marker}${trailing}`;
}

/** Render every child as inline content, separating adjacent blocks. */
function inlineChildren(node: ElementNode, ctx: RenderContext): string {
  let out = '';
  for (const child of node.children) {
    const part = inlineNode(child, ctx);
    if (part.length === 0) continue;
    const block = child.kind === 'element' && child.tag !== 'br' && !INLINE_TAGS.has(child.tag);
    if (block && out.length > 0 && !/\s$/.test(out) && !/^\s/.test(part)) out += ' ';
    out += part;
  }
  return out;
}

/** Render one node as inline content. */
function inlineNode(node: HtmlNode, ctx: RenderContext): string {
  if (node.kind === 'text') return collapseInline(decodeEntities(node.value));
  if (DROP_TAGS.has(node.tag)) return '';
  return inlineElement(node, ctx);
}

/** Render one element as inline content. */
function inlineElement(node: ElementNode, ctx: RenderContext): string {
  switch (node.tag) {
    case 'br':
      return '\n';
    case 'img': {
      const source = absoluteUrl(node.attrs['src'] ?? node.attrs['data-src'] ?? '', ctx.baseUrl);
      const alt = node.attrs['alt'] ?? '';
      if (source.length === 0 || ctx.format === 'text') return alt;
      return `![${alt.replace(/]/g, '\\]')}](${source})`;
    }
    case 'a': {
      const href = absoluteUrl(node.attrs['href'] ?? '', ctx.baseUrl);
      const inner = inlineChildren(node, ctx);
      if (ctx.format === 'text') return href.length === 0 ? inner : `${inner} (${href})`;
      if (href.length === 0) return inner;
      const label = inner.trim();
      // Documentation sites (Python's Sphinx, many others) attach a "¶" permalink
      // to every heading. Keeping it turns every heading into a broken-looking
      // `[¶](...#id)` fragment in the Markdown a model has to read.
      if (label === '¶' || label === '#' || label === '§' || label === '🔗' || label === '↩') return '';
      // A link whose text is its own URL adds nothing over an autolink.
      if (label === href) return `<${href}>`;
      return `[${label.length === 0 ? href : inner}](${href})`;
    }
    case 'code': {
      const text = textOf(node).replace(/\s+/g, ' ').trim();
      if (text.length === 0) return '';
      if (ctx.format === 'text') return stashCode(ctx, text);
      const fence = '`'.repeat(longestRun(text, '`') + 1);
      const pad = /^\s|^`|`$|\s$/.test(text) ? ' ' : '';
      return stashCode(ctx, `${fence}${pad}${text}${pad}${fence}`);
    }
    case 'strong':
    case 'b':
      return wrapInline(inlineChildren(node, ctx), '**', ctx.format);
    case 'em':
    case 'i':
      return wrapInline(inlineChildren(node, ctx), '*', ctx.format);
    case 'del':
    case 's':
    case 'strike':
      return wrapInline(inlineChildren(node, ctx), '~~', ctx.format);
    case 'q':
      return ctx.format === 'markdown' ? `"${inlineChildren(node, ctx)}"` : inlineChildren(node, ctx);
    default:
      return inlineChildren(node, ctx);
  }
}

/** Render every child as block content. */
function renderChildren(node: ElementNode, ctx: RenderContext): string {
  let out = '';
  for (const child of node.children) out += renderNode(child, ctx);
  return out;
}

/** Render one node as block content. */
function renderNode(node: HtmlNode, ctx: RenderContext): string {
  if (node.kind === 'text') return collapseInline(decodeEntities(node.value));
  if (DROP_TAGS.has(node.tag)) return '';
  return renderElement(node, ctx);
}

/** Render one element as block content. */
function renderElement(node: ElementNode, ctx: RenderContext): string {
  if (/^h[1-6]$/.test(node.tag)) {
    const level = Number.parseInt(node.tag.slice(1), 10);
    const text = inlineChildren(node, ctx).trim();
    if (text.length === 0) return '';
    const prefix = ctx.format === 'markdown' ? `${'#'.repeat(level)} ` : '';
    return `\n\n${prefix}${text}\n\n`;
  }
  switch (node.tag) {
    case 'p':
      return `\n\n${inlineChildren(node, ctx).trim()}\n\n`;
    case 'pre':
      return `\n\n${renderPre(node, ctx)}\n\n`;
    case 'ul':
    case 'ol':
      return `\n\n${renderList(node, ctx)}\n\n`;
    case 'blockquote': {
      const inner = cleanup(renderChildren(node, ctx));
      if (inner.length === 0) return '';
      if (ctx.format === 'text') return `\n\n${inner.replace(/^/gm, '  ')}\n\n`;
      const quoted = inner
        .split('\n')
        .map((line) => (line.length === 0 ? '>' : `> ${line}`))
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    case 'table':
      return `\n\n${renderTable(node, ctx)}\n\n`;
    case 'hr':
      return ctx.format === 'markdown' ? '\n\n---\n\n' : '\n\n';
    case 'br':
      return '\n';
    case 'img':
    case 'a':
    case 'code':
      return inlineElement(node, ctx);
    case 'dl':
      return `\n\n${renderChildren(node, ctx)}\n\n`;
    case 'dt': {
      const text = inlineChildren(node, ctx).trim();
      return text.length === 0 ? '' : `\n\n${ctx.format === 'markdown' ? `**${text}**` : text}\n\n`;
    }
    case 'dd': {
      const text = inlineChildren(node, ctx).trim();
      return text.length === 0 ? '' : `\n\n${text}\n\n`;
    }
    case 'summary':
      return `\n\n${inlineChildren(node, ctx).trim()}\n\n`;
    default:
      if (INLINE_TAGS.has(node.tag)) return inlineElement(node, ctx);
      return `\n\n${renderChildren(node, ctx)}\n\n`;
  }
}

/** Language hint from `class="language-x"`, `lang-x` or `brush: x`. */
function codeLanguage(node: ElementNode): string {
  let marker = node.attrs['class'] ?? '';
  const code = node.children.find((child): child is ElementNode => child.kind === 'element' && child.tag === 'code');
  if (code !== undefined) marker += ` ${code.attrs['class'] ?? ''}`;
  const match = /(?:language-|lang-|brush:\s*)([A-Za-z0-9_+#.-]+)/i.exec(marker);
  return match === null ? '' : (match[1] ?? '').toLowerCase();
}

/** Render a `<pre>` block, fence included for Markdown output. */
function renderPre(node: ElementNode, ctx: RenderContext): string {
  const content = textOf(node)
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');
  if (content.length === 0) return '';
  if (ctx.format === 'text') return stashCode(ctx, content);
  const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
  const language = codeLanguage(node);
  return stashCode(ctx, `${fence}${language}\n${content}\n${fence}`);
}

/** Render one list item, including any nested lists. */
function renderListItem(item: ElementNode, ctx: RenderContext, marker: string): string {
  const nested: ElementNode[] = [];
  const parts: string[] = [];
  for (const child of item.children) {
    if (child.kind === 'element' && (child.tag === 'ul' || child.tag === 'ol')) {
      nested.push(child);
      continue;
    }
    parts.push(renderNode(child, ctx));
  }
  const body = cleanup(parts.join('')).replace(/\n{2,}/g, '\n');
  const indent = ' '.repeat(marker.length);
  let out = '';
  const lines = body.length === 0 ? [] : body.split('\n');
  const first = lines[0] ?? '';
  out = `${marker}${first}`.trimEnd();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    out += line.length === 0 ? '\n' : `\n${indent}${line}`;
  }
  for (const list of nested) {
    const rendered = cleanup(renderList(list, ctx));
    for (const line of rendered.split('\n')) out += `\n${indent}${line}`;
  }
  return out;
}

/** Render an ordered or unordered list. */
function renderList(node: ElementNode, ctx: RenderContext): string {
  const ordered = node.tag === 'ol';
  const parsedStart = Number.parseInt(node.attrs['start'] ?? '1', 10);
  const start = Number.isFinite(parsedStart) && parsedStart > 0 ? parsedStart : 1;
  const items = node.children.filter(
    (child): child is ElementNode => child.kind === 'element' && child.tag === 'li',
  );
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const marker = ordered ? `${start + index}. ` : ctx.format === 'markdown' ? '- ' : '• ';
    lines.push(renderListItem(item, ctx, marker));
  }
  return lines.join('\n');
}

/** Collect table rows without descending into a nested table. */
function collectRows(node: ElementNode, rows: ElementNode[]): void {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (child.tag === 'tr') {
      rows.push(child);
    } else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
      collectRows(child, rows);
    }
  }
}

/** Render a table as a Markdown table with a header separator row. */
function renderTable(node: ElementNode, ctx: RenderContext): string {
  const rows: ElementNode[] = [];
  collectRows(node, rows);
  const matrix: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const child of row.children) {
      if (child.kind !== 'element' || (child.tag !== 'td' && child.tag !== 'th')) continue;
      const cell = inlineChildren(child, ctx).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
      cells.push(cell);
    }
    if (cells.length > 0) matrix.push(cells);
  }
  if (matrix.length === 0) return '';
  let columns = 0;
  for (const row of matrix) columns = Math.max(columns, row.length);
  const padded = matrix.map((row) => {
    const copy = [...row];
    while (copy.length < columns) copy.push('');
    return copy;
  });
  if (ctx.format === 'text') return padded.map((row) => row.join(' | ')).join('\n');
  const header = padded[0] ?? [];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of padded.slice(1)) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/**
 * Convert an HTML document or fragment to readable Markdown or plain text.
 *
 * @param html - the raw markup.
 * @param options - output format and the base URL for relative links.
 * @returns the converted text; an empty or contentless document yields `''`.
 */
export function htmlToMarkdown(html: string, options: RenderOptions = {}): string {
  if (typeof html !== 'string') return '';
  const trimmed = html.trim();
  if (trimmed.length === 0) return '';
  const root = parseHtml(trimmed);
  prune(root);
  const body = findElement(root, (node) => node.tag === 'body') ?? root;
  if (characterCount(body) === 0) return '';
  const renderFrom = (node: ElementNode): string => {
    const ctx: RenderContext = {
      format: options.format ?? 'markdown',
      baseUrl: options.baseUrl,
      stash: [],
    };
    return restoreCode(cleanup(renderElement(node, ctx)), ctx).trim();
  };

  const main = pickMain(root);
  const chosen = renderFrom(main);
  // Last guard: if the landmark produced (almost) nothing while the page holds
  // real prose, read the body instead of returning an empty document.
  if (chosen.length < 120 && characterCount(body) >= 400) {
    const whole = renderFrom(body);
    if (whole.length > chosen.length) return whole;
  }
  return chosen;
}

/**
 * Apply the output character budget.
 *
 * The notice names both the configured limit and the original converted
 * length, so a reader knows how much is missing and can ask for a narrower URL.
 *
 * @param content - converted content.
 * @param maxLength - configured character budget.
 * @returns the content, cut with a notice when it exceeded the budget.
 */
export function truncateFetchText(content: string, maxLength: number): TruncatedText {
  const limit = Number.isFinite(maxLength) && maxLength >= 1 ? Math.floor(maxLength) : DEFAULT_FETCH_MAX_LENGTH;
  if (content.length <= limit) return { content, truncated: false };
  let cut = content.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  // Never leave half of a surrogate pair at the cut point.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.replace(/\s+$/, '');
  const notice = `\n\n[truncated at ${limit} chars; original length ${content.length} chars; the rest is not shown]`;
  return { content: `${cut}${notice}`, truncated: true };
}

/**
 * Convert a fetched HTML page and apply the configured budget in one step.
 *
 * @param html - the page markup.
 * @param options - format, base URL and character budget.
 * @returns converted content plus the pre-truncation length and cut flag.
 */
export function renderFetchText(
  html: string,
  options: RenderOptions & { readonly maxLength: number },
): RenderedFetchText {
  const converted = htmlToMarkdown(html, {
    format: options.format ?? 'markdown',
    baseUrl: options.baseUrl,
  });
  const limited = truncateFetchText(converted, options.maxLength);
  return {
    content: limited.content,
    originalLength: converted.length,
    truncated: limited.truncated,
  };
}
