// The breadcrumb bar's two halves, both scanned without a DOM: the path split
// into navigable segments, and the outline a cursor line resolves against.
// Run from the repository root: jsc web/tests/breadcrumb.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function modeFor'), src.indexOf('function initEditor')));
eval(src.slice(src.indexOf('function pathCrumbs'), src.indexOf('function renderCrumbs')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}
function labels(nodes) { return nodes.map(function (n) { return n.label; }); }
function chain(nodes, line) {
  return outlineChainAt(nodes, line).map(function (i) { return nodes[i].label; });
}

print('--- path crumbs ---');
var deep = pathCrumbs('models/edp_core/40_prep/claim/pit_claim.yml');
check('one segment per folder and the file', labels(deep.map(function (c) { return { label: c.label }; })),
  ['models', 'edp_core', '40_prep', 'claim', 'pit_claim.yml']);
check('the first segment lists the project root', deep[0].dir, '');
check('a segment lists the folder it sits in', deep[4].dir, 'models/edp_core/40_prep/claim');
check('and knows its own path, to mark itself current', deep[2].path, 'models/edp_core/40_prep');
check('a bare file name is one segment at the root', pathCrumbs('dbt_project.yml'),
  [{ label: 'dbt_project.yml', path: 'dbt_project.yml', dir: '' }]);
check('no file, no crumbs', pathCrumbs(''), []);

print('\n--- yamlIndent ---');
check('counts leading spaces', yamlIndent('    name: a'), 4);
check('no indentation is zero', yamlIndent('models:'), 0);
check('a tab in the indentation is refused', yamlIndent('  \tname: a'), -1);
check('a tab after the content is none of its business', yamlIndent('  name:\ta'), 2);

print('\n--- yamlKey ---');
check('splits on a colon followed by a space', yamlKey('name: pit_claim'), { key: 'name', value: 'pit_claim' });
check('a colon ending the line opens a block', yamlKey('columns:'), { key: 'columns', value: '' });
check('a colon inside a word is not a mapping', yamlKey('a:b'), null);
check('a url splits once, at the right colon', yamlKey('url: http://x/y'), { key: 'url', value: 'http://x/y' });
check('a quoted key keeps its colon', yamlKey('"a: b": c'), { key: 'a: b', value: 'c' });
check('a line with no colon at all', yamlKey('just text'), null);

var SCHEMA = [
  'version: 2',                         // 0
  '',                                   // 1
  'models:',                            // 2
  '  - name: pit_claim',                // 3
  '    config:',                        // 4
  '      contract:',                    // 5
  '        enforced: true',             // 6
  '    data_tests:',                    // 7
  '      - dbt_utils.unique:',          // 8
  '          arguments:',               // 9
  '            columns:',               // 10
  '              - claim_hk',           // 11
  '    columns:',                       // 12
  '      - name: claim_hk',             // 13
  '        data_type: binary',          // 14
  '      - name: as_of_date',           // 15
  '  - name: hub_claim',                // 16
  '    description: |',                 // 17
  '      A hub.',                       // 18
  '      - not a node: really',         // 19
  '    # a comment',                    // 20
  '    tags: [dv]',                     // 21
].join('\n');
var y = yamlOutline(SCHEMA);

print('\n--- yamlOutline ---');
check('a sequence item is labelled by its index, and the key on its line follows',
  chain(y, 3), ['models', '0', 'name']);
check('an inline key nests under its item', chain(y, 6), ['models', '0', 'config', 'contract', 'enforced']);
check('a second item counts on from the first', chain(y, 16), ['models', '1', 'name']);
check('items under a nested key restart at zero', chain(y, 13), ['models', '0', 'columns', '0', 'name']);
check('the second column is index one', chain(y, 15), ['models', '0', 'columns', '1', 'name']);
check('a deeper list keeps its own nesting',
  chain(y, 11), ['models', '0', 'data_tests', '0', 'dbt_utils.unique', 'arguments', 'columns', 'claim_hk']);
check('a block scalar body is text, not structure', chain(y, 19), ['models', '1', 'description']);
// A comment sits inside whatever preceded it: the next node is what closes a
// range, so trailing comments and blank lines attach upwards.
check('a comment line stays inside the node above it', chain(y, 20), ['models', '1', 'description']);
check('a key after a block scalar is read again', chain(y, 21), ['models', '1', 'tags']);
check('nothing contains the first line but itself', chain(y, 0), ['version']);
check('a blank line attaches to the node above it', chain(y, 1), ['version']);
check('nothing at all above the first node', outlineChainAt(yamlOutline('\n\nmodels:'), 0), []);
check('a scalar key never adopts the key below it', chain(y, 14), ['models', '0', 'columns', '0', 'data_type']);

function kindOf(nodes, line, label) {
  var hit = nodes.filter(function (n) { return n.line === line && n.label === label; })[0];
  return hit ? hit.kind : 'missing';
}
check('a key whose children are items is a sequence', kindOf(y, 2, 'models'), 'seq');
check('an item whose children are keys is a mapping', kindOf(y, 3, '0'), 'map');
check('a key with a value of its own is a scalar', kindOf(y, 0, 'version'), 'scalar');

print('\n--- a list of plain strings ---');
var PLAIN = ['satellites:', '  - sat_dual__claim', '  - "sat_cc10__claim"', '  - sat_iris__claim'].join('\n');
var pl = yamlOutline(PLAIN);
check('an item with no key of its own is labelled by its value', labels(pl),
  ['satellites', 'sat_dual__claim', 'sat_cc10__claim', 'sat_iris__claim']);
check('quotes are stripped, once', chain(pl, 2), ['satellites', 'sat_cc10__claim']);
check('and each item ends on its own line', chain(pl, 3), ['satellites', 'sat_iris__claim']);
check('a mapping item keeps its index', chain(y, 15), ['models', '0', 'columns', '1', 'name']);

print('\n--- a sequence at its key\'s own column ---');
var FLUSH = ['models:', '- name: a', '- name: b'].join('\n');
var f = yamlOutline(FLUSH);
check('still nests under the key', chain(f, 2), ['models', '1', 'name']);

print('\n--- outlineSiblings ---');
var cols = outlineChainAt(y, 15);
var col1 = cols[cols.length - 2];               // the item, not the name under it
check('the columns of a model are each other\'s siblings',
  outlineSiblings(y, col1).map(function (i) { return y[i].label; }), ['0', '1']);

print('\n--- crumbIcon ---');
check('mapping', crumbIcon('map'), '{ }');
check('sequence', crumbIcon('seq'), '[ ]');
check('heading', crumbIcon('heading'), '#');
check('anything else', crumbIcon('scalar'), 'abc');

print('\n--- markdown headings ---');
var MD = [
  '# Title',            // 0
  'text',               // 1
  '## One',             // 2
  '```',                // 3
  '# not a heading',    // 4
  '```',                // 5
  '### Deep',           // 6
  '#no space',          // 7
  '## Two',             // 8
].join('\n');
var m = mdOutline(MD);
check('headings only', labels(m), ['Title', 'One', 'Deep', 'Two']);
check('a heading nests under the level above it', chain(m, 6), ['Title', 'One', 'Deep']);
check('a sibling closes the one before it', chain(m, 8), ['Title', 'Two']);
check('a hash inside a fence is text', chain(m, 4), ['Title', 'One']);

print('\n--- documentOutline dispatches on the file name ---');
check('a properties file is scanned', documentOutline('models/a.yml', SCHEMA).length > 0, true);
check('so is .yaml', documentOutline('models/a.yaml', SCHEMA).length > 0, true);
check('markdown too', labels(documentOutline('README.md', MD)), ['Title', 'One', 'Deep', 'Two']);
check('sql has no outline yet, and says so with an empty one',
  documentOutline('models/a.sql', 'with x as (select 1)\nselect * from x'), []);
check('an unknown extension likewise', documentOutline('a.txt', 'anything'), []);
