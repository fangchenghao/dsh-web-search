---
name: dsh-web-search
description: Search the live web and read the pages behind the results when the DSH web-search plugin provides web_search, research, domain_search, search_many, read_page or web_fetch. Use it for current facts, version numbers, release notes, package metadata, or any answer that needs a citation, instead of guessing.
---

# Live web research with dsh-web-search

The host exposes some or all of these tools. Use the narrowest one that answers
the question, and cite the URLs you actually read.

| Tool | Use it when |
| --- | --- |
| `web_search` | You need candidate URLs. One call returns up to eight de-duplicated rows with title, link and snippet. |
| `research` | The answer needs several sources or citations. One call searches up to three queries, opens the leading pages and returns an evidence pack with a URL under every excerpt. |
| `domain_search` | The question is about a package, repository, paper, Q&A thread or reference entry, and a structured record beats a web page. |
| `search_many` | You have 2–5 distinct questions that should run together instead of one at a time. |
| `read_page` | A page is longer than one fetch and you need the next chunk (pass the `nextOffset` from the previous call). |
| `web_fetch` | You already have the URL and need its readable text. |

## How to ask

- Put the **distinctive words** in the query: an error string, a version, an
  API name. "python requests timeout parameter" beats "how do I fix my request".
- Do not paste whole paragraphs; a search query is a few keywords, not a
  document.
- One `web_search` per fact is usually enough. If the first page of rows does
  not contain the answer, change a word rather than repeating the same query.
- Prefer official documentation, release notes and the project's own repository
  over aggregator pages. The plugin already boosts known authority domains, but
  it cannot read the page for you.

## How to answer

- Quote the page, not the snippet: a snippet can be stale or truncated.
- For a factual claim, link the URL you read, not the search results page.
- When a source contradicts another, say so and show both links rather than
  picking the more convenient one.
- If every fetch fails, report the URLs and the failure reasons; do not invent
  content from the snippet.

## Installing this skill elsewhere

This folder follows the plain `SKILL.md` convention, so it can be copied into a
harness that reads skills from disk (for example `~/.claude/skills/` or a
project's `skills/` directory). The plugin itself is a DSH plugin; other
harnesses need their own way to expose the tools above, but the guidance still
applies whenever equivalent search and fetch tools exist.
