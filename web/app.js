/* dbt-lens UI shell: sidebar, editor tabs, lineage, node detail, terminal. */
(() => {
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  meta: null,
  open: new Map(),   // path -> {doc, dirty}
  order: [],
  active: null,
  focus: null,       // unique_id currently in the lineage view
  cm: null,
  term: null, ws: null, fit: null,
  preview: null,              // path of the reusable preview tab, VS Code style
  rows: new Map(),            // tree rows currently rendered, by path
  gitMod: new Set(), gitUnt: new Set(),
  gitModDirs: new Set(), gitUntDirs: new Set(),
  gitPrefixes: [], gitKey: '',
  git: null,                  // full payload of /api/git
  compiledCm: null,           // read-only editor for the compiled SQL
  envs: null,                 // payload of /api/envs
  env: '',                    // this tab's chosen .env file, '' for the manifest as parsed
  node: null,                 // catalog: node currently displayed
  catTab: 'preview',          // catalog: preview | columns
  graphMode: 'model',         // lineage canvas: model | column
  colFocus: null,             // {id, column} when the canvas shows columns
  colHighlight: '',           // column row to mark in the Columns table
  colSort: 'az',              // catalog: az | tests
  sidecar: null,              // payload of /api/sidecar: the Snowflake lineage switch and its script
  colAsk: 0,                  // bumped on every column click, so only the latest answer is drawn
  colAnswered: false,         // Snowflake has answered once on this page, so no sign-in tab is expected
  nodeCache: new Map(),       // /api/node payloads, by query: hover asks far more often than click
  nodeGen: 0,                 // bumped when the manifest or a .env file changes under the cache
  vars: null,                 // payload of /api/vars, for the editor's var() marks
  outline: null,              // { path, nodes } scanned for the breadcrumb's symbol half
  crumbLine: -1,              // the line that half was last drawn for
};

// ------------------------------------------------------------------ util --
/* A route that can fail in several ways answers with JSON, and its fields end
   up on the Error: the message stays readable either way. */
function apiError(text, fallback) {
  try {
    const body = JSON.parse(text);
    if (body && body.error) return Object.assign(new Error(body.error), body);
  } catch { /* a plain sentence, which is the usual case */ }
  return new Error(text || fallback);
}

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw apiError(await r.text(), r.statusText);
    return r.json();
  },
  async send(path, method, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw apiError(await r.text(), r.statusText);
    return r.json();
  },
};

/* One /api/node payload per node, shared by the catalog, the ref() marks and the
   hover card. The server rediscovers the .env files and walks the graph twice on
   every request, which a click could afford and a hover cannot. The promise is
   what is stored, not the value: a hover and the click that follows it 30ms
   later are then one request rather than two.

   The entry expires, because the server reloads the graph by itself when dbt
   rewrites the artifacts (watch_artifacts, every three seconds) and never tells
   the browser. Before this cache existed every click refetched, so a `dbt build`
   in the terminal showed up on the next click; an entry that outlived that poll
   would take that back. Three seconds is the server's own interval, so the cache
   is never staler than the thing it is caching. */
const NODE_CACHE_MAX = 200;
const NODE_CACHE_TTL = 3000;

function nodeKey(q) {
  return q.id ? 'id:' + q.id : 'file:' + q.file;
}

function nodeDetail(q) {
  const key = nodeKey(q);
  const hit = S.nodeCache.get(key);
  if (hit && hit.gen === S.nodeGen && Date.now() - hit.at < NODE_CACHE_TTL) return hit.p;
  const path = q.id ? '/api/node?id=' + encodeURIComponent(q.id) : '/api/node?file=' + encodeURIComponent(q.file);
  // A failed request must not be remembered as the answer.
  const p = api.get(path).catch((e) => { S.nodeCache.delete(key); throw e; });
  S.nodeCache.set(key, { gen: S.nodeGen, at: Date.now(), p });
  if (S.nodeCache.size > NODE_CACHE_MAX) S.nodeCache.delete(S.nodeCache.keys().next().value);
  return p;
}

/* The project's vars, plus any env var asked for by name. Keyed by the chosen
   environment as well, because the same var resolves differently under each. */
function fetchVars(names) {
  const key = (S.env || '') + '|' + (names || '');
  if (!S.vars) S.vars = new Map();
  const hit = S.vars.get(key);
  if (hit) return hit;
  let url = '/api/vars?env=' + encodeURIComponent(S.env || '');
  if (names) url += '&names=' + encodeURIComponent(names);
  const p = api.get(url).catch((e) => { S.vars.delete(key); throw e; });
  S.vars.set(key, p);
  return p;
}

