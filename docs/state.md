# Where the work stands

Rewritten as things change, unlike [decisions/](decisions/), which is appended
to. Last updated 2026-09-17.

## Shipped

Editor with clickable `ref()` and `source()` and Jinja coloured by role,
lineage graph in model and column modes, terminal, file explorer with git and
unsaved colouring, search across nodes and every file, Catalog with columns and
locations, compiled SQL with freshness, git panel (status, branch switch, stage,
commit, push, pull, conflicts, side-by-side diff), Python environment in the
status bar, and environment-aware location resolution with a `.env` selector.

Every route sits behind the Host and Origin guard added on 2026-09-17 after a
security audit found the terminal reachable from any web page (0015). The same
pass confined `/api/git/diff` to the project and added `SECURITY.md`.

## Deferred, in the order they were chosen

1. **Macro layer.** Links on `{{ macro() }}` calls, and a used-by count per
   macro. The interesting part is reporting macros with no inbound reference
   without claiming they are dead: a macro can be called from YAML, from a
   selector, or by another package.
2. **Run history.** `run_results.json` gives status and timing per node. Status
   as the box stroke in the graph, plus staleness against the manifest. Watch
   for partial runs: a node absent from the file was not run, which is not the
   same as not tested.
3. **Selector resolution, then orchestration coverage.** Resolve the project's
   named selectors locally, validate against `dbt ls`, and only then scan the
   orchestrator's jobs to show which models no schedule covers.

Sketched but not started: a second column-lineage source using dbt Fusion's
local index (`dbt compile --static-analysis strict --write-index
--write-lineage`), which needs no warehouse privileges and covers uncommitted
SQL. It fills the same cache file (0008).

0.1.0 is tagged and released on GitHub as source only. No binary is attached, so
installing means building from source, as
[the README](../README.md#getting-started) describes. Attaching binaries is a
deliberate later step: an unsigned executable download brings its own friction
on a managed Windows machine.

The VM can also build its own binary. On 2026-09-17, `cargo install --path .`
succeeded there without administrator rights, with Rust's GNU toolchain and a
mingw-w64 installed through winget, once the assembler that `raw-dylib` linking
needs was on `PATH`. The README gives both that route and the cross-compile.

## Waiting on a human

- **A real column-lineage cache.** `python3 tools/sf_lineage.py probe` has never
  been run against a warehouse, so the permissions story is unverified.
- **Two checks on the Windows VM**: `.env` files with CRLF endings read
  correctly, and the time a node click takes on that machine. The plan was to
  cache the per-node environment resolution only if it exceeded 10 ms, and it
  measures well under that on a Mac.
- **A release binary predating 2026-09-17 has no guard.** Anyone running one
  needs `cargo build --release` again, the old one being vulnerable to the
  three attacks 0015 describes.

## Traps worth knowing

- **A synthetic column-lineage cache looks exactly like a real one** apart from
  its `source` field. If the column graph looks suspiciously complete, check
  what produced the cache before trusting a screenshot of it.
- **Release binaries embed the frontend** (0005). A frontend fix that appears to
  do nothing usually means the release binary was not rebuilt.
- **The test harnesses slice `web/app.js` by function name** (0013). Renaming a
  sliced function breaks its harness; `./scripts/check.sh` catches it.
- **Reaching the server by any name other than `127.0.0.1` or `localhost`
  gets a 403** (0015). A tunnel or a proxy in front of it is not a supported
  setup, and the symptom is every request refused, not a blank page.

## Automated checks

GitHub Actions runs `cargo test`, a RustSec audit of the lockfile and an OSV
audit of `web/vendor/` on every push and every Monday, and Dependabot opens
weekly lockfile bumps. CodeMirror is at 5.65.21 since 2026-09-17, which does
not fix CVE-2025-6493 (SECURITY.md). The browser harnesses are not
in CI: they need `jsc`, which ships with macOS (0013).
