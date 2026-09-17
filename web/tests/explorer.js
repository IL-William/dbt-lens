// Explorer colouring: unsaved buffers in green, uncommitted changes in amber,
// both propagated to parent folders.
// Run from the repository root: jsc web/tests/explorer.js
var src = read('web/app.js');
var code = src.slice(src.indexOf('function ancestorsOf'), src.indexOf('async function refreshGit'));

var S = { open: new Map(), rows: new Map(), gitMod: new Set(), gitUnt: new Set(),
          gitModDirs: new Set(), gitUntDirs: new Set(), gitPrefixes: [] };
var branchEl = { textContent: '' };
function $(sel) { return branchEl; }
eval(code);

function fakeEl() {
  var cls = {};
  return { isConnected: true, title: '',
    classList: { toggle: function (c, on) { if (on) cls[c] = 1; else delete cls[c]; }, all: cls } };
}
function addRow(path, dir) { S.rows.set(path, { el: fakeEl(), dir: dir }); }
function stateOf(path) {
  var c = S.rows.get(path).el.classList.all;
  return c['st-unsaved'] ? 'green' : c['st-modified'] ? 'amber' : c['st-untracked'] ? 'amber(untracked)' : '-';
}
function check(path, want) {
  var got = stateOf(path);
  print((got === want ? 'PASS  ' : 'FAIL  ') + path.padEnd(28) + got + (got === want ? '' : '   expected ' + want));
}

// The exact payload /api/git returned on the test repository.
var payload = { repo: true, branch: 'master',
  modified: ['macros/m.sql', 'models/staging/a.sql', 'staged.sql'],
  untracked: ['models/newfolder/', 'models/staging/c.sql'] };

['macros','models','models/staging','models/newfolder'].forEach(function(p){ addRow(p, true); });
['macros/m.sql','models/schema.yml','models/staging/a.sql','models/staging/b.sql',
 'models/staging/c.sql','models/newfolder/d.sql','staged.sql'].forEach(function(p){ addRow(p, false); });

applyGit(payload);
print('branch shown: ' + branchEl.textContent);
print('\n--- git alone ---');
check('models/staging/a.sql', 'amber');
check('macros/m.sql', 'amber');
check('staged.sql', 'amber');
check('models/staging/b.sql', '-');
check('models/schema.yml', '-');
check('models/staging/c.sql', 'amber(untracked)');
check('models/newfolder/d.sql', 'amber(untracked)');
check('models/newfolder', 'amber(untracked)');
check('macros', 'amber');
check('models/staging', 'amber');
check('models', 'amber');

print('\n--- with an unsaved buffer on b.sql ---');
S.open.set('models/staging/b.sql', { dirty: true });
S.open.set('models/staging/a.sql', { dirty: false });
paintTree();
check('models/staging/b.sql', 'green');
check('models/staging', 'green');
check('models', 'green');
check('models/staging/a.sql', 'amber');
check('macros', 'amber');
