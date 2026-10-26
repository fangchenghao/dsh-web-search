# 30-query keyless comparison

Generated: 2026-10-26T06:47:10.082Z

## Method

- Same 30 queries, same top-8 budget, same machine and network route.
- Plugin arm: `search()` plus the narrow official release lookup, no cache, 15 s timeout.
- Metrics are availability, latency, unique domains and whether a known official domain appears. They are not a human relevance grade; failures are listed below.

## Summary

| Provider | Answered | Official-domain hit | Mean unique domains | Mean ms | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dsh-web-search | 30/30 | 29/30 | 5.67 | 3768 | 4000 | 5003 |

## Per query

| Query | Category | dsh-web-search | Plugin official |
| --- | --- | --- | --- |
| Node.js 24 release notes | release | 8 rows / 2662ms | yes |
| PostgreSQL 18 release notes | release | 8 rows / 2843ms | yes |
| Python 3.14 release notes | release | 8 rows / 5002ms | yes |
| Rust 1.90 release notes | release | 8 rows / 2610ms | yes |
| Go 1.25 release notes | release | 8 rows / 4208ms | yes |
| TypeScript 5.9 release notes | release | 8 rows / 5002ms | yes |
| Kubernetes 1.34 release notes | release | 8 rows / 3428ms | yes |
| React 19 release notes | release | 8 rows / 2397ms | yes |
| Playwright locator documentation | docs | 8 rows / 4243ms | yes |
| npm install documentation | docs | 8 rows / 4495ms | yes |
| pip install documentation | docs | 8 rows / 2487ms | yes |
| Docker Compose documentation | docs | 8 rows / 5003ms | yes |
| GitHub Actions cache documentation | docs | 8 rows / 4787ms | yes |
| MDN Fetch API documentation | docs | 8 rows / 4207ms | yes |
| FastAPI query parameters documentation | docs | 8 rows / 4300ms | yes |
| Next.js App Router documentation | docs | 8 rows / 5003ms | yes |
| Vite config documentation | docs | 8 rows / 2662ms | yes |
| Model Context Protocol tools specification | docs | 8 rows / 4931ms | yes |
| DeepSeek API documentation | docs | 8 rows / 3905ms | yes |
| Claude Code MCP configuration | docs | 8 rows / 5004ms | yes |
| Node.js 24 发布说明 | release | 8 rows / 2815ms | yes |
| PostgreSQL 18 发布说明 | release | 8 rows / 2085ms | yes |
| React 19 发布说明 | release | 8 rows / 3003ms | yes |
| Python 3.14 发布说明 | release | 8 rows / 3003ms | yes |
| Rust 1.90 发布说明 | release | 8 rows / 2979ms | yes |
| @fffangchenghao/dsh-web-search npm | package | 8 rows / 4000ms | yes |
| fangchenghao dsh-web-search GitHub | package | 8 rows / 4666ms | yes |
| requests PyPI package | package | 8 rows / 3278ms | yes |
| retrieval augmented generation survey arXiv | research | 8 rows / 5002ms | no |
| Node.js fetch proxy environment variable Stack Overflow | qa | 8 rows / 3024ms | yes |

## Failures and caveats

### dsh-web-search

- node24: anysearch: aborted once enough results had arrived
- node24: exa: aborted once enough results had arrived
- postgres18: anysearch: aborted once enough results had arrived
- postgres18: ddg-html: aborted once enough results had arrived
- python314: anysearch: still running at deadline
- python314: exa: still running at deadline
- python314: ddg-html: still running at deadline
- rust190: anysearch: aborted once enough results had arrived
- rust190: exa: aborted once enough results had arrived
- go125: anysearch: aborted once enough results had arrived
- go125: ddg-html: aborted once enough results had arrived
- typescript59: anysearch: still running at deadline
- typescript59: exa: still running at deadline
- typescript59: ddg-html: still running at deadline
- kubernetes134: anysearch: aborted once enough results had arrived
- kubernetes134: exa: aborted once enough results had arrived
- react19: anysearch: aborted once enough results had arrived
- react19: exa: aborted once enough results had arrived
- playwright-locator: exa: aborted once enough results had arrived
- playwright-locator: ddg-html: aborted once enough results had arrived
- npm-install: anysearch: aborted once enough results had arrived
- npm-install: exa: aborted once enough results had arrived
- pip-install: anysearch: aborted once enough results had arrived
- pip-install: exa: aborted once enough results had arrived
- docker-compose: anysearch: still running at deadline
- docker-compose: exa: no results
- docker-compose: ddg-html: still running at deadline
- github-actions-cache: anysearch: aborted once enough results had arrived
- github-actions-cache: exa: aborted once enough results had arrived
- mdn-fetch: anysearch: aborted once enough results had arrived

The result files are the evidence; rerun with `node bench/compare30.mjs` and keep the raw JSON. A single run is a snapshot, not a permanent ranking.
