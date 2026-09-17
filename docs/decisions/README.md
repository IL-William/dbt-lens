# Decisions

Why this codebase is shaped the way it is, and what was rejected along the way.
The README says what dbt-lens does for the person using it; these files say why
it is built this way, for whoever changes it next.

| | Decision | Read it before |
| --- | --- | --- |
| [0001](0001-one-self-contained-binary.md) | One self-contained binary, written in Rust | adding anything the user would have to install |
| [0002](0002-lineage-from-the-manifest.md) | Lineage comes from manifest.json, never from parsing SQL | reading `.sql` files to work out dependencies |
| [0003](0003-minimal-dependencies.md) | A deliberately small dependency list | adding a crate, or wondering why there is no regex |
| [0004](0004-frontend-without-a-build-step.md) | A frontend with no build step | reaching for a framework, a bundler or CodeMirror 6 |
| [0005](0005-embedded-in-release-disk-in-debug.md) | Disk in debug, embedded in release | a frontend change that seems to have no effect |
| [0006](0006-hand-written-graph-layout.md) | The graph is laid out and drawn by hand | adding a graph library, or editing `web/lineage.js` |
| [0007](0007-git-through-the-cli.md) | git runs as a subprocess, never as a library | touching `src/git.rs` |
| [0008](0008-column-lineage-from-an-offline-cache.md) | Column lineage arrives as a cache file | making the server talk to a warehouse |
| [0009](0009-env-resolution-by-scanner.md) | Environments are resolved by a scanner | touching `src/envs.rs`, or adding a template engine |
| [0010](0010-moved-compares-parsed-with-built.md) | "Moved" always compares parsed with built | changing the location table or the environment selector |
| [0011](0011-settings-outside-the-project.md) | Settings live outside the project | persisting anything |
| [0012](0012-secrets-and-boundaries.md) | What may leave the server, and what may not | adding a field to a payload, a log line, or a route |
| [0013](0013-tests-without-a-toolchain.md) | Tests that need nothing installed | renaming a function in `web/app.js` |
| [0014](0014-public-repository-hygiene.md) | Treat this repository as public | writing a fixture, an example or a commit message |
| [0015](0015-the-browser-is-not-trusted.md) | The browser is not trusted: Host and Origin are checked | adding a route, changing the port logic, or adding a CORS header |

## Keeping these honest

- **One decision per file**, numbered in order, dated, with what was rejected.
  The rejected options are the part worth writing: the decision itself is
  usually visible in the code, the discarded alternatives never are.
- **Never edit a decision to change its meaning.** Reversing one means adding a
  new file that says which number it supersedes, and marking the old one
  `Status: superseded by NNNN`. The reasoning then reads in order, including the
  mistakes.
- **Keep them short**, under about forty lines. A file too long to read fully is
  a file that gets skimmed.
- **Write only what can be checked**, in this repository or by running
  something. Measurements taken elsewhere are dated and given as orders of
  magnitude, not as current facts.
- **Anything that changes week to week** belongs in [../state.md](../state.md),
  which is rewritten rather than appended.
