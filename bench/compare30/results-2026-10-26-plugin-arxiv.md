# 30-query keyless comparison

Generated: 2026-10-26T08:58:27.747Z

## Method

- Same 30 queries, same top-8 budget, same machine and network route.
- Plugin arm: `search()` plus the narrow official-release and explicit-arXiv lookups, no cache, 15 s timeout.
- Metrics are availability, latency, unique domains and whether a known official domain appears. They are not a human relevance grade; failures are listed below.

## Summary

| Provider | Answered | Official-domain hit | Mean unique domains | Mean ms | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dsh-web-search | 30/30 | 30/30 | 5.47 | 2263 | 2112 | 2997 |

## Per query

| Query | Category | dsh-web-search | Plugin official |
| --- | --- | --- | --- |
| Node.js 24 release notes | release | 8 rows / 2093ms | yes |
| PostgreSQL 18 release notes | release | 8 rows / 2033ms | yes |
| Python 3.14 release notes | release | 8 rows / 1996ms | yes |
| Rust 1.90 release notes | release | 8 rows / 2276ms | yes |
| Go 1.25 release notes | release | 8 rows / 1975ms | yes |
| TypeScript 5.9 release notes | release | 8 rows / 2578ms | yes |
| Kubernetes 1.34 release notes | release | 8 rows / 2069ms | yes |
| React 19 release notes | release | 8 rows / 2287ms | yes |
| Playwright locator documentation | docs | 8 rows / 2428ms | yes |
| npm install documentation | docs | 8 rows / 2997ms | yes |
| pip install documentation | docs | 8 rows / 5003ms | yes |
| Docker Compose documentation | docs | 8 rows / 2091ms | yes |
| GitHub Actions cache documentation | docs | 8 rows / 2092ms | yes |
| MDN Fetch API documentation | docs | 8 rows / 1993ms | yes |
| FastAPI query parameters documentation | docs | 8 rows / 2173ms | yes |
| Next.js App Router documentation | docs | 8 rows / 1808ms | yes |
| Vite config documentation | docs | 8 rows / 2291ms | yes |
| Model Context Protocol tools specification | docs | 8 rows / 2169ms | yes |
| DeepSeek API documentation | docs | 8 rows / 2103ms | yes |
| Claude Code MCP configuration | docs | 8 rows / 2472ms | yes |
| Node.js 24 发布说明 | release | 8 rows / 1847ms | yes |
| PostgreSQL 18 发布说明 | release | 8 rows / 2131ms | yes |
| React 19 发布说明 | release | 8 rows / 2112ms | yes |
| Python 3.14 发布说明 | release | 8 rows / 2334ms | yes |
| Rust 1.90 发布说明 | release | 8 rows / 2016ms | yes |
| @fffangchenghao/dsh-web-search npm | package | 8 rows / 2503ms | yes |
| fangchenghao dsh-web-search GitHub | package | 8 rows / 1972ms | yes |
| requests PyPI package | package | 8 rows / 2114ms | yes |
| retrieval augmented generation survey arXiv | research | 8 rows / 1962ms | yes |
| Node.js fetch proxy environment variable Stack Overflow | qa | 8 rows / 1964ms | yes |

## Failures and caveats

### dsh-web-search

- node24: anysearch: aborted once enough results had arrived
- node24: exa: aborted once enough results had arrived
- postgres18: anysearch: aborted once enough results had arrived
- postgres18: exa: aborted once enough results had arrived
- python314: anysearch: aborted once enough results had arrived
- python314: exa: aborted once enough results had arrived
- rust190: anysearch: aborted once enough results had arrived
- rust190: exa: aborted once enough results had arrived
- go125: anysearch: aborted once enough results had arrived
- go125: exa: aborted once enough results had arrived
- typescript59: anysearch: aborted once enough results had arrived
- typescript59: ddg-html: aborted once enough results had arrived
- kubernetes134: anysearch: aborted once enough results had arrived
- kubernetes134: exa: aborted once enough results had arrived
- react19: anysearch: aborted once enough results had arrived
- react19: exa: aborted once enough results had arrived
- playwright-locator: anysearch: aborted once enough results had arrived
- playwright-locator: exa: aborted once enough results had arrived
- npm-install: anysearch: aborted once enough results had arrived
- npm-install: exa: aborted once enough results had arrived
- pip-install: anysearch: still running at deadline
- pip-install: exa: still running at deadline
- pip-install: ddg-html: still running at deadline
- docker-compose: anysearch: aborted once enough results had arrived
- docker-compose: exa: aborted once enough results had arrived
- github-actions-cache: anysearch: aborted once enough results had arrived
- github-actions-cache: exa: aborted once enough results had arrived
- mdn-fetch: anysearch: aborted once enough results had arrived
- mdn-fetch: exa: aborted once enough results had arrived
- fastapi-query: anysearch: aborted once enough results had arrived

The result files are the evidence; rerun with `node bench/compare30.mjs` and keep the raw JSON. A single run is a snapshot, not a permanent ranking.
