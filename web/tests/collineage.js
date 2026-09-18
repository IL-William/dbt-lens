// Column-mode logic: composite ids and the node subtitle.
// Run from the repository root: jsc web/tests/collineage.js
var app = read('web/app.js');
eval(app.slice(app.indexOf('function splitColId'), app.indexOf('/* Column-level lineage')));

eval(app.slice(app.indexOf('function sidecarLabel'), app.indexOf('function sidecarSwitch')));
eval(app.slice(app.indexOf('function connectionAdvice'), app.indexOf('function profileLink')));

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

print('\n--- Snowflake lineage switch ---');
check('no payload reads as off', sidecarLabel(null).text, 'Snowflake lineage: off');
check('off explains that nothing connects before a click',
      sidecarLabel({ enabled: false, state: 'off' }).title.indexOf('nothing connects before the first click') > 0, true);
var ready = sidecarLabel({ enabled: true, state: 'ready', profile: 'shop', target: 'dev', role: 'transformer',
                           python: '/work/shop/.venv/bin/python' });
check('ready is on', ready.text + ' / ' + ready.tone, 'Snowflake lineage: on / on');
check('ready names the connection and the Python that runs',
      ready.title, 'Click a column to fetch its lineage (profile shop, target dev, role transformer).\nPython: /work/shop/.venv/bin/python');
var failed = sidecarLabel({ enabled: true, state: 'failed', error: 'no profiles.yml at /home/me/.dbt/profiles.yml',
                            log: ['Traceback (most recent call last):', 'sf_lineage: no profiles.yml at /home/me/.dbt/profiles.yml'] });
check('failed is its own tone', failed.tone, 'failed');
check('failed shows the error first, then the last lines of the script',
      failed.title, 'no profiles.yml at /home/me/.dbt/profiles.yml\nTraceback (most recent call last):\nsf_lineage: no profiles.yml at /home/me/.dbt/profiles.yml');
check('switched on but not started yet still reads as on',
      sidecarLabel({ enabled: true, state: 'off' }).text, 'Snowflake lineage: on');

print('\n--- what the Columns tab says beside the switch ---');
check('off says nothing: the switch already does', columnsHint({ enabled: false, state: 'off' }, false), null);
check('on with nothing fetched yet tells you what to do',
      columnsHint({ enabled: true, state: 'ready' }, false).text, 'click a column to fetch its lineage from Snowflake');
check('on with lineage already there stays quiet', columnsHint({ enabled: true, state: 'ready' }, true), null);
check('a failed script shows its own message, not a tooltip',
      columnsHint({ enabled: true, state: 'failed', error: 'no profiles.yml at /home/me/.dbt/profiles.yml' }, false).text,
      'no profiles.yml at /home/me/.dbt/profiles.yml');
check('a failed script with no message still says something',
      columnsHint({ enabled: true, state: 'failed', error: '' }, false).text, 'the Snowflake script could not start');
check('waiting on Snowflake says so', columnsHint({ enabled: true, state: 'busy' }, true).tone, 'busy');

print('\n--- what a failed click says ---');
var refused = connectionAdvice('251005: User is empty, but it must be provided', 'connect', '/Users/me/.dbt/profiles.yml');
check('a refused connection quotes Snowflake and points at the profile',
      refused.text + ' | ' + refused.ask + ' | ' + refused.file,
      'Snowflake refused the connection: 251005: User is empty, but it must be provided'
      + ' | check the user and account in | /Users/me/.dbt/profiles.yml');
check('a refused connection with no profile known says nothing about a file',
      connectionAdvice('could not connect', 'connect', '').file, undefined);
check('a query Snowflake rejected is not the profile\'s fault',
      connectionAdvice('Object does not exist', 'query', '/Users/me/.dbt/profiles.yml').file, undefined);
check('...and reads as itself', connectionAdvice('Object does not exist', 'query', '').text,
      'Snowflake: Object does not exist');
check('a request this build got wrong points nowhere',
      connectionAdvice('depth must be a whole number', 'request', '/Users/me/.dbt/profiles.yml').file, undefined);
