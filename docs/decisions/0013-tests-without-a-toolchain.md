# 0013. Tests that need nothing installed

Date: 2026-09-13 · Status: accepted

**Trigger:** read before renaming a function in `web/app.js`, before adding a
test, and when a harness prints nothing.

## Context

The frontend is a single large file with no module system (0004), and the
machines involved have no npm, no jest and no headless browser by default.

## Decision

Two suites, both run by `./scripts/check.sh`:

- **Rust:** ordinary `#[cfg(test)]` modules beside the code they test.
- **Browser:** `web/tests/*.js` run by JavaScriptCore, which ships with macOS.
  Each harness reads `web/app.js` as text and `eval`s the slice between two
  function names, so it can test pure logic without a DOM.

Pure, testable logic therefore lives in named `function` declarations placed
between stable neighbours, never inside a closure or an event handler.

## Rejected

- **jest, vitest, playwright.** All need npm.
- **Refactoring `web/app.js` into modules.** ES modules would need a bundler to
  keep the no-build-step rule.

## Consequences

**Renaming a function that a harness slices on, or moving one outside its
slice, breaks that harness.** A missing marker makes `indexOf` return -1, the
slice comes out empty, and the first call throws a `ReferenceError`; a suite
that produces no assertion at all also fails `scripts/check.sh`. Either way it
is loud, never a quiet pass. `grep -n "src.indexOf" web/tests/*.js` lists every
marker in use at once.

For anything needing a real browser, drive a headless one over the DevTools
protocol: no install either.