/* The manifest was reloaded, or a file the payload derives from was saved. */
function dropNodeCache() {
  S.nodeGen++;
  S.nodeCache.clear();
  S.vars = null;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* Same colour rule as the lineage canvas, so a model looks the same everywhere. */
const dot = (n) => {
  const d = document.createElement('span');
  d.className = 'dot';
  d.style.background = Lineage.nodeColor(typeof n === 'string' ? { kind: n } : n);
  d.title = Lineage.matLabel(typeof n === 'string' ? { kind: n } : n);
  return d;
};

// ---------------------------------------------------------------- editor --
/* Jinja in a model, one token at a time, from an opening delimiter to its close.
   Each piece is styled by what it is, so a call reads apart from a variable, a
   keyword or a string. `jinja-dbt` is what dbt itself provides, taken from its list
   of Jinja functions and context variables: `ref`, `this` and `adapter` look alike,
   `dbt_utils.star` does not. */
const JINJA_KEYWORDS = new Set(('and as block break call continue do docs elif else endblock endcall ' +
  'enddocs endfilter endfor endif endmacro endmaterialization endraw endset endsnapshot endtest ' +
  'endwith extends filter for from if import in include is macro materialization not or raw ' +
  'recursive set snapshot test with without').split(' '));
const JINJA_ATOMS = new Set(['true', 'false', 'none', 'True', 'False', 'None']);
const DBT_GLOBALS = new Set(('adapter api builtins config dbt_version debug env_var exceptions ' +
  'execute flags fromjson fromyaml graph invocation_id is_incremental load_result local_md5 log ' +
  'model modules print project_name ref return run_query run_started_at selected_resources set ' +
  'set_strict source statement target this thread_id tojson toyaml var zip zip_strict').split(' '));

function jinjaStart() {
  return { close: null, quote: null, depth: 0, tag: false, dot: false, pipe: false };
}

function jinjaToken(stream, state) {
  if (!state.close) {
    // dbtSqlMode only calls in here outside a block when a delimiter opens.
    const open = stream.match(/^\{([{%#])[-+]?/);
    Object.assign(state, jinjaStart(), { close: { '{': '}}', '%': '%}', '#': '#}' }[open[1]] });
    state.tag = open[1] === '%';
    return open[1] === '#' ? 'jinja-comment' : 'jinja-delim';
  }
  if (state.close === '#}') {
    if (stream.match(/^.*?#\}/)) state.close = null;
    else stream.skipToEnd();
    return 'jinja-comment';
  }
  if (state.quote || stream.match(/^['"]/, false)) {
    if (!state.quote) state.quote = stream.next();
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === '\\') stream.next();
      else if (ch === state.quote) { state.quote = null; break; }
    }
    state.tag = state.dot = state.pipe = false;
    return 'jinja-string';
  }
  const end = stream.match(/^[-+]?(?:\}\}|%\})/, false);
  if (end && end[0].endsWith(state.close)) {
    stream.match(end[0]);
    state.close = null;
    return 'jinja-delim';
  }
  if (stream.eatSpace()) return null;
  if (stream.match(/^\d+(?:\.\d+)?/)) {
    state.tag = state.dot = state.pipe = false;
    return 'jinja-number';
  }
  const word = stream.match(/^[A-Za-z_]\w*/);
  if (word) {
    const w = word[0];
    const { tag, dot, pipe } = state;
    state.tag = state.dot = state.pipe = false;
    // The first word of a {% %} block is its tag, whatever else it could be.
    if (tag) return 'jinja-keyword';
    // A named argument before a keyword: dbt_utils.star(from=...) is common.
    if (state.depth > 0 && stream.match(/^\s*=(?!=)/, false)) return 'jinja-param';
    if (JINJA_KEYWORDS.has(w) && !stream.match('(', false)) return 'jinja-keyword';
    const called = stream.match(/^\s*\(/, false);
    // After a dot it is an attribute or a method, never a dbt global.
    if (dot) return called ? 'jinja-fn' : 'jinja-var';
    if (JINJA_ATOMS.has(w)) return 'jinja-atom';
    if (DBT_GLOBALS.has(w)) return 'jinja-dbt';
    return called || pipe ? 'jinja-fn' : 'jinja-var';
  }
  const ch = stream.next();
  if ('([{'.includes(ch)) state.depth++;
  else if (')]}'.includes(ch) && state.depth > 0) state.depth--;
  state.tag = false;
  state.dot = ch === '.';
  state.pipe = ch === '|';
  return 'jinja-punct';
}

/* SQL with Jinja in it. The SQL mode is never shown the Jinja: while it tokenizes,
   the line is cut short at the next delimiter, as CodeMirror's multiplex addon
   does. Shown the whole line, it took the apostrophe in {# don't #} for the start
   of a string and coloured the rest of the file as one. */
function dbtSqlMode(sql) {
  return {
    startState: () => ({ sql: CodeMirror.startState(sql), jinja: jinjaStart() }),
    copyState: (s) => ({ sql: CodeMirror.copyState(sql, s.sql), jinja: { ...s.jinja } }),
    token(stream, state) {
      if (state.jinja.close || stream.match(/^\{[{%#]/, false)) return jinjaToken(stream, state.jinja);
      const at = stream.string.slice(stream.pos).search(/\{[{%#]/);
      if (at < 0) return sql.token(stream, state.sql);
      const line = stream.string;
      stream.string = line.slice(0, stream.pos + at);
      try {
        return sql.token(stream, state.sql);
      } finally {
        stream.string = line;
      }
    },
    indent: sql.indent && ((state, textAfter, line) => sql.indent(state.sql, textAfter, line)),
    innerMode: (state) => ({ state: state.sql, mode: sql }),
  };
}

CodeMirror.defineMode('dbt-sql', (cfg) => dbtSqlMode(CodeMirror.getMode(cfg, 'text/x-sql')));

/* ref('x') / ref('pkg','x') / source('src','table') -> clickable marks.
   Marks live on the Doc, so they survive tab switches and are scanned once. */
const REF_RE = /\b(ref|source)\s*\(\s*(['"])([^'"\n]+)\2\s*(?:,\s*(['"])([^'"\n]+)\4\s*)?\)/g;
const TOKEN_RE = /[A-Za-z0-9_]+/g;

/* Blanks out {# ... #} blocks, keeping both offsets and line breaks intact: dbt
   never evaluates what is inside them, so neither should the link scanner. */
function maskJinjaComments(src) {
  return src.replace(/\{#[\s\S]*?#\}/g, (block) => block.replace(/[^\n]/g, ' '));
}

/* Explicit ref() / source() calls, with the exact range of each name. */
function scanCalls(text) {
  const found = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) {
    const isSource = m[1] === 'source';
    const q1 = m[2] + m[3] + m[2];
    const o1 = m[0].indexOf(q1);
    const a1 = [m.index + o1 + 1, m.index + o1 + 1 + m[3].length];
    let a2 = null;
    if (m[5] !== undefined) {
      const q2 = m[4] + m[5] + m[4];
      const o2 = m[0].indexOf(q2, o1 + q1.length);
      a2 = [m.index + o2 + 1, m.index + o2 + 1 + m[5].length];
    }
    if (isSource && !a2) continue;
    const name = isSource ? `${m[3]}.${m[5]}` : (m[5] !== undefined ? m[5] : m[3]);
    found.push({ name, ranges: isSource ? [a1, a2] : [a2 || a1] });
  }
  return found;
}

/* var('x') / var('x', default) / env_var('X') / env_var('X', 'd') -> hover marks.
   The dbt-sql mode gives var, env_var, ref and source the same `jinja-dbt`
   token, so the token type cannot tell them apart. The scanner can. */
const VAR_RE = /\b(var|env_var)\s*\(\s*(['"])([^'"\n]+)\2\s*(?:,([^)\n]*))?\)/g;

function scanVars(text) {
  const found = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    // \b matches after a dot too, so dbt_utils.var('x') would otherwise count.
    if (text[m.index - 1] === '.') continue;
    // The whole call, not just the name inside the quotes the way scanCalls
    // marks a ref(). A ref's name is the thing you click, so a tight target is
    // right there; a variable has nothing to click, and `var('x')` reads as one
    // word, so anything less than the whole of it is a target you have to aim at.
    found.push({
      kind: m[1],
      name: m[3],
      fallback: m[4] === undefined ? '' : m[4].trim(),
      ranges: [[m.index, m.index + m[0].length]],
    });
  }
  return found;
}

/* The line under a variable's value, saying where the value came from. Pure, so
   the wording can be checked without a DOM. `env` is the chosen file's name, or
   '' when this tab is showing the manifest as dbt parsed it. */
function varNote(row, env) {
  const names = (row.vars || []).join(', ');
  const where = env || 'any environment file';
  if (row.redacted) {
    return row.status === 'env' || row.status === 'placeholder'
      ? `set in ${where}, hidden because the name reads as a credential`
      : 'hidden because the name reads as a credential';
  }
  switch (row.status) {
    case 'env':
      return row.default_used ? 'the default written in the call, not from a file' : `read from ${where}`;
    case 'missing':
      return env ? `${names} is not set in ${env}` : `${names} needs an environment, and none is selected`;
    case 'placeholder':
      return `${names} is a placeholder in ${where}, not a real value`;
    case 'unevaluated':
      return 'not evaluated: a secret, or Jinja this does not read';
    default:
      return '';
  }
}

/* automate_dv declares parents through a YAML metadata block rather than ref(),
   in more shapes than are worth chasing with one regex per shape:

       source_model: "prepdv_x"        source_model = ["a", "b"]
       source_model: prepdv_x          satellites:
       as_of_date_table: as_of_8h        sat_x__y:

   So the vocabulary comes from the manifest (the node's real parents) and only
   those names are looked for in the text. A name is linked when it is quoted,
   is a YAML key, or is a YAML value, which keeps short model names such as
   "claim" or "stamp" from matching every column that happens to share the name.
*/
function scanVocabulary(text, vocab) {
  const found = [];
  if (!vocab.size) return found;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const name = m[0];
    if (!vocab.has(name)) continue;
    const s = m.index, e = s + name.length;
    const prev = text[s - 1], next = text[e];
    const quoted = (prev === '"' && next === '"') || (prev === "'" && next === "'");
    const isKey = /^\s*:/.test(text.slice(e, e + 8));
    const isValue = prev !== '.' && /[:=]\s*$/.test(text.slice(Math.max(0, s - 32), s));
    if (quoted || isKey || isValue) found.push({ name, ranges: [[s, e]] });
  }
  return found;
}

async function markRefs(doc, path) {
  doc.getAllMarks().forEach((mk) => { if (mk.refTarget) mk.clear(); });
  const text = maskJinjaComments(doc.getValue());
  const calls = scanCalls(text);

  // The manifest is the authority on what this file actually depends on.
  let parents = [];
  if (path) {
    try { parents = (await nodeDetail({ file: path })).parents; }
    catch { /* not a dbt node: ref() calls are still linked below */ }
  }
  const known = {};
  parents.forEach((p) => { known[p.name] = p; });

  const unknown = [...new Set(calls.map((c) => c.name))].filter((n) => !known[n]);
  if (unknown.length) {
    try {
      const rows = await api.send('/api/resolve', 'POST', { names: unknown });
      rows.forEach((r) => { known[r.name] = r; });
    } catch { /* leave them unresolved */ }
  }

  // A source parent is named "src.table", which never appears as one token.
  // Custom macros such as replicate('archie', 'X') hide the source() call, so
  // the table half is added to the vocabulary when no model already claims it.
  for (const [name, target] of Object.entries({ ...known })) {
    const dot = name.indexOf('.');
    if (dot < 0) continue;
    const table = name.slice(dot + 1);
    if (!known[table]) known[table] = target;
  }
  const vocab = new Set(Object.keys(known).filter((n) => !n.includes('.')));
  const hits = [...calls, ...scanVocabulary(text, vocab)];

  const seen = new Set();
  for (const hit of hits) {
    const target = known[hit.name];
    for (const [from, to] of hit.ranges) {
      if (seen.has(from)) continue;
      seen.add(from);
      if (!target && !calls.includes(hit)) continue;
      const title = target
        ? `${target.disabled ? 'DISABLED ' : ''}${target.kind}${target.materialized ? ' · ' + target.materialized : ''}\n${target.file}`
        : `${hit.name} is in no manifest node (stale manifest or a typo)`;
      // No `attributes: {title}`: the native tooltip it drew is now the hover
      // card's job, and the two would overlap. The line it used to show is kept
      // on the mark so the card can say exactly the same thing.
      const mark = doc.markText(doc.posFromIndex(from), doc.posFromIndex(to), {
        className: 'cm-reflink' + (target ? (target.disabled ? ' dis' : '') : ' missing'),
      });
      mark.refTarget = target || { name: hit.name };
      mark.refTitle = title;
    }
  }
}

/* Marks every var() and env_var() call so the hover card has something to
   attach to. Synchronous on purpose: the values arrive when a card opens, not
   on every keystroke. markRefs only ever clears its own refTarget marks and
   this only ever clears its own, and ref|source and var|env_var are disjoint,
   so the two never contend for a range. */
function markVars(doc) {
  doc.getAllMarks().forEach((mk) => { if (mk.varTarget) mk.clear(); });
  const text = maskJinjaComments(doc.getValue());
  for (const hit of scanVars(text)) {
    for (const [from, to] of hit.ranges) {
      const mark = doc.markText(doc.posFromIndex(from), doc.posFromIndex(to), { className: 'cm-varlink' });
      mark.varTarget = hit;
    }
  }
}

function wireRefClicks(cm) {
  cm.getWrapperElement().addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.altKey) return;              // alt-click still places the cursor
    if (!e.target.classList || !e.target.classList.contains('cm-reflink')) return;
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    const mark = cm.findMarksAt(pos).find((mk) => mk.refTarget);
    if (!mark) return;
    e.preventDefault();
    const t = mark.refTarget;
    if (!t.id) return toast(`${t.name} is not in the manifest`, 'err');
    openFile(t.file, { focusLineage: false, preview: true });
    focusNode(t.id);
    revealInTree(t.file);
  });
}

/* Hovering a mark opens the card. The classList gate comes first because
   coordsChar snaps to the nearest character even far past the end of a line, so
   without it every move over the empty area to the right of a line would
   resolve onto whatever mark that line ends with. */
function wireHovers(cm) {
  const wrap = cm.getWrapperElement();
  wrap.addEventListener('mousemove', (e) => {
    const cl = e.target.classList;
    if (!cl) return hoverLeave();
    const isVar = cl.contains('cm-varlink');
    if (!isVar && !cl.contains('cm-reflink')) return hoverLeave();
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    const at = () => cm.charCoords(pos, 'window');
    if (isVar) {
      const vm = cm.findMarksAt(pos).find((mk) => mk.varTarget);
      if (!vm) return hoverLeave();
      return hoverEnter(`${vm.varTarget.kind}:${vm.varTarget.name}`, at, (el) => fillVarCard(el, vm.varTarget));
    }
    const mark = cm.findMarksAt(pos).find((mk) => mk.refTarget);
    if (!mark) return hoverLeave();
    const t = mark.refTarget;
    if (!t.id) {
      return hoverEnter('miss:' + t.name, at, (el) => {
        hoverCardBody(el, { title: t.name });
        el.append(Object.assign(document.createElement('div'), { className: 'hc-desc muted', textContent: mark.refTitle }));
      });
    }
    hoverEnter('node:' + t.id, at, (el) => fillNodeCard(el, t.id, t));
  });
  wrap.addEventListener('mouseleave', hoverLeave);
}

function modeFor(path) {
  const p = path.toLowerCase();
  if (p.endsWith('.sql')) return 'dbt-sql';
  if (p.endsWith('.yml') || p.endsWith('.yaml')) return 'text/x-yaml';
  if (p.endsWith('.md')) return 'text/x-markdown';
  return null;
}

function initEditor() {
  S.cm = CodeMirror($('#editor-host'), {
    lineNumbers: true, lineWrapping: false, indentUnit: 4, tabSize: 4,
    styleActiveLine: false, value: '',
  });
  S.cm.on('change', () => {
    if (!S.active) return;
    const f = S.open.get(S.active);
    if (!f || f.kind === 'diff') return;
    const pinned = S.preview === S.active;
    if (pinned) S.preview = null;       // editing a preview tab pins it
    if (f && !f.dirty) { f.dirty = true; renderTabs(); }
    else if (pinned) renderTabs();
  });
  S.cm.on('cursorActivity', updateStatus);
  S.cm.on('cursorActivity', crumbCursor);
  let rescan = null;
  S.cm.on('change', () => {
    clearTimeout(rescan);
    const doc = S.cm.getDoc();
    rescan = setTimeout(() => {
      markRefs(doc, S.active);
      markVars(doc);
      refreshOutline();
      renderCrumbs();
    }, 500);
  });
  wireRefClicks(S.cm);
  wireHovers(S.cm);
}

const base = (path) => path.split('/').pop();
const fileName = (path) => path.split(/[\\/]/).pop();
const dirOf = (path) => {
  const d = path.slice(0, path.lastIndexOf('/'));
  return d.length > 36 ? '\u2026' + d.slice(-35) : d;
};

/* `preview` opens the file in the single reusable tab instead of stacking a new
   one, the way a single click does in VS Code. Editing it, or opening it again
   with preview off, pins it. */
async function openFile(path, { focusLineage = true, preview = false } = {}) {
  closeHoverCard();
  if (S.open.has(path)) {
    if (!preview && S.preview === path) S.preview = null;
    return activate(path, focusLineage);
  }
  let body;
  try { body = await api.get('/api/file?path=' + encodeURIComponent(path)); }
  catch (e) { return toast(`cannot open ${path}: ${e.message}`, 'err'); }

  const doc = CodeMirror.Doc(body.content, modeFor(path));
  let slot = S.order.length;
  const stale = S.preview && S.open.has(S.preview) && !S.open.get(S.preview).dirty;
  if (preview && stale) {
    slot = S.order.indexOf(S.preview);
    S.open.delete(S.preview);
    S.order.splice(slot, 1);
  }
  S.open.set(path, { doc, dirty: false, truncated: body.truncated });
  S.order.splice(slot, 0, path);
  if (preview) S.preview = path;
  markRefs(doc, path);
  markVars(doc);
  activate(path, focusLineage);
}

/* A diff tab holds no CodeMirror Doc: it owns a MergeView of HEAD against the
   working tree. Read-only on purpose, the file itself is one click away. */
async function openDiff(path) {
  const key = 'diff:' + path;
  if (!S.open.has(key)) {
    let view;
    try { view = await api.get('/api/git/diff?path=' + encodeURIComponent(path)); }
    catch (e) { return toast('diff: ' + e.message, 'err'); }
    S.open.set(key, { kind: 'diff', path, view, dirty: false, host: null, mv: null });
    S.order.push(key);
  }
  activate(key);
}

function mountDiff(key) {
  const f = S.open.get(key);
  const host = $('#diff-host');
  [...host.children].forEach((c) => c.classList.add('hidden'));
  if (!f.host) {
    f.host = document.createElement('div');
    f.host.className = 'diffpane';
    host.appendChild(f.host);

    const head = document.createElement('div');
    head.className = 'diff-head';

    const title = document.createElement('div');
    title.className = 'diff-title';
    title.append(fileIcon(f.path));
    const nm = document.createElement('b');
    nm.textContent = base(f.path);
    const state = document.createElement('span');
    state.className = 'diff-state';
    state.textContent = f.view.before_missing ? '(new file)'
      : f.view.after_missing ? '(deleted)' : '(working tree)';
    title.append(nm, state);
    const lock = document.createElement('span');
    lock.className = 'diff-lock';
    lock.textContent = 'read only';
    lock.title = 'Open the file itself to edit it';
    title.append(lock, Object.assign(document.createElement('div'), { className: 'grow' }));
    const open = document.createElement('button');
    open.className = 'btn sm';
    open.textContent = 'Open the file';
    open.addEventListener('click', () => openFile(f.path, { preview: true }));
    const close = document.createElement('button');
    close.className = 'icon';
    close.textContent = '×';
    close.title = 'Close this diff';
    close.addEventListener('click', () => closeFile(key));
    title.append(open, close);

    const crumb = document.createElement('div');
    crumb.className = 'diff-crumb';
    f.path.split('/').forEach((seg, i, all) => {
      if (i) crumb.append(Object.assign(document.createElement('span'), { textContent: '›', className: 'sep' }));
      const b = document.createElement('span');
      b.textContent = seg;
      if (i === all.length - 1) b.className = 'leaf';
      crumb.append(b);
    });
    if (f.view.truncated) {
      crumb.append(Object.assign(document.createElement('span'),
        { textContent: '  ·  truncated', className: 'sep' }));
    }
    head.append(title, crumb);
    f.host.appendChild(head);

    if (f.view.binary) {
      f.host.append(Object.assign(document.createElement('div'), {
        className: 'compiled-empty', textContent: 'Binary file, nothing to show side by side.' }));
      return;
    }
    const pane = document.createElement('div');
    pane.className = 'mergepane';
    f.host.appendChild(pane);
    f.mv = CodeMirror.MergeView(pane, {
      value: f.view.after,
      origLeft: f.view.before,
      lineNumbers: true,
      // Forwarded to both panes by the addon, so each gets a +/- column.
      gutters: ['CodeMirror-linenumbers', 'diff-mark'],
      mode: modeFor(f.path),
      highlightDifferences: true,
      connect: 'align',
      collapseIdentical: 12,
      revertButtons: false,
      readOnly: true,
    });
    decorateDiff(f.mv, pane);
  }
  f.host.classList.remove('hidden');
  setTimeout(() => {
    if (!f.mv) return;
    f.mv.editor().refresh();
    if (f.mv.leftOriginal()) f.mv.leftOriginal().refresh();
  }, 0);
}

/* The merge addon paints the changed backgrounds; these are the parts that make
   a diff readable at a glance: a +/- per line, and a ruler showing where the
   changes sit in a file too long to scroll through. */
/* Position of one chunk on the overview ruler, clamped so a mark can never
   escape the bar on a short file. */
function rulerMark(chunk, total) {
  const lines = Math.max(1, total);
  const span = Math.max(1, chunk.editTo - chunk.editFrom);
  const top = Math.min(99, Math.max(0, (100 * chunk.editFrom) / lines));
  return {
    kind: chunk.editTo > chunk.editFrom ? 'add' : 'del',
    top,
    height: Math.max(0.5, Math.min(100 - top, (100 * span) / lines)),
  };
}

function decorateDiff(mv, pane) {
  // leftChunks() computes the diff first, unlike reading mv.left.chunks raw.
  const chunks = (mv.leftChunks && mv.leftChunks()) || [];
  if (!chunks.length) return;
  const mark = (cm, line, sign) => {
    const el = document.createElement('div');
    el.className = 'diff-sign ' + (sign === '+' ? 'add' : 'del');
    el.textContent = sign;
    cm.setGutterMarker(line, 'diff-mark', el);
  };
  const leftCm = mv.leftOriginal(), rightCm = mv.editor();
  for (const c of chunks) {
    for (let l = c.origFrom; l < c.origTo && l < leftCm.lineCount(); l++) mark(leftCm, l, '\u2212');
    for (let l = c.editFrom; l < c.editTo && l < rightCm.lineCount(); l++) mark(rightCm, l, '+');
  }

  const ruler = document.createElement('div');
  ruler.className = 'diff-ruler';
  const total = Math.max(1, rightCm.lineCount());
  for (const c of chunks) {
    const g = rulerMark(c, total);
    const m = document.createElement('div');
    m.className = g.kind;
    m.style.top = g.top + '%';
    m.style.height = g.height + '%';
    m.title = g.kind === 'add' ? `lines ${c.editFrom + 1}-${c.editTo}` : `removed at line ${c.editFrom + 1}`;
    m.addEventListener('click', () => rightCm.scrollIntoView({ line: c.editFrom, ch: 0 }, 120));
    ruler.appendChild(m);
  }
  pane.appendChild(ruler);
}

function activate(path, focusLineage = true) {
  S.active = path;
  const f = S.open.get(path);
  $('#editor-empty').classList.add('hidden');
  if (f.kind === 'diff') {
    $('#editor-host').style.display = 'none';
    $('#diff-host').classList.remove('hidden');
    mountDiff(path);
  } else {
    $('#diff-host').classList.add('hidden');
    $('#editor-host').style.display = '';
    S.cm.swapDoc(f.doc);
    S.cm.refresh();
  }
  renderTabs();
  updateStatus();
  refreshOutline();
  renderCrumbs();
  // A profile is not in the project, so no tree row and no node answer to it.
  const inProject = f.kind === 'profile' ? '' : f.kind === 'diff' ? f.path : path;
  markTreeSelection(inProject);
  if (focusLineage && inProject) syncNode(inProject);
}

function closeFile(path) {
  const f = S.open.get(path);
  if (f && f.dirty && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  if (f && f.host) f.host.remove();
  S.open.delete(path);
  S.order = S.order.filter((p) => p !== path);
  if (S.preview === path) S.preview = null;
  if (S.active === path) {
    S.active = S.order[S.order.length - 1] || null;
    if (S.active) activate(S.active);
    else {
      $('#editor-host').style.display = 'none';
      $('#diff-host').classList.add('hidden');
      $('#editor-empty').classList.remove('hidden');
      updateStatus();
      renderCrumbs();
    }
  }
  renderTabs();
}

async function saveFile(path) {
  const f = S.open.get(path);
  if (f && f.kind === 'diff') return true;
  if (!f || !f.dirty) return true;
  if (f.kind === 'profile') return saveProfile(path, f);
  try {
    await api.send('/api/file', 'PUT', { path, content: f.doc.getValue() });
    f.dirty = false;
    // Resolved locations and var values are derived from these two, so a cached
    // payload would keep showing what they used to say.
    if (base(path).startsWith('.env') || base(path) === 'dbt_project.yml') dropNodeCache();
    return true;
  } catch (e) {
    toast(`save failed for ${base(path)}: ${e.message}`, 'err');
    return false;
  }
}

async function save() {
  if (!S.active) return;
  const ok = await saveFile(S.active);
  renderTabs();
  // The status bar carries the modified marker too, and it was keeping it.
  updateStatus();
  refreshGit();
  if (ok) toast('saved ' + base(S.active), 'ok');
}

async function saveAll() {
  const dirty = S.order.filter((p) => S.open.get(p).dirty);
  if (!dirty.length) return toast('nothing to save');
  let done = 0;
  for (const path of dirty) if (await saveFile(path)) done++;
  renderTabs();
  updateStatus();
  refreshGit();
  toast(`saved ${done} of ${dirty.length} file${dirty.length > 1 ? 's' : ''}`, done === dirty.length ? 'ok' : 'err');
}

function closeAll() {
  const dirty = S.order.filter((p) => S.open.get(p).dirty);
  if (dirty.length && !confirm(
    `${dirty.length} file${dirty.length > 1 ? 's have' : ' has'} unsaved changes.\n\n` +
    `${dirty.join('\n')}\n\nClose every tab anyway? The files themselves are not touched.`)) return;
  S.open.clear();
  S.order = [];
  S.active = null;
  S.preview = null;
  $('#editor-host').style.display = 'none';
  $('#editor-empty').classList.remove('hidden');
  renderTabs();
  updateStatus();
  renderCrumbs();
}

function renderTabs() {
  const bar = $('#tabbar');
  bar.textContent = '';
  for (const path of S.order) {
    const f = S.open.get(path);
    const t = document.createElement('div');
    t.className = 'ftab' + (path === S.active ? ' active' : '') + (f.dirty ? ' dirty' : '');
    const name = document.createElement('span');
    name.textContent = f.kind === 'diff' ? base(f.path) + '  ↔' : f.kind === 'profile' ? fileName(f.path) : base(path);
    name.title = f.kind === 'diff' ? f.path + '  (HEAD against the working tree)'
      : f.kind === 'profile' ? f.path + '  (the dbt profile, outside the project)'
      : path;
    const x = document.createElement('span');
    x.className = 'x';
    if (!f.dirty) x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeFile(path); });
    t.append(name, x);
    if (path === S.preview) t.classList.add('preview');
    t.addEventListener('click', () => activate(path));
    t.addEventListener('dblclick', () => { if (S.preview === path) { S.preview = null; renderTabs(); } });
    t.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeFile(path); } });
    bar.appendChild(t);
  }
  renderOpenEditors();
  paintTree();
}

const SAVE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7M5 6.2l3 3 3-3M3 12.5h10"/></svg>';

function renderOpenEditors() {
  const list = $('#oe-list');
  list.textContent = '';
  const dirty = S.order.filter((p) => S.open.get(p).dirty).length;
  $('#oe-count').textContent = String(S.order.length);
  $('#save-all-btn').disabled = dirty === 0;
  $('#close-all-btn').disabled = S.order.length === 0;

  for (const path of S.order) {
    const f = S.open.get(path);
    const row = document.createElement('div');
    row.className = 'oe-row'
      + (path === S.active ? ' active' : '')
      + (f.dirty ? ' dirty' : '')
      + (path === S.preview ? ' preview' : '');

    const state = document.createElement('span');
    state.className = 'state';
    const paint = (hover) => { state.textContent = f.dirty && !hover ? '\u25cf' : '\u00d7'; };
    paint(false);
    state.title = f.dirty ? 'Close, losing unsaved changes' : 'Close';
    state.addEventListener('mouseenter', () => paint(true));
    state.addEventListener('mouseleave', () => paint(false));
    state.addEventListener('click', (e) => { e.stopPropagation(); closeFile(path); });

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = base(path);
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = dirOf(path);

    const sv = document.createElement('button');
    sv.className = 'icon save';
    sv.title = 'Save this file';
    sv.innerHTML = SAVE_SVG;
    sv.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await saveFile(path)) { renderTabs(); toast('saved ' + base(path), 'ok'); }
    });

    row.append(state, nm, dir, sv);
    row.title = path;
    row.addEventListener('click', () => activate(path));
    row.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeFile(path); } });
    list.appendChild(row);
  }
}

function updateStatus() {
  const s = $('#status-file');
  if (!S.active) { s.textContent = 'no file'; return; }
  const f = S.open.get(S.active);
  if (f.kind === 'diff') {
    s.textContent = `${f.path}  ·  diff against HEAD  ·  read only`;
    return;
  }
  if (f.kind === 'profile') {
    const at = S.cm.getCursor();
    s.textContent = `${f.path}  ·  ${at.line + 1}:${at.ch + 1}${f.dirty ? '  ·  modified' : ''}  ·  outside the project`;
    return;
  }
  const c = S.cm.getCursor();
  s.textContent = `${S.active}  ·  ${c.line + 1}:${c.ch + 1}${f.dirty ? '  ·  modified' : ''}${f.truncated ? '  ·  truncated' : ''}`;
}

// ------------------------------------------------------------ breadcrumbs --
/* The bar under the tabs: where the file sits in the project, then where the
   cursor sits inside the file. Both halves navigate, the way VS Code's
   breadcrumb does. The path half asks /api/dir; the symbol half is scanned in
   the browser, from the document CodeMirror already holds, so an unsaved edit
   is reflected without a round trip. */

/* One entry per path segment. `dir` is the folder that segment's menu lists,
   which is its parent, so the first segment lists the project root. */
function pathCrumbs(path) {
  if (!path) return [];
  const parts = path.split('/').filter((p) => p !== '');
  return parts.map((label, i) => ({
    label,
    path: parts.slice(0, i + 1).join('/'),
    dir: parts.slice(0, i).join('/'),
  }));
}

/* Leading spaces, or -1 when the indentation contains a tab. YAML forbids a tab
   there, and misreading the nesting is worse than dropping the line. The same
   refusal src/project.rs makes for dbt_project.yml. */
function yamlIndent(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return line[n] === '\t' ? -1 : n;
}

/* Splits `key: value` at the first `:` outside quotes. YAML only starts a
   mapping when the colon is followed by a space or ends the line, so `a:b` stays
   a scalar and `url: http://x` splits once, at the right colon. */
function yamlKey(s) {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c !== ':') continue;
    const next = s[i + 1];
    if (next !== undefined && next !== ' ' && next !== '\t') continue;
    return { key: unquote(s.slice(0, i).trim()), value: s.slice(i + 1).trim() };
  }
  return null;
}

/* One layer of matching quotes, so a quoted key or list entry reads as itself. */
function unquote(s) {
  const q = s[0];
  return (q === '"' || q === "'") && s.length > 1 && s[s.length - 1] === q ? s.slice(1, -1) : s;
}

/* Every node owns the lines up to the next node that is not below it. Filled in
   one pass so a cursor line resolves by containment rather than by guessing. */
function closeRanges(nodes, lastLine) {
  const open = [];
  for (let j = 0; j < nodes.length; j++) {
    while (open.length && nodes[open[open.length - 1]].depth >= nodes[j].depth) {
      const t = open.pop();
      nodes[t].endLine = Math.max(nodes[t].line, nodes[j].line - 1);
    }
    open.push(j);
  }
  for (const t of open) nodes[t].endLine = Math.max(nodes[t].line, lastLine);
  return nodes;
}

/* A flat outline of a YAML document: one node per mapping key and per sequence
   item, in line order, each pointing at its parent. Enough for a breadcrumb and
   no more. Flow collections, anchors and multi-document files are deliberately
   not modelled: a dbt properties file uses none of them, and a crumb that is
   sometimes wrong is worse than a crumb that is absent. */
function yamlOutline(text) {
  const lines = text.split('\n');
  const nodes = [];
  // The root frame is never popped, so every line has somewhere to attach.
  const stack = [{ indent: -1, node: -1, item: false, count: 0, leaf: false }];
  let block = -1;              // indent of the key owning a `|` or `>` body

  const add = (line, col, label, parent) => {
    nodes.push({ line, col, label, kind: 'scalar', depth: stack.length - 1, parent, endLine: line });
    return nodes.length - 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const ind = yamlIndent(raw);
    if (block >= 0) {
      // A description block is full of dashes and colons that are not structure.
      if (trimmed === '' || (ind > block && ind >= 0)) continue;
      block = -1;
    }
    if (trimmed === '' || trimmed[0] === '#' || ind < 0) continue;

    let col = ind;
    let rest = raw.slice(ind);
    let item = -1;               // the item opened on this line, if any
    // `- - a` opens two levels on one line, so the dashes are taken in a loop.
    while (rest === '-' || rest.startsWith('- ')) {
      while (stack.length > 1) {
        const top = stack[stack.length - 1];
        // A key frame at the same indent is kept: YAML lets a sequence sit at
        // its key's own column, and that is how dbt files are usually written.
        if (top.indent > col || top.leaf || (top.indent === col && top.item)) stack.pop();
        else break;
      }
      const parent = stack[stack.length - 1];
      const idx = add(i, col, String(parent.count++), parent.node);
      item = idx;
      if (parent.node >= 0) nodes[parent.node].kind = 'seq';
      stack.push({ indent: col, node: idx, item: true, count: 0, leaf: false });
      let k = 1;
      while (rest[k] === ' ') k++;
      col += k;
      rest = rest.slice(k);
      if (rest === '') break;
    }
    if (rest === '' || rest === '-') continue;

    const kv = yamlKey(rest);
    if (!kv) {
      // A list of plain strings, which dbt files are full of, reads by value
      // rather than by index: `satellites > sat_dual__claim`, not `> 4`.
      if (item >= 0 && rest !== '') {
        nodes[item].label = unquote(rest);
        stack[stack.length - 1].leaf = true;
      }
      continue;
    }
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.indent >= col || top.leaf) stack.pop();
      else break;
    }
    const parent = stack[stack.length - 1];
    // A value that is only a comment leaves the key free to adopt children.
    const value = kv.value[0] === '#' ? '' : kv.value;
    const leaf = value !== '';
    const idx = add(i, col, kv.key, parent.node);
    if (parent.node >= 0) nodes[parent.node].kind = 'map';
    stack.push({ indent: col, node: idx, item: false, count: 0, leaf });
    if (leaf && (value[0] === '|' || value[0] === '>')) block = col;
  }
  return closeRanges(nodes, lines.length - 1);
}

/* ATX headings, and none inside a fenced block: that is what a reader navigates
   a markdown file by. */
function mdOutline(text) {
  const lines = text.split('\n');
  const nodes = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fence) { if (t.startsWith(fence)) fence = ''; continue; }
    if (t.startsWith('```')) { fence = '```'; continue; }
    if (t.startsWith('~~~')) { fence = '~~~'; continue; }
    if (t[0] !== '#') continue;
    let level = 0;
    while (t[level] === '#') level++;
    if (level > 6 || (t[level] !== undefined && t[level] !== ' ')) continue;
    const label = t.slice(level).trim();
    if (!label) continue;
    let parent = -1;
    for (let j = nodes.length - 1; j >= 0; j--) {
      if (nodes[j].depth < level - 1) { parent = j; break; }
    }
    nodes.push({
      line: i, col: lines[i].indexOf('#'), label,
      kind: 'heading', depth: level - 1, parent, endLine: i,
    });
  }
  return closeRanges(nodes, lines.length - 1);
}

/* SQL is absent on purpose. A CTE name can only be found honestly by masking
   strings and comments first, and a bar that occasionally names a case arm as a
   model section is worse than a bar with nothing after the file name. */
function documentOutline(path, text) {
  const mode = modeFor(path);
  if (mode === 'text/x-yaml') return yamlOutline(text);
  if (mode === 'text/x-markdown') return mdOutline(text);
  return [];
}

/* The nodes containing a line, outermost first. */
function outlineChainAt(nodes, line) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].line > line) break;
    if (nodes[i].endLine >= line) out.push(i);
  }
  return out;
}

