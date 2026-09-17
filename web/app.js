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
};

// ------------------------------------------------------------------ util --
const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    return r.json();
  },
  async send(path, method, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    return r.json();
  },
};

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
    try { parents = (await api.get('/api/node?file=' + encodeURIComponent(path))).parents; }
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
      const mark = doc.markText(doc.posFromIndex(from), doc.posFromIndex(to), {
        className: 'cm-reflink' + (target ? (target.disabled ? ' dis' : '') : ' missing'),
        attributes: { title },
      });
      mark.refTarget = target || { name: hit.name };
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
  let rescan = null;
  S.cm.on('change', () => {
    clearTimeout(rescan);
    const doc = S.cm.getDoc();
    rescan = setTimeout(() => markRefs(doc, S.active), 500);
  });
  wireRefClicks(S.cm);
}

const base = (path) => path.split('/').pop();
const dirOf = (path) => {
  const d = path.slice(0, path.lastIndexOf('/'));
  return d.length > 36 ? '\u2026' + d.slice(-35) : d;
};

/* `preview` opens the file in the single reusable tab instead of stacking a new
   one, the way a single click does in VS Code. Editing it, or opening it again
   with preview off, pins it. */
async function openFile(path, { focusLineage = true, preview = false } = {}) {
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
  markTreeSelection(f.kind === 'diff' ? f.path : path);
  if (focusLineage) syncNode(f.kind === 'diff' ? f.path : path);
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
    }
  }
  renderTabs();
}

async function saveFile(path) {
  const f = S.open.get(path);
  if (f && f.kind === 'diff') return true;
  if (!f || !f.dirty) return true;
  try {
    await api.send('/api/file', 'PUT', { path, content: f.doc.getValue() });
    f.dirty = false;
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
  refreshGit();
  if (ok) toast('saved ' + base(S.active), 'ok');
}

async function saveAll() {
  const dirty = S.order.filter((p) => S.open.get(p).dirty);
  if (!dirty.length) return toast('nothing to save');
  let done = 0;
  for (const path of dirty) if (await saveFile(path)) done++;
  renderTabs();
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
}

function renderTabs() {
  const bar = $('#tabbar');
  bar.textContent = '';
  for (const path of S.order) {
    const f = S.open.get(path);
    const t = document.createElement('div');
    t.className = 'ftab' + (path === S.active ? ' active' : '') + (f.dirty ? ' dirty' : '');
    const name = document.createElement('span');
    name.textContent = f.kind === 'diff' ? base(f.path) + '  ↔' : base(path);
    name.title = f.kind === 'diff' ? f.path + '  (HEAD against the working tree)' : path;
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
  const c = S.cm.getCursor();
  s.textContent = `${S.active}  ·  ${c.line + 1}:${c.ch + 1}${f.dirty ? '  ·  modified' : ''}${f.truncated ? '  ·  truncated' : ''}`;
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
  S.focus = id;
  S.graphMode = 'model';
  S.colFocus = null;
  paintMode();
  const up = +$('#up').value, down = +$('#down').value;
  const tests = $('#with-tests').checked ? 1 : 0;
  try {
    const [sub, detail] = await Promise.all([
      api.get(`/api/lineage?id=${encodeURIComponent(id)}&up=${up}&down=${down}&tests=${tests}`),
      api.get('/api/node?id=' + encodeURIComponent(id)),
    ]);
    $('#lineage-empty').classList.add('hidden');
    Lineage.render(sub);
    $('#lineage-status').textContent =
      `${sub.nodes.length} nodes · ${sub.edges.length} edges${sub.truncated ? ' · truncated' : ''}`;
    paintLegend(sub.nodes);
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
    paintLegend(sub.nodes);
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

/* Only the materializations present in the current graph, so the legend stays
   short and always matches what is drawn. */
function paintLegend(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    const label = Lineage.matLabel(n);
    if (!seen.has(label)) seen.set(label, Lineage.nodeColor(n));
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
    const detail = await api.get('/api/node?file=' + encodeURIComponent(path));
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
  tools.append(note);
  if (!(S.meta && S.meta.cll_edges)) {
    const hint = document.createElement('span');
    hint.textContent = '  ·  no column lineage: python3 tools/sf_lineage.py dump';
    hint.title = 'dbt-lens reads target/column_lineage.json, written by the Snowflake sidecar';
    tools.appendChild(hint);
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

  const linked = n.columns.some((c) => c.up || c.down);
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
        tr.classList.add('c-linked');
        tr.title = `column lineage for ${c.name}`;
        tr.addEventListener('click', () => focusColumn(n.id, c.name));
      } else {
        lin.append(nul());
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
function wireTabs() {
  $$('[data-side]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-side]').forEach((x) => x.classList.toggle('active', x === b));
    $('#side-files').classList.toggle('hidden', b.dataset.side !== 'files');
    $('#side-models').classList.toggle('hidden', b.dataset.side !== 'models');
    $('#side-git').classList.toggle('hidden', b.dataset.side !== 'git');
    if (b.dataset.side === 'models' && !$('#model-list').children.length) refreshModels();
    if (b.dataset.side === 'git') refreshGit();
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
      api.get('/api/node?id=' + encodeURIComponent(nodeId)).then(renderCatalog).catch(() => {});
    },
    onOpen: (n) => {
      const { node: nodeId, column } = splitColId(n.id);
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
  renderTabs();
  paintMode();
  $('#editor-host').style.display = 'none';

  const info = await api.get('/api/meta');
  applyMeta(info.meta);
  $('#status-shell').textContent = info.shell;
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
