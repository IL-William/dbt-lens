# 0023. Column lineage may be parsed out of SQL, and 0002 still holds

Date: 2026-09-19 · Status: accepted · Amends 0002, follows 0021

**Trigger:** read before reading a `.sql` file to work out anything, or when
0002's title seems to forbid where the column lineage now comes from.

## Context

0002 is titled "Lineage comes from manifest.json, never from parsing SQL", and a
title is the whole of what most people read in the index. The column lineage now
on screen is produced by collin, which parses the compiled SQL of all 3341 models
in a project and derives every column edge from it.

Side by side, those read as a contradiction. They are not, but the resolution is
not obvious enough to leave implicit, and 0021 does not supply it: it settles
which file each producer writes, not which rule each one is under.

## Decision

0002 governs the **structure of the graph**: which node depends on which. dbt has
already resolved every `ref()` and `source()` and written the answer down, so
re-deriving it from SQL would redo, worse, something already correct, and would
miss a `ref()` that a macro builds dynamically.

Column lineage is a different question, and the manifest does not answer it at
all. Nothing dbt writes records that `fct_orders.customer_id` comes from
`orders.customer_id`, still less whether it arrived unchanged, cast, or inside a
CASE. That answer exists only in the SQL. So the two rules never meet:

- **node to node** edges come from the manifest, always;
- **column to column** edges are parsed out of the compiled SQL, by a separate
  tool, and arrive as the cache 0008 defined and 0021 named.

Two boundaries hold it in place. The parsing happens outside this binary. And
dbt-lens still opens no `.sql` file to work out a dependency: the only SQL it
reads is the file already open in the editor, to turn a `ref()` into a link,
which is presentation and not graph construction, exactly as 0002 allows.

## Rejected

- **Parsing SQL inside dbt-lens.** It would put a SQL parser, a name resolver and
  a schema store inside a binary whose premise is that it starts instantly and
  installs nothing (0001, 0003). The analysis takes about three seconds across a
  whole project: that belongs in a tool run when the project changes, not in a
  process serving a page.
- **Rewording 0002 to say "never from parsing SQL for structure".** Editing a
  record to change what it means is the one thing the index forbids. A later
  record naming which part still holds is the sanctioned route, and it keeps the
  reasoning readable in order, mistake included.
- **Saying nothing, on the grounds that 0021 mentions the producer.** It mentions
  it while settling a file conflict. A reader who gets as far as the index and no
  further is left with a contradiction and no way out of it.

## Consequences

The two halves of the graph refresh at different speeds. Node edges follow the
manifest, polled every three seconds, so a `dbt build` updates them. Column edges
only change when someone reruns the producer, which is why the Columns tab shows
the cache's age and who wrote it.

A relation the project does not own appears in the column graph under the `rel:`
prefix the cache format reserves, with no counterpart among the manifest's nodes.
That is expected, not a defect.

A third producer, such as dbt Fusion's own lineage index if it ever runs
somewhere licensed for it, changes nothing here. It writes its own file under
0021 and falls under this rule, not under 0002.
