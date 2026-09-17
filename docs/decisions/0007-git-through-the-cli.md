# 0007. git runs as a subprocess, never as a library

Date: 2026-09-13 · Status: accepted

**Trigger:** read before touching `src/git.rs` or adding a git library.

## Context

The tool has to act as the user's own git: their ssh agent, their
`~/.gitconfig`, their `includeIf` rules that set a different identity per
directory, their hooks, their credential helper.

## Decision

Shell out to the `git` binary already on the machine, through
`git::run(root, args, env, timeout)`. Two invariants hold everywhere in that
file, and they are the reason it stays small:

- **Nothing destroys work.** No `-f`, no `--hard`, no `clean`, no
  `push --force`. The worst any button can do is create a stash. A checkout
  that would overwrite local changes is reported with the blocking files, and
  the user decides.
- **Nothing can hang the server.** Network commands run with
  `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, every
  command has a deadline, and both pipes are drained so a chatty hook cannot
  deadlock.

## Rejected

`git2`/libgit2: it reimplements config resolution, ignores hooks, and handles
ssh agents and `includeIf` differently from the git the user already trusts. A
tool that commits as the wrong identity is worse than no tool.

## Consequences

A passphrase-protected key fails fast with a readable message instead of
hanging, and pushes that need one are left to the user in a terminal. Adding a
command means adding it to this file with a timeout, and keeping both
invariants.
