// Catalog location rows: config as written, resolved, and where it was built.
// Fixtures mirror real manifest shapes with invented names.
// Run from the repository root: jsc web/tests/location.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function locationRows'), src.indexOf('function catalogLocation')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}
function row(rows, key) { return rows.filter(function (r) { return r.key === key; })[0]; }

print('--- model redirected into a developer sandbox ---');
var model = locationRows({
  written:  { database: "{{ env_var('DBT_DB_ANALYTICS') }}", schema: 'marts', alias: '' },
  resolved: { database: 'ANALYTICS_PROD', schema: 'marts', alias: '' },
  built:    { database: 'dev_db', schema: 'dbt_jdoe', alias: 'orders' },
});
check('three rows', model.map(function (r) { return r.key; }), ['database', 'schema', 'alias']);
check('an env_var database is flagged as templated', row(model, 'database').templated, true);
check('a plain schema is not templated', row(model, 'schema').templated, false);
check('database built elsewhere is redirected', row(model, 'database').redirected, true);
check('schema built elsewhere is redirected', row(model, 'schema').redirected, true);
check('an unset alias defaulting to the name is not a redirect', row(model, 'alias').redirected, false);

print('\n--- case alone is not a move ---');
var folded = locationRows({
  written:  { database: "{{ env_var('DBT_DB') }}", schema: 'staging', alias: '' },
  resolved: { database: 'DEV_DB', schema: 'staging', alias: '' },
  built:    { database: 'dev_db', schema: 'staging', alias: 'stg_orders' },
});
check('DEV_DB built as dev_db is the same place', row(folded, 'database').redirected, false);
check('identical schema is not redirected', row(folded, 'schema').redirected, false);

print('\n--- source ---');
var source = locationRows({
  written:  { database: "{{ env_var('DBT_DB_RAW') }}", schema: 'crm', alias: '' },
  resolved: { database: 'RAW_DB', schema: 'crm', alias: 'customers' },
  built:    { database: 'RAW_DB', schema: 'crm', alias: 'customers' },
});
check('a source is never redirected', source.some(function (r) { return r.redirected; }), false);
check('its identifier shows as the alias', row(source, 'alias').built, 'customers');

print('\n--- current payload shape uses "parsed" ---');
var current = locationRows({
  written: { database: "{{ env_var('DBT_DB_MART') }}", schema: 'marts', alias: '' },
  parsed:  { database: 'MART_CI', schema: 'marts', alias: '' },
  built:   { database: 'dev_db', schema: 'dbt_jdoe', alias: 'orders' },
});
check('parsed is read', row(current, 'database').parsed, 'MART_CI');
check('without an env, resolved is the parsed value', row(current, 'database').resolved, 'MART_CI');
check('without an env there is no status', row(current, 'database').status, '');

print('\n--- literal quotes dropped by dbt are not a move ---');
var quoted = locationRows({
  written: { database: '"{{ env_var(\'DBT_DB_RAW\') }}"', schema: 'raw', alias: '' },
  parsed:  { database: '"RAW_DB"', schema: 'raw', alias: '' },
  built:   { database: 'raw_db', schema: 'raw', alias: 'events' },
});
check('"RAW_DB" built as raw_db is the same place', row(quoted, 'database').redirected, false);
check('sameIdent strips one pair of quotes', sameIdent('"A_B"', 'a_b'), true);
check('sameIdent keeps distinct names distinct', sameIdent('A_B', 'A_C'), false);
check('sameIdent does not strip a lone quote', sameIdent('"A', 'a'), false);

print('\n--- templating ---');
var branchy = locationRows({
  written: { database: "{%- if var('p') -%} RAW {%- else -%} other {%- endif -%}", schema: 's', alias: '' },
  parsed:  { database: 'RAW', schema: 's', alias: '' },
  built:   { database: 'RAW', schema: 's', alias: 't' },
});
check('a pure {% %} block counts as templated', row(branchy, 'database').templated, true);

