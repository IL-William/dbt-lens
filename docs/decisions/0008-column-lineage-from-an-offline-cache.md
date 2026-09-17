# 0008. Column lineage arrives as a cache file, not a warehouse connection

Date: 2026-09-12 · Status: accepted

**Trigger:** read before making the server talk to Snowflake, or before
changing the shape of the column-lineage file.

## Context

Column-level lineage has to come from somewhere outside the manifest. The
obvious route, querying `SNOWFLAKE.CORE.GET_LINEAGE`, would put a database
driver, TLS, credentials and an SSO flow inside a binary that is meant to be
copied onto a locked-down machine and run without ceremony.

## Decision

Split it in two. `tools/sf_lineage.py` owns the warehouse: it reads the dbt
profile, so SSO, key pair and password targets all work, and it offers `probe`,
`dump` and `serve`. It writes a JSON cache that `src/collin.rs` merges into the
graph the way `catalog.json` is merged. The format is deliberately source
agnostic: it names nodes and columns, not Snowflake objects.

## Rejected

- **A Snowflake driver in the binary.** Adds TLS and credentials, breaks the
  dependency-free cross-compile, and a background server triggering an SSO
  browser tab is unacceptable behaviour.
- **Pre-computing the whole project.** `GET_LINEAGE` takes one column per call,
  so a full project is hundreds of thousands of calls. Scoped `dump` and
  on-demand `serve` exist for that reason.

## Consequences

Column lineage is only as fresh as the cache, and the UI says so, including how
to refresh it. A future second source, such as dbt Fusion's local lineage index,
can fill the same file without touching the graph. A synthetic cache is easy to
generate for UI work, and equally easy to mistake for real data: a cache that is
not from the warehouse should say so in its `source` field.
