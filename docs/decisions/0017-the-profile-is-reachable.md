# 0017. The dbt profile is reachable, and it alone

Date: 2026-09-18 · Status: accepted, amended by 0019 · Supersedes 0012

**Trigger:** read before opening, reading or writing anything outside the
project.

## Context

The first column click against a real warehouse answered `251005: User is
empty`, which is Snowflake's way of saying that `profiles.yml` was still the
template the setup script wrote. Nothing in dbt-lens named the file the
connection came from, and that file sits in `~/.dbt`, outside the project,
where 0012 says nothing is read.

## Decision

- **One file, and the script names it.** `tools/sf_lineage.py` announces the
  profile before reading it, so the path is known even when reading it is what
  fails. dbt-lens opens that path and no other.
- **The route takes no path.** `GET` and `PUT /api/profiles` serve what the
  script announced, so no request can widen the exception. `/api/file` and its
  confinement to the project do not move.
- **It is editable.** An editor that shows the problem and cannot fix it sends
  the user elsewhere, which is where this started. The write is atomic, and the
  file has to exist already: this route never creates one.
- **Saving restarts the script**, which reads the profile once, when it starts.
  A correction nobody reads is worse than no correction.

What 0012 said and still holds: `.env` values never leave the server,
`DBT_ENV_SECRET_*` is never substituted, the server binds to `127.0.0.1`, and
the binary makes no outbound call of its own.
*Amended by [0019](0019-a-resolved-value-may-be-shown.md): a resolved
`env_var()` value may leave, under two guards.*

## Rejected

- **An exception inside `/api/file`.** Its rule would stop being readable in one
  line, and a path from the browser would be the thing deciding.
- **Read only.** It would name the problem and leave the fix somewhere else.
- **Opening it in the machine's own editor.** Nothing comes back to the page,
  and on Windows it lands in whatever claims `.yml`.

## Consequences

A profile can hold a password for another target, and it then appears in the
user's own browser, on their own machine, behind the same guard as everything
else (0015). The tab and the status bar both say the file is outside the
project, so it cannot be mistaken for one of its files.
