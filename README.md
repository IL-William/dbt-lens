# dbt-lens

A very small browser IDE for dbt projects: file tree, editor, real terminal and
lineage read straight from `target/manifest.json`.

One Rust binary, no runtime to install, no Node build step. The whole UI is
embedded in the executable, so the machine that runs it needs nothing but the
binary itself and a browser.

```
dbt-lens /path/to/dbt/project
```

It prints a `http://127.0.0.1:4321` URL and opens it.

Changing dbt-lens itself rather than using it: [AGENTS.md](AGENTS.md) is the
short version, and [docs/decisions/](docs/decisions/) says why it is built this
way.

## Getting started

### What you need

- **A dbt project that has been parsed at least once.** dbt-lens reads
  `target/manifest.json` and never runs dbt itself, so that file has to exist.
  Any `dbt parse`, `dbt compile` or `dbt build` writes one.
- **Rust, on the machine that builds.** Not on the machine that runs: the binary
  carries its own UI and needs nothing installed. Get it from
  [rustup.rs](https://rustup.rs). Building on Windows itself also takes a C
  toolchain, see [Build it on the Windows machine](#build-it-on-the-windows-machine).
- **git on `PATH`**, for the Git tab. On Windows that usually means
  [Git for Windows](https://git-scm.com/download/win), which brings both `git`
  and the Git Bash the terminal runs. Where nothing can be installed, its
  [PortableGit](https://git-scm.com/download/win) archive unpacks into a folder
  and works the same once it is on `PATH`. Without any git, the rest still runs:
  the terminal falls back to PowerShell and the Git tab reports no repository.
- A browser.

### Install it

```
git clone https://github.com/IL-William/dbt-lens.git
cd dbt-lens
cargo install --path .
```

That one command builds it and puts `dbt-lens` in `~/.cargo/bin`, which rustup
already has on your `PATH`, so you can run it from any project afterwards. If
the command is not found once it finishes, add that directory to your `PATH`.

The repository is public, so the clone needs no account and no key. There is no
published download, though: building is how you get a binary.

Prefer not to install it? `cargo build --release` leaves the same binary at
`target/release/dbt-lens`, and everything below works with that path in place of
the `dbt-lens` command.

After a `git pull`, run the same command again. The binary carries the UI inside
it and does not update on its own.

### For a Windows machine

Two routes lead to the same `.exe`: build it elsewhere and copy it over, or build
it on the Windows machine. Either way, running it needs nothing installed.

#### Build it on a Mac or Linux, then copy it

Cross-compile (needs `mingw-w64`, available through Homebrew or your package
manager):

```
rustup target add x86_64-pc-windows-gnu
cargo build --release --target x86_64-pc-windows-gnu
```

Copy `target/x86_64-pc-windows-gnu/release/dbt-lens.exe` to the machine and run
it: no installer, no admin rights. It imports nothing but Windows system
libraries, so there is no runtime to place beside it. The terminal uses ConPTY,
which ships with Windows 10 and 11. Windows may warn about an unsigned
executable that arrived by copy, which is what an in-house build looks like
to it.

To type `dbt-lens` from any project there, as you would elsewhere, keep the
`.exe` in a folder of your own and put that folder on your `PATH`. Neither step
needs admin rights. In Git Bash:

```
mkdir -p ~/bin && mv /c/Users/you/Downloads/dbt-lens.exe ~/bin/
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
```

In PowerShell, touching your own `PATH` and not the machine's:

```
[Environment]::SetEnvironmentVariable('Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\Users\you\bin', 'User')
```

Updating is replacing that one file, and nothing else.

#### Build it on the Windows machine

Rust alone is not enough there: linking needs a C toolchain, and Windows does not
ship one. There are two ways to get it.

**With Visual Studio Build Tools** and their C++ workload, which is what rustup's
default toolchain expects. `cargo install --path .` then works as on any other
machine. Installing Build Tools takes administrator rights.

**Without administrator rights**, use Rust's GNU toolchain and a mingw-w64 of
your own. The GNU toolchain is not enough by itself: `windows-sys`, which tokio
and clap depend on, links Windows functions as `raw-dylib`, so rustc calls
`dlltool`, which calls the assembler `as`, and Rust does not ship `as`
([rust-lang/rust#140704](https://github.com/rust-lang/rust/issues/140704)).
WinLibs, from winget, installs for your user only and brings both. In Git Bash:

```
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu
winget install --id BrechtSanders.WinLibs.POSIX.UCRT -e
```

winget unpacks it under `%LOCALAPPDATA%\Microsoft\WinGet\Packages`, in a folder
named after the package. Put that folder's `mingw64\bin` on your `PATH`, open a
new terminal, and check that `as --version` answers:

```
echo 'export PATH="/c/Users/you/AppData/Local/Microsoft/WinGet/Packages/<WinLibs folder>/mingw64/bin:$PATH"' >> ~/.bashrc
```

Then `cargo install --path .` from the clone builds it and drops `dbt-lens.exe`
in `%USERPROFILE%\.cargo\bin`, which rustup already put on your `PATH`.

The two errors this avoids, word for word, so that searching for them lands here:

- `error calling dlltool 'dlltool.exe': program not found`: `dlltool` itself
  was not found.
- `dlltool.exe: CreateProcess`: `dlltool` ran but could not start `as`.

To update, stop dbt-lens first, because Windows will not replace an `.exe` that
is running, then `git pull` and `cargo install --path .` again.

### Run it

```
cd /path/to/your-dbt-project
dbt-lens
```

With no argument it opens the current directory, so be in the one that holds
`dbt_project.yml`. From anywhere else, pass that directory:
`dbt-lens /path/to/your-dbt-project`. Either way it prints what it found, then
opens a browser:

```
  reading /home/you/analytics/target/manifest.json
  2104 nodes in 180 ms  (412 models, 96 sources, 1508 tests)

  dbt-lens  0.2.0  (v0.2.0, built 2026-09-18)
  project   /home/you/analytics
  shell     /bin/zsh -l
  venv      dbt-env (activated, python 3.12)
  open      http://127.0.0.1:4321
```

Those lines are worth reading once: they say which project, manifest, shell and
Python environment were picked up, which is where nearly every setup mistake
shows up first. The version carries the build it came from, from
`git describe`, so two installs of the same release are still told apart; the
status bar shows the same thing at the bottom right of the page, and `dbt-lens
--version` prints it without starting anything. `Ctrl+C` in that terminal stops the server. Every flag is listed
under [Options](#options).

Only the manifest fields the UI needs are read and the rest is ignored, so a
manifest from dbt-core 1.x and one from dbt Fusion 2 both load. Fusion is what
it is used against day to day.

### If something looks off

| Symptom | Cause | Fix |
| --- | --- | --- |
| empty lineage, and startup said `no manifest at ...` | dbt has not written one, or it is elsewhere | run `dbt parse` in the project, or pass `--manifest path/to/manifest.json` |
| startup said `no dbt_project.yml in ...` | pointed at the wrong folder | pass the directory holding `dbt_project.yml` |
| the terminal opens PowerShell on Windows | Git Bash was not found where it is usually installed | point at it: `--shell '"C:\Program Files\Git\bin\bash.exe" -i'`, quotes included because of the space |
| the Git tab reports no repository | `git` is not on `PATH`, or the folder is not a clone | check `git -C <project> status` |
| column types are missing in the Catalog | no `catalog.json` | dbt Fusion: `dbt compile --write-catalog`; dbt-core: `dbt docs generate` |
| the URL says a port other than 4321 | 4321 was busy, so it walked forward to a free one | use the URL it printed, or pass `--port` |
| the Snowflake lineage switch says `failed` | the script could not start, and its tooltip says why | usually no `snowflake-connector-python` in the Python it found, or no `profiles.yml` it can read |
| a clicked column comes back with no lineage | the object was not built by a query Snowflake could analyse, or the role cannot see it | check with `sf_lineage.py probe`, and check the environment pill names the objects you mean |
| no browser opened | `--no-open`, or no default browser | open the printed URL by hand |
| a fix seems to have no effect after reinstalling | the running binary is an older build | compare `dbt-lens --version` with `git describe --tags --always --dirty` in the clone; on Windows, stop dbt-lens first, since the `.exe` cannot be replaced while it runs |

## Why

The lineage is already in `manifest.json`. This reads it once (roughly one
second for a 90 MB manifest), keeps a compact graph in memory, and serves
sub-graphs around whichever model you are looking at.

## Usage

| Action | |
| --- | --- |
| click a `ref()` / `source()` / `source_model` name | jump to that model's file |
| `Cmd/Ctrl + K` | search models, sources and every file in the project |
| `Cmd/Ctrl + S` | save the current file |
| `Cmd/Ctrl + Alt + S` | save every modified file |
| `Alt + W`, or middle-click a tab | close a tab |
| `Cmd/Ctrl + \`` | jump to the terminal |
| click a column in Catalog > Columns | draw its lineage, fetched from Snowflake when the switch is on |
| hover a lineage node, a `ref()` or a `var()` | a card with what it is |
| click a lineage node | select it, fill the Node panel |
| double-click a lineage node | re-centre the lineage on it and open its file |
| `+N` badge on a node | pull in one more level of parents or children |
| wheel / drag | zoom and pan the lineage |

Opening a `.sql` or `.yml` file that belongs to a dbt node moves the lineage
onto that node, so the graph follows the editor.

The lineage graph itself comes entirely from `manifest.json` (`parent_map`).
No `.sql` file is ever parsed to build it: dbt already did that work.

The editor links are a separate mechanism. The manifest knows *what* a model
depends on, but not reliably *where* in the file that name is written, and its
positions freeze at parse time anyway. So the vocabulary comes from the
manifest (a node's real parents) and the positions come from the open buffer,
which keeps the links correct while you type.

A name is linked when it is quoted, is a YAML key, or is a YAML value, which
covers `ref()`, `source()` and every automate_dv shape (`source_model` quoted or
bare, lists, `satellites:`, `stage_tables:`) without linking every column that
happens to share a model name. Jinja comments are skipped. Disabled models are
amber and still open; a name in `ref()` that no manifest node matches is red,
which makes it a genuine dangling-reference signal. Alt-click places the cursor
instead of navigating.

Jinja in a model is coloured by role: delimiters and keywords in orange, what
dbt itself provides (`ref`, `source`, `this`, `adapter`, `is_incremental`...) in
yellow, any other macro or filter in blue, named arguments in red. The SQL
colouring is never shown the Jinja, so an apostrophe in a Jinja comment cannot
turn the rest of the file into a string.

The **Catalog** tab mirrors what dbt's own catalog shows: materialization,
column count, upstream and downstream counts, tags and description under
Preview, and a Column / Type / Description / Tests table under Columns. The
upstream and downstream lists navigate like the graph: click moves the lineage
and the catalog to that node, double-click also opens its file.
Everything there comes from `manifest.json`, which already holds the merged YAML
(descriptions, tags, and the tests attached to each column). Column *types* are
the exception: the manifest only carries them when they are declared in YAML, so
run `dbt compile --write-catalog` under Fusion, or `dbt docs generate` under
dbt-core, and
`catalog.json` is picked up automatically, filling in
the real warehouse types and listing the columns that exist in the warehouse but
are not documented (shown in italics).

### Hover cards

Pausing on a lineage box, or on a `ref()` / `source()` in the editor, opens a
small card with the model's description, its first columns and their types, the
upstream, downstream and test counts, and its tags. It is the Catalog Preview in
passing, without leaving the file or the graph. Panning, zooming, scrolling,
clicking or typing dismisses it, and a click on a `ref()` still navigates.

Pausing on a `var('x')` or an `env_var('X')` shows what that variable is worth.
This is the one thing dbt's own artifacts cannot tell you: the manifest holds no
`vars` at all, so the values are read straight from the `vars:` block of
`dbt_project.yml`, and the card names the line they came from. A var whose value
is itself `{{ env_var(...) }}` is resolved under the environment selected in the
status bar, and the card says whether the value came from that file or from the
default written in the call. Any line of the block it could not read is reported
with its line number rather than quietly skipped.

Two things are never shown, both refused on the server rather than hidden in the
page: a `DBT_ENV_SECRET_*`, which dbt itself marks as never renderable, and any
variable whose name reads as a credential (`SNOWFLAKE_PASSWORD`, `DBT_API_KEY`,
`SF_PW`). Those still show their name and whether the file defines them, which
is usually the question anyway. Ordinary config keeps working: `PARTITION_KEY`
and `DBT_UNIQUE_KEY` are not credentials.

`manifest.json` is polled every three seconds: run `dbt build` in the built-in
terminal and the lineage refreshes on its own when dbt rewrites the file.

### Search

`Cmd/Ctrl + K` searches two things at once: dbt nodes from the manifest, and a
flat index of every file in the project. That second half matters more than it
sounds: a generic test definition, a macro, a script or a dotfile is not a dbt
node, and a manifest-only search can never find one.

The index is a directory walk, redone every 20 seconds, so a new file or a
branch switch shows up without any invalidation logic. `target`, `logs`, `.git`
and virtualenvs are skipped, since `target` alone holds more files than the rest
of the project put together. `dbt_packages` is indexed but ranked below your own
files, so reading an automate_dv macro is one search away without ever
outranking your own code.

### Explorer

Folders carry the state of what is inside them:

| | |
| --- | --- |
| green | holds a file with unsaved changes in the editor |
| amber | holds a file that is saved but not committed, or untracked |

Files are coloured the same way, so a green folder can be followed down to the
buffer that is still unwritten. Status comes from `git status --porcelain`, run
server-side, cached for 1.5 s and polled every 5 s, so committing from the
built-in terminal clears the colours on its own.

File types get their own icon and colour; `.sql` files use a database glyph.

### Column lineage

Column-level edges come from Snowflake's `SNOWFLAKE.CORE.GET_LINEAGE`, read by
`tools/sf_lineage.py`. dbt-lens itself never connects to Snowflake: it has no
HTTP client, no TLS and no credential handling, and keeping it that way is what
lets it ship as one dependency-free binary. The script owns the connection and
reads your dbt profile, so SSO, key-pair and password targets all work
unchanged.

**Switch it on in Catalog > Columns, then click a column.** The switch is
remembered per project. Switching on starts the script and checks everything
that needs no network: a Python with the connector, your profile, its target
and role, all named in the switch's tooltip. Nothing connects until you click a
column, and the first click of a session may open a sign-in tab.

In the top bar, next to the model counts, `profiles.yml` names the file the
script read, and opens it in the editor. It is the one file outside the project dbt-lens opens, and only
because the script says which one it is (0017). Saving it restarts the script,
since the profile is read once, when it starts. When Snowflake refuses the
connection, the message points at that file rather than leaving you with an
error code.

A click asks for that column's upstream and downstream lineage, as deep as the
`up` and `down` boxes say and at most five levels, which is `GET_LINEAGE`'s
limit. What comes back is added to `target/column_lineage.json` and drawn with
columns as nodes, so it is still there after a restart and stays readable with
the switch off. Changing `up` or `down` redraws what has been fetched; clicking
a column asks Snowflake again.

**Which objects are asked about follows the environment pill** in the status
bar. On `manifest` that is the relation your last dbt run built, usually your
own schema. Choose a `.env` file and it is the relation that environment
resolves to, exactly as the Location table shows it. The cache itself names dbt
nodes rather than warehouse objects, so one file holds for every environment.

The Python that runs is a virtual environment of the project that has
`snowflake-connector-python` (dbt-snowflake brings it), else the one the status
bar names, else `python` on the `PATH`.

`GET_LINEAGE` needs Enterprise Edition and the `VIEW LINEAGE` privilege. When a
column comes back with nothing, check what the role is allowed to read:

```
python tools/sf_lineage.py probe \
  --relation my_database.my_schema.my_model --column my_column
```

The same script still fills the cache ahead of time, which is what to do before
working offline. One call covers one column, so a whole project is hundreds of
thousands of calls: always scope the dump.

```
python tools/sf_lineage.py dump --select model_a,model_b \
  --out target/column_lineage.json
```

dbt-lens picks `target/column_lineage.json` up on its own, the same way it picks
up `catalog.json`, and reloads when the file changes. `--column-lineage <path>`
overrides the location. With edges present, the Catalog > Columns table gains a
Lineage column and the canvas gains a Models / Columns switch. With no edges and
the switch off, nothing changes: the Columns table is exactly as it was and the
Columns switch stays disabled.

### Where a model lives

The Catalog preview shows each node's database, schema and alias at three
stages, because in a project driven by `env_var()` and `generate_*_name`
macros no single value tells the whole story:

| | |
| --- | --- |
| **as written** | the config exactly as authored, Jinja included |
| **resolved** | the config with its env vars evaluated |
| **built** | where the target that produced the manifest actually built it |

A last row gives the full relation for *resolved* and *built*, each with a Copy
button, quoted part by part the way dbt quotes the built one. The resolved
relation is only offered when it can be written for real: a database or schema
left to the target profile, a placeholder or a missing variable says why
instead.

Without an environment selected, *resolved* is the config as dbt parsed it,
which means with whatever env vars happened to be loaded at the time. That is
not necessarily any particular environment: a shell that sourced a CI `.env`
file yields CI values.

When a manifest comes from a developer sandbox, where nearly every model is
built into one `database.schema`, dbt-lens detects it once and says so, rather
than flagging every model as moved. A model built somewhere unexpected is only
highlighted when it is the exception. The comparison is always between the
parsed config and the built location, which come from the same parse. Case
alone is never counted as a move, since Snowflake folds unquoted identifiers,
and neither is a pair of literal quotes that dbt drops.

### Environments

The `env` pill in the status bar evaluates the *resolved* column against one of
the project's `.env` files, so a model's location can be read for DEV, QA or
UAT without running dbt. Built stays tied to the manifest's own target. The same
switch sits in the header of the resolved column, and the pill takes a colour
per environment family (DEV, CI, QA, STG, UAT, PROD) so the one in use shows at
a glance.

- **Detection.** Every `.env` and `.env.*` file in the project root is offered,
  named after its suffix: `.env.uat` is UAT. A `DBT_TARGET` that disagrees with
  the suffix is flagged, since it usually means a file copied from another
  environment. Templates (`.env.example`), backups, and files that define none
  of the variables in use start hidden.
- **Evaluation.** `{{ env_var('NAME') }}`, with or without a default, and plain
  literals are evaluated. A single `if` / `else` is followed through the branch
  dbt actually took when it parsed, and marked as such. Anything else, filters
  or `target.*` for instance, is shown as not evaluated rather than guessed.
- **The file alone.** Values come only from the chosen file, never from the
  shell dbt-lens was started in. So *missing* means "not defined in this file",
  which is not quite what dbt would see after sourcing several files in a row.
  `${...}` interpolation is kept as text and not evaluated.
- **Flagged, not shown as real.** Variables set to a placeholder (`N/A`, `TODO`,
  `null` and the like) or left undefined.
- **Secrets.** `DBT_ENV_SECRET_*` variables are never substituted, and no
  variable value is ever sent to the browser except resolved locations and
  `DBT_TARGET`.

*Manage environments* renames or hides files. It also reports, per file, how
often that file reproduces what dbt parsed: the file dbt actually had loaded
scores 100%, which makes it easy to spot which environment a manifest came from.

Those settings are stored per project in the user's config directory, never in
the project itself:

| | |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/dbt-lens`, else `~/.config/dbt-lens` |
| Windows | `%APPDATA%\dbt-lens` |
| anywhere | `DBT_LENS_CONFIG_DIR` overrides both |

Each browser tab keeps its own environment. The stored one is only where a new
tab starts.

### Reading the graph

Node colour is the materialization, not the resource type, because that is what
you reason about when reading a DAG: what exists in the warehouse and what gets
rebuilt. View, table, incremental and ephemeral each have their own colour,
sources, seeds and snapshots keep theirs, and **any materialization the tool
does not know is drawn in magenta** so a custom one stands out rather than
blending in. Ephemeral models are dashed, like disabled ones: nothing of them
exists in the warehouse. The legend in the corner lists only the
materializations actually on screen. The same colours are used for the dots in
the sidebar and the catalog, so a model looks the same everywhere.

### Compiled SQL

A Compiled tab shows what dbt last wrote to `target/compiled/`, with its age.
It turns amber when the compiled file is over an hour old, or when the model or
its schema file changed after it was compiled, which is the case that actually
bites: reading compiled SQL that no longer matches the source.

dbt-lens never compiles anything itself. dbt runs where you run it, so when
there is no compiled file the tab names the paths it checked and offers to type
`dbt compile --select <model>` into the integrated terminal, without pressing
Enter for you.

### Python environment

The status bar shows the virtualenv, labelled `venv` when it was active as
dbt-lens started and `venv (inactive)` when it was merely found in the project,
with the Python and dbt versions in the tooltip. When several are present, the
one that actually contains dbt wins.

### Git

A third sidebar tab stages, commits, pulls and pushes, and the branch name in
its header (and in the status bar) opens a filtered branch switcher rather than a
list, since a long-lived repository easily carries hundreds of branches.

Two rules hold across the whole git surface:

- **Nothing destroys work.** There is no `-f`, no `--hard`, no `clean`, no
  `push --force` anywhere in `src/git.rs`. The worst any button can do is create
  a stash. When a branch switch is refused because local changes are in the way,
  the blocking paths are listed and the only offer is to stash them, tagged with
  the branch being left, recoverable with `git stash pop`.
- **Nothing can hang the server.** Network commands run with
  `GIT_TERMINAL_PROMPT=0` and ssh in batch mode, so a missing credential fails
  in seconds instead of waiting forever on a prompt nobody can answer. Every
  command has a deadline, and both pipes are drained by their own threads so a
  chatty hook cannot deadlock.

Commit fetches first, so the ahead/behind counts next to it are current; a
failing fetch never blocks the commit. Hooks always run: pre-commit hooks can take
a while and can fail, and their output is shown in full rather than bypassed
with `--no-verify`. Pull is `--ff-only`, so it can
never start a merge on its own; if the branches have diverged it says so and
leaves the choice of merge or rebase to you.

Clicking a changed file opens a side-by-side diff of HEAD against the working
tree, in its own tab, read-only: a `+` or `-` sits next to every changed line,
regions with no counterpart on the other side are hatched, long identical
stretches collapse, and a ruler down the right edge shows where the changes are
and jumps to them. New files show entirely as added, deleted ones as removed.
Editing stays in the file itself, one button away.

Conflicted files get their own section. Opening one highlights the
`<<<<<<<` / `=======` / `>>>>>>>` blocks and puts *keep ours / keep theirs /
keep both* above each one; a block only counts once all three markers are
present, so a half-edited file is left alone. When a file is done, one button
marks it resolved (`git add`), and the merge can be aborted at any point.

### Tabs

A single click in the file tree opens a **preview** tab, shown in italics and
reused by the next single click, so browsing the project does not pile up tabs.
Double-clicking, or editing the file, pins it. The **Open editors** panel at the
top of the sidebar lists every open file with its own close and save buttons,
plus save-all and close-all in its header. Closing a tab never touches the file
on disk.

### Options

```
dbt-lens [PROJECT]                       dbt project root, default the current directory
         [-p, --port 4321]               tries up to 20 ports from there, then gives up
         [--manifest path/manifest.json] default <project>/target/manifest.json
         [--catalog path/catalog.json]   default <project>/target/catalog.json
         [--column-lineage path.json]    default <project>/target/column_lineage.json
         [--shell "zsh -l"]              overrides the shell below
         [--no-open]                     do not open a browser at startup
```

A relative path in `--manifest`, `--catalog` or `--column-lineage` is relative
to where you run the command, not to the project. `dbt-lens --help` prints the
same list. The terminal runs `$SHELL -l` on macOS
and Linux, and Git Bash on Windows, falling back to PowerShell when Git Bash is
not installed.

## Tests

Everything at once, which is what to run before calling a change done:

```
./scripts/check.sh
```

The Rust side has unit tests for `.env` parsing, location resolution and the
settings store:

```
cargo test
```

The browser code has small harnesses that run on macOS with the system
JavaScript engine, no install required, from the repository root:

```
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC web/tests/tabs.js        # preview/pinned tab state machine
$JSC web/tests/explorer.js    # git and unsaved colouring, including folders
$JSC web/tests/collineage.js  # composite column ids and node subtitles
$JSC web/tests/conflicts.js   # conflict block detection, including half blocks
$JSC web/tests/colours.js     # materialization colours, including custom ones
$JSC web/tests/diff.js        # diff ruler geometry, clamping and pane heights
$JSC web/tests/palette.js     # search palette merging nodes and files
$JSC web/tests/location.js    # written, resolved and built locations
$JSC web/tests/jinja.js       # Jinja colouring, and SQL never shown the Jinja
$JSC web/tests/hovercard.js   # where a hover card lands beside its anchor
$JSC web/tests/vars.js        # var() / env_var() scanning, and where a value came from
```

The Snowflake script has tests of its own, against a fake connector and a fake
PyYAML, so they need no warehouse and nothing installed:

```
python3 tools/test_sf_lineage.py
```

## Layout

```
src/manifest.rs   manifest.json -> raw structs (only the fields the UI needs)
src/graph.rs      compact node vector, adjacency, search, lineage BFS
src/api.rs        HTTP + WebSocket handlers
src/collin.rs     the column lineage cache, merged like catalog.json
src/sidecar.rs    the Snowflake script: started by the switch, one request at a time
src/compiled.rs   compiled SQL lookup and freshness
src/envs.rs       .env parsing and location resolution per environment
src/project.rs    the vars: block of dbt_project.yml, read by hand
src/git.rs        working tree status and the git commands the UI can run
src/settings.rs   per-project settings, kept outside the project
src/venv.rs       which Python environment is in play
src/files.rs      filesystem access, confined to the project root
src/pty.rs        one PTY per terminal connection
web/              UI: no framework, CodeMirror 5 and xterm.js are vendored
web/lineage.js    layered graph layout and SVG renderer, model and column modes
web/vendor/       CodeMirror, xterm, the merge addon and diff-match-patch
tools/            sf_lineage.py, the only piece that talks to Snowflake
```

The server binds to `127.0.0.1` only, and every file path is resolved against
the project root, so nothing outside the opened project is reachable. Requests
must come from its own page: a `Host` or `Origin` naming anything else gets a
`403`, which keeps other web pages in your browser away from the terminal and
the git buttons. [SECURITY.md](SECURITY.md) spells out what is and is not
covered.

## Not there yet

Compiled SQL preview, running a selector straight from the graph, persisting
open tabs between sessions, and filtering column lineage by edge kind once we
know how dense the real graph is. A second lineage source is sketched out but
not built: dbt Fusion computes column lineage locally with
`dbt compile --static-analysis strict --write-index --write-lineage`, which
needs no warehouse privileges and covers uncommitted SQL.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party libraries keep their own
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
