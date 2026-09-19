# 0022. The breadcrumb's outline is scanned in the browser, and SQL has none

Date: 2026-09-18 · Status: accepted

**Trigger:** read before adding structure inside a file to the UI, or before
reaching for a YAML parser a second time.

## Context

The breadcrumb bar under the tabs has two halves. The path half is navigation
between files and needs nothing new: `/api/dir` already lists a folder, sorted
the way VS Code sorts it. The symbol half says where the cursor sits inside the
document, `models > 0 > data_tests` in a properties file, and that needs
something that understands the file's structure.

0003 says no YAML parser and 0018 kept that rule for `dbt_project.yml`. The
question is whether the breadcrumb is the case that finally earns one, and on
which side of the wire it would live.

## Decision

The outline is scanned in `web/app.js`, over the document CodeMirror already
holds, by hand. `yamlOutline` walks indentation and dashes with a stack, the way
`src/project.rs` walks the `vars:` block, and returns one flat node per mapping
key and per sequence item. `mdOutline` does headings. `documentOutline`
dispatches on `modeFor`.

**SQL returns an empty outline, on purpose.** A CTE name can only be found
honestly by masking strings and comments first, and `maskJinjaComments` masks
Jinja comments only. A bar that occasionally names a `case` arm as a section is
worse than a bar that stops at the file name. 0023 puts reading the open buffer
to draw something on the screen squarely under presentation rather than under
0002, so what stops this is the honesty of the result, not a rule.

The scanner's blind spots are stated here so the next reader does not find them
as bugs: flow collections (`[a, b]` spanning lines), anchors and aliases, and
multi-document files. A dbt properties file uses none of them.

## Rejected

- **Vendoring js-yaml.** Allowed by 0004, since it needs no build step, but it
  adds a library to `scripts/audit_vendored.py` and to the notices file for one
  cosmetic bar, and 0003's point is that the short list is deliberate.
- **A server route, `/api/outline`.** It would make the server parse YAML, which
  0018 refused, and it would re-read from disk a buffer the browser already has,
  so the crumb would be stale for every unsaved edit.
- **CTE detection now.** Deferred until string and comment masking exists, for
  the reason above.

## Consequences

The symbol half is free for `.yml`, `.yaml` and `.md`, and absent for `.sql`
until masking lands. `yamlOutline` is also the scanner deferred item 4 in
state.md was waiting on, so a clickable `dbt_project.yml:<line>` on the var card
is now a small follow-up rather than a new capability.