function outlineSiblings(nodes, i) {
  const out = [];
  for (let j = 0; j < nodes.length; j++) if (nodes[j].parent === nodes[i].parent) out.push(j);
  return out;
}

/* The glyph stands for the kind of the node's value, which is what VS Code
   shows: a mapping, a sequence, or a plain scalar. */
function crumbIcon(kind) {
  if (kind === 'map') return '{ }';
  if (kind === 'seq') return '[ ]';
  if (kind === 'heading') return '#';
  return 'abc';
}

function renderCrumbs() {
  const bar = $('#crumbs');
  const f = S.active ? S.open.get(S.active) : null;
  /* Hidden for a diff, which holds two documents and no cursor, and for the
     profile, which lives outside the project where /api/dir cannot list. */
  if (!f || f.kind === 'diff' || f.kind === 'profile') {
    bar.textContent = '';
    bar.classList.add('hidden');
    return;
  }
  bar.textContent = '';
  bar.classList.remove('hidden');

  const segs = pathCrumbs(S.active);
  segs.forEach((seg, i) => {
    if (i) bar.appendChild(crumbSep());
    bar.appendChild(crumbButton(seg.label, '', (btn) =>
      openCrumbMenu(btn, { kind: 'path', dir: seg.dir, current: seg.path })));
  });

  const nodes = S.outline && S.outline.path === S.active ? S.outline.nodes : [];
  for (const idx of outlineChainAt(nodes, S.crumbLine)) {
    const n = nodes[idx];
    bar.appendChild(crumbSep());
    bar.appendChild(crumbButton(n.label, n.kind, (btn) =>
      openCrumbMenu(btn, { kind: 'symbol', index: idx })));
  }
  // A deep path scrolls: the end is the part that says where you are.
  bar.scrollLeft = bar.scrollWidth;
}

function crumbSep() {
  return Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '›' });
}

function crumbButton(label, kind, open) {
  const b = document.createElement('button');
  b.className = 'crumb';
  b.type = 'button';
  if (kind) {
    const ic = document.createElement('span');
    ic.className = 'sicon';
    ic.dataset.kind = kind;
    ic.textContent = crumbIcon(kind);
    b.appendChild(ic);
  }
  b.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: label }));
  b.addEventListener('click', () => {
    if (crumbMenu && crumbMenu.anchor === b) return closeCrumbMenu();
    open(b);
  });
  return b;
}

// A document larger than this is not worth scanning on every keystroke pause.
const OUTLINE_MAX = 2 * 1024 * 1024;

function refreshOutline() {
  S.outline = null;
  S.crumbLine = -1;
  const f = S.active ? S.open.get(S.active) : null;
  if (!f || f.kind === 'diff' || f.kind === 'profile' || !f.doc) return;
  const text = f.doc.getValue();
  if (text.length > OUTLINE_MAX) return;
  S.outline = { path: S.active, nodes: documentOutline(S.active, text) };
  S.crumbLine = S.cm ? S.cm.getCursor().line : 0;
}

/* Only a change of line can change the chain, and the cursor moves far more
   often than that. */
function crumbCursor() {
  if (!S.outline || S.outline.path !== S.active || !S.cm) return;
  const line = S.cm.getCursor().line;
  if (line === S.crumbLine) return;
  S.crumbLine = line;
  renderCrumbs();
}

/* Puts the cursor somewhere in the active document and shows it. Shared by the
   search results and the symbol crumbs, which want the same three steps. */
function gotoPos(line, ch = 0) {
  if (!S.cm) return;
  const pos = { line: Math.max(0, line), ch: Math.max(0, ch) };
  S.cm.setCursor(pos);
  S.cm.scrollIntoView({ from: pos, to: pos }, 120);
  S.cm.focus();
}

let crumbMenu = null;                        // { el, anchor, off }

function closeCrumbMenu({ refocus = false } = {}) {
  if (!crumbMenu) return;
  const { el, anchor, off } = crumbMenu;
  crumbMenu = null;
  off();
  el.remove();
  anchor.classList.remove('open');
  if (refocus) anchor.focus();
}

/* The menu a crumb opens. A path crumb lists the folder it sits in, so picking
   a sibling is one click; a folder inside it reopens the menu one level down,
   which is how VS Code lets you walk the tree without leaving the bar. */
async function openCrumbMenu(anchor, spec) {
  closeCrumbMenu();
  // A card that opened by accident must not sit over a menu opened on purpose.
  closeHoverCard();

  let rows = [];
  if (spec.kind === 'path') {
    let entries;
    try { entries = await api.get('/api/dir?path=' + encodeURIComponent(spec.dir)); }
    catch (e) { return toast(e.message, 'err'); }
    rows = entries.map((entry) => ({
      label: entry.name,
      dir: entry.dir,
      current: entry.path === spec.current,
      pick: () => {
        if (entry.dir) return openCrumbMenu(anchor, { kind: 'path', dir: entry.path, current: '' });
        closeCrumbMenu();
        openFile(entry.path, { preview: true });
        revealInTree(entry.path);
      },
    }));
  } else {
    const nodes = S.outline ? S.outline.nodes : [];
    if (!nodes[spec.index]) return;
    rows = outlineSiblings(nodes, spec.index).map((j) => ({
      label: nodes[j].label,
      kind: nodes[j].kind,
      current: j === spec.index,
      pick: () => { closeCrumbMenu(); gotoPos(nodes[j].line, nodes[j].col); },
    }));
  }
  if (!rows.length) return;

  const el = document.createElement('div');
  el.className = 'crumbmenu';
  for (const row of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = row.current ? 'on' : '';
    const ic = document.createElement('span');
    if (row.kind) {
      ic.className = 'sicon';
      ic.dataset.kind = row.kind;
      ic.textContent = crumbIcon(row.kind);
      b.appendChild(ic);
    } else if (row.dir) {
      ic.className = 'caret';
      ic.innerHTML = CHEVRON;
      b.appendChild(ic);
    } else {
      b.appendChild(fileIcon(row.label));
    }
    b.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: row.label }));
    b.addEventListener('click', row.pick);
    el.appendChild(b);
  }
  document.body.appendChild(el);
  anchor.classList.add('open');

  const box = el.getBoundingClientRect();
  const p = placeFloating(anchor.getBoundingClientRect(), { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight }, 2);
  el.style.top = `${p.top}px`;
  el.style.left = `${p.left}px`;

  const buttons = [...el.querySelectorAll('button')];
  const onKey = (e) => {
    if (e.key === 'Tab') return closeCrumbMenu();
    const i = buttons.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (e.key !== 'Escape' && !step) return;
    // Handled here only: the editor and the global shortcuts never see it.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') closeCrumbMenu({ refocus: true });
    else buttons[(i + step + buttons.length) % buttons.length].focus();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeCrumbMenu(); };
  // Scrolling the crumb bar away leaves the menu floating in the wrong place.
  const onScroll = (e) => {
    const t = e.target;
    if (t === document || (t instanceof Node && t.contains(anchor))) closeCrumbMenu();
  };
  const onResize = () => closeCrumbMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  crumbMenu = {
    el, anchor,
    off: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    },
  };
  (buttons.find((b) => b.classList.contains('on')) || buttons[0]).focus();
}

// ----------------------------------------------------------------- icons --
const CHEVRON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>';

/* A plain database glyph for .sql files. Drawn for this project: it is not
   derived from any vendor logo. */
const SQL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="3.6" rx="5" ry="1.9"/><path d="M3 3.6v8.8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.6"/><path d="M3 8c0 1.05 2.24 1.9 5 1.9S13 9.05 13 8"/></svg>';

const DOC = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8H4.2a1 1 0 00-1 1v10.4a1 1 0 001 1h7.6a1 1 0 001-1V5.6z"/>' +
  '<path d="M9 1.8v3.8h3.8"/></svg>';
const BRACES = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 2.5C4.8 2.5 5 5 5 6.2S3.6 8 3.6 8 5 8.6 5 9.8 4.8 13.5 6.4 13.5"/>' +
  '<path d="M9.6 2.5c1.6 0 1.4 2.5 1.4 3.7S12.4 8 12.4 8 11 8.6 11 9.8s.2 3.7-1.4 3.7"/></svg>';
const TABLE = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" ' +
  'stroke-linejoin="round"><rect x="2.3" y="3.3" width="11.4" height="9.4" rx="1.2"/><path d="M2.3 6.6h11.4M6.4 6.6v6.1"/></svg>';

function fileIcon(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const span = document.createElement('span');
  if (ext === 'sql') { span.className = 'ficon sql'; span.innerHTML = SQL_ICON; }
  else if (ext === 'yml' || ext === 'yaml') { span.className = 'ficon yml'; span.innerHTML = DOC; }
  else if (ext === 'md') { span.className = 'ficon md'; span.innerHTML = DOC; }
  else if (ext === 'json') { span.className = 'ficon json'; span.innerHTML = BRACES; }
  else if (ext === 'csv') { span.className = 'ficon csv'; span.innerHTML = TABLE; }
  else { span.className = 'ficon other'; span.innerHTML = DOC; }
  return span;
}

// ------------------------------------------------------------------ tree --
async function loadDir(container, path, depth) {
  let entries;
  try { entries = await api.get('/api/dir?path=' + encodeURIComponent(path)); }
  catch (e) { return toast(e.message, 'err'); }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'row ' + (entry.dir ? 'folder' : 'file');
    row.style.paddingLeft = 6 + depth * 12 + 'px';
    row.dataset.path = entry.path;
    const caret = document.createElement('span');
    caret.className = 'caret';
    if (entry.dir) caret.innerHTML = CHEVRON;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = entry.name;
    row.append(caret);
    if (!entry.dir) row.append(fileIcon(entry.name));
    row.append(nm);
    container.appendChild(row);
    S.rows.set(entry.path, { el: row, dir: entry.dir });

    if (entry.dir) {
      const kids = document.createElement('div');
      kids.className = 'kids hidden';
      container.appendChild(kids);
      row.expand = async () => {
        if (!row.loading) row.loading = loadDir(kids, entry.path, depth + 1);
        await row.loading;
        kids.classList.remove('hidden');
        row.classList.add('open');
        return kids;
      };
      row.addEventListener('click', async () => {
        if (!kids.classList.contains('hidden')) {
          kids.classList.add('hidden');
          row.classList.remove('open');
          return;
        }
        await row.expand();
      });
    } else {
      row.addEventListener('click', () => openFile(entry.path, { preview: true }));
      row.addEventListener('dblclick', () => openFile(entry.path));
    }
  }
  paintTree();
}

// ------------------------------------------------------------ git status --
function ancestorsOf(paths) {
  const out = new Set();
  for (const p of paths) {
    const parts = p.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return out;
}

function applyGit(info) {
  const files = (list) => new Set(list.filter((p) => !p.endsWith('/')));
  // git collapses an untracked directory into a single entry ending in "/".
  S.gitPrefixes = [...info.modified, ...info.untracked].filter((p) => p.endsWith('/'));
  S.gitMod = files(info.modified);
  S.gitUnt = files(info.untracked);
  S.gitModDirs = ancestorsOf(info.modified);
  S.gitUntDirs = ancestorsOf(info.untracked);
  for (const pre of S.gitPrefixes) S.gitUntDirs.add(pre.replace(/\/$/, ''));
  $('#status-branch').textContent = info.repo ? 'git ' + (info.branch || 'detached') : '';
  paintTree();
}

const underGitPrefix = (path) => S.gitPrefixes.some((pre) => (path + '/').startsWith(pre));

function paintTree() {
  const dirtyFiles = new Set([...S.open].filter(([, f]) => f.dirty).map(([p]) => p));
  const dirtyDirs = ancestorsOf(dirtyFiles);
  for (const [path, row] of S.rows) {
    if (!row.el.isConnected) { S.rows.delete(path); continue; }
    let state = '';
    if (row.dir) {
      if (dirtyDirs.has(path)) state = 'unsaved';
      else if (S.gitModDirs.has(path)) state = 'modified';
      else if (S.gitUntDirs.has(path) || underGitPrefix(path)) state = 'untracked';
    } else {
      if (dirtyFiles.has(path)) state = 'unsaved';
      else if (S.gitMod.has(path)) state = 'modified';
      else if (S.gitUnt.has(path) || underGitPrefix(path)) state = 'untracked';
    }
    row.el.classList.toggle('st-unsaved', state === 'unsaved');
    row.el.classList.toggle('st-modified', state === 'modified');
    row.el.classList.toggle('st-untracked', state === 'untracked');
    row.el.title = state === 'unsaved' ? path + '  (unsaved changes)'
      : state === 'modified' ? path + '  (modified, not committed)'
      : state === 'untracked' ? path + '  (untracked)'
      : path;
  }
}

async function refreshGit() {
  try {
    const info = await api.get('/api/git');
    const key = JSON.stringify(info);
    if (key === S.gitKey) return;
    S.gitKey = key;
    S.git = info;
    applyGit(info);
    renderGit(info);
  } catch { /* git missing or not a repo */ }
}

function markTreeSelection(path) {
  $$('#tree .row').forEach((r) => r.classList.toggle('sel', r.dataset.path === path));
}

/* Reveals a path in the tree, expanding folders as needed. */
async function revealInTree(path) {
  const parts = path.split('/');
  let container = $('#tree');
  for (let i = 0; i < parts.length - 1; i++) {
    const sub = parts.slice(0, i + 1).join('/');
    const row = [...container.children].find((c) => c.dataset && c.dataset.path === sub);
    if (!row || !row.expand) return;
    container = await row.expand();
  }
  markTreeSelection(path);
  const row = $$('#tree .row').find((r) => r.dataset.path === path);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------ model list --
let modelTimer = null;
async function refreshModels() {
  const q = $('#model-filter').value;
  const list = $('#model-list');
  const hits = await api.get(`/api/search?q=${encodeURIComponent(q)}&kind=model,source,seed,snapshot&limit=300`);
  list.textContent = '';
  for (const h of hits) {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = h.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = h.disabled ? 'disabled' : h.kind === 'source' ? 'source' : (h.materialized || h.kind);
    if (h.disabled) row.classList.add('off');
    row.append(dot(h), nm, sub);
    row.title = h.file;
    row.addEventListener('click', () => focusNode(h.id, { open: false }));
    row.addEventListener('dblclick', () => focusNode(h.id, { open: true }));
    list.appendChild(row);
  }
  if (!hits.length) list.innerHTML = '<p class="muted pad">No match.</p>';
}


// --------------------------------------------------------------- git panel --
/* A modal that resolves to the id of the button pressed, or null if dismissed.
   Used for every action that cannot simply be undone. */
function modal({ title, body, actions, wide = false }) {
  return new Promise((resolve) => {
    const box = $('#modal');
    box.querySelector('.modal-box').classList.toggle('wide', wide);
    $('#modal-title').textContent = title;
    const host = $('#modal-body');
    host.textContent = '';
    host.append(body);
    const bar = $('#modal-actions');
    bar.textContent = '';
    const esc = (e) => { if (e.key === 'Escape') close(null); };
    let done = false;
    // Every way out removes the Escape listener. It used to be removed only on
    // Escape, so each button close left one behind.
    const close = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', esc);
      box.classList.add('hidden');
      resolve(value);
    };
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.style || '');
      b.textContent = a.label;
      b.addEventListener('click', () => close(a.id));
      bar.appendChild(b);
    }
    box.classList.remove('hidden');
    box.onclick = (e) => { if (e.target === box) close(null); };
    document.addEventListener('keydown', esc);
    bar.lastChild && bar.lastChild.focus();
  });
}

