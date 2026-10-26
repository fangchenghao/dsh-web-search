/**
 * Recognize arXiv page URLs and map PDF requests to the HTML full-text view.
 *
 * arXiv serves the same paper as `/abs/<id>` (metadata and abstract),
 * `/html/<id>` (full text) and `/pdf/<id>` (binary PDF). This plugin converts
 * HTML and text to Markdown but deliberately does not pretend binary PDF bytes
 * are prose, so a PDF link is read through the HTML view instead.
 *
 * @module @fangchenghao/dsh-web-search/arxiv-url
 */
const HOST = /^(?:www\.|export\.)?arxiv\.org$/iu;
/**
 * Parse an arXiv abs/html/pdf URL.
 *
 * @param url - any URL string.
 * @returns the identifier and kind, or `undefined` for other hosts.
 */
export function parseArxivUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return undefined;
    }
    if (!HOST.test(parsed.hostname))
        return undefined;
    const match = /^\/(abs|html|pdf)\/(.+?)\/?$/iu.exec(parsed.pathname);
    if (match === null)
        return undefined;
    const kind = match[1]?.toLowerCase();
    let raw = match[2] ?? '';
    raw = raw.replace(/\.pdf$/iu, '');
    const versionMatch = /v(\d+)$/iu.exec(raw);
    const version = versionMatch?.[1];
    const id = version === undefined ? raw : raw.slice(0, -versionMatch[0].length);
    if (id.length === 0 || !/[a-z0-9]/iu.test(id))
        return undefined;
    return { id, kind, ...(version === undefined ? {} : { version }) };
}
/**
 * The HTML full-text URL for a paper.
 *
 * @param reference - parsed arXiv URL.
 * @returns an `https://arxiv.org/html/...` URL.
 */
export function arxivHtmlUrl(reference) {
    const suffix = reference.version === undefined ? '' : `v${reference.version}`;
    return `https://arxiv.org/html/${reference.id}${suffix}`;
}
/**
 * Map a PDF URL to the HTML view; leave other URLs alone.
 *
 * @param url - the caller's URL.
 * @returns the URL the fetch ladder should read.
 */
export function arxivReadableUrl(url) {
    const reference = parseArxivUrl(url);
    if (reference === undefined || reference.kind !== 'pdf')
        return url;
    return arxivHtmlUrl(reference);
}
