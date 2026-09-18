// What a search result says, and where the match falls inside a line.
// Run from the repository root: jsc web/tests/grep.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function splitMatch'), src.indexOf('let grepTimer')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}

print('--- splitMatch ---');
check('splits around the match', splitMatch('select brokercode from t', 'brokercode'),
  ['select ', 'brokercode', ' from t']);
check('the match keeps the line\'s own case', splitMatch('select BrokerCode from t', 'brokercode'),
  ['select ', 'BrokerCode', ' from t']);
check('a query in another case still matches', splitMatch('select brokercode', 'BROKERCODE'),
  ['select ', 'brokercode', '']);
check('at the very start', splitMatch('brokercode, x', 'brokercode'), ['', 'brokercode', ', x']);
check('no match leaves the text whole', splitMatch('select 1', 'nope'), ['select 1', '', '']);
check('an empty query leaves the text whole', splitMatch('select 1', ''), ['select 1', '', '']);

print('\n--- grepSummary ---');
check('nothing typed says nothing', grepSummary(null, ''), '');
check('too short asks for more', grepSummary(null, 'br'), 'three letters or more');
check('waiting says so', grepSummary(null, 'broker'), 'searching…');
check('no match names the query', grepSummary({ files: [], total: 0 }, 'broker'), 'no match for "broker"');
check('one match is singular',
  grepSummary({ files: [{ path: 'a.sql', hits: [{}] }], total: 1 }, 'broker'),
  '1 match in 1 file');
check('several are plural',
  grepSummary({ files: [{ path: 'a.sql' }, { path: 'b.sql' }], total: 29 }, 'broker'),
  '29 matches in 2 files');
check('a capped search says it is partial',
  grepSummary({ files: [{ path: 'a.sql' }], total: 5, capped: true }, 'broker'),
  '5 matches in 1 file · showing the first found');
check('skipped files are reported, not hidden',
  grepSummary({ files: [{ path: 'a.sql' }], total: 5, skipped: 17 }, 'broker'),
  '5 matches in 1 file · 17 files skipped');