const para = (text) => { const p = document.createElement('p'); p.textContent = text; p.style.margin = '0 0 8px'; return p; };
const list = (items) => {
  const ul = document.createElement('ul');
  items.slice(0, 40).forEach((i) => { const li = document.createElement('li'); li.textContent = i; ul.appendChild(li); });
  if (items.length > 40) ul.appendChild(Object.assign(document.createElement('li'), { textContent: `… ${items.length - 40} more` }));
  return ul;
};
const pre = (text) => { const p = document.createElement('pre'); p.textContent = text.trim(); return p; };

/* Shows whatever git actually said. Pre-commit hooks fail here, so the output
   matters more than a tidy message. */
async function gitPost(path, body) {
  let res;
  try {
    res = await api.send('/api/git/' + path, 'POST', body || {});
  } catch (e) {
    toast('git: ' + e.message, 'err');
    return null;
  }
  await refreshGit();
  return res;
}

async function showGitFailure(title, res) {
  const body = document.createElement('div');
  body.append(para('git exited with code ' + res.code + '.'));
  if (res.stderr.trim()) body.append(pre(res.stderr));
  if (res.stdout.trim()) body.append(pre(res.stdout));
  await modal({ title, body, actions: [{ id: 'ok', label: 'Close' }] });
}

function renderGit(info) {
  const host = $('#git-body');
  if (!host) return;
  $('#branch-name').textContent = info.repo ? (info.branch || 'detached HEAD') : 'no repository';
  const badge = $('#git-badge');
  const changes = info.staged.length + info.unstaged.length + info.untracked.length + info.conflicted.length;
  badge.textContent = String(changes);
  badge.classList.toggle('hidden', changes === 0);
  for (const [id, n] of [['#ahead-n', info.ahead], ['#behind-n', info.behind]]) {
    const el = $(id);
    el.textContent = String(n);
    el.classList.toggle('hidden', !n);
  }

  host.textContent = '';
  if (!info.repo) {
    host.append(Object.assign(document.createElement('div'), { className: 'git-empty', textContent: 'Not a git repository.' }));
    return;
  }

  if (info.merging) {
    const banner = document.createElement('div');
    banner.className = 'conflict-banner';
    banner.append(document.createTextNode(
      info.conflicted.length
        ? `Merge in progress, ${info.conflicted.length} file(s) still conflicted. Edit them, then mark each resolved.`
        : 'Merge in progress, all conflicts resolved. Commit to finish it.'));
    const abort = document.createElement('button');
    abort.className = 'btn sm danger';
    abort.style.marginTop = '7px';
    abort.textContent = 'Abort merge';
    abort.addEventListener('click', abortMerge);
    banner.append(document.createElement('br'), abort);
    host.append(banner);
  }

  const section = (label, count, action) => {
    const h = document.createElement('div');
    h.className = 'git-sec';
    h.append(document.createTextNode(label));
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = count;
    h.append(n);
    if (action) {
      const a = document.createElement('span');
      a.className = 'act';
      a.textContent = action.label;
      a.addEventListener('click', action.run);
      h.append(a);
    }
    host.append(h);
  };

  const row = (path, code, button) => {
    const r = document.createElement('div');
    r.className = 'git-row';
    const c = document.createElement('span');
    c.className = 'code st-' + (code.trim()[0] || 'Q');
    c.textContent = code.trim() || '?';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = base(path);
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = dirOf(path);
    r.append(c, nm, dir);
    if (button) {
      const b = document.createElement('button');
      b.className = 'icon go';
      b.title = button.title;
      b.textContent = button.glyph;
      b.addEventListener('click', (e) => { e.stopPropagation(); button.run(); });
      r.append(b);
    }
    r.title = path + '  (click to see the changes)';
    r.addEventListener('click', () => openDiff(path));
    host.append(r);
  };

  if (info.conflicted.length) {
    section('Conflicts', info.conflicted.length);
    info.conflicted.forEach((p) => row(p, 'U', {
      glyph: '✓', title: 'Mark resolved (git add)',
      run: () => markResolved(p),
    }));
  }
  if (info.staged.length) {
    section('Staged', info.staged.length, { label: 'unstage all', run: () => gitPost('unstage', { paths: info.staged.map((f) => f.path) }) });
    info.staged.forEach((f) => row(f.path, f.code[0], {
      glyph: '−', title: 'Unstage', run: () => gitPost('unstage', { paths: [f.path] }),
    }));
  }
  const pending = [...info.unstaged.map((f) => ({ path: f.path, code: f.code[1] })),
                   ...info.untracked.map((p) => ({ path: p, code: 'U' }))];
  if (pending.length) {
    section('Changes', pending.length, { label: 'stage all', run: () => gitPost('stage', { paths: pending.map((f) => f.path) }) });
    pending.forEach((f) => row(f.path, f.code, {
      glyph: '+', title: 'Stage', run: () => gitPost('stage', { paths: [f.path] }),
    }));
  }
  if (!changes) {
    host.append(Object.assign(document.createElement('div'), { className: 'git-empty', textContent: 'Working tree clean.' }));
  }
}

async function markResolved(path) {
  const doc = S.open.get(path);
  if (doc && doc.dirty && !confirm(`${base(path)} has unsaved changes. Save it before marking resolved?`)) return;
  if (doc && doc.dirty) await saveFile(path);
  const res = await gitPost('stage', { paths: [path] });
  if (res && !res.ok) showGitFailure('Could not mark resolved', res);
  else toast('marked resolved: ' + base(path), 'ok');
  renderTabs();
}

async function abortMerge() {
  const body = document.createElement('div');
  body.append(para('This runs git merge --abort. The merge is undone and the working tree returns to where it was before it started.'));
  if (await modal({ title: 'Abort the merge?', body,
                    actions: [{ id: null, label: 'Cancel' }, { id: 'go', label: 'Abort merge', style: 'danger' }] }) !== 'go') return;
  const res = await gitPost('merge-abort');
  if (res && !res.ok) showGitFailure('Abort failed', res);
  else toast('merge aborted', 'ok');
}

async function doCommit() {
  const message = $('#commit-msg').value.trim();
  if (!message) return toast('write a commit message first');
  const info = S.git;
  if (info && info.conflicted.length) return toast('resolve the conflicts first', 'err');
  if (info && !info.staged.length && !info.merging) return toast('nothing staged: stage some files first', 'err');

  const btn = $('#commit-btn');
  btn.disabled = true;
  btn.textContent = 'Fetching, then committing…';   // hooks can take a while
  const res = await gitPost('commit', { message });
  btn.disabled = false;
  btn.textContent = 'Commit';
  if (!res) return;
  if (!res.ok) return showGitFailure('Commit failed', res);
  $('#commit-msg').value = '';
  toast('committed', 'ok');
  if (res.fetch_note) toast(res.fetch_note, 'err');
}

async function doPush() {
  let commits = [];
  try { commits = await api.get('/api/git/outgoing'); } catch { /* no upstream yet */ }
  const info = S.git || {};
  const body = document.createElement('div');
  body.append(para(`Pushing ${info.branch} to origin${info.upstream ? '' : ' (and setting it as upstream)'}.`));
  body.append(commits.length ? list(commits) : para('No upstream yet, so this is the first push of this branch.'));
  if (await modal({ title: 'Push to origin?', body,
                    actions: [{ id: null, label: 'Cancel' }, { id: 'go', label: 'Push', style: 'primary' }] }) !== 'go') return;
  const res = await gitPost('push');
  if (res && !res.ok) showGitFailure('Push failed', res);
  else toast('pushed', 'ok');
}

async function doPull() {
  const res = await gitPost('pull');
  if (!res) return;
  if (!res.ok) {
    if (/diverge|not possible to fast-forward/i.test(res.stderr)) {
      const body = document.createElement('div');
      body.append(para('Your branch and origin have diverged, so a fast-forward is impossible.'));
      body.append(para('dbt-lens will not pick a merge or a rebase for you: run the one you want in the terminal.'));
      body.append(pre(res.stderr));
      return modal({ title: 'Cannot fast-forward', body, actions: [{ id: 'ok', label: 'Close' }] });
    }
    return showGitFailure('Pull failed', res);
  }
  toast(res.stdout.includes('Already up to date') ? 'already up to date' : 'pulled', 'ok');
}

// ------------------------------------------------------------ branch picker --
let branchHits = [], branchIndex = 0;

async function openBranches() {
  const box = $('#branches');
  box.classList.remove('hidden');
  const input = $('#branch-filter');
  input.value = '';
  input.focus();
  try { branchHits = await api.get('/api/git/branches'); }
  catch (e) { return toast('git: ' + e.message, 'err'); }
  paintBranches('');
}

function paintBranches(query) {
  const q = query.trim().toLowerCase();
  const rows = branchHits.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 80);
  branchIndex = 0;
  const host = $('#branch-results');
  host.textContent = '';
  rows.forEach((b, i) => {
    const r = document.createElement('div');
    r.className = 'pres' + (i === 0 ? ' on' : '');
    const p1 = document.createElement('span');
    p1.className = 'p1';
    p1.textContent = b.name;
    if (b.current) p1.style.color = 'var(--accent)';
    const p2 = document.createElement('span');
    p2.className = 'p2';
    p2.textContent = (b.current ? 'current · ' : '') + b.when;
    r.append(p1, p2);
    r.addEventListener('click', () => chooseBranch(b));
    host.appendChild(r);
  });
  host.dataset.rows = rows.length;
  branchHits.visible = rows;
}

function moveBranch(delta) {
  const rows = $$('#branch-results .pres');
  if (!rows.length) return;
  rows[branchIndex].classList.remove('on');
  branchIndex = (branchIndex + delta + rows.length) % rows.length;
  rows[branchIndex].classList.add('on');
  rows[branchIndex].scrollIntoView({ block: 'nearest' });
}

async function chooseBranch(b) {
  $('#branches').classList.add('hidden');
  if (b.current) return;
  const res = await gitPost('checkout', { branch: b.name, stash: false });
  if (!res) return;
  if (res.ok) return toast('switched to ' + b.name, 'ok');

  // git refused. Never force: show what is in the way and let the user choose.
  const blocking = res.blocking || [];
  const body = document.createElement('div');
  body.append(para(`git will not switch to ${b.name} because local changes would be overwritten.`));
  if (blocking.length) body.append(list(blocking));
  else body.append(pre(res.stderr));
  body.append(para('Stashing puts those changes aside, tagged with the branch you are leaving, and git stash pop brings them back. Nothing is discarded.'));
  const choice = await modal({
    title: 'Switch blocked',
    body,
    actions: [{ id: null, label: 'Cancel' }, { id: 'stash', label: 'Stash and switch', style: 'primary' }],
  });
  if (choice !== 'stash') return;
  const second = await gitPost('checkout', { branch: b.name, stash: true });
  if (second && !second.ok) showGitFailure('Switch still failed', second);
  else toast('stashed, then switched to ' + b.name, 'ok');
}

// ------------------------------------------------------------- conflicts ----
/* Decorates the <<<<<<< ======= >>>>>>> blocks git leaves behind, and offers a
   one-click choice per block. */
/* Locates the conflict blocks in a text. A block only counts once all three
   markers have been seen in order, so half-edited files are simply ignored
   rather than half-resolved. */
function findConflicts(text) {
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('<<<<<<<')) open = { start: i, mid: -1 };
    else if (line.startsWith('=======') && open && open.mid < 0) open.mid = i;
    else if (line.startsWith('>>>>>>>') && open && open.mid >= 0) { blocks.push({ start: open.start, mid: open.mid, end: i }); open = null; }
  });
  return blocks;
}

function decorateConflicts(cm) {
  (cm.state.conflictWidgets || []).forEach((w) => w.clear());
  cm.state.conflictWidgets = [];
  cm.eachLine((line) => {
    cm.removeLineClass(line, 'background', 'cm-conflict-head');
    cm.removeLineClass(line, 'background', 'cm-conflict-mid');
  });

  const blocks = findConflicts(cm.getValue());
  if (!blocks.length) return 0;

  for (const b of blocks) {
    cm.addLineClass(b.start, 'background', 'cm-conflict-head');
    cm.addLineClass(b.mid, 'background', 'cm-conflict-mid');
    cm.addLineClass(b.end, 'background', 'cm-conflict-head');
    const bar = document.createElement('div');
    bar.className = 'conflict-bar';
    for (const [label, side] of [['Keep ours', 'ours'], ['Keep theirs', 'theirs'], ['Keep both', 'both']]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => resolveBlock(cm, b, side));
      bar.appendChild(btn);
    }
    cm.state.conflictWidgets.push(cm.addLineWidget(b.start, bar, { above: true }));
  }
  return blocks.length;
}

function resolveBlock(cm, b, side) {
  const ours = cm.getRange({ line: b.start + 1, ch: 0 }, { line: b.mid, ch: 0 });
  const theirs = cm.getRange({ line: b.mid + 1, ch: 0 }, { line: b.end, ch: 0 });
  const keep = side === 'ours' ? ours : side === 'theirs' ? theirs : ours + theirs;
  cm.replaceRange(keep, { line: b.start, ch: 0 }, { line: b.end + 1, ch: 0 });
  decorateConflicts(cm);
}

// ---------------------------------------------------------------- lineage --
async function focusNode(id, { open = false } = {}) {
  closeHoverCard();
  S.focus = id;
  S.graphMode = 'model';
  S.colFocus = null;
  paintMode();
  const up = +$('#up').value, down = +$('#down').value;
  const tests = $('#with-tests').checked ? 1 : 0;
  try {
    const [sub, detail] = await Promise.all([
      api.get(`/api/lineage?id=${encodeURIComponent(id)}&up=${up}&down=${down}&tests=${tests}`),
      nodeDetail({ id }),
    ]);
    $('#lineage-empty').classList.add('hidden');
    Lineage.render(sub);
    $('#lineage-status').textContent =
      `${sub.nodes.length} nodes · ${sub.edges.length} edges${sub.truncated ? ' · truncated' : ''}`;
    paintLegend(sub);
    renderCatalog(detail);
    if (!$('#dock-compiled').classList.contains('hidden')) loadCompiled(id);
    if (open && detail.file) openFile(detail.file, { focusLineage: false });
  } catch (e) { toast('lineage: ' + e.message, 'err'); }
}

/* Column nodes carry a composite id, "<unique_id>::<column>". Model nodes carry
   a bare unique_id, and a dbt unique_id never contains "::". */
function splitColId(id) {
  const at = id.indexOf('::');
  return at < 0 ? { node: id, column: '' } : { node: id.slice(0, at), column: id.slice(at + 2) };
}

/* Column-level lineage. Sibling of focusNode: same canvas, same pan/zoom, the
   nodes are columns instead of models. */
async function focusColumn(id, column) {
  S.graphMode = 'column';
  S.colFocus = { id, column };
  paintMode();
  const up = +$('#up').value, down = +$('#down').value;
  try {
    const sub = await api.get(
      `/api/collineage?id=${encodeURIComponent(id)}&column=${encodeURIComponent(column)}&up=${up}&down=${down}`);
    $('#lineage-empty').classList.add('hidden');
    Lineage.render(sub);
    $('#lineage-status').textContent =
      `${sub.focus_column} · ${sub.nodes.length} columns · ${sub.edges.length} edges${sub.truncated ? ' · truncated' : ''}`;
    paintLegend(sub);
    showDock('lineage');
  } catch (e) {
    toast('column lineage: ' + e.message, 'err');
    S.graphMode = 'model';
    S.colFocus = null;
    paintMode();
  }
}

/* Every control that used to re-run focusNode has to respect the current mode. */
const rerender = () => (S.graphMode === 'column' && S.colFocus)
  ? focusColumn(S.colFocus.id, S.colFocus.column)
  : (S.focus ? focusNode(S.focus) : undefined);

// ------------------------------------------------------ snowflake lineage --
/* Column lineage fetched from Snowflake on click. The server starts
   tools/sf_lineage.py while the switch is on, and the script connects on the
   first column click, never before (0016). */
async function loadSidecar() {
  try { S.sidecar = await api.get('/api/sidecar'); } catch { S.sidecar = null; }
  paintProfileChip();
}

const sidecarOn = () => !!(S.sidecar && S.sidecar.enabled);

/* Label, tone and tooltip of the switch for one /api/sidecar payload. */
function sidecarLabel(sc) {
  if (!sc || !sc.enabled) {
    return {
      text: 'Snowflake lineage: off', tone: 'off',
      title: 'Switch on to fetch a column\'s lineage from Snowflake when you click it. '
        + 'dbt-lens starts tools/sf_lineage.py with your dbt profile, and nothing connects before the first click.',
    };
  }
  const who = [sc.profile && `profile ${sc.profile}`, sc.target && `target ${sc.target}`, sc.role && `role ${sc.role}`]
    .filter(Boolean).join(', ');
  const python = sc.python ? `Python: ${sc.python}` : '';
  switch (sc.state) {
    case 'ready':
      return { text: 'Snowflake lineage: on', tone: 'on',
        title: [`Click a column to fetch its lineage${who ? ` (${who})` : ''}.`, python].filter(Boolean).join('\n') };
    case 'busy':
      return { text: 'Snowflake lineage: querying', tone: 'busy', title: ['Waiting for Snowflake.', python].filter(Boolean).join('\n') };
    case 'starting':
      return { text: 'Snowflake lineage: starting', tone: 'busy', title: 'Starting tools/sf_lineage.py' };
    case 'failed':
      return { text: 'Snowflake lineage: failed', tone: 'failed',
        title: [sc.error, python, ...(sc.log || []).slice(-8)].filter(Boolean).join('\n') };
    default:
      return { text: 'Snowflake lineage: on', tone: 'on', title: 'The script starts with the next column click.' };
  }
}

