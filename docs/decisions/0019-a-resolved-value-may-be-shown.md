# 0019. A resolved value may reach the browser, under two guards

Date: 2026-09-18 · Status: accepted · Amends 0017

**Trigger:** read before returning any value derived from a `.env` file.

## Context

0012 allowed exactly two things derived from a `.env` file to leave the server:
resolved locations, and `DBT_TARGET`. 0017 superseded it on where files may be
read, and restated that boundary unchanged. Hovering a variable in the editor is
worth having only if it answers the question asked. A card that shows
`var('edp_ts')` as `{{ env_var('DBT_EDP_TS', '...') }}` and stops there restates
the line already on screen. Answering it means a third thing leaves.

## Decision

A resolved `env_var()` value may be returned by `GET /api/vars` and shown in the
hover card, subject to two guards, both server-side and both in `src/envs.rs`:

- **`DBT_ENV_SECRET_*` is never substituted**, unchanged from 0012 and 0017. One
  predicate, `is_secret`, now serves both `substitute` and `lookup`, so a value
  cannot reach through one door that the other refuses.
- **A name that reads as a credential returns its status and no value.**
  `sensitive_name` matches underscore-delimited tokens, so `PARTITION_KEY` and
  `DBT_UNIQUE_KEY` are ordinary config while `DBT_API_KEY` and `SF_PW` are not.
  It is applied only by the vars route: the location resolver legitimately reads
  names like `DBT_DB_RAW`, and a broad rule there would blank real schema names
  and quietly wreck `agreement` (0009).

The Manage environments panel is unchanged: names, counts and an agreement
percentage, never a value.

## Rejected

Returning the parsed `.env` to the browser, which 0012 rejected and which is
still wrong. A configurable allow-list: a setting that turns off a safety guard
is a setting that gets turned off. Click-to-reveal in the browser, which puts
the value in the payload and the devtools either way.

## Consequences

The question to ask when adding a payload field is now: could it carry a value
from a `.env` file, and if so does it pass both guards? A false positive from
the name guard shows the variable's name and status with no value, which is a
legible answer rather than a broken one. The check that matters is not what the
card draws but what the response body contains.
