// Conflict block detection. A mistake here would corrupt a file being resolved.
// Run from the repository root: jsc web/tests/conflicts.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function findConflicts'), src.indexOf('function decorateConflicts')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}

var simple = [
  'select', '<<<<<<< HEAD', '  a', '=======', '  b', '>>>>>>> feature/x', 'from t'
].join('\n');
check('a single block', findConflicts(simple), [{ start: 1, mid: 3, end: 5 }]);

var two = [
  '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> x',
  'middle',
  '<<<<<<< HEAD', 'c', '=======', 'd', '>>>>>>> x'
].join('\n');
check('two blocks', findConflicts(two), [{ start: 0, mid: 2, end: 4 }, { start: 6, mid: 8, end: 10 }]);

check('no marker', findConflicts('select 1\nfrom t'), []);

// Half a block must be ignored, and above all not half resolved.
check('opening without closing', findConflicts('<<<<<<< HEAD\na\n=======\nb'), []);
check('closing alone', findConflicts('>>>>>>> x'), []);
check('separator before opening', findConflicts('=======\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x'),
      [{ start: 1, mid: 3, end: 5 }]);

// An extra "=======" inside a block must not move its middle.
check('duplicate separator', findConflicts('<<<<<<< HEAD\na\n=======\nb\n=======\nc\n>>>>>>> x'),
      [{ start: 0, mid: 2, end: 6 }]);

// A SQL line that looks like a marker but is not one.
check('ordinary dashed line', findConflicts('-- =======================\nselect 1'), []);
