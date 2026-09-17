# 0009. Environments are resolved by a scanner, not a Jinja engine

Date: 2026-09-16 · Status: accepted

**Trigger:** read before touching `src/envs.rs`, and before adding a template
engine to evaluate dbt configuration.

## Context

The Catalog resolves where a model lives for a chosen `.env` file, which in
principle means evaluating Jinja. In practice, a survey of a large project
(roughly 3 300 models and 2 400 sources, September 2026) found only two shapes:
a plain literal, or `{{ env_var('NAME') }}` with an optional default, plus one
family of sources wrapping it in a single `{% if %}` whose condition depends on
a dbt variable rather than the environment.

## Decision

Hand-written scanning in `src/envs.rs`, covering exactly those shapes, with
whitespace control and either quote style. Anything else is reported as
`unevaluated` rather than guessed. The manifest's parsed value is the hint for
which branch dbt took, and the result is marked `branch` so the UI can say the
condition itself was not evaluated. Values come from the chosen file alone,
never from the process environment, which is likely to hold whatever
`activate.sh` last sourced.

## Rejected

- **minijinja or tera.** A full template engine, plus a fabricated `target`
  context and dbt's own builtins, to evaluate a grammar that can be enumerated
  in a page of code. Any unsupported construct would then be silently rendered
  wrong instead of visibly skipped.
- **Shelling out to dbt.** The tool does not run dbt (0002), and a parse takes
  minutes.

## Consequences

The safety net is `envs::agreement`: for every value driven by an environment
variable, how often a file reproduces what dbt parsed. The file dbt had loaded
must score 100%. Less than that means the scanner, the quoting or the manifest
is wrong, and it is the first check to run after changing this module.