/* What to say beside the switch: the script's trouble, or what to do next.
   The tooltip alone was invisible, and a toast is gone in three seconds. */
function columnsHint(sc, cached) {
  if (!sc || !sc.enabled) return null;
  if (sc.state === 'failed') return { text: sc.error || 'the Snowflake script could not start', tone: 'failed' };
  if (sc.state === 'starting') return { text: 'starting the Snowflake script', tone: 'busy' };
  if (sc.state === 'busy') return { text: 'querying Snowflake', tone: 'busy' };
  return cached ? null : { text: 'click a column to fetch its lineage from Snowflake', tone: 'hint' };
}

/* How old a cache is, in the shortest form that is still honest. */
function cacheAge(mtime) {
  if (!mtime) return '';
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - mtime);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* What one entry of the producer menu reads as. A cache with no source field is
   not named "unknown" but by its file, which is the only true thing about it. */
function sourceLabel(src) {
  const name = src.source || src.file.replace(/^column_lineage\.?|\.json$/g, '') || src.file;
  const bits = [src.target, cacheAge(src.mtime)].filter(Boolean);
  return { name, sub: bits.join(' · ') };
}

/* The producer of the column lineage on screen.

   One control rather than two: the graph holds one source at a time, so picking
   a cache and switching Snowflake fetching on are the same decision made twice.
   The live entry is last and marked, because it is the only one that reaches a
   warehouse. */
function sourceMenu() {
  const wrap = document.createElement('span');
  wrap.className = 'srcpick';
  const b = document.createElement('button');
  b.id = 'cll-source';
  b.className = 'btn sm';
  paintSourceButton(b);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openSourceMenu(b);
  });
  wrap.appendChild(b);
  return wrap;
}

function paintSourceButton(b = $('#cll-source')) {
  if (!b) return;
  if (sidecarOn()) {
    const label = sidecarLabel(S.sidecar);
    b.textContent = `source: Snowflake, live \u25be`;
    b.dataset.tone = label.tone;
    b.title = label.title;
    return;
  }
  const active = (S.cllSources || []).find((x) => x.file === S.cllActive);
  if (!active) {
    b.textContent = 'source: none \u25be';
    b.dataset.tone = 'off';
    b.title = 'No column lineage cache beside the manifest. Generate one, or switch on Snowflake to fetch per column.';
    return;
  }
  const { name, sub } = sourceLabel(active);
  b.textContent = `source: ${name} \u25be`;
  b.dataset.tone = 'on';
  b.title = `column lineage from ${name}${sub ? ` (${sub})` : ''}\n${active.file}`;
}

function openSourceMenu(anchor) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'envmenu';
  const add = (name, sub, on, onPick) => {
    const item = document.createElement('button');
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = on ? '\u2713' : '';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = name;
    item.append(check, lbl);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'sub';
      s.textContent = sub;
      item.appendChild(s);
    }
    if (on) item.classList.add('on');
    item.addEventListener('click', () => { closeMenus(); onPick(); });
    menu.appendChild(item);
  };

  const sources = S.cllSources || [];
  if (!sources.length) {
    const p = document.createElement('div');
    p.className = 'sub';
    p.style.padding = '5px 8px';
    p.textContent = 'no cache beside the manifest';
    menu.appendChild(p);
  }
  for (const src of sources) {
    const { name, sub } = sourceLabel(src);
    add(name, sub, !sidecarOn() && src.file === S.cllActive, () => selectSource(src.file));
  }
  if (sources.length) menu.appendChild(document.createElement('hr'));
  add('Snowflake, live', 'fetches on click', sidecarOn(), () => setSidecar(true));
  if (sidecarOn()) add('stop fetching', '', false, () => setSidecar(false));

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}

function closeMenus() {
  $$('.envmenu').forEach((m) => m.remove());
}

async function selectSource(file) {
  if (sidecarOn()) await setSidecar(false);
  try {
    const meta = await api.post('/api/collineage/source', { file });
    S.meta = Object.assign({}, S.meta, meta);
    S.cllActive = file;
    paintSourceButton();
    paintChips();
    if (S.node) renderCatalog(S.node);
    rerender();
    toast(`column lineage from ${meta.cll_source || file}`);
  } catch (e) {
    toast('column lineage source: ' + e.message, 'err');
  }
}

function sidecarSwitch() {
  const b = document.createElement('button');
  b.id = 'sidecar-switch';
  b.className = 'btn sm sfswitch';
  paintSidecarSwitch(b);
  b.addEventListener('click', () => {
    if (S.sidecar && S.sidecar.state === 'starting') return;
    setSidecar(!sidecarOn());
  });
  return b;
}

function paintSidecarSwitch(b = $('#sidecar-switch')) {
  if (!b) return;
  const label = sidecarLabel(S.sidecar);
  b.textContent = label.text;
  b.dataset.tone = label.tone;
  b.title = label.title;
  // The script may still be starting in the background, as it does when
  // dbt-lens starts with the switch already on.
  if (S.sidecar && S.sidecar.state === 'starting') {
    setTimeout(() => loadSidecar().then(() => paintSidecarSwitch()), 1500);
  }
}

async function setSidecar(enabled) {
  S.sidecar = Object.assign({}, S.sidecar, { enabled, state: enabled ? 'starting' : 'off', error: '', log: [] });
  paintProfileChip();
  if (S.node) renderCatalog(S.node);
  try {
    S.sidecar = await api.send('/api/sidecar', 'POST', { enabled });
    if (S.sidecar.state === 'failed') toast('Snowflake lineage: ' + S.sidecar.error, 'err');
  } catch (e) {
    toast('Snowflake lineage: ' + e.message, 'err');
    await loadSidecar();
  }
  // The answer carries the file the script named, so the bar can say it now
  // rather than on the next poll.
  paintProfileChip();
  if (S.node) renderCatalog(S.node);
}

/* A column clicked in the Catalog, or double-clicked on the canvas. With the
   switch on, its lineage is fetched from Snowflake before it is drawn; off, the
   cache is drawn as it is. */
/* What a failed fetch should say. Only a connection Snowflake refused points at
   the profile: a query it rejected is about the object or the role, and a
   request this build got wrong is neither. */
function connectionAdvice(error, phase, profiles) {
  if (phase !== 'connect') return { text: `Snowflake: ${error}` };
  const text = `Snowflake refused the connection: ${error}`;
  return profiles ? { text, ask: 'check the user and account in', file: profiles } : { text };
}

/* The profile as a link. It is the file the script named, so there is nothing
   to open before the script has run once. */
function profileLink() {
  const path = (S.sidecar && S.sidecar.profiles) || '';
  if (!path) return null;
  const a = document.createElement('a');
  a.className = 'filelink';
  a.textContent = fileName(path);
  a.title = `${path}\nThe dbt profile the Snowflake script reads. Click to open it here.`;
  a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openProfiles(); });
  return a;
}

/* The profile the connection comes from is a fact about the project, so it sits
   in the top bar, not only where a column is clicked. Known once the script has
   run and said which file it reads. */
function paintProfileChip() {
  const host = $('#profile-chip');
  host.textContent = '';
  const link = profileLink();
  if (link) host.append(link);
  // At startup the script may still be on its way to saying which file it
  // reads, and nothing else would come back to fill this in.
  else if (S.sidecar && S.sidecar.state === 'starting') setTimeout(loadSidecar, 1500);
}

/* The profile lives outside the project, so it has its own route rather than a
   hole in the one that is confined to the project (0017). */
async function openProfiles() {
  const path = (S.sidecar && S.sidecar.profiles) || '';
  if (!path) return toast('no profile yet: switch Snowflake lineage on once', 'err');
  const key = 'profile:' + path;
  if (!S.open.has(key)) {
    let body;
    try { body = await api.get('/api/profiles'); }
    catch (e) { return toast('profile: ' + e.message, 'err'); }
    S.open.set(key, { kind: 'profile', path: body.path, doc: CodeMirror.Doc(body.content, 'text/x-yaml'), dirty: false });
    S.order.push(key);
  }
  activate(key, false);
}

/* The script reads the profile once, when it starts, so a correction that does
   not restart it changes nothing. The server restarts it and says so. */
async function saveProfile(key, f) {
  try {
    const saved = await api.send('/api/profiles', 'PUT', { content: f.doc.getValue() });
    f.dirty = false;
    await loadSidecar();
    paintSidecarSwitch();
    if (S.node) renderCatalog(S.node);
    // The caller already says it saved; this is the part it cannot know.
    if (saved.restarted) toast('Snowflake script restarted on the new profile', 'ok');
    if (S.sidecar && S.sidecar.state === 'failed') toast('Snowflake lineage: ' + S.sidecar.error, 'err');
    return true;
  } catch (e) {
    toast(`save failed for ${fileName(key)}: ${e.message}`, 'err');
    return false;
  }
}

async function openColumn(n, column) {
  if (!sidecarOn()) return focusColumn(n.id, column);
  const rel = lineageRelation(n, S.env);
  if (!rel.text) return toast(`no Snowflake lineage for ${column}: ${rel.reason}`, 'err');
  const ask = ++S.colAsk;
  const status = $('#lineage-status');
  showDock('lineage');
  status.title = '';
  status.textContent = `querying Snowflake for ${column} in ${rel.text}`
    + (S.colAnswered ? '' : ' (the first query of a session may open a sign-in tab)');
  S.sidecar = Object.assign({}, S.sidecar, { state: 'busy' });
  paintSidecarSwitch();
  try {
    const res = await api.send('/api/collineage/fetch', 'POST', {
      id: n.id, column, relation: rel.text, env: rel.file, up: +$('#up').value, down: +$('#down').value,
    });
    if (ask !== S.colAsk) return;
    S.colAnswered = true;
    if (res.added) {
      applyMeta((await api.get('/api/meta')).meta);
      if (S.node && S.node.id === n.id) {
        S.colHighlight = column;
        renderCatalog(await nodeDetail({ id: n.id }));
      }
    }
    const outside = res.unmatched_total
      ? ` · ${res.unmatched_total} object${res.unmatched_total > 1 ? 's' : ''} outside the project`
      : '';
    if (!res.up && !res.down) {
      status.textContent = `Snowflake has no column lineage for ${column} in ${res.relation}${outside}`;
      status.title = res.unmatched.join('\n');
      return;
    }
    await focusColumn(n.id, column);
    if (ask !== S.colAsk) return;
    status.textContent += ` · from Snowflake, ${res.added} new${outside}`;
    status.title = res.unmatched.length ? 'Not nodes of this project:\n' + res.unmatched.join('\n') : '';
  } catch (e) {
    if (ask !== S.colAsk) return;
    const advice = connectionAdvice(e.message, e.phase, (S.sidecar && S.sidecar.profiles) || '');
    status.textContent = advice.ask ? `${advice.text}  ·  ${advice.ask} ` : advice.text;
    const link = advice.file ? profileLink() : null;
    if (link) status.appendChild(link);
    toast('Snowflake lineage: ' + e.message, 'err');
  } finally {
    await loadSidecar();
    paintSidecarSwitch();
  }
}

/* Only what is actually on screen, so the legend stays short and always matches
   what is drawn.

   Model mode explains the boxes, whose colour is the materialization. Column
   mode explains the edges instead, whose colour is what happened to the column:
   that is the question the column graph exists to answer, and repeating the
   materializations there would explain something nobody is looking at. */
function paintLegend(sub) {
  const seen = new Map();
  const kinds = sub.edge_kinds || [];
  if (kinds.length) {
    // The badges too, not just the edges: `raw` and `mixed` only ever appear on
    // a box, and a legend that skipped them would leave two colours unexplained.
    for (const k of kinds.concat(Lineage.nodeRoles(sub))) {
      if (k && !seen.has(k)) seen.set(k, Lineage.roleColor(k));
    }
  } else {
    for (const n of sub.nodes) {
      const label = Lineage.matLabel(n);
      if (!seen.has(label)) seen.set(label, Lineage.nodeColor(n));
    }
  }
  const host = $('#lineage-legend');
  host.textContent = '';
  [...seen].sort((a, b) => a[0].localeCompare(b[0])).forEach(([label, colour]) => {
    const chip = document.createElement('span');
    const sq = document.createElement('i');
    sq.style.background = colour;
    chip.append(sq, document.createTextNode(label));
    host.appendChild(chip);
  });
}

function paintMode() {
  const column = S.graphMode === 'column';
  $$('#graph-mode .segbtn').forEach((b) => {
    b.classList.toggle('active', (b.dataset.mode === 'column') === column);
    if (b.dataset.mode === 'column') {
      b.disabled = !S.colFocus;
      b.title = S.colFocus ? '' : 'pick a column in the Catalog tab first';
    }
  });
  const chip = $('#col-chip');
  chip.classList.toggle('hidden', !S.colFocus);
  if (S.colFocus) {
    chip.textContent = '';
    const b = document.createElement('b');
    b.textContent = S.colFocus.column;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'back to model lineage';
    x.addEventListener('click', () => { if (S.focus) focusNode(S.focus); });
    chip.append(b, x);
  }
}

async function syncNode(path) {
  try {
    const detail = await nodeDetail({ file: path });
    if (detail.id !== S.focus) focusNode(detail.id);
  } catch { /* file is not a dbt node: leave the lineage as it is */ }
}

function relinkTools() {
  for (const el of [$('#up'), $('#down'), $('#with-tests')]) {
    el.addEventListener('change', rerender);
  }
  $('#fit-btn').addEventListener('click', () => Lineage.fit());
  $$('#graph-mode .segbtn').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    if (b.dataset.mode === 'column' && S.colFocus) focusColumn(S.colFocus.id, S.colFocus.column);
    else if (S.focus) focusNode(S.focus);
  }));
}

// --------------------------------------------------------------- compiled --
/* The compiled SQL dbt left in target/. Never compiled here: dbt runs where the
   user runs it, so a missing file is reported with the command to produce it. */
async function loadCompiled(id) {
  const head = $('#compiled-head');
  const body = $('#compiled-body');
  head.textContent = '';
  if (!id) {
    body.textContent = '';
    head.append(Object.assign(document.createElement('div'), {
      className: 'compiled-empty', textContent: 'Select a model first.' }));
    return;
  }
  const node = S.node && S.node.id === id ? S.node : null;
  const name = node ? node.name : id.split('.').pop();

  let info;
  try { info = await api.get('/api/compiled?id=' + encodeURIComponent(id)); }
  catch (e) { return toast('compiled: ' + e.message, 'err'); }

  if (!info.found) {
    if (S.compiledCm) S.compiledCm.setValue('');
    body.textContent = '';
    const box = document.createElement('div');
    box.className = 'compiled-empty';
    box.append(Object.assign(document.createElement('p'), {
      textContent: `No compiled SQL for ${name}. dbt has not compiled it into target/ yet.`,
      style: 'margin:0 0 4px' }));
    const cmd = `dbt compile --select ${name}`;
    const code = document.createElement('code');
    code.textContent = cmd;
    box.append(code, document.createElement('br'));
    const send = document.createElement('button');
    send.className = 'btn sm';
    send.textContent = 'Type it in the terminal';
    send.title = 'Puts the command in the integrated terminal without running it';
    send.addEventListener('click', () => sendToTerminal(cmd));
    box.append(send);
    const det = document.createElement('details');
    det.style.marginTop = '12px';
    det.append(Object.assign(document.createElement('summary'), {
      textContent: 'paths checked', style: 'cursor:pointer;font-size:11px' }));
    const ul = document.createElement('ul');
    info.candidates.forEach((c) => ul.append(Object.assign(document.createElement('li'), { textContent: c })));
    det.append(ul);
    box.append(det);
    body.append(box);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'fresh-bar' + (info.stale ? ' stale' : '');
  const when = document.createElement('b');
  when.textContent = 'compiled ' + humanAge(info.age_secs) + ' ago';
  bar.append(when);
  if (info.stale) {
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = info.reasons.join(' · ') + ' (may be out of date)';
    bar.append(why);
  }
  bar.append(Object.assign(document.createElement('div'), { className: 'grow' }));
  const recompile = document.createElement('button');
  recompile.className = 'btn sm';
  recompile.textContent = info.stale ? 'Recompile' : 'Compile again';
  recompile.addEventListener('click', () => sendToTerminal(`dbt compile --select ${name}`));
  bar.append(recompile);
  bar.title = info.path;
  head.append(bar);

  body.textContent = '';
  if (!S.compiledCm) {
    S.compiledCm = CodeMirror(body, { lineNumbers: true, readOnly: true, mode: 'text/x-sql', lineWrapping: false });
  } else {
    body.appendChild(S.compiledCm.getWrapperElement());
  }
  S.compiledCm.setValue(info.content + (info.truncated ? '\n\n-- truncated by dbt-lens\n' : ''));
  setTimeout(() => S.compiledCm.refresh(), 0);
}

function humanAge(secs) {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.round(secs / 60) + 'min';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h' + String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  return Math.floor(secs / 86400) + 'd';
}

/* Types a command into the integrated terminal and stops there: running it is
   the user's decision, and dbt is theirs to launch. */
function sendToTerminal(cmd) {
  showDock('terminal');
  let tries = 0;
  const attempt = () => {
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ t: 'i', d: cmd }));
      S.term && S.term.focus();
      toast('command ready in the terminal, press Enter to run it');
    } else if (tries++ < 40) setTimeout(attempt, 100);
    else toast('terminal is not connected', 'err');
  };
  setTimeout(attempt, 60);
}

// ---------------------------------------------------------------- catalog --
function renderCatalog(n) {
  S.node = n;
  const host = $('#catalog');
  if (envMenu && host.contains(envMenu.anchor)) closeEnvMenu();
  host.textContent = '';

  const head = document.createElement('div');
  head.className = 'cat-head';
  const title = document.createElement('div');
  title.className = 'cat-title';
  title.append(dot(n), document.createTextNode(n.name));
  if (n.disabled) {
    const off = document.createElement('span');
    off.className = 'offchip';
    off.textContent = 'disabled';
    off.title = 'enabled: false, so dbt leaves this model out of the graph';
    title.appendChild(off);
  }
  if (n.file) {
    const open = document.createElement('button');
    open.className = 'btn sm';
    open.textContent = 'Open file';
    open.addEventListener('click', () => { openFile(n.file, { focusLineage: false }); revealInTree(n.file); });
    title.appendChild(open);
  }
  const crumb = document.createElement('div');
  crumb.className = 'crumb';
  crumb.innerHTML = '';
  crumb.append(document.createTextNode(n.package || ''), document.createTextNode('  /  '));
  const b = document.createElement('b');
  b.textContent = n.file || n.id;
  crumb.appendChild(b);

  const tabs = document.createElement('div');
  tabs.className = 'cat-tabs';
  for (const [key, label] of [['preview', 'Preview'], ['columns', `Columns${n.columns.length ? ' (' + n.columns.length + ')' : ''}`]]) {
    const t = document.createElement('button');
    t.className = 'ctab' + (S.catTab === key ? ' active' : '');
    t.textContent = label;
    t.addEventListener('click', () => { S.catTab = key; renderCatalog(n); });
    tabs.appendChild(t);
  }
  head.append(title, crumb, tabs);

  const body = document.createElement('div');
  body.className = 'cat-body';
  (S.catTab === 'columns' ? catalogColumns : catalogPreview)(body, n);
  host.append(head, body);
}

