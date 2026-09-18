# 0018. The `vars:` block is read by a scanner, not a YAML parser

Date: 2026-09-18 · Status: accepted

**Trigger:** read before reading a `.yml` file from the server, or before
reaching for a YAML parser.

## Context

0003 says "No YAML parser. The manifest already holds the merged YAML, so
nothing needs to read `.yml` files." The second sentence is false for one thing:
a 93 MB dbt Fusion manifest (schema v12) has no `vars` key anywhere, not at the
root, not under `metadata`, not under any node's `config`. `var(` appears in it
only inside unrendered `raw_code`. `run_results.json` carries `args.vars`, but
only for the vars a run was given, and a parse writes no such file.

So `dbt_project.yml` is the only place project vars exist on disk, and the
hover card that shows a variable's value cannot be built without reading it.

## Decision

Keep the rule, fix the reason. No `serde_yaml`. `src/project.rs` scans one
block, `vars:` at indentation 0, covering the shapes that appear in real
projects: flat keys at whatever indentation the block uses, quoted and unquoted
scalars, integers, flow sequences, Jinja kept as text, and a key with no value
as the null it means.

Everything else is reported as `unparsed`, with a line number and a fixed
message, and shown in the card. Package-scoped blocks are named rather than
flattened: a package scope shadows the global one, so pretending they are the
same would show the wrong value.

## Rejected

`serde_yaml`, unmaintained since 2024, and a whole document model for one
block. Reading `vars` from the manifest, which is not there. `dbt debug`, which
would mean running dbt (0002).

## Consequences

The scanner sees only this project's own `vars:`. It cannot see `--vars` passed
on the command line, nor a package's own defaults, so the card says what it read
and from which line, and stops there. An `Unparsed` carries no text from the
file, only a line number, so no value can escape through an error path.
