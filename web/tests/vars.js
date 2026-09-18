// var() and env_var() calls in a model, and the line that says where a value
// came from. Fixtures are invented.
// Run from the repository root: jsc web/tests/vars.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function maskJinjaComments'), src.indexOf('/* Explicit ref()'))
  + src.slice(src.indexOf('const VAR_RE'), src.indexOf('/* automate_dv declares parents')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}
function scan(text) { return scanVars(maskJinjaComments(text)); }
function found(text) {
  return scan(text).map(function (h) { return h.kind + ':' + h.name + (h.fallback ? '/' + h.fallback : ''); });
}

print('--- the four shapes ---');
check('var with one argument', found("select {{ var('prefix') }}"), ['var:prefix']);
check('var with a default', found("{{ var('days', 7) }}"), ['var:days/7']);
check('env_var with one argument', found("{{ env_var('DBT_WH') }}"), ['env_var:DBT_WH']);
check('env_var with a default', found("{{ env_var('DBT_TS', '1900-01-01') }}"), ["env_var:DBT_TS/'1900-01-01'"]);

print('\n--- quoting and spacing ---');
check('double quotes', found('{{ var("prefix") }}'), ['var:prefix']);
check('a space before the bracket', found("{{ var ('prefix') }}"), ['var:prefix']);
check('space inside the brackets', found("{{ var(  'prefix'  ) }}"), ['var:prefix']);

print('\n--- what must not match ---');
check('a namespaced macro is not dbt var()', found("{{ dbt_utils.var('x') }}"), []);
check('a macro whose name ends in var', found("{{ my_var('x') }}"), []);
check('ref is not a variable', found("{{ ref('orders') }}"), []);
check('source is not a variable', found("{{ source('raw', 'orders') }}"), []);
check('a call inside a jinja comment', found("{# {{ var('gone') }} #}"), []);
check('only the commented one is skipped',
  found("{# {{ var('gone') }} #}\nselect {{ var('kept') }}"), ['var:kept']);

print('\n--- ranges ---');
var text = "select {{ var('prefix') }} from {{ env_var('DBT_WH') }}";
var hits = scan(text);
check('two hits on one line', hits.length, 2);
// The whole call is the hover target: a variable has nothing to click, so a
// range covering only the quoted name is something you have to aim at.
check('the range covers the whole call', text.slice(hits[0].ranges[0][0], hits[0].ranges[0][1]), "var('prefix')");
check('and for the second call', text.slice(hits[1].ranges[0][0], hits[1].ranges[0][1]), "env_var('DBT_WH')");
check('the ranges do not overlap', hits[0].ranges[0][1] <= hits[1].ranges[0][0], true);
check('a call with a default is covered to its closing bracket',
  (function () { var t = "{{ var('days', 7) }}"; var h = scan(t)[0]; return t.slice(h.ranges[0][0], h.ranges[0][1]); })(),
  "var('days', 7)");

print('\n--- offsets survive masked comments and newlines ---');
var multi = "{# a note\n   over two lines #}\nwith x as (\n  select {{ var('prefix') }}\n)";
var one = scan(multi)[0];
check('the call is still found at its real offset', multi.slice(one.ranges[0][0], one.ranges[0][1]), "var('prefix')");

print('\n--- varNote ---');
check('read from the chosen file',
  varNote({ status: 'env', vars: ['DBT_WH'] }, '.env.dev'), 'read from .env.dev');
check('a default is not a file',
  varNote({ status: 'env', default_used: true, vars: ['DBT_TS'] }, '.env.dev'),
  'the default written in the call, not from a file');
check('missing names the file',
  varNote({ status: 'missing', vars: ['DBT_LAG'] }, '.env.dev'), 'DBT_LAG is not set in .env.dev');
check('missing with no environment selected',
  varNote({ status: 'missing', vars: ['DBT_LAG'] }, ''),
  'DBT_LAG needs an environment, and none is selected');
check('a placeholder is called one',
  varNote({ status: 'placeholder', vars: ['DBT_DB'] }, '.env.dev'),
  'DBT_DB is a placeholder in .env.dev, not a real value');
check('unevaluated covers the secret case',
  varNote({ status: 'unevaluated', vars: [] }, '.env.dev'),
  'not evaluated: a secret, or Jinja this does not read');
check('a redacted name never says the value, but does say it is set',
  varNote({ status: 'env', redacted: true, vars: ['SF_PW'] }, '.env.dev'),
  'set in .env.dev, hidden because the name reads as a credential');
check('a redacted and unset name says only that it is hidden',
  varNote({ status: 'missing', redacted: true, vars: ['SF_PW'] }, '.env.dev'),
  'hidden because the name reads as a credential');
check('a plain literal has nothing to add', varNote({ status: 'literal', vars: [] }, ''), '');