function h3(label) {
  const h = document.createElement('h3');
  h.textContent = label;
  return h;
}

function stat(label, value, onClick) {
  const s = document.createElement('div');
  s.className = 'stat';
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('div');
  v.className = 'v' + (onClick ? ' link' : '');
  v.textContent = value;
  if (onClick) v.addEventListener('click', onClick);
  s.append(k, v);
  return s;
}

// -------------------------------------------------------------- hover card --
/* One floating card, shared by the lineage boxes and the editor's marks. It is
   hoverable, so its text can be read and selected, but holds no focusable
   control: a surface that opens by accident should not also own a focus trap
   and an Escape contract the way the env menu has to. */
const HOVER_DELAY = 350;   // a sweep across a dense graph must open nothing
const HOVER_GRACE = 180;   // time for the pointer to cross the gap into the card
const HOVER_COLS = 8;      // the card never scrolls: the rest is counted, not listed

/* Where a box of size `box` goes next to `at`, inside `view`. Below when it
   fits, above when it does not, clamped rather than clipped when neither works.
   `view` is a parameter rather than a read of `window` so this can be checked
   without a DOM. */
function placeFloating(at, box, view, gap = 8) {
  const below = at.bottom + gap + box.height <= view.height;
  const above = at.top - gap - box.height >= 0;
  let top;
  if (below) top = at.bottom + gap;
  else if (above) top = at.top - gap - box.height;
  else top = Math.max(4, Math.min(at.bottom + gap, view.height - box.height - 4));
  // A box wider than the viewport pins to the left edge rather than going negative.
  const left = Math.max(4, Math.min(at.left, view.width - box.width - 4));
  return { top, left, above: !below && above };
}

/* The head every card shares. Returns the element so a filler can keep appending. */
function hoverCardBody(el, { title, tone, sub, crumb }) {
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'hc-head';
  if (tone) head.appendChild(tone);
  head.append(Object.assign(document.createElement('span'), { className: 'hc-name', textContent: title }));
  el.appendChild(head);
  if (sub) el.append(Object.assign(document.createElement('div'), { className: 'hc-sub', textContent: sub }));
  if (crumb) el.append(Object.assign(document.createElement('div'), { className: 'hc-crumb', textContent: crumb }));
  return el;
}

let hoverCard = null;                        // { el, at, off }
let hoverTimer = null, hoverGrace = null;
let hoverKey = '';                           // what the card shows, or is about to

function closeHoverCard() {
  clearTimeout(hoverTimer);
  clearTimeout(hoverGrace);
  hoverTimer = hoverGrace = null;
  hoverKey = '';
  if (!hoverCard) return;
  const { el, off } = hoverCard;
  hoverCard = null;
  off();
  el.remove();
}

/* Re-measured after every paint: a card that grows when the payload lands would
   otherwise keep the position its first, shorter self was given. */
function placeHoverCard() {
  if (!hoverCard) return;
  const box = hoverCard.el.getBoundingClientRect();
  const p = placeFloating(hoverCard.at, { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight });
  hoverCard.el.style.top = `${p.top}px`;
  hoverCard.el.style.left = `${p.left}px`;
}

function openHoverCard(at, fill) {
  const el = document.createElement('div');
  el.className = 'hovercard';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  hoverCard = { el, at, off: () => {} };
  fill(el);
  placeHoverCard();

  el.addEventListener('mouseenter', () => { clearTimeout(hoverGrace); hoverGrace = null; });
  el.addEventListener('mouseleave', hoverLeave);

  // Typing means the card is not being read.
  const onKey = () => closeHoverCard();
  // Deliberately no preventDefault: a click on a ref() still has to reach wireRefClicks.
  const onDown = (e) => { if (!el.contains(e.target)) closeHoverCard(); };
  const onScroll = (e) => { if (!el.contains(e.target)) closeHoverCard(); };
  const onResize = () => closeHoverCard();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  hoverCard.off = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };
}

/* `key` identifies what is under the pointer, so a mousemove that stays on the
   same thing neither restarts the delay nor repaints. Moving to a different one
   while a card is open swaps it without waiting again, the way a group of
   tooltips behaves. */
function hoverEnter(key, getRect, fill) {
  clearTimeout(hoverGrace);
  hoverGrace = null;
  if (key === hoverKey) return;
  const swap = !!hoverCard;
  clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverKey = key;
  // The rect is read when the card opens, not now: a pan during the delay would
  // otherwise anchor it where the box used to be.
  const show = () => {
    hoverTimer = null;
    if (hoverCard) { hoverCard.off(); hoverCard.el.remove(); hoverCard = null; }
    openHoverCard(getRect(), fill);
  };
  if (swap) show();
  else hoverTimer = setTimeout(show, HOVER_DELAY);
}

function hoverLeave() {
  clearTimeout(hoverTimer);
  hoverTimer = null;
  if (!hoverCard) { hoverKey = ''; return; }
  clearTimeout(hoverGrace);
  hoverGrace = setTimeout(closeHoverCard, HOVER_GRACE);
}

/* Painted twice: once from what the caller already holds, so the card appears
   with the pointer, and again when /api/node answers with the description and
   the columns. */
function fillNodeCard(el, id, seed) {
  const paint = (n, full) => {
    if (!hoverCard || hoverCard.el !== el) return;   // closed, or swapped for another
    const tone = dot(n);
    tone.removeAttribute('title');           // no native tooltip inside the card
    hoverCardBody(el, { title: n.name || id, tone, sub: Lineage.subtitle(n), crumb: n.file || id });
    if (n.disabled) {
      const off = Object.assign(document.createElement('span'), { className: 'offchip', textContent: 'disabled' });
      el.querySelector('.hc-head').appendChild(off);
    }
    if (!full) return;

    el.append(Object.assign(document.createElement('div'), {
      className: 'hc-desc' + (n.description ? '' : ' muted'),
      textContent: n.description || 'No description in the YAML.',
    }));

    const counts = [`${n.columns.length} columns`, `${n.upstream_total} upstream`,
      `${n.downstream_total} downstream`, `${n.tests.length} tests`];
    el.append(Object.assign(document.createElement('div'), { className: 'hc-counts', textContent: counts.join('  ·  ') }));

    if (n.columns.length) {
      const list = document.createElement('div');
      list.className = 'hc-cols';
      for (const c of n.columns.slice(0, HOVER_COLS)) {
        const row = document.createElement('div');
        row.className = 'hc-col';
        row.append(Object.assign(document.createElement('span'), { className: 'c-name', textContent: c.name }));
        row.append(Object.assign(document.createElement('span'), { className: 'c-type', textContent: c.data_type || '' }));
        list.appendChild(row);
      }
      if (n.columns.length > HOVER_COLS) {
        list.append(Object.assign(document.createElement('div'), {
          className: 'hc-more', textContent: `+${n.columns.length - HOVER_COLS} more`,
        }));
      }
      el.appendChild(list);
    }

    if (n.tags && n.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'hc-tags';
      for (const t of n.tags) tags.append(Object.assign(document.createElement('span'), { className: 'tagchip', textContent: t }));
      el.appendChild(tags);
    }
    placeHoverCard();
  };

  paint(seed, false);
  nodeDetail({ id }).then((n) => paint(n, true)).catch(() => {});
}

/* A variable's value. The head is painted at once and the value replaces a
   placeholder line when /api/vars answers. */
function fillVarCard(el, t) {
  const call = `${t.kind}('${t.name}')`;
  const envLabel = S.env || '';
  hoverCardBody(el, { title: call, sub: t.kind === 'env_var' ? 'environment variable' : 'project var' });
  el.append(Object.assign(document.createElement('div'), { className: 'hc-note muted', textContent: 'reading...' }));

  const show = (value, sub, crumb, tone) => {
    if (!hoverCard || hoverCard.el !== el) return;   // closed, or swapped for another
    el.textContent = '';
    hoverCardBody(el, { title: call, sub: t.kind === 'env_var' ? 'environment variable' : 'project var', crumb });
    if (value !== null) {
      el.append(Object.assign(document.createElement('div'), {
        className: 'hc-value' + (value === '' ? ' muted' : ''),
        textContent: value === '' ? '(empty)' : value,
      }));
    }
    if (sub) el.append(Object.assign(document.createElement('div'), { className: 'hc-note ' + (tone || 'muted'), textContent: sub }));
    placeHoverCard();
  };

  fetchVars(t.kind === 'env_var' ? t.name : '').then((body) => {
    if (t.kind === 'env_var') {
      const row = (body.env_vars || [])[0];
      if (!row) return show(null, 'no answer for this name', '', 'warn');
      const fallback = t.fallback ? `\ndefault written in this call: ${t.fallback}` : '';
      return show(row.value === undefined ? null : row.value, varNote(row, envLabel) + fallback,
        envLabel || 'no environment selected', row.redacted ? 'warn' : '');
    }
    const row = (body.vars || []).find((v) => v.name === t.name);
    if (!row) {
      const miss = t.fallback
        ? `not in the vars: block, so the default in this call is used: ${t.fallback}`
        : 'not in the vars: block of dbt_project.yml';
      return show(null, miss, body.file, 'warn');
    }
    const lines = [];
    // A redacted value is never shown, but the expression that produced it is
    // text from the repository, so "as written" still earns its place.
    const value = row.null || row.redacted ? null : (row.resolved !== undefined ? row.resolved : row.raw);
    if (row.null) lines.push('declared with no value, so var() returns null');
    if (row.status) lines.push(varNote(row, envLabel));
    else if (row.redacted) lines.push('hidden because the name reads as a credential');
    if (row.status && row.raw) lines.push('as written: ' + row.raw);
    show(value, lines.filter(Boolean).join('\n'), `${body.file}:${row.line}`, row.redacted ? 'warn' : '');
  }).catch(() => show(null, 'could not read dbt_project.yml', '', 'warn'));
}

// ------------------------------------------------------------ environments --
/* Which .env file resolves locations. The choice lives in this tab: the stored
   one is only where a fresh tab starts, so two tabs never draw one environment's
   values under the other's name. */
/* A colour family for an environment name, so the one in use is recognisable
   at a glance. Matched on whole words, trailing digits ignored ("DEV2"), and
   pre-production is checked before production. */
function envTone(name) {
  if (!name) return 'manifest';
  const upper = name.toUpperCase();
  const words = upper.split(/[^A-Z0-9]+/).map((w) => w.replace(/\d+$/, ''));
  const has = (...list) => words.some((w) => list.includes(w));
  if (upper.replace(/[^A-Z]/g, '').includes('PREPROD') || has('UAT', 'ACC', 'ACCEPTANCE')) return 'uat';
  if (has('PROD', 'PRD', 'PRODUCTION', 'LIVE')) return 'prod';
  if (has('STG', 'STAGING', 'STAGE')) return 'stg';
  if (has('QA', 'TEST', 'TST', 'SIT')) return 'qa';
  if (has('DEV', 'DEVELOPMENT', 'LOCAL', 'SANDBOX')) return 'dev';
  if (has('CI')) return 'ci';
  return 'other';
}

function envDisplayName(file) {
  const f = S.envs && S.envs.files.find((e) => e.file === file);
  return f ? f.name : file;
}

async function loadEnvs() {
  // Re-reading the env list means the .env files were re-read too, so any
  // resolution cached against the old ones is stale.
  dropNodeCache();
  try { S.envs = await api.get('/api/envs'); } catch { S.envs = null; }
  // The stored choice is where a fresh tab starts, and nothing more: after the
  // first load this tab keeps its own.
  if (!S.envsLoaded) {
    S.envsLoaded = true;
    if (S.envs && S.envs.selected) S.env = S.envs.selected;
  }
  paintEnvSelect();
  if (S.node) renderCatalog(S.node);
}

/* True when switching environment can change something on screen. */
const envsInUse = () => !!(S.envs && S.envs.referenced.length);

function paintEnvSelect() {
  const pill = $('#status-env');
  // No location config reads an env var: the selector could change nothing.
  if (!envsInUse()) { pill.classList.add('hidden'); return; }
  const visible = S.envs.files.filter((f) => !f.hidden);
  if (S.env && !visible.some((f) => f.file === S.env)) S.env = '';
  fillEnvPill(pill, 'env');
  pill.classList.remove('hidden');
}

/* A button showing the environment in use, coloured by envTone. */
function fillEnvPill(el, prefix) {
  const name = S.env ? envDisplayName(S.env) : 'manifest';
  el.textContent = '';
  el.dataset.tone = S.env ? envTone(name) : 'manifest';
  if (prefix) el.append(Object.assign(document.createElement('span'), { className: 'envpill-k', textContent: prefix }));
  el.append(document.createTextNode(name),
    Object.assign(document.createElement('span'), { className: 'envpill-caret', textContent: '▾' }));
  el.title = S.env
    ? `Catalog locations are resolved with ${S.env}. Click to change.`
    : 'Catalog locations are shown as dbt parsed them. Click to pick an environment.';
}

function selectEnv(file) {
  S.env = file;
  paintEnvSelect();
  if (S.node) renderCatalog(S.node);
  // Remembered as the starting point for the next tab; failure is harmless.
  api.send('/api/envs/select', 'POST', { file: file || null }).catch(() => {});
}

/* The environment menu, shared by the status bar pill and the catalog header.
   Opens below its anchor, or above when there is no room (the status bar). */
let envMenu = null;

function closeEnvMenu({ refocus = false } = {}) {
  if (!envMenu) return;
  const { el, anchor, off } = envMenu;
  envMenu = null;
  off();
  el.remove();
  if (refocus && anchor.isConnected) anchor.focus();
}

function openEnvMenu(anchor) {
  const reopen = envMenu && envMenu.anchor === anchor;
  closeEnvMenu();
  if (reopen || !envsInUse()) return;   // a second click on the same anchor closes it

  const el = document.createElement('div');
  el.className = 'envmenu';
  el.setAttribute('role', 'menu');
  const item = ({ label, sub = '', tone = '', current = false, title = '', pick }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(current));
    if (current) b.classList.add('on');
    if (title) b.title = title;
    const check = Object.assign(document.createElement('span'), { className: 'check', textContent: current ? '✓' : '' });
    b.append(check);
    if (tone) {
      const d = Object.assign(document.createElement('span'), { className: 'envdot' });
      d.dataset.tone = tone;
      b.append(d);
    }
    b.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: label }));
    if (sub) b.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: sub }));
    b.addEventListener('click', () => { closeEnvMenu(); pick(); });
    el.appendChild(b);
    return b;
  };
  for (const f of S.envs.files.filter((e) => !e.hidden)) {
    item({
      label: f.name + (f.target_mismatch ? ' ⚠' : ''),
      sub: f.file,
      tone: envTone(f.name),
      current: S.env === f.file,
      title: f.target_mismatch ? `DBT_TARGET in ${f.file} is ${f.target}, which does not match the name` : '',
      pick: () => selectEnv(f.file),
    });
  }
  item({
    label: 'manifest', sub: 'as dbt parsed it', tone: 'manifest', current: !S.env,
    title: 'the config with the env vars dbt had loaded when it parsed this manifest',
    pick: () => selectEnv(''),
  });
  el.appendChild(document.createElement('hr'));
  item({ label: 'Manage environments...', pick: openEnvPanel });
  document.body.appendChild(el);

  const at = anchor.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const below = at.bottom + 4 + box.height <= window.innerHeight;
  el.style.top = `${below ? at.bottom + 4 : Math.max(4, at.top - 4 - box.height)}px`;
  el.style.left = `${Math.min(Math.max(4, at.left), window.innerWidth - box.width - 4)}px`;

  const buttons = [...el.querySelectorAll('button')];
  const onKey = (e) => {
    if (e.key === 'Tab') return closeEnvMenu();
    const i = buttons.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (e.key !== 'Escape' && !step) return;
    // Handled here only: the editor and the global shortcuts never see it.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') closeEnvMenu({ refocus: true });
    else buttons[(i + step + buttons.length) % buttons.length].focus();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeEnvMenu(); };
  // Scrolling the anchor away leaves the menu floating in the wrong place. Only
  // a container of the anchor counts: a terminal printing output scrolls too.
  const onScroll = (e) => {
    const t = e.target;
    if (t === document || (t instanceof Node && t.contains(anchor))) closeEnvMenu();
  };
  const onResize = () => closeEnvMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  envMenu = {
    el, anchor,
    off: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    },
  };
  (buttons.find((b) => b.classList.contains('on')) || buttons[0]).focus();
}

/* The Manage panel. Only real overrides are stored: a name equal to the
   automatic one, or a visibility equal to what detection would decide, is sent
   as "automatic" so later detection changes still apply. */
