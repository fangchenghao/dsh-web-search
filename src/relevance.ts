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

/** Runs of CJK characters (Han, kana, Hangul). */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/gu;

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

/** Common CJK function-word bigrams that match almost any page. */
const CJK_STOPWORDS = new Set([
  '的是', '了吗', '什么', '怎么', '如何', '哪些', '多少', '一下', '请问',
  '帮我', '告诉', '介绍', '以及', '或者', '还是', '就是', '可以', '需要',
]);

/**
 * Build the overlap profile for a query.
 * @param query - the user's question.
 * @returns the profile; `cjk` is false for an English-only query.
 */
export function queryProfile(query: string): QueryProfile {
  const text = query.toLowerCase();
  const tokens = new Map<string, QueryToken>();
  let cjk = false;
  for (const run of text.match(CJK_RUN) ?? []) {
    cjk = true;
    if (run.length === 1) {
      // A one-character query has no bigram; keep the character itself so the
      // check still has something to match.
      tokens.set(run, { text: run, weight: 1 });
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!CJK_STOPWORDS.has(bigram)) tokens.set(bigram, { text: bigram, weight: 1 });
    }
  }
  // A specific ASCII word is stronger evidence than a two-character slice of a
  // Chinese phrase: a PostgreSQL page can match `postgres` without containing
  // any of the Chinese words around it, and dropping it would be worse than
  // keeping a dictionary page.
  for (const word of text.match(/[a-z][a-z0-9.+#_-]{2,}/gu) ?? []) tokens.set(word, { text: word, weight: 2 });
  const required = !cjk || tokens.size <= 1 ? 1 : Math.min(3, Math.max(2, Math.ceil(tokens.size * 0.2)));
  return { cjk, tokens: [...tokens.values()], required };
}

/**
 * Whether one row talks about the query at all.
 * @param source - engine row with title, snippet and URL.
 * @param profile - prepared query tokens.
 * @returns true when at least `profile.required` distinct tokens appear.
 */
export function isRelevant(source: Source, profile: QueryProfile): boolean {
  if (!profile.cjk) return true;
  let haystack = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
  try {
    haystack += ` ${decodeURIComponent(source.url)}`.toLowerCase();
  } catch {
    haystack += ` ${source.url}`.toLowerCase();
  }
  let matched = 0;
  for (const token of profile.tokens) {
    if (haystack.includes(token.text)) {
      matched += token.weight;
      if (matched >= profile.required) return true;
    }
  }
  return profile.required === 0;
}

/**
 * Drop rows that do not share enough words with a CJK query.
 * @param sources - one engine's rows.
 * @param query - the user's question.
 * @returns the rows that survive; English queries are returned unchanged.
 */
export function filterRelevant(sources: readonly Source[], query: string): Source[] {
  const profile = queryProfile(query);
  if (!profile.cjk) return [...sources];
  return sources.filter((source) => isRelevant(source, profile));
}
