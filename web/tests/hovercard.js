// Where the hover card lands next to what it describes: below by preference,
// above when there is no room, clamped rather than clipped when neither fits.
// Run from the repository root: jsc web/tests/hovercard.js
var src = read('web/app.js');
eval(src.slice(src.indexOf('function placeFloating'), src.indexOf('function hoverCardBody')));

function check(label, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  print((g === w ? 'PASS  ' : 'FAIL  ') + label + (g === w ? '' : '\n        expected ' + w + '\n        got      ' + g));
}
function atRect(left, top, width, height) {
  return { left: left, top: top, right: left + width, bottom: top + height };
}
var VIEW = { width: 1200, height: 800 };
var CARD = { width: 320, height: 200 };

print('--- room below ---');
var below = placeFloating(atRect(100, 100, 200, 48), CARD, VIEW);
check('sits under the anchor, one gap down', below.top, 156);
check('aligned on the anchor left edge', below.left, 100);
check('not flagged as flipped', below.above, false);

print('\n--- no room below, room above ---');
var flipped = placeFloating(atRect(100, 700, 200, 48), CARD, VIEW);
check('flips above the anchor', flipped.top, 492);
check('flagged as flipped', flipped.above, true);

print('\n--- no room either way ---');
var tight = placeFloating(atRect(10, 60, 200, 700), CARD, { width: 1200, height: 780 });
check('clamped into the viewport', tight.top, 576);
check('never flagged as flipped when clamped', tight.above, false);
check('stays on screen', tight.top >= 4 && tight.top + CARD.height <= 780, true);

print('\n--- a card taller than the viewport still starts on screen ---');
var tall = placeFloating(atRect(10, 10, 200, 20), { width: 320, height: 900 }, VIEW);
check('top is never negative', tall.top, 4);

print('\n--- horizontal clamping ---');
check('clamped at the right edge', placeFloating(atRect(1150, 100, 40, 20), CARD, VIEW).left, 876);
check('anchor off screen left pins to the margin', placeFloating(atRect(-300, 100, 40, 20), CARD, VIEW).left, 4);
check('a card wider than the viewport pins left, never negative',
  placeFloating(atRect(600, 100, 40, 20), { width: 1400, height: 100 }, VIEW).left, 4);

print('\n--- degenerate anchors ---');
var zero = placeFloating(atRect(500, 300, 0, 0), CARD, VIEW);
check('a zero-sized anchor still places below it', zero.top, 308);
check('and keeps its left', zero.left, 500);

print('\n--- the gap is a parameter ---');
check('a wider gap pushes the card further down', placeFloating(atRect(100, 100, 200, 48), CARD, VIEW, 20).top, 168);
