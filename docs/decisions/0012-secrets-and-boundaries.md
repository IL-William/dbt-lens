# 0012. What may leave the server, and what may not

Date: 2026-09-16 · Status: superseded by 0017

**Trigger:** read before adding a field to any API payload, a log line, or a
new route.

## Context

dbt-lens reads `.env` files and a whole project directory. It runs as the user,
with the user's access. The interesting question is not what it can read but
what it is allowed to hand out.

## Decision

- **`.env` values never leave the server.** Only two things derived from them
  do: resolved locations, which are the point of the feature, and `DBT_TARGET`,
  which is shown as a cross-check against a file's name. Nothing else, and no
  value is ever logged.
- **`DBT_ENV_SECRET_*` is never substituted**, whatever it would resolve to.
- **The server binds to `127.0.0.1` only** (`src/main.rs`).
- **Every path is resolved against the project root** and refused if it escapes
  it, including through `..`, an absolute path, or a symlink pointing out
  (`src/files.rs`).
- **No outbound network calls at all.** There is no HTTP client in the binary
  (0003), and warehouse access is out of process (0008).

## Rejected

Returning parsed `.env` contents to the browser so the frontend could resolve
locations itself. It would put secrets in a payload, in the browser's memory,
and in anyone's devtools, to save a few milliseconds of server work.

## Consequences

The Manage environments panel shows variable *names*, counts and an agreement
percentage, never values. When adding a field to a payload, the question to ask
is whether it could carry a value from a `.env` file, directly or by
concatenation.
