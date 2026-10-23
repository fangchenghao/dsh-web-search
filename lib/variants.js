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
/** Segments that ask rather than name. */
const QUESTION_PREFIX = /^(如何|怎么|怎样|为什么|为何|哪些|什么|多少|请问|帮我|帮忙|查一下|介绍一下|介绍|解释一下|解释|说明一下|说明|有没有|是否|想知道|求)/u;
/** Whole segments that add intent rather than retrieval signal. */
const INTENT_SEGMENTS = new Set([
    '定位', '介绍', '含义', '意思', '意义', '区别', '对比', '比较', '方法',
    '教程', '步骤', '指南', '攻略', '用法', '示例', '例子', '作用', '原理',
    '配置', '安装', '使用', '设置', '部署', '怎么用', '如何用', '有哪些',
]);
/** Characters that make a segment CJK. */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
/** Split a query into the labels a user separated with spaces. */
function segmentsOf(query) {
    return query.trim().split(/\s+/u).filter((segment) => segment.length > 0);
}
/** Strip a leading question word and report whether anything usable is left. */
function contentOf(segment) {
    const stripped = segment.replace(QUESTION_PREFIX, '').trim();
    if (stripped.length < 2)
        return undefined;
    if (INTENT_SEGMENTS.has(stripped))
        return undefined;
    return stripped;
}
/** Whether a whole segment only carries intent. */
function isIntent(segment) {
    return INTENT_SEGMENTS.has(segment) || QUESTION_PREFIX.test(segment);
}
/**
 * Build at most one alternate query for a whole-phrase engine.
 * @param query - the user's original query.
 * @returns a single variant, or an empty array when none is likely useful.
 */
export function cjkQueryVariants(query) {
    if (!CJK.test(query))
        return [];
    const segments = segmentsOf(query);
    if (segments.length < 2)
        return [];
    const ascii = segments.some((segment) => /^[a-z0-9][a-z0-9.+#_-]*$/iu.test(segment));
    const variant = ascii
        ? segments
            .filter((segment) => !isIntent(segment))
            .map((segment) => contentOf(segment) ?? '')
            .filter((segment) => segment.length > 0)
            .join(' ')
        : (contentOf(segments[0] ?? '') ?? '');
    if (variant.length === 0)
        return [];
    if (variant.toLowerCase() === query.trim().replace(/\s+/gu, ' ').toLowerCase())
        return [];
    return [variant];
}
