# 0006. The lineage graph is laid out and drawn by hand

Date: 2026-09-11 · Status: accepted

**Trigger:** read before adding a graph library or rewriting `web/lineage.js`.

## Context

The graph needed is narrow: a left-to-right layered DAG of at most a few
hundred visible nodes, with pan, zoom, selection, expansion handles and a
column mode. dbt lineage has a natural layering already, since the manifest
gives the direction of every edge.

## Decision

`web/lineage.js`, around 230 lines, computes layers by longest path from the
focus node, orders within a layer to reduce crossings, and emits SVG. Model
mode and column mode share the same canvas, the same pan and zoom, and the same
renderer; only the node set differs.

## Rejected

- **d3.** Would be vendored weight for force layouts and scales that a layered
  DAG does not use.
- **cytoscape.js, dagre, elk.** Heavier still, and their layout quality matters
  most on graphs that are wider than what is shown here.

## Consequences

Layout quality is ours to improve, and there is no library to blame or upgrade.
One trap is recorded in the tests: node colours are set with an inline `style`
because a `fill` attribute loses to the `.nd rect` CSS rule, and
`web/tests/colours.js` pins the behaviour.
