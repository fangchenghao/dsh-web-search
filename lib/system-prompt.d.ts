/**
 * The plugin's small, static system-prompt section.
 *
 * Tool schemas already say what each tool does and when to use it, so this
 * section adds only the one rule the schemas cannot carry: web-derived text is
 * data, even when it looks like an instruction. It is deliberately short; the
 * host already has its own external-content notice for `web_search`/`web_fetch`.
 *
 * Registration is best-effort through Cordis's dynamic `inject`: a headless
 * deployment without the `systemPrompt` service keeps every other capability.
 *
 * @module @fangchenghao/dsh-web-search/system-prompt
 */
import type { InjectableHost } from './inject.ts';
/** Stable section name; lets the host replace or remove exactly this text. */
export declare const SEARCH_PROMPT_SECTION = "dsh-web-search";
/** Section order, just after the host's own web/search guidance. */
export declare const SEARCH_PROMPT_ORDER = 520;
/** The complete prompt text, exported so tests can pin it. */
export declare const SEARCH_PROMPT_TEXT: string;
/**
 * Register the section and return its disposer.
 * @param ctx - plugin context; hosts without `inject` simply skip the section.
 * @param text - prompt body; defaults to {@link SEARCH_PROMPT_TEXT}.
 * @returns a disposer, or `undefined` when the host cannot inject a prompt.
 */
export declare function registerSearchPrompt(ctx: InjectableHost, text?: string): (() => void) | undefined;
