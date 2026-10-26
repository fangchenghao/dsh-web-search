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
/** One recognized arXiv URL. */
export interface ArxivUrl {
    /** Canonical identifier, including an old-style archive prefix. */
    id: string;
    /** Page kind in the original URL. */
    kind: 'abs' | 'html' | 'pdf';
    /** Version suffix, when the URL named one. */
    version?: string;
}
/**
 * Parse an arXiv abs/html/pdf URL.
 *
 * @param url - any URL string.
 * @returns the identifier and kind, or `undefined` for other hosts.
 */
export declare function parseArxivUrl(url: string): ArxivUrl | undefined;
/**
 * The HTML full-text URL for a paper.
 *
 * @param reference - parsed arXiv URL.
 * @returns an `https://arxiv.org/html/...` URL.
 */
export declare function arxivHtmlUrl(reference: ArxivUrl): string;
/**
 * Map a PDF URL to the HTML view; leave other URLs alone.
 *
 * @param url - the caller's URL.
 * @returns the URL the fetch ladder should read.
 */
export declare function arxivReadableUrl(url: string): string;
