# 0021. One column-lineage cache per producer, and the user picks

Date: 2026-09-18 · Status: accepted · Amends 0008 and 0016

**Trigger:** read before adding a source of column lineage, or before changing
where one writes.

## Context

0008 made column lineage arrive as a cache file, source agnostic on purpose so a
second producer could fill it. A second one now exists: a generator that derives
lineage from the compiled SQL dbt already writes, with no warehouse. It filled
the same `target/column_lineage.json`, and the two producers immediately
contended for it. The Snowflake path refused to write, which was correct and a
dead end: the only way forward was to move a file by hand.

Blending them was never an option: a cache half read from SQL and half fetched
from Snowflake is indistinguishable from a whole one, which is the trap 0008
already described for synthetic caches.

## Decision

Each producer owns a file, `column_lineage.<source>.json`, and the user chooses
which one is merged. The bare `column_lineage.json` is still read, as what every
producer wrote before this existed.

The graph holds one source at a time, because `merge_col_lineage` replaces the
edge set rather than adding to it. So the choice is a real switch, persisted per
project (0011), and the Columns tab names the active producer instead of naming
Snowflake whatever is loaded.

Fetching from Snowflake is that same choice made explicitly, so it writes to its
own file and makes it active.

## Rejected

- **A `source` per edge, in one file.** Cleaner, and it would let two producers
  be compared in place. It needs a cache version 2, which every released
  dbt-lens refuses to read.
- **Merging whatever is found.** Two producers disagree in ways worth seeing;
  averaging them hides the disagreement that tells you which to trust.

## Consequences

A name from the browser selects a file only by matching one discovery already
found, never by being joined to a path (0015). Discovery reads headers and
discards the edges, so opening the menu parses no megabytes. Comparing two
producers is a click.
