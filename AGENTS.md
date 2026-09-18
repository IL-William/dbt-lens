# Working on dbt-lens

A browser IDE for dbt projects: editor, terminal and lineage, served from one
binary that contains its own frontend. It reads a dbt project, it never runs
dbt.

**The constraint behind most of this codebase:** it has to run on a locked-down
Windows VM where nothing can be installed. No runtime, no npm, no installer.
That is why there is no build step, no framework, and a short dependency list.

## Verify

```
./scripts/check.sh          # Rust tests, both audits, the Snowflake script, browser tests, syntax
```

Run it before saying a change works. It is the only answer to "how do I check
this", and it needs nothing installed beyond Rust and macOS. The audit step
needs `cargo install cargo-audit --locked` and skips itself without it, like
the browser half without a JavaScript shell. The second audit asks OSV about
`web/vendor/` and skips itself offline. GitHub Actions runs the Rust tests and
both audits on every push and every Monday, never the browser half, which wants
macOS (0013). The Snowflake script is tested against a fake connector, so it
needs no warehouse, only Python 3.10 or later, and skips itself without one.
Updating a vendored library means changing its version in
`scripts/audit_vendored.py` and `THIRD_PARTY_NOTICES.md` too: the audit fails
when they disagree.

## Run

```
cargo run -- /path/to/dbt-project --port 4399 --no-open    # debug: serves web/ from disk
cargo build --release                                      # release: embeds web/
cargo build --release --target x86_64-pc-windows-gnu       # the VM's .exe
```

Debug reads `web/` from disk, so edit and refresh. Release embeds it, so a
frontend fix does not exist in a release binary until it is rebuilt (see 0005).

## Rules

- **No new dependency** without a decision record saying why. The absence of a
  regex, YAML or HTTP crate is deliberate (0003).
- **No build step for the frontend.** What ships is what is in `web/` (0004).
- **Never run dbt.** The binary never talks to a warehouse either:
  `tools/sf_lineage.py` does, started by the server only once the user switches
  Snowflake lineage on, under their own credentials (0002, 0016).
- **Never return or log a `.env` value**, beyond the three things allowed to
  leave: resolved locations, `DBT_TARGET` (0012, 0017), and a resolved
  `env_var()` in the hover card, which passes two guards first (0019).
- **Nothing outside the project is read or written**, except the one dbt profile
  the Snowflake script names, through its own route (0017).
- **Treat this repository as public.** Fixtures and examples are invented, never
  taken from a real project (0014).
- **The browser is not trusted.** Every route sits behind the Host and Origin
  guard in `src/api.rs`, and no CORS header is ever added (0015).
- **Bump the version in `Cargo.toml` and tag the commit** for anything anyone
  installs. Between tags the build stamp tells builds apart; the version is
  what says a release happened.
- **Comments say why, not what.** The code already says what it does.
- **No em dash** in code, comments or documentation.

## Conventions

- **`web/app.js`** is one IIFE with a single state object `S`. Pure logic goes
  in named `function` declarations, because the test harnesses slice the file
  between two function names: renaming one breaks its harness (0013).
- **Rust tests** live beside the code in `#[cfg(test)]` modules.
- **Rust modules** are one concern each, with a header comment that states the
  concern and any invariant. `src/git.rs` is the example to follow.
- **API payloads** are `serde` structs in `src/api.rs`, skipping empty fields.

## Where to read next

| If you are about to | Read |
| --- | --- |
| add a crate, or wonder why some parsing is hand-written | [0003](docs/decisions/0003-minimal-dependencies.md) |
| add a framework, a bundler, or upgrade CodeMirror | [0004](docs/decisions/0004-frontend-without-a-build-step.md) |
| touch a frontend change that seems to have no effect | [0005](docs/decisions/0005-embedded-in-release-disk-in-debug.md) |
| touch `src/git.rs` | [0007](docs/decisions/0007-git-through-the-cli.md) |
| touch `src/envs.rs`, or evaluate Jinja | [0009](docs/decisions/0009-env-resolution-by-scanner.md) |
| change the location table or the environment selector | [0010](docs/decisions/0010-moved-compares-parsed-with-built.md) |
| persist anything, or add a write endpoint | [0011](docs/decisions/0011-settings-outside-the-project.md) |
| add a field to a payload, a log line or a route | [0012](docs/decisions/0012-secrets-and-boundaries.md), [0017](docs/decisions/0017-the-profile-is-reachable.md) |
| rename a function in `web/app.js`, or add a test | [0013](docs/decisions/0013-tests-without-a-toolchain.md) |
| add a route, change the port logic, or add a CORS header | [0015](docs/decisions/0015-the-browser-is-not-trusted.md) |
| start a process from the server, or touch `src/sidecar.rs` | [0016](docs/decisions/0016-column-lineage-on-demand.md) |
| read a `.yml` file from the server, or reach for a YAML parser | [0018](docs/decisions/0018-project-vars-by-scanner.md) |
| return any value derived from a `.env` file | [0019](docs/decisions/0019-a-resolved-value-may-be-shown.md) |
| set this up for someone, rather than change it | [README, Getting started](README.md#getting-started) |
| pick up the next piece of work | [docs/state.md](docs/state.md) |

All nineteen decisions, with what was rejected each time, are indexed in
[docs/decisions/](docs/decisions/). The [README](README.md) is the user-facing
documentation: what the tool does and how to use it. Rationale lives here, never
in both.

## Layout

`src/manifest.rs` reads the manifest, `src/graph.rs` holds the compact graph,
`src/api.rs` serves HTTP and WebSocket, and the remaining modules take one
concern each: `envs`, `project`, `settings`, `git`, `collin`, `sidecar`,
`compiled`, `venv`, `files`, `pty`. `build.rs` stamps the binary with
`git describe`, so two builds of one release can be told apart. `web/` is the
frontend, `web/vendor/` the vendored libraries, `tools/sf_lineage.py` the only
piece that talks to a warehouse. The README has the annotated version.
