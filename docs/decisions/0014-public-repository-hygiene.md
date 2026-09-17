# 0014. Treat this repository as public

Date: 2026-09-15 · Status: accepted

**Trigger:** read before writing a test fixture, an example, a screenshot or a
commit message, and before copying any asset.

## Context

dbt-lens is developed against a client's dbt project, and lives in its own
repository under MIT at `github.com/IL-William/dbt-lens`. That repository is
private today, but it is written to be publishable at any moment, and it is
already shared with colleagues. Nothing about the client may be in it.

## Decision

- **Fixtures and examples are invented.** Names such as `MART_UAT`,
  `stg_orders` or `dev_db` stand in for anything real. No client name, database
  name, schema, model name or Jinja template copied from a client project
  appears in this repository, including in tests and comments.
- **Facts measured on a real project are written generically**, as orders of
  magnitude and dated, never as identifying detail.
- **Third-party assets are checked before use.** An icon was taken from a
  published VS Code extension early on and removed once its licence was read
  properly: being an editor extension does not make its artwork reusable.
  `THIRD_PARTY_NOTICES.md` lists everything vendored, with versions.

## Rejected

Keeping "just one" real fixture because it exercised an unusual template. It
was replaced by an equivalent invented one, and the tests are no weaker for it.

## Consequences

Before a commit, a quick scan for client terms is cheap insurance. `git grep`
searches tracked files only, so build output is skipped for free:

    git grep -niE "<client>|<project>|<database prefix>"

Anything project-specific that is genuinely worth keeping belongs in the
developer's own notes, not here.
