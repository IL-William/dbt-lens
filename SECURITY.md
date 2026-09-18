# Security

## What dbt-lens assumes

dbt-lens is a local tool. One person runs it on their own machine, against a
project they already have full access to, and it runs with that person's
rights: the terminal is their shell, the git buttons use their credentials,
the editor reads and writes their files.

- **The server listens on `127.0.0.1` only.** Other machines cannot reach it.
- **The browser is not trusted.** Any web page can talk to localhost, so every
  request must carry a `Host` naming this server and, for anything that is not
  a plain read, an `Origin` that is this server's own page. Everything else is
  refused with `403`. The WebSocket terminal requires the `Origin`.
- **Every reply carries a content security policy** that allows nothing from
  another origin and refuses framing, so the terminal cannot be put under an
  invisible overlay on someone else's page.
- **Every file path is confined to the opened project.** `..`, absolute paths,
  drive letters and symlinks pointing out are refused. One file outside it is
  reachable: the dbt profile the Snowflake script reads, which that script
  names itself, and which only its own route serves. No path for it ever comes
  from the browser.
- **The editor reads the whole project, `.env` included.** That is what an
  editor is for. The environments panel, by contrast, never returns a `.env`
  value, only names and counts. The hover card on a variable does show a
  resolved value, but never one whose name is a `DBT_ENV_SECRET_*` or reads as a
  credential; both guards are server-side (0019).
- **No outbound network calls of its own**, apart from the git commands you
  click. Snowflake column lineage is a separate script, `tools/sf_lineage.py`,
  which dbt-lens starts only while you have that switch on, and which opens a
  connection only when you click a column. It reads your dbt profile itself, so
  no credential passes through dbt-lens.

## Out of scope

- The project you open is yours. Its git hooks run when you commit, as they
  would from the command line, and with Snowflake lineage switched on its
  virtual environment's Python runs the lineage script.
- Anything already running as your user on the same machine.
- Exposing the port to the network with a tunnel or a proxy. It has no
  authentication and was never meant to be reached that way.

## Known issues

- **CodeMirror 5.65.21 carries CVE-2025-6493**, a regular expression that goes
  quadratic on crafted input in the Markdown mode. It is fixed only in
  CodeMirror 6, which this project does not use and will not adopt lightly
  (0004). Reaching it means opening a hostile `.md` file that is already in the
  project you opened, and the result is a frozen browser tab, not code
  execution or a leak. OSV records it against CodeMirror's commits up to 5.65.20
  only, so asking about 5.65.21 returns nothing, but its `markdown.js` is
  byte-identical to the affected one. The vendored version and its licence are
  in `THIRD_PARTY_NOTICES.md`.

## Reporting

Open a private security advisory on the GitHub repository, or write to its
owner directly. Please include the request that reproduces
the problem. Rust dependencies are checked against the RustSec database, and the
vendored frontend libraries against OSV (`scripts/audit_vendored.py`), on every
push, every Monday, and locally by `./scripts/check.sh`.
