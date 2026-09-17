# 0010. "Moved" always compares parsed with built

Date: 2026-09-16 · Status: accepted

**Trigger:** read before changing the location table, the `moved` highlight, or
what the environment selector affects.

## Context

The Catalog shows three stages of a location: as written, resolved, and built.
Once resolved can be evaluated against any `.env` file, it is tempting to
compare the selected environment's value with the built one and flag the
difference.

## Decision

The `moved` signal always compares the **parsed** value from the manifest with
the **built** value from the same manifest. Both come from one parse, so the
comparison is fair. Choosing an environment changes the text and the status of
the resolved cell, and nothing else.

Two refinements keep the signal honest: case alone is never a move, because
Snowflake folds unquoted identifiers, and neither is a pair of literal quotes
that dbt drops (`sameIdent` in `web/app.js`). When almost every model in a
manifest lands in one `database.schema`, that sandbox is detected once and
stated, instead of flagging thousands of models.

## Rejected

Comparing the selected environment with built. In a sandbox manifest it would
mark every environment-driven key as moved, which is noise in place of the one
signal worth having: this model was built somewhere unexpected.

## Consequences

`web/tests/location.js` pins this directly: the same fixture returns the same
`redirected` values in manifest mode and with an environment selected. That test
failing means the two concerns have been mixed again.
