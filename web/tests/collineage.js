// Column-mode logic: composite ids and the node subtitle.
// Run from the repository root: jsc web/tests/collineage.js
var app = read('web/app.js');
eval(app.slice(app.indexOf('function splitColId'), app.indexOf('/* Column-level lineage')));

var lin = read('web/lineage.js');
eval(lin.slice(lin.indexOf('function subtitle(n)'), lin.indexOf('  function init(')));

function check(label, got, want) {
  print((got === want ? 'PASS  ' : 'FAIL  ') + label + (got === want ? '' : '\n        expected ' + want + '\n        got      ' + got));
}

print('--- composite id ---');
var c = splitColId('model.shop.orders::order_id');
check('node extracted', c.node, 'model.shop.orders');
check('column extracted', c.column, 'order_id');

var m = splitColId('model.shop.orders');
check('model id: node', m.node, 'model.shop.orders');
check('model id: no column', m.column, '');

var src = splitColId('source.shop.crm.customers::customer_id');
check('source (several dots)', src.node, 'source.shop.crm.customers');
check('source: column', src.column, 'customer_id');

// A column name may contain a lone colon; only the first "::" separates.
var odd = splitColId('model.x.y::weird:name');
check('column containing a colon', odd.column, 'weird:name');

print('\n--- node subtitle ---');
check('column mode uses sub',
      subtitle({ sub: 'stg_crm__customers  ·  varchar', kind: 'model', materialized: 'view', schema: 'analytics', tests: 3 }),
      'stg_crm__customers  ·  varchar');
check('model mode without sub',
      subtitle({ sub: '', kind: 'model', materialized: 'incremental', schema: 'analytics', tests: 2 }),
      'incremental  ·  analytics  ·  2 tests');
check('source',
      subtitle({ kind: 'source', materialized: 'source', schema: 'raw', tests: 0 }),
      'source  ·  raw');
check('disabled model',
      subtitle({ kind: 'model', disabled: true, materialized: 'view', schema: 'x', tests: 0 }),
      'disabled  ·  x');
check('a single test is singular',
      subtitle({ kind: 'model', materialized: 'table', schema: 's', tests: 1 }),
      'table  ·  s  ·  1 test');
