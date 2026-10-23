/**
 * Lexical relevance for CJK queries.
 *
 * A Chinese query sent to a scraped engine can come back as a dictionary entry
 * for one character of it: `东数西算 八个国家枢纽节点 定位` against `cn.bing`
 * returned `东（汉语文字）`, `东的意思…`, and a company named 李在东, none of
 * which share a word with the question. The engines' own rank order cannot be
 * trusted for those rows, and letting them into the fusion is worse than
 * dropping them: one engine's ten junk rows can outweigh the three good rows
 * another engine found.
 *
 * The check is deliberately lexical and conservative: a CJK query is split into
 * overlapping two-character tokens (its bigrams), and a row must share at least
 * two of them with its title, snippet or URL. Two matches is enough for a page
 * that mentions the entity and the aspect, and it is exactly what a
 * single-character dictionary page cannot produce. English queries are left
 * alone; their engines did not show this failure mode, and an ASCII word
 * overlap would start rejecting legitimate paraphrases.
 *
 * @module @fangchenghao/dsh-web-search/relevance
 */
import type { Source } from './types.ts';
/** One overlap token and how much evidence a match is worth. */
export interface QueryToken {
    text: string;
    /** ASCII words are specific (`postgres`), so a match is worth two bigrams. */
    weight: number;
}
/** A CJK query prepared for overlap checks. */
export interface QueryProfile {
    /** True when the query contains at least one CJK character. */
    cjk: boolean;
    /** Distinct two-character tokens (CJK bigrams) plus ASCII words. */
    tokens: QueryToken[];
    /** How many weight units a row must accumulate. */
    required: number;
}
/**
 * Build the overlap profile for a query.
 * @param query - the user's question.
 * @returns the profile; `cjk` is false for an English-only query.
 */
export declare function queryProfile(query: string): QueryProfile;
/**
 * Whether one row talks about the query at all.
 * @param source - engine row with title, snippet and URL.
 * @param profile - prepared query tokens.
 * @returns true when at least `profile.required` distinct tokens appear.
 */
export declare function isRelevant(source: Source, profile: QueryProfile): boolean;
/**
 * Drop rows that do not share enough words with a CJK query.
 * @param sources - one engine's rows.
 * @param query - the user's question.
 * @returns the rows that survive; English queries are returned unchanged.
 */
export declare function filterRelevant(sources: readonly Source[], query: string): Source[];
