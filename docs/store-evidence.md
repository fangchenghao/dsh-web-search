# DSH STORE compatibility evidence

Declaration in `package.json`:

```json
"engines": { "node": ">=22.18.0", "dsh": ">=0.2.1-rc.2 <0.3.0" },
"dsh": {
  "compatibility": {
    "dshReleases": { "0.2.1-rc.2": "compatible" },
    "dshOperations": {
      "0.2.1-rc.2": {
        "install": "passed", "start": "passed",
        "uninstall": "passed", "rollback": "passed"
      }
    }
  }
}
```

Only `0.2.1-rc.2` is declared, because that is the version actually exercised.
`0.2.1-rc.1` and `0.2.1-alpha.5` are **not** declared and remain `unknown`.

## Environment

- macOS (arm64), DeepSeek Harness **0.2.1-rc.2** (`dsh --version`), Node 22.18+.
- Runtime artifacts: `lib/` is committed to this repository (86 files, 956 KiB),
  so the fixed commit's tree contains `lib/index.js` and `lib/index.d.ts`.
- Disposable profile for the destructive steps: a fresh `DSH_HOME` created with
  `mktemp -d`; the real `~/.dsh` was never written to. Bundled pnpm 11.28.5.
- **Windows CI:** GitHub Actions `windows-latest`, Node 24. Install, typecheck,
  the full test suite, build and the entry-point import all pass. Run:
  https://github.com/fangchenghao/dsh-web-search/actions/runs/40357774607
  (the matrix also runs on macOS and Ubuntu). This is a CI environment, not a
  claim about every Windows terminal or proxy client.

## install — passed

```sh
export DSH_HOME=$(mktemp -d)/dsh-home
dsh plugin --profile e2e add /path/to/dsh-web-search
dsh --profile e2e --dump-config | grep -n 'web-search-bing'
# 362:- id: web-search-bing
node -e "import(process.env.DSH_HOME + '/profiles/e2e/node_modules/@fffangchenghao/dsh-web-search/lib/index.js').then(m => console.log(m.name, m.inject))"
# dsh-web-search ["web"]
```

The entry appears in the composed tree (`id: web-search-bing`, name
`@fffangchenghao/dsh-web-search`), and the package's runtime entry resolves and
exports `name`/`inject`/`Config`.

## start — passed

Two independent observations:

1. **Real desktop profile, live host.** The plugin is mounted in the running
   Harness 0.2.1-rc.2 instance. The host Inspect interface lists the live entry:

   ```
   cordis_inspect_query remote Config listConfigs { name: "@fffangchenghao/dsh-web-search" }
   → { entries: [{ id: "include:web-search-bing",
                   patchId: "web-search-bing",
                   name: "@fffangchenghao/dsh-web-search",
                   status: "schema" }], total: 1 }
   ```

   `status: "schema"` means the entry is active; the current build projects a
   29-field Config schema. Eight tools (`domain_search`, `search_many`,
   `advanced_search`, `read_page`, `research`, `cache_search`, `platform_search`,
   `engine_test`) and the
   search/fetch providers are registered from the same mount; the GUI lists the
   plugin as 运行中. This probe was retaken after a restart with the current
   build; a live `advanced_search` window note and a fresh npm publish date were
   observed through those tools, so the list is a live observation rather than a
   projection.

2. **Disposable profile, composed tree.** `dsh --profile e2e --dump-config`
   composes the full tree without error and contains the entry above.

A full `dsh headless` boot inside the disposable profile was attempted but waits
for model credentials that a throwaway `DSH_HOME` does not have; the live-host
evidence above is the stronger observation and is why `start` is marked passed.

## uninstall — passed

```sh
dsh plugin --profile e2e remove @fffangchenghao/dsh-web-search
dsh --profile e2e --dump-config | grep -c 'web-search-bing'
# 0
```

## rollback — passed

Re-installing the same local path restores the identical composed tree:

```sh
dsh plugin --profile e2e add /path/to/dsh-web-search
dsh --profile e2e --dump-config > after.yml
diff before.yml after.yml   # no differences
```

## Limits of this evidence

- Only one DSH version was exercised; the other two releases in the current
  latest-three window stay undeclared (`unknown`) rather than being claimed.
- The desktop start evidence is a real mount, but it is not a scripted
  installation/rollback matrix on three operating systems.
- `start` does not include an end-to-end model call; it covers host boot, plugin
  mount, tool registration and Settings schema projection.