async function openEnvPanel() {
  await loadEnvs();
  if (!S.envs) return toast('environments are unavailable', 'err');
  const refs = S.envs.referenced;
  const nodesFor = (v) => (refs.find((r) => r.var === v) || { nodes: 0 }).nodes;

  const body = document.createElement('div');
  body.className = 'envpanel';
  const table = document.createElement('table');
  table.className = 'loc';
  const head = document.createElement('tr');
  for (const [label, tip] of [
    ['file', ''],
    ['name', 'leave empty for the automatic name, the uppercased file suffix'],
    ['shown', 'hidden files do not appear in the status bar menu'],
    ['DBT_TARGET', 'read from the file as a cross-check against the name'],
    ['variables', `how many of the ${refs.length} variables your location config reads this file defines`],
    ['matches manifest', 'how often this file reproduces what dbt parsed. The file dbt had loaded scores 100%.'],
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    if (tip) th.title = tip;
    head.appendChild(th);
  }
  table.appendChild(head);

  const inputs = [];
  for (const f of S.envs.files) {
    const tr = document.createElement('tr');
    const td = (content, cls) => {
      const cell = document.createElement('td');
      if (cls) cell.className = cls;
      cell.append(content);
      return cell;
    };

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 32;
    name.placeholder = f.auto_name;
    name.value = f.name === f.auto_name ? '' : f.name;

    const shown = document.createElement('input');
    shown.type = 'checkbox';
    shown.checked = !f.hidden;
    const shownCell = td(shown);
    if (f.hidden_reason) shownCell.title = f.hidden_reason;

    const target = document.createElement('span');
    target.textContent = f.target || '-';
    if (f.target_mismatch) {
      target.className = 'env-placeholder';
      target.title = `DBT_TARGET is ${f.target}, which does not match ${f.file}`;
    }

    const cov = f.coverage;
    const vars = document.createElement('span');
    vars.textContent = `${cov.defined}/${refs.length}`;
    const notes = [];
    if (cov.missing.length) notes.push(`missing: ${cov.missing.join(', ')}`);
    if (cov.placeholders.length) {
      notes.push(`placeholder: ${cov.placeholders.map((v) => `${v} (${nodesFor(v)} nodes)`).join(', ')}`);
      vars.className = 'env-placeholder';
    }
    if (cov.missing.length && !cov.placeholders.length) vars.className = 'env-missing';
    if (notes.length) vars.title = notes.join('\n');

    const a = f.agreement;
    const match = document.createElement('span');
    match.textContent = a.checked ? `${Math.round((1000 * a.equal) / a.checked) / 10}%` : '-';
    match.title = a.checked ? `${a.equal} of ${a.checked} env-driven values equal what dbt parsed` : 'no env-driven values to compare';

    tr.append(td(f.file, 'k'), td(name), shownCell, td(target), td(vars), td(match));
    table.appendChild(tr);
    inputs.push({ f, name, shown });
  }
  body.appendChild(table);
  body.appendChild(Object.assign(document.createElement('p'), {
    className: 'muted',
    textContent: S.envs.persist
      ? `Saved in ${S.envs.settings_path}, outside the project.`
      : 'No config directory is available, so these settings cannot be saved.',
  }));

  const actions = [{ id: null, label: 'Cancel' }];
  if (S.envs.persist) actions.push({ id: 'save', label: 'Save', style: 'primary' });
  if (await modal({ title: 'Environments', body, actions, wide: true }) !== 'save') return;

  const envs = {};
  for (const { f, name, shown } of inputs) {
    const typed = name.value.trim();
    const hidden = !shown.checked;
    envs[f.file] = {
      name: typed && typed !== f.auto_name ? typed : null,
      hidden: hidden === !!f.auto_hidden_reason ? null : hidden,
    };
  }
  try {
    await api.send('/api/envs', 'PUT', { envs });
    await loadEnvs();
    toast('environments saved', 'ok');
  } catch (e) {
    toast('could not save: ' + e.message, 'err');
  }
}

/* One row per location key, across the stages dbt goes through. `envFile`
   picks a .env resolution when the node carries one; without it, the resolved
   column is the config as dbt parsed it. Rows empty at every stage are dropped. */
function locationRows(loc, envFile) {
  if (!loc) return [];
  const parsed = loc.parsed || loc.resolved || {};   // payloads before the rename
  const env = envFile && loc.envs ? loc.envs[envFile] : null;
  return ['database', 'schema', 'alias']
    .map((key) => {
      const cell = env && env.status ? env.status[key] : null;
      const row = {
        key,
        written: loc.written[key] || '',
        parsed: parsed[key] || '',
        resolved: (env ? env.place : parsed)[key] || '',
        built: loc.built[key] || '',
        status: cell ? cell.kind : '',
        vars: cell && cell.vars ? cell.vars : [],
        branch: !!(cell && cell.branch),
      };
      row.templated = /\{[{%]/.test(row.written);
      // Moved compares parsed with built, never the selected environment with
      // built: both come from the same parse, so the answer does not change
      // when another environment is picked.
      row.redirected = !!row.parsed && !!row.built && !sameIdent(row.parsed, row.built);
      return row;
    })
    .filter((row) => row.written || row.parsed || row.resolved || row.built);
}

/* Same warehouse identifier: Snowflake folds unquoted names, and dbt Fusion
   drops a pair of literal quotes that the written config may still carry. */
function sameIdent(a, b) {
  const bare = (s) => (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);
  return bare(a).toLowerCase() === bare(b).toLowerCase();
}

/* Text, class and tooltip for one resolved cell. `file` is the chosen .env
   file, empty in manifest mode. */
function resolvedCell(row, envName, file) {
  const vars = row.vars.join(', ');
  const branchNote = row.branch
    ? '\nPicked the branch dbt took when it parsed; the condition itself is not evaluated.'
    : '';
  const empty = { text: 'default', cls: 'nul', title: 'not set here, inherited from the target' };
  switch (row.status) {
    case 'missing':
      return { text: `missing ${vars}`, cls: 'env-missing', title: `${vars} is not defined in ${file}` };
    case 'placeholder':
      return {
        text: `${row.resolved || 'empty'} (placeholder)`,
        cls: 'env-placeholder',
        title: `${vars} is set to a placeholder in ${file}, not a real name`,
      };
    case 'unevaluated':
      return {
        text: row.resolved || 'not evaluated',
        cls: 'env-unevaluated',
        title: 'Contains Jinja that dbt-lens does not evaluate.' + branchNote,
      };
    case 'env':
      return { text: row.resolved, cls: '', title: `${vars} from ${file}` + branchNote };
    case 'literal':
      return row.resolved
        ? { text: row.resolved, cls: '', title: `written as a plain value, the same in every environment${branchNote}` }
        : empty;
    case 'parsed':
      return { text: row.resolved, cls: '', title: 'nothing written for this key: value as dbt parsed it' };
    default:
      return row.resolved
        ? { text: row.resolved, cls: '', title: `as dbt parsed it for ${envName || 'this manifest'}` }
        : empty;
  }
}

/* A relation name split into its parts, each remembering whether it was
   quoted. Inside quotes, "" stands for one literal quote. */
function splitRelation(text) {
  const parts = [];
  let name = '', quoted = false, inside = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inside) {
      if (ch === '"' && text[i + 1] === '"') { name += '"'; i++; }
      else if (ch === '"') inside = false;
      else name += ch;
    } else if (ch === '"') { inside = true; quoted = true; }
    else if (ch === '.') { parts.push({ name, quoted }); name = ''; quoted = false; }
    else name += ch;
  }
  parts.push({ name, quoted });
  return parts;
}

/* The relation the resolved column points at, quoted part by part the way the
   built relation is, or the reason it cannot be written. Database and schema
   must come from the config: left unset, they fall back to the target profile,
   which dbt-lens does not read. An unset alias is the one dbt built, since dbt
   derives it from the node, not from the environment. */
function resolvedRelation(rows, builtRelation, file) {
  const names = [];
  for (const key of ['database', 'schema', 'alias']) {
    const r = rows.find((row) => row.key === key) || { resolved: '', built: '', status: '', vars: [] };
    const vars = r.vars.join(', ');
    if (r.status === 'missing') return { text: '', reason: `${vars} is not defined in ${file}` };
    if (r.status === 'placeholder') return { text: '', reason: `${key} is a placeholder in ${file}, not a real name` };
    if (r.status === 'unevaluated') return { text: '', reason: `${key} contains Jinja that dbt-lens does not evaluate` };
    if (r.resolved) names.push(r.resolved);
    else if (key === 'alias' && r.built) names.push(r.built);
    else return { text: '', reason: `${key} is not set in the config, so it comes from the target profile, which dbt-lens does not read` };
  }
  const parts = builtRelation ? splitRelation(builtRelation) : [];
  const bare = (s) => (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);
  const write = (name, i) => (parts.length === 3 && parts[i].quoted
    ? `"${bare(name).replace(/"/g, '""')}"`
    : name);
  return { text: names.map(write).join('.'), reason: '' };
}

/* The relation Snowflake is asked about for a column's lineage, the .env file
   actually used, or why there is none. With no file chosen it is where this
   manifest's target built the node, since that object exists. A chosen file
   gives the relation the Location table resolves, and a file this node was
   not resolved against falls back to the manifest, as that table does. */
function lineageRelation(n, env) {
  if (!n.relation) {
    return { text: '', file: '', reason: n.materialized === 'ephemeral'
      ? `${n.name} is ephemeral, so it is not in the warehouse`
      : `${n.name} has no relation in the warehouse` };
  }
  const file = env && n.location && n.location.envs && n.location.envs[env] ? env : '';
  if (!file) return { text: n.relation, file: '', reason: '' };
  const rel = resolvedRelation(locationRows(n.location, file), n.relation, file);
  return { text: rel.text, file, reason: rel.reason };
}

function catalogLocation(body, n) {
  // A chosen file this node was not resolved against (none discovered at the
  // time, or the file was removed) quietly falls back to manifest mode.
  const file = S.env && n.location && n.location.envs && n.location.envs[S.env] ? S.env : '';
  const envName = file ? envDisplayName(file) : '';
  const rows = locationRows(n.location, file);
  if (!rows.length) return;
  // In a sandbox manifest every model is built away from its config, so a move
  // is expected there and only a model built outside the sandbox stands out.
  const sandbox = (S.meta && S.meta.sandbox) || '';
  const builtAt = n.location ? `${n.location.built.database}.${n.location.built.schema}`.toLowerCase() : '';
  const inSandbox = !!sandbox && builtAt === sandbox;
  body.appendChild(h3('location'));

  const table = document.createElement('table');
  table.className = 'loc';
  const head = document.createElement('tr');
  // The environment switch sits in the header of the column it changes. It
  // shows only when this node follows the choice, so its label never differs
  // from the values underneath.
  const pill = envsInUse() && file === S.env;
  for (const [label, tip] of [
    ['', ''],
    ['as written', 'the config as it appears in YAML, SQL or dbt_project.yml'],
    file
      ? [pill ? 'resolved' : `resolved (${envName})`, `the config evaluated with ${file} alone, before the generate_*_name macros`]
      : [pill ? 'resolved' : 'resolved (manifest)', 'the config with the env vars dbt had loaded when it parsed this manifest, '
        + 'before the generate_*_name macros. Not necessarily any particular environment.'],
    ['built (manifest)', 'where the target that produced this manifest actually built it'],
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    if (tip) th.title = tip;
    head.appendChild(th);
  }
  if (pill) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'envpill sm';
    b.setAttribute('aria-haspopup', 'menu');
    fillEnvPill(b, '');
    b.addEventListener('click', () => openEnvMenu(b));
    head.children[2].append(b);
  }
  table.appendChild(head);

  const cell = (value, cls) => {
    const td = document.createElement('td');
    if (value) {
      td.textContent = value;
      if (cls) td.className = cls;
    } else {
      td.textContent = 'default';
      td.className = 'nul';
      td.title = 'not set here, inherited from the target';
    }
    return td;
  };
  for (const r of rows) {
    const tr = document.createElement('tr');
    const k = document.createElement('td');
    k.className = 'k';
    k.textContent = r.key;
    const built = cell(r.built, r.redirected ? (inSandbox ? 'moved expected' : 'moved') : '');
    if (r.redirected) built.title = `dbt parsed ${r.parsed}, built in ${r.built}`;
    const rc = resolvedCell(r, envName, file);
    const resolved = document.createElement('td');
    resolved.textContent = rc.text;
    if (rc.cls) resolved.className = rc.cls;
    resolved.title = rc.title;
    tr.append(k, cell(r.written, r.templated ? 'tpl' : ''), resolved, built);
    table.appendChild(tr);
  }
  // Ephemeral models have no relation, in any environment.
  if (n.relation) {
    const tr = document.createElement('tr');
    tr.className = 'rel';
    const k = document.createElement('td');
    k.className = 'k';
    k.textContent = 'relation';
    const rel = resolvedRelation(rows, n.relation, file);
    tr.append(k, document.createElement('td'),
      relationCell(rel.text, rel.reason,
        file ? `resolved with ${file}, before the generate_*_name macros` : 'as dbt parsed it, before the generate_*_name macros'),
      relationCell(n.relation, '', 'where this manifest\'s target built it'));
    table.appendChild(tr);
  }
  body.appendChild(table);

  const foot = document.createElement('div');
  foot.className = 'loc-foot';
  const unresolved = rows.filter((r) => r.status === 'missing' || r.status === 'placeholder');
  if (unresolved.length) {
    foot.append(Object.assign(document.createElement('span'), {
      className: 'moved-note',
      textContent: `${file} does not give a usable value for ${unresolved.map((r) => r.key).join(' and ')}.`,
    }));
  } else if (inSandbox) {
    foot.append(Object.assign(document.createElement('span'), {
      className: 'sandbox-note',
      textContent: `Sandbox manifest: ${S.meta.sandbox_models} models are built into ${sandbox}. `
        + (file
          ? `Resolved shows ${envName}; built still shows where this manifest's target built it.`
          : 'Resolved is the config with the env vars dbt had when it parsed. Pick an environment in the status bar to see another.'),
    }));
  } else if (rows.some((r) => r.redirected)) {
    foot.append(Object.assign(document.createElement('span'), {
      className: 'moved-note',
      textContent: 'Built outside its configured location: the generate_*_name macros redirect it for this target.',
    }));
  }
  if (foot.children.length) body.appendChild(foot);
}

/* A full relation name with its own Copy button, or why there is none. */
function relationCell(text, reason, what) {
  const td = document.createElement('td');
  if (!text) {
    td.className = 'nul';
    td.textContent = 'not available';
    td.title = reason;
    return td;
  }
  const wrap = document.createElement('div');
  wrap.className = 'relcell';
  const name = document.createElement('span');
  name.textContent = text;
  name.title = what;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn sm';
  copy.textContent = 'Copy';
  copy.title = 'copy ' + text;
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast('copied ' + text, 'ok'); }
    catch { toast('clipboard unavailable', 'err'); }
  });
  wrap.append(name, copy);
  td.appendChild(wrap);
  return td;
}

function catalogPreview(body, n) {
  const desc = document.createElement('p');
  desc.className = 'cat-desc';
  if (n.description) desc.textContent = n.description;
  else { desc.classList.add('muted'); desc.textContent = 'No description in the YAML.'; }
  body.appendChild(desc);

  body.appendChild(h3('context'));
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.append(
    stat('Mat. type', n.materialized || n.kind),
    stat('Columns', String(n.columns.length)),
    stat('Upstream models', `${n.parents.length}`, () => { $('#up').value = 1; focusNode(n.id); showDock('lineage'); }),
    stat('Downstream models', `${n.children.length}`, () => { $('#down').value = 1; focusNode(n.id); showDock('lineage'); }),
    stat('Tests', String(n.tests.length)),
  );
  const totals = document.createElement('div');
  totals.className = 'muted';
  totals.style.cssText = 'font-size:11px;margin-top:8px';
  totals.textContent = `${n.upstream_total} models upstream in total, ${n.downstream_total} downstream (whole graph).`;
  body.append(stats, totals);
  catalogLocation(body, n);

  if (n.tags.length) {
    body.appendChild(h3('tags'));
    const box = document.createElement('div');
    box.className = 'links';
    n.tags.forEach((t) => {
      const c = document.createElement('span');
      c.className = 'tagchip';
      c.textContent = t;
      box.appendChild(c);
    });
    body.appendChild(box);
  }

  const kv = document.createElement('dl');
  kv.className = 'kvline';
  const add = (k, v) => {
    if (!v) return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    kv.append(dt, dd);
  };
  add('strategy', n.strategy);
  add('unique key', n.unique_key);
  add('model file', n.file);
  add('schema file', n.yml);
  add('unique id', n.id);
  if (kv.children.length) { body.appendChild(h3('details')); body.appendChild(kv); }

  const refs = (label, items) => {
    if (!items.length) return;
    body.appendChild(h3(`${label} (${items.length})`));
    const box = document.createElement('div');
    box.className = 'links';
    // Same gestures as a box in the graph: click moves the lineage and the
    // catalog to that node, double-click also opens its file.
    items.slice(0, 300).forEach((r) => {
      const a = document.createElement('span');
      a.className = 'link';
      a.append(dot(r), document.createTextNode(r.name));
      a.title = `${r.id}\nclick: show it here and in the lineage`
        + (r.file ? '\ndouble-click: also open its file' : '');
      a.addEventListener('click', () => focusNode(r.id));
      a.addEventListener('dblclick', () => {
        if (!r.file) return;
        openFile(r.file, { focusLineage: false });
        revealInTree(r.file);
      });
      box.appendChild(a);
    });
    body.appendChild(box);
  };
  refs('upstream', n.parents);
  refs('downstream', n.children);
}

function catalogColumns(body, n) {
  if (!n.columns.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No column is declared for this node. Document them in the YAML, or run dbt docs generate so catalog.json lists the warehouse columns.';
    body.appendChild(p);
    return;
  }

  const tools = document.createElement('div');
  tools.className = 'coltools';
  const untyped = n.columns.filter((c) => !c.data_type).length;
  const note = document.createElement('span');
  note.textContent = untyped === n.columns.length
    ? 'no types: run dbt compile --write-catalog to pull them from Snowflake'
    : `${n.columns.length - untyped}/${n.columns.length} typed`;
  tools.append(note, sourceMenu());
  const hint = columnsHint(S.sidecar, n.columns.some((c) => c.up || c.down));
  if (hint) {
    const span = document.createElement('span');
    span.className = 'colhint';
    span.dataset.tone = hint.tone;
    span.textContent = hint.text;
    if (hint.tone === 'failed') span.title = ((S.sidecar && S.sidecar.log) || []).join('\n');
    tools.appendChild(span);
  }
  tools.append(Object.assign(document.createElement('div'), { className: 'grow' }));
  tools.appendChild(document.createTextNode('Sort by'));
  for (const [key, label] of [['az', 'A-Z'], ['tests', 'Tests']]) {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = label;
    if (S.colSort === key) b.style.borderColor = 'var(--accent)';
    b.addEventListener('click', () => { S.colSort = key; renderCatalog(n); });
    tools.appendChild(b);
  }
  body.appendChild(tools);

  const cols = [...n.columns];
  if (S.colSort === 'tests') cols.sort((a, b) => b.tests.length - a.tests.length || a.name.localeCompare(b.name));
  else cols.sort((a, b) => a.name.localeCompare(b.name));

  // With the switch on, every column can be asked about, not just the cached ones.
  const live = sidecarOn();
  const linked = live || n.columns.some((c) => c.up || c.down);
  const table = document.createElement('table');
  table.className = 'cols';
  const head = document.createElement('tr');
  (linked ? ['Column', 'Type', 'Description', 'Tests', 'Lineage'] : ['Column', 'Type', 'Description', 'Tests']).forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    head.appendChild(th);
  });
  table.appendChild(head);

  const nul = () => {
    const s = document.createElement('span');
    s.className = 'nul';
    s.textContent = "\u2013";
    return s;
  };
  for (const c of cols) {
    const tr = document.createElement('tr');
    if (c.undeclared) tr.className = 'c-undeclared';
    const name = document.createElement('td');
    name.className = 'c-name';
    name.textContent = c.name;
    if (c.undeclared) name.title = 'in the warehouse but not declared in YAML';
    const type = document.createElement('td');
    type.className = 'c-type';
    type.append(c.data_type || nul());
    const desc = document.createElement('td');
    desc.className = 'c-desc';
    desc.append(c.description || nul());
    const tests = document.createElement('td');
    if (!c.tests.length) tests.append(nul());
    c.tests.forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'testchip' + (t === 'not_null' ? ' nn' : t === 'unique' ? ' un' : '');
      chip.textContent = t;
      tests.appendChild(chip);
    });
    tr.append(name, type, desc, tests);
    if (linked) {
      const lin = document.createElement('td');
      lin.className = 'c-lin';
      if (c.up || c.down) {
        const u = document.createElement('b'); u.textContent = `\u2190${c.up}`;
        const dn = document.createElement('b'); dn.textContent = `${c.down}\u2192`;
        lin.append(u, document.createTextNode('  '), dn);
      } else if (live) {
        const ask = document.createElement('span');
        ask.className = 'c-ask';
        ask.textContent = 'fetch';
        lin.append(ask);
      } else {
        lin.append(nul());
      }
      if (c.up || c.down || live) {
        tr.classList.add('c-linked');
        tr.title = live ? `fetch the lineage of ${c.name} from Snowflake` : `column lineage for ${c.name}`;
        // The name cell is left out of the click target on purpose: copying a
        // column name is the more common thing to want, and a click target
        // makes the text impossible to select. The rest of the row still opens
        // the lineage, so column mode stays reachable from here.
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.c-name')) return;
          openColumn(n, c.name);
        });
      }
      tr.appendChild(lin);
    }
    if (c.name === S.colHighlight) tr.classList.add('c-focus');
    table.appendChild(tr);
  }
  body.appendChild(table);
}

