/**
 * Query variants for engines that match a whole phrase.
 *
 * `cn.bing` treats a long Chinese query as one phrase: when the phrase is not
 * in its index it falls back to a dictionary page for the first character.
 * `东数西算 枢纽节点` answers correctly, `东数西算 八个国家枢纽节点 定位`
 * answers with ten entries for `东`, and `postgres 逻辑复制` answers with the
 * PostgreSQL manual while `如何配置 postgres 逻辑复制` answers with the
 * dictionary entry for `如何`. Re-asking once with the core words turns those
 * failures back into relevant rows, at the cost of one extra request that the
 * tier's soft deadline bounds.
 *
 * The rule is deliberately small and explainable:
 *
 * - a mixed query (CJK plus ASCII) drops question/action/intent segments and
 *   keeps the technical ones (`如何配置 postgres 逻辑复制` → `postgres 逻辑复制`);
 * - a pure CJK query keeps its first content segment, which is where the entity
 *   usually sits (`东数西算 八个国家枢纽节点 定位` → `东数西算`);
 * - everything else gets no variant, so an ordinary two-word query pays nothing.
 *
 * @module @fangchenghao/dsh-web-search/variants
 */
/**
 * Build at most one alternate query for a whole-phrase engine.
 * @param query - the user's original query.
 * @returns a single variant, or an empty array when none is likely useful.
 */
export declare function cjkQueryVariants(query: string): string[];
