# 0002. Lineage comes from manifest.json, never from parsing SQL

Date: 2026-09-10 · Status: accepted

**Trigger:** read before writing anything that reads `.sql` files to work out
dependencies.

## Context

A dbt project's dependency graph is already computed: dbt resolves every
`ref()` and `source()` during parsing and writes the result, with
materializations, tags, tests, descriptions and built locations, into
`target/manifest.json`.

## Decision

Read the manifest and nothing else for graph structure. `src/manifest.rs`
declares only the fields the UI needs, so serde discards the rest while parsing
and a large manifest never becomes a large object graph. The file is polled
every three seconds, so a `dbt build` in the terminal refreshes the lineage.

SQL is read for one purpose only: turning `ref()` and `source()` in the open
editor into clickable links, which is presentation, not graph construction.

## Rejected

- **Parsing SQL for dependencies.** It re-derives, worse, something dbt already
  did correctly. Macros that build a `ref()` dynamically would be missed, and
  every project would need its own special cases.
- **Running dbt to get fresher data.** The tool never runs dbt: dbt runs where
  the user runs it, with their profiles and their warehouse credentials.

## Consequences

No manifest means no lineage, and the UI says so rather than guessing. Anything
the manifest does not carry (compiled SQL paths under Fusion, column lineage)
needs its own source, which is why `src/compiled.rs` probes the filesystem and
`src/collin.rs` reads a separate cache.