print('\n--- selecting an environment ---');
var withEnvs = {
  written: { database: "{{ env_var('DBT_DB_MART') }}", schema: 'marts', alias: '' },
  parsed:  { database: 'MART_CI', schema: 'marts', alias: '' },
  built:   { database: 'MART_CI', schema: 'marts', alias: 'orders' },
  envs: {
    '.env.uat': {
      place:  { database: 'MART_UAT', schema: 'marts', alias: '' },
      status: { database: { kind: 'env', vars: ['DBT_DB_MART'] }, schema: { kind: 'literal' }, alias: { kind: 'literal' } },
    },
  },
};
var uat = locationRows(withEnvs, '.env.uat');
check('resolved comes from the chosen file', row(uat, 'database').resolved, 'MART_UAT');
check('parsed is still the manifest value', row(uat, 'database').parsed, 'MART_CI');
check('status and vars are carried', [row(uat, 'database').status, row(uat, 'database').vars], ['env', ['DBT_DB_MART']]);
check('UAT differing from built is NOT a move: parsed equals built', row(uat, 'database').redirected, false);

var sandboxed = JSON.parse(JSON.stringify(withEnvs));
sandboxed.built.database = 'dev_db';
check('parsed differing from built is a move in manifest mode', row(locationRows(sandboxed), 'database').redirected, true);
check('...and exactly the same move with an env selected', row(locationRows(sandboxed, '.env.uat'), 'database').redirected, true);
check('an unknown env file falls back to manifest mode', row(locationRows(withEnvs, '.env.nope'), 'database').resolved, 'MART_CI');

print('\n--- resolved cell per status ---');
function cellFor(status, resolved, vars, branch) {
  return resolvedCell({ status: status, resolved: resolved, vars: vars || [], branch: !!branch }, 'UAT', '.env.uat');
}
var miss = cellFor('missing', '', ['DBT_DB_MART']);
check('missing names the variable', [miss.text, miss.cls], ['missing DBT_DB_MART', 'env-missing']);
check('missing tooltip names the file', miss.title, 'DBT_DB_MART is not defined in .env.uat');
check('missing lists several variables', cellFor('missing', '', ['A', 'B']).text, 'missing A, B');
var ph = cellFor('placeholder', 'N/A', ['DBT_DB_RAW']);
check('placeholder keeps the value and says so', [ph.text, ph.cls], ['N/A (placeholder)', 'env-placeholder']);
check('an empty placeholder reads as empty', cellFor('placeholder', '', ['X']).text, 'empty (placeholder)');
check('env shows the value with its source', [cellFor('env', 'MART_UAT', ['DBT_DB_MART']).text, cellFor('env', 'MART_UAT', ['DBT_DB_MART']).title],
      ['MART_UAT', 'DBT_DB_MART from .env.uat']);
check('a branch adds a note', cellFor('env', 'RAW_UAT', ['DBT_DB_RAW'], true).title.indexOf('branch dbt took') > 0, true);
check('unevaluated without a value says so', [cellFor('unevaluated', '').text, cellFor('unevaluated', '').cls],
      ['not evaluated', 'env-unevaluated']);
check('an empty literal reads as default', [cellFor('literal', '').text, cellFor('literal', '').cls], ['default', 'nul']);
check('manifest mode shows the parsed value', resolvedCell({ status: '', resolved: 'MART_CI', vars: [], branch: false }, '', '').text, 'MART_CI');

print('\n--- relation to copy for the resolved column ---');
check('unquoted parts', splitRelation('db.sch.tbl'), [
  { name: 'db', quoted: false }, { name: 'sch', quoted: false }, { name: 'tbl', quoted: false }]);
check('quoted parts, a dot and a doubled quote inside', splitRelation('"DB"."a.b"."x""y"'), [
  { name: 'DB', quoted: true }, { name: 'a.b', quoted: true }, { name: 'x"y', quoted: true }]);

check('UAT relation, unset alias taken from the built one', resolvedRelation(uat, 'MART_CI.marts.orders', '.env.uat'),
      { text: 'MART_UAT.marts.orders', reason: '' });
