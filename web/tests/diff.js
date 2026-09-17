// Overview ruler geometry: a mark must never escape the bar.
// Run from the repository root: jsc web/tests/diff.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function rulerMark'), src.indexOf('function decorateDiff')));

function check(label, ok) { print((ok ? 'PASS  ' : 'FAIL  ') + label); }
function inBar(m) { return m.top >= 0 && m.height > 0 && m.top + m.height <= 100.0001; }

var cases = [
  ['addition in the middle',       { editFrom: 50, editTo: 60, origFrom: 50, origTo: 50 }, 100, 'add'],
  ['pure deletion',                { editFrom: 20, editTo: 20, origFrom: 20, origTo: 30 }, 100, 'del'],
  ['chunk at the very end',        { editFrom: 99, editTo: 100, origFrom: 99, origTo: 99 }, 100, 'add'],
  ['chunk longer than the file',   { editFrom: 0, editTo: 500, origFrom: 0, origTo: 0 }, 100, 'add'],
  ['single-line file',             { editFrom: 0, editTo: 1, origFrom: 0, origTo: 0 }, 1, 'add'],
];
cases.forEach(function (c) {
  var m = rulerMark(c[1], c[2]);
  check(c[0] + ' stays inside the bar', inBar(m));
  check(c[0] + ' is of kind ' + c[3], m.kind === c[3]);
});

check('a zero total does not divide by zero', inBar(rulerMark({ editFrom: 0, editTo: 0 }, 0)));
check('a deletion stays visible', rulerMark({ editFrom: 5, editTo: 5 }, 1000).height >= 0.5);

print('\n--- regression: the diff panes must be able to scroll ---');
// height:100% on the editor does nothing if its parent pane has no definite
// height: CodeMirror then sizes itself to its content and nothing scrolls.
// These three rules form the chain.
var css = read('web/app.css');
[['.mergepane .CodeMirror-merge ', 'the merge container'],
 ['.mergepane .CodeMirror-merge-pane', 'the panes'],
 ['.mergepane .CodeMirror-merge .CodeMirror ', 'the editor']].forEach(function (r) {
  var i = css.indexOf(r[0]);
  var rule = i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  check(r[1] + ' has a definite height', /height:\s*100%/.test(rule));
});
check('the container does not overflow because of its border',
      /\.mergepane \.CodeMirror-merge \{[^}]*box-sizing:\s*border-box/.test(css));
