// Search palette: nodes and plain files in one list, without duplicates.
// Run from the repository root: jsc web/tests/palette.js
var src = read('web/app.js');
// A single eval: a `const` declaration does not leak from one eval to the next,
// so `base` has to live in the same scope as `mergeHits`.
eval(src.slice(src.indexOf('const base = (path)'), src.indexOf('const dirOf'))
   + src.slice(src.indexOf('function mergeHits'), src.indexOf('/* One box for everything')));

function check(label, ok) { print((ok ? 'PASS  ' : 'FAIL  ') + label); }

var nodes = [
  { id: 'model.p.stg_x', name: 'stg_x', file: 'models/stg/stg_x.sql' },
  { id: 'source.p.raw.y', name: 'raw.y', file: '' },
];
var paths = [
  'models/stg/stg_x.sql',                                  // already represented by a node
  'tests/generic/data_quality/dq__ldts_monotonic.sql',     // generic test: not a node
  '.env',                                                  // not a node at all
  'macros/project_ops/audit.sql',
];
var out = mergeHits(nodes, paths);

check('nodes come first', out[0].kind === 'node' && out[1].kind === 'node');
check('a model .sql is not listed twice', out.filter(function (h) {
  return h.sub === 'models/stg/stg_x.sql'; }).length === 1);
check('a generic test can be found', out.some(function (h) {
  return h.kind === 'file' && h.label === 'dq__ldts_monotonic.sql'; }));
check('.env can be found', out.some(function (h) { return h.label === '.env'; }));
check('expected total', out.length === 5);
check('a file shows its name, not its path', out[2].label.indexOf('/') === -1);
check('a node without a file hides nothing', mergeHits([{ name: 'n', file: '' }], ['a.sql']).length === 2);
check('no node: files only', mergeHits([], paths).length === 4);
check('no file: nodes only', mergeHits(nodes, []).length === 2);
