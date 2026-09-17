# 0016. Column lineage on demand, behind a switch

Date: 2026-09-17 · Status: accepted · Supersedes 0008

**Trigger:** read before starting a process from the server, or before changing
what clicking a column does.

## Context

0008 kept the warehouse out of the binary by giving `tools/sf_lineage.py` the
connection and a cache file to write. Its `serve` mode, meant for answering one
column at a time, was never wired to anything: the only way to see column
lineage was to run `dump` by hand first, and the Columns tab could only print
that command. On the one machine with Snowflake access, it read as a feature
that did not work. `GET_LINEAGE` takes one column per call, which is the shape
of a click.

## Decision

The server may start the script, and that alone.

- **Not without the switch.** One in Catalog > Columns, remembered per project
  (0011), decides whether the script runs at all.
- **Not a connection of its own.** The binary still has no driver, no TLS and no
  credentials. Starting checks what is local (Python, the profile, the
  connector) and then waits; the script connects on its first request, so a
  sign-in tab can only ever follow a click.
- **POST, never GET**, for the switch and for a fetch: a GET passes the guard on
  its Host alone, so an image tag on any page could run warehouse queries
  (0015).
- **The objects asked about follow the environment selector.** The browser sends
  the relation the Catalog already shows, so what is queried is what is read.
- **Results are merged into the same cache**, and stay readable with the switch
  off. `probe` and `dump` are unchanged.

## Rejected

- **A driver in the binary**, for the reasons 0008 gives.
- **A script the user starts, calling back into the server.** More routes, and a
  command to type: the switch would only be instructions.
- **One process per click.** Imports and a connection every time, and a sign-in
  per click wherever an account does not allow cached ID tokens.
- **Typing the command into the built-in terminal.** It lands in the middle of
  whatever is running there.

## Consequences

The server runs the project's Python with the user's dbt profile, the same trust
its git hooks already have (SECURITY.md). Stopping closes stdin before killing,
because a virtual environment's `python.exe` on Windows is a launcher for
another interpreter. The cache mixes environments by design: it names nodes, not
objects.
