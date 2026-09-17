// Preview and pinned tabs, VS Code style.
// Run from the repository root: jsc web/tests/tabs.js
var src = read('web/app.js');
var fn = src.slice(src.indexOf('const base = (path)'), src.indexOf('function activate(path'));

// Stubs: only what openFile touches.
var S = { open: new Map(), order: [], active: null, preview: null };
var api = { get: function (u) { return Promise.resolve({ content: 'x', truncated: false }); } };
var CodeMirror = { Doc: function (t, m) { return { t: t }; } };
var activated = [];
function activate(p) { S.active = p; activated.push(p); }
function markRefs() {}
function modeFor() { return null; }
function toast(m) { print('  toast: ' + m); }
eval(fn);

function tabs() { return S.order.map(function (p) { return p === S.preview ? '[' + p + ']' : p; }).join(' '); }
function check(label, got, want) {
  print((got === want ? 'PASS  ' : 'FAIL  ') + label);
  if (got !== want) print('        expected: ' + want + '\n        got     : ' + got);
}

var q = Promise.resolve();
function step(f) { q = q.then(f); }

step(function () { return openFile('a.sql', { preview: true }); });
step(function () { return openFile('b.sql', { preview: true }); });
step(function () { return openFile('c.sql', { preview: true }); });
step(function () { check('3 single clicks -> a single preview tab', tabs(), '[c.sql]'); });

step(function () { return openFile('d.sql'); });
step(function () { check('double click -> pinned tab added, preview kept', tabs(), '[c.sql] d.sql'); });

step(function () { return openFile('e.sql', { preview: true }); });
step(function () { return openFile('e.sql'); });
step(function () { check('reopening without preview -> pinned in place', tabs(), 'e.sql d.sql'); });

step(function () { return openFile('f.sql', { preview: true }); });
step(function () { S.open.get('f.sql').dirty = true; return openFile('g.sql', { preview: true }); });
step(function () { check('edited preview -> not replaced', tabs(), 'e.sql d.sql f.sql [g.sql]'); });

step(function () { return openFile('h.sql', { preview: true }); });
step(function () { check('clean preview -> replaced in place', tabs(), 'e.sql d.sql f.sql [h.sql]'); });

step(function () { return openFile('d.sql', { preview: true }); });
step(function () {
  check('reopening a pinned tab does not demote it', tabs(), 'e.sql d.sql f.sql [h.sql]');
  check('  and it becomes active', S.active, 'd.sql');
});
q.then(function () { print('\nfinal tabs: ' + S.order.length + ', preview: ' + S.preview); });
