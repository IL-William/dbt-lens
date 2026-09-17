# 0011. Settings live outside the project, keyed by its path

Date: 2026-09-16 · Status: accepted

**Trigger:** read before persisting anything, or before adding a second write
endpoint.

## Context

The environment feature remembers display names, hidden files and the last
selection. The project being browsed is someone's repository, often a client's,
and a tool that drops a file into it creates a diff the user has to explain.

## Decision

`src/settings.rs` writes to the user's own configuration directory:
`DBT_LENS_CONFIG_DIR` if set, then `%APPDATA%` on Windows, then
`$XDG_CONFIG_HOME` or `~/.config`. One file per project,
`projects/<slug>-<fnv1a64 of the normalised path>.json`, recognisable by name
while two projects sharing a folder name stay apart. Writes go through a
temporary file and a rename, retried on Windows where antivirus can briefly
hold a handle, under an async mutex.

Two separate write endpoints, `PUT /api/envs` for overrides and
`POST /api/envs/select` for the selection, because a single endpoint carrying
both would let a second browser tab undo a rename made in the first. Each tab
keeps its own selection in memory; the stored one is only where a fresh tab
starts.

## Rejected

- **A dotfile in the project.** Pollutes someone else's repository.
- **`localStorage` only.** Lost per browser, and invisible to the user.
- **The project path as the file name.** Unusable on Windows, and long.

## Consequences

No configuration directory means no persistence, which the API reports as
`persist: false` rather than failing. Corrupt JSON is logged and treated as
defaults, never silently overwritten. The settings file holds names and
visibility only, never a variable value (0012).