// --------------------------------------------------------------- terminal --
function initTerm() {
  if (S.term) return;
  S.term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12.5, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0e1219', foreground: '#d7dee8', cursor: '#4da3ff', selectionBackground: '#2b3a4d' },
  });
  S.fit = new FitAddon.FitAddon();
  S.term.loadAddon(S.fit);
  S.term.open($('#term'));
  S.fit.fit();
  connectTerm();
  S.term.onData((d) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t: 'i', d })));
  S.term.onKey(({ domEvent }) => {
    if (domEvent.key === 'Enter' && (!S.ws || S.ws.readyState > 1)) { S.term.reset(); connectTerm(); }
  });
  new ResizeObserver(() => {
    if ($('#dock-terminal').classList.contains('hidden')) return;
    try { S.fit.fit(); } catch {}
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'r', cols: S.term.cols, rows: S.term.rows }));
  }).observe($('#dock-terminal'));
}

function connectTerm() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws/pty?cols=${S.term.cols}&rows=${S.term.rows}`);
  S.ws.binaryType = 'arraybuffer';
  S.ws.onmessage = (e) => {
    if (typeof e.data === 'string') S.term.write(e.data);
    else S.term.write(new Uint8Array(e.data));
  };
  S.ws.onclose = () => S.term.write('\r\n\x1b[90m[disconnected - press Enter to start a new shell]\x1b[0m\r\n');
}

// ---------------------------------------------------------------- palette --
let palIndex = 0, palHits = [];
function openPalette() {
  closeCrumbMenu();
  $('#palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = ''; input.focus();
  runPalette('');
}
function closePalette() { $('#palette').classList.add('hidden'); }

/* Nodes first, then the files that are not already represented by one: a model
   would otherwise appear twice, once as a node and once as its own .sql. */
function mergeHits(nodes, paths) {
  const taken = new Set();
  for (const n of nodes) {
    if (n.file) taken.add(n.file);
  }
  return [
    ...nodes.map((n) => ({ kind: 'node', node: n, label: n.name, sub: n.file })),
    ...paths.filter((p) => !taken.has(p)).map((p) => ({ kind: 'file', path: p, label: base(p), sub: p })),
  ];
}

/* One box for everything: dbt nodes from the manifest, and every file in the
   project. A generic test definition or a dotfile is not a node, and used to be
   unfindable. */
async function runPalette(q) {
  const [nodes, paths] = await Promise.all([
    api.get(`/api/search?q=${encodeURIComponent(q)}&kind=model,source,seed,snapshot,exposure&limit=40`).catch(() => []),
    api.get(`/api/files?q=${encodeURIComponent(q)}&limit=40`).catch(() => []),
  ]);
  palHits = mergeHits(nodes, paths);
  palIndex = 0;

  const box = $('#palette-results');
  box.textContent = '';
  if (!palHits.length) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'git-empty',
      textContent: q.trim() ? `Nothing matches "${q.trim()}".` : 'Type to search models, sources and every file in the project.',
    }));
    return;
  }
  palHits.forEach((h, i) => {
    const r = document.createElement('div');
    r.className = 'pres' + (i === 0 ? ' on' : '') + (h.kind === 'node' && h.node.disabled ? ' off' : '');
    const p1 = document.createElement('span');
    p1.className = 'p1';
    p1.textContent = h.label;
    const p2 = document.createElement('span');
    p2.className = 'p2';
    p2.textContent = h.sub;
    r.append(h.kind === 'node' ? dot(h.node) : fileIcon(h.path), p1, p2);
    r.addEventListener('click', () => choosePalette(i));
    box.appendChild(r);
  });
}

function movePalette(delta) {
  const rows = $$('#palette-results .pres');
  if (!rows.length) return;
  rows[palIndex].classList.remove('on');
  palIndex = (palIndex + delta + rows.length) % rows.length;
  rows[palIndex].classList.add('on');
  rows[palIndex].scrollIntoView({ block: 'nearest' });
}

function choosePalette(i) {
  const h = palHits[i ?? palIndex];
  if (!h) return;
  closePalette();
  if (h.kind === 'file') {
    openFile(h.path, { preview: true });
    revealInTree(h.path);
    return;
  }
  focusNode(h.node.id);
  if (h.node.file) { openFile(h.node.file, { focusLineage: false, preview: true }); revealInTree(h.node.file); }
}

// ------------------------------------------------------------------ tabs --
/* Search across file contents, which the path index cannot answer. The server
   finds the lines; the match inside one is found here, because the browser knows
   the query and a byte offset from Rust would not survive into a UTF-16 string. */
function splitMatch(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || at < 0) return [text, '', ''];
  return [text.slice(0, at), text.slice(at, at + query.length), text.slice(at + query.length)];
}

/* What the status line says about a result. Pure, so the wording is checkable. */
function grepSummary(result, query) {
  if (!query) return '';
  if (query.length < 3) return 'three letters or more';
  if (!result) return 'searching…';
  const files = result.files.length;
  if (!files) return `no match for "${query}"`;
  const hits = result.total;
  const bits = [`${hits} match${hits > 1 ? 'es' : ''} in ${files} file${files > 1 ? 's' : ''}`];
  if (result.capped) bits.push('showing the first found');
  if (result.skipped) bits.push(`${result.skipped} file${result.skipped > 1 ? 's' : ''} skipped`);
  return bits.join(' · ');
}

let grepTimer = null;
let grepRun = 0;

function paintGrep(result, query) {
  $('#grep-status').textContent = grepSummary(result, query);
  const host = $('#grep-results');
  host.textContent = '';
  if (!result) return;
  for (const f of result.files) {
    const head = document.createElement('div');
    head.className = 'grep-file';
    head.append(Object.assign(document.createElement('span'), { className: 'nm', textContent: base(f.path) }));
    head.append(Object.assign(document.createElement('span'), { className: 'dir', textContent: dirOf(f.path) }));
    head.title = f.path;
    head.addEventListener('click', () => openAt(f.path, f.hits[0].line));
    host.appendChild(head);
    for (const h of f.hits) {
      const row = document.createElement('div');
      row.className = 'grep-hit';
      row.append(Object.assign(document.createElement('span'), { className: 'ln', textContent: h.line }));
      const [before, hit, after] = splitMatch(h.text, query);
      const body = document.createElement('span');
      body.className = 'tx';
      body.append(document.createTextNode(before));
      if (hit) body.append(Object.assign(document.createElement('mark'), { textContent: hit }));
      body.append(document.createTextNode(after));
      row.appendChild(body);
      row.addEventListener('click', () => openAt(f.path, h.line));
      host.appendChild(row);
    }
    if (f.more) {
      host.append(Object.assign(document.createElement('div'), {
        className: 'grep-more', textContent: `+${f.more} more in this file`,
      }));
    }
  }
}

function runGrep() {
  const query = $('#grep-input').value.trim();
  clearTimeout(grepTimer);
  if (query.length < 3) {
    paintGrep(null, query);
    return;
  }
  paintGrep(null, query);
  const run = ++grepRun;
  // A full scan of a large project is well under a second, so a short pause is
  // enough to keep a burst of typing down to one request.
  grepTimer = setTimeout(() => {
    api.get('/api/grep?q=' + encodeURIComponent(query))
      .then((result) => { if (run === grepRun) paintGrep(result, query); })
      .catch((e) => { if (run === grepRun) $('#grep-status').textContent = 'search failed: ' + e.message; });
  }, 250);
}

/* Opens a file and puts the cursor on one of its lines, which is what a search
   result is for. Preview, like a single click in the explorer: browsing results
   should not leave a dozen pinned tabs behind. */
async function openAt(path, line) {
  await openFile(path, { focusLineage: false, preview: true });
  if (!S.cm || S.active !== path) return;
  gotoPos(line - 1, 0);
}

function wireTabs() {
  $$('[data-side]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-side]').forEach((x) => x.classList.toggle('active', x === b));
    $('#side-files').classList.toggle('hidden', b.dataset.side !== 'files');
    $('#side-models').classList.toggle('hidden', b.dataset.side !== 'models');
    $('#side-git').classList.toggle('hidden', b.dataset.side !== 'git');
    $('#side-search').classList.toggle('hidden', b.dataset.side !== 'search');
    if (b.dataset.side === 'models' && !$('#model-list').children.length) refreshModels();
    if (b.dataset.side === 'git') refreshGit();
    if (b.dataset.side === 'search') $('#grep-input').focus();
  }));

  $$('[data-dock]').forEach((b) => b.addEventListener('click', () => showDock(b.dataset.dock)));
}

function showDock(which) {
  $$('[data-dock]').forEach((x) => x.classList.toggle('active', x.dataset.dock === which));
  $('#dock-lineage').classList.toggle('hidden', which !== 'lineage');
  $('#dock-terminal').classList.toggle('hidden', which !== 'terminal');
  $('#dock-catalog').classList.toggle('hidden', which !== 'catalog');
  $('#dock-compiled').classList.toggle('hidden', which !== 'compiled');
  if (which === 'compiled') loadCompiled(S.focus);
  $('#lineage-tools').classList.toggle('hidden', which !== 'lineage');
  if (which === 'terminal') { initTerm(); setTimeout(() => { try { S.fit.fit(); } catch {} S.term.focus(); }, 30); }
  if (which === 'lineage') setTimeout(() => Lineage.fit(), 30);
}

// -------------------------------------------------------------- splitters --
function wireSplitters() {
  const drag = (gutter, onMove) => {
    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      gutter.classList.add('drag');
      const move = (ev) => onMove(ev);
      const up = () => {
        gutter.classList.remove('drag');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        S.cm && S.cm.refresh();
        if (S.fit && !$('#dock-terminal').classList.contains('hidden')) { try { S.fit.fit(); } catch {} }
        Lineage.fit();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };
  drag($('#gutter-side'), (e) => {
    const w = Math.min(520, Math.max(150, e.clientX));
    document.documentElement.style.setProperty('--side-w', w + 'px');
  });
  drag($('#gutter-dock'), (e) => {
    const body = $('#body').getBoundingClientRect();
    const pct = Math.min(85, Math.max(10, ((body.bottom - e.clientY) / body.height) * 100));
    document.documentElement.style.setProperty('--dock-h', pct + '%');
  });
}

// ------------------------------------------------------------------ keys --
function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveAll(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.altKey && !mod && e.key.toLowerCase() === 'w') { e.preventDefault(); if (S.active) closeFile(S.active); return; }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (mod && e.key === '`') { e.preventDefault(); showDock('terminal'); return; }
    if (e.key === 'Escape' && !$('#palette').classList.contains('hidden')) closePalette();
  });
  $('#palette-input').addEventListener('input', (e) => runPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choosePalette(); }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });
  $('#palette-btn').addEventListener('click', openPalette);
  $('#model-filter').addEventListener('input', () => {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(refreshModels, 120);
  });
  $('#branch-btn').addEventListener('click', openBranches);
  $('#status-branch').addEventListener('click', openBranches);
  $('#git-fetch').addEventListener('click', async () => {
    const r = await gitPost('fetch');
    if (r && !r.ok) showGitFailure('Fetch failed', r); else toast('fetched', 'ok');
  });
  $('#git-pull').addEventListener('click', doPull);
  $('#git-push').addEventListener('click', doPush);
  $('#commit-btn').addEventListener('click', doCommit);
  $('#commit-msg').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doCommit(); }
  });
  $('#branch-filter').addEventListener('input', (e) => paintBranches(e.target.value));
  $('#branch-filter').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveBranch(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveBranch(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const b = (branchHits.visible || [])[branchIndex];
      if (b) chooseBranch(b);
    } else if (e.key === 'Escape') $('#branches').classList.add('hidden');
  });
  $('#branches').addEventListener('click', (e) => { if (e.target.id === 'branches') e.currentTarget.classList.add('hidden'); });
  $('#save-all-btn').addEventListener('click', (e) => { e.stopPropagation(); saveAll(); });
  $('#close-all-btn').addEventListener('click', (e) => { e.stopPropagation(); closeAll(); });
  $('#oe-head').addEventListener('click', () => {
    const box = $('#open-editors');
    box.classList.toggle('collapsed');
    $('#oe-caret').textContent = box.classList.contains('collapsed') ? '\u25b8' : '\u25be';
  });
  $('#reload-btn').addEventListener('click', async () => {
    try {
      const meta = await api.send('/api/reload', 'POST', {});
      applyMeta(meta);
      toast(`manifest reloaded in ${meta.load_ms} ms`, 'ok');
      rerender();
    } catch (e) { toast('reload failed: ' + e.message, 'err'); }
  });
}

// ------------------------------------------------------------------ boot --
function applyMeta(meta) {
  // Every caller of this has just learned the graph changed, which is exactly
  // when a cached /api/node payload stops being true. Here rather than at each
  // call site: forgetting one is how a stale count survives a column fetch.
  dropNodeCache();
  S.meta = meta;
  $('#project').textContent = meta.project || '(no manifest)';
  const c = meta.counts || {};
  $('#counts').textContent = '';
  for (const k of ['model', 'source', 'seed', 'snapshot', 'test']) {
    if (!c[k]) continue;
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = `${c[k]} ${k}${c[k] > 1 ? 's' : ''}`;
    $('#counts').appendChild(s);
  }
  if (meta.cll_edges) {
    const s = document.createElement('span');
    s.className = 'chip';
    // Always name the source: mistaking synthetic or stale edges for warehouse
    // truth is the expensive failure mode here.
    s.textContent = `${meta.cll_edges} col edges · ${meta.cll_source || 'unknown source'}`;
    s.title = `column lineage from ${meta.cll_source || 'cache'} (${meta.cll_file || '?'})`
      + (meta.cll_dropped ? `, ${meta.cll_dropped} row(s) dropped as unknown` : '');
    $('#counts').appendChild(s);
  }
  const when = meta.manifest_mtime ? new Date(meta.manifest_mtime * 1000).toLocaleString() : 'missing';
  $('#status-manifest').textContent = `dbt ${meta.dbt_version || '?'} · manifest ${when}`;
}

async function boot() {
  initEditor();
  Lineage.init($('#graph'), {
    onSelect: (n) => {
      const { node: nodeId, column } = splitColId(n.id);
      S.colHighlight = column;
      if (column) S.catTab = 'columns';
      nodeDetail({ id: nodeId }).then(renderCatalog).catch(() => {});
    },
    onHover: (n, g) => {
      const { node: nodeId, column } = splitColId(n.id);
      if (column) return;                  // in column mode the box already says everything
      hoverEnter('node:' + nodeId, () => g.getBoundingClientRect(), (el) => fillNodeCard(el, nodeId, n));
    },
    onHoverOut: hoverLeave,
    onHoverClose: closeHoverCard,
    onOpen: (n) => {
      const { node: nodeId, column } = splitColId(n.id);
      if (column && sidecarOn()) {
        return api.get('/api/node?id=' + encodeURIComponent(nodeId))
          .then((detail) => openColumn(detail, column))
          .catch((e) => toast('column lineage: ' + e.message, 'err'));
      }
      if (column) return focusColumn(nodeId, column);
      focusNode(nodeId);
      if (n.file) { openFile(n.file, { focusLineage: false }); revealInTree(n.file); }
    },
    onExpand: (dir) => {
      const input = dir === 'up' ? $('#up') : $('#down');
      input.value = Math.min(20, +input.value + 1);
      rerender();
    },
  });
  wireTabs(); wireKeys(); wireSplitters(); relinkTools();
  $('#grep-input').addEventListener('input', runGrep);
  renderTabs();
  paintMode();
  $('#editor-host').style.display = 'none';

  const info = await api.get('/api/meta');
  applyMeta(info.meta);
  await loadSidecar();
  $('#status-shell').textContent = info.shell;
  // Which build drew this page. A release binary embeds web/ (0005), so this is
  // what tells a stale binary from a frontend change that really did nothing.
  const build = $('#status-build');
  build.textContent = 'v' + (info.version || '?');
  build.title = `dbt-lens ${info.version || '?'}\n${info.build || 'no build stamp'}`;
  const v = info.venv || {};
  const venvEl = $('#status-venv');
  if (v.name) {
    venvEl.textContent = (v.source === 'activated' ? 'venv ' : 'venv (inactive) ') + v.name
      + (v.python ? ' · py ' + v.python : '');
    venvEl.title = [v.path, v.dbt && ('dbt: ' + v.dbt),
      v.source === 'activated' ? 'activated when dbt-lens started'
        : 'found in the project but not activated; source its activate script in the terminal',
      v.others.length ? 'also found: ' + v.others.join(', ') : ''].filter(Boolean).join('\n');
  } else {
    venvEl.textContent = 'no venv';
    venvEl.title = 'no VIRTUAL_ENV when dbt-lens started, and none found in the project';
  }
  document.title = `${info.meta.project || 'dbt-lens'} · dbt-lens`;
  $('#status-env').addEventListener('click', (e) => openEnvMenu(e.currentTarget));
  loadEnvs();
  await loadDir($('#tree'), '', 0);
  refreshGit();
  setInterval(refreshGit, 5000);
  window.addEventListener('resize', () => Lineage.fit());
}

boot().catch((e) => toast('startup failed: ' + e.message, 'err'));
})();
