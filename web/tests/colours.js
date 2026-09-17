// Node colour: the visual language of the whole tool, so it gets a test.
// Run from the repository root: jsc web/tests/colours.js
var lin = read('web/lineage.js');
eval(lin.slice(lin.indexOf('const MAT = {'), lin.indexOf('let svg, root')));

function check(label, got, want) {
  print((got === want ? 'PASS  ' : 'FAIL  ') + label + (got === want ? '' : '   expected ' + want + ', got ' + got));
}
var distinct = {};
function unique(label, colour) {
  if (distinct[colour] && distinct[colour] !== label) {
    print('FAIL  ' + label + ' shares its colour with ' + distinct[colour]);
  } else { distinct[colour] = label; print('PASS  ' + label + ' has a distinct colour'); }
}

print('--- common materializations ---');
check('view',        matLabel({ kind: 'model', materialized: 'view' }), 'view');
check('table',       matLabel({ kind: 'model', materialized: 'table' }), 'table');
check('incremental', matLabel({ kind: 'model', materialized: 'incremental' }), 'incremental');
check('ephemeral',   matLabel({ kind: 'model', materialized: 'ephemeral' }), 'ephemeral');

['view', 'table', 'incremental', 'ephemeral'].forEach(function (m) {
  unique(m, nodeColor({ kind: 'model', materialized: m }));
});

print('\n--- custom materializations ---');
var custom = nodeColor({ kind: 'model', materialized: 'dynamic_transient' });
check('a custom one does not fall back to neutral grey', custom !== nodeColor({ kind: 'model', materialized: '' }), true);
check('two custom ones share the "custom" colour',
      custom, nodeColor({ kind: 'model', materialized: 'my_own_materialization' }));
check('case is ignored', nodeColor({ kind: 'model', materialized: 'TABLE' }), nodeColor({ kind: 'model', materialized: 'table' }));

print('\n--- other resource types ---');
check('a source ignores its materialization', matLabel({ kind: 'source', materialized: 'source' }), 'source');
unique('source', nodeColor({ kind: 'source' }));
unique('seed', nodeColor({ kind: 'seed' }));
unique('snapshot', nodeColor({ kind: 'snapshot' }));
check('a model without a materialization does not break', typeof nodeColor({ kind: 'model' }), 'string');
check('an empty node does not break', typeof nodeColor({}), 'string');

print('\n--- regression: CSS must not be able to repaint the bar ---');
// A CSS rule always beats an SVG presentation attribute. The colour bar stayed
// invisible for as long as `.nd rect` set a fill.
var css = read('web/app.css');
var offenders = css.split('\n').filter(function (l) {
  return /^\s*\.nd[^{]*rect\s*(\{|,)/.test(l) && /fill\s*:/.test(l) && !/rect\.box/.test(l);
});
check('no unqualified .nd rect rule sets a fill', offenders.length, 0);
if (offenders.length) offenders.forEach(function (o) { print('        ' + o.trim()); });
check('the colour is set as an inline style', /kindbar[^)]*style:\s*`fill:/.test(lin), true);
