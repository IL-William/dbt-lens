# 0005. The frontend is read from disk in debug and embedded in release

Date: 2026-09-11 · Status: accepted

**Trigger:** read when a frontend change seems to have no effect, or before
changing how `web/` is served.

## Context

Two needs pull in opposite directions: development wants an edit-and-refresh
loop, and the VM wants exactly one file to copy.

## Decision

`rust-embed` with the default behaviour: `#[folder = "web/"]` in `src/api.rs`
reads from disk in a debug build and embeds the files in a release build.

- `cargo run -- <project> --port 4399`: edit `web/app.js`, refresh, done.
- `cargo build --release`: the frontend is inside the binary.

## Rejected

Embedding in both profiles, which turns every CSS tweak into a rebuild; and
serving `web/` from disk in both, which would mean shipping a folder.

## Consequences

A release binary is only as fresh as its last build, which has bitten before.
After changing anything under `web/`, rebuild before testing the release binary,
and to be sure, grep the binary for a string you just added:

    LC_ALL=C grep -ac 'function relationCell' target/release/dbt-lens

The same applies to a copy handed to someone else: it carries the frontend and
the Rust code as they were at build time, and nothing tells its user how old it
is.
