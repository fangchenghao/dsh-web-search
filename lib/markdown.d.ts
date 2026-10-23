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
export declare const DEFAULT_FETCH_MAX_LENGTH = 20000;
/**
 * Decode named and numeric HTML entities.
 *
 * Unknown named entities are preserved verbatim: dropping them would silently
 * delete text, and guessing a codepoint would corrupt it.
 *
 * @param value - text or an attribute value.
 * @returns the decoded text.
 */
export declare function decodeEntities(value: string): string;
/**
 * Convert an HTML document or fragment to readable Markdown or plain text.
 *
 * @param html - the raw markup.
 * @param options - output format and the base URL for relative links.
 * @returns the converted text; an empty or contentless document yields `''`.
 */
export declare function htmlToMarkdown(html: string, options?: RenderOptions): string;
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
export declare function truncateFetchText(content: string, maxLength: number): TruncatedText;
/**
 * Convert a fetched HTML page and apply the configured budget in one step.
 *
 * @param html - the page markup.
 * @param options - format, base URL and character budget.
 * @returns converted content plus the pre-truncation length and cut flag.
 */
export declare function renderFetchText(html: string, options: RenderOptions & {
    readonly maxLength: number;
}): RenderedFetchText;