check('manifest mode uses the parsed values', resolvedRelation(locationRows(withEnvs), 'MART_CI.marts.orders', '').text,
      'MART_CI.marts.orders');

var quotedSource = locationRows({
  written: { database: "{{ env_var('DBT_DB_RAW') }}", schema: 'crm', alias: '' },
  parsed:  { database: 'RAW_CI', schema: 'crm', alias: 'Customers' },
  built:   { database: 'RAW_CI', schema: 'crm', alias: 'Customers' },
  envs: {
    '.env.dev': {
      place:  { database: 'RAW_DEV', schema: 'crm', alias: 'Customers' },
      status: { database: { kind: 'env', vars: ['DBT_DB_RAW'] }, schema: { kind: 'literal' }, alias: { kind: 'parsed' } },
    },
  },
}, '.env.dev');
check('a quoted built relation keeps its quoting, case preserved',
      resolvedRelation(quotedSource, '"RAW_CI"."crm"."Customers"', '.env.dev').text, '"RAW_DEV"."crm"."Customers"');

function envRows(database, status, vars) {
  return locationRows({
    written: { database: "{{ env_var('DBT_DB_MART') }}", schema: 'marts', alias: '' },
    parsed:  { database: 'MART_CI', schema: 'marts', alias: '' },
    built:   { database: 'MART_CI', schema: 'marts', alias: 'orders' },
    envs: { '.env.qa': {
      place:  { database: database, schema: 'marts', alias: '' },
      status: { database: { kind: status, vars: vars }, schema: { kind: 'literal' }, alias: { kind: 'literal' } },
    } },
  }, '.env.qa');
}
check('a missing variable gives no relation, and says why',
      resolvedRelation(envRows('', 'missing', ['DBT_DB_MART']), 'MART_CI.marts.orders', '.env.qa'),
      { text: '', reason: 'DBT_DB_MART is not defined in .env.qa' });
check('a placeholder gives no relation',
      resolvedRelation(envRows('N/A', 'placeholder', ['DBT_DB_MART']), 'MART_CI.marts.orders', '.env.qa').text, '');
check('unevaluated Jinja gives no relation',
      resolvedRelation(envRows('', 'unevaluated', []), 'MART_CI.marts.orders', '.env.qa').reason,
      'database contains Jinja that dbt-lens does not evaluate');
var noDatabase = locationRows({
  written: { database: '', schema: 'marts', alias: '' },
  parsed:  { database: '', schema: 'marts', alias: '' },
  built:   { database: 'dev_db', schema: 'marts', alias: 'orders' },
});
check('a database left to the target profile gives no relation',
      resolvedRelation(noDatabase, 'dev_db.marts.orders', '').reason.indexOf('target profile') > 0, true);

print('\n--- environment colours ---');
var toneSrc = read('web/app.js');
eval(toneSrc.slice(toneSrc.indexOf('function envTone'), toneSrc.indexOf('function envDisplayName')));
check('names map to their family',
      ['DEV', 'LOCAL', 'CI', 'QA', 'STG', 'UAT', 'PROD', 'PRD'].map(envTone),
      ['dev', 'dev', 'ci', 'qa', 'stg', 'uat', 'prod', 'prod']);
check('pre-production is not production', ['PREPROD', 'PRE-PROD', 'pre_prod'].map(envTone), ['uat', 'uat', 'uat']);
check('whole words only, digits ignored', ['DEV2', 'DEVOPS', 'CIRCLE', 'my-qa'].map(envTone), ['dev', 'other', 'other', 'qa']);
check('no name is manifest mode', envTone(''), 'manifest');

print('\n--- degenerate input ---');
check('no location gives no rows', locationRows(null), []);
check('an entirely empty key is dropped', locationRows({
  written:  { database: 'a', schema: 'b', alias: '' },
  resolved: { database: 'a', schema: 'b', alias: '' },
  built:    { database: 'a', schema: 'b', alias: '' },
}).length, 2);
