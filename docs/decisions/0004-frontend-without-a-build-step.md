# 0004. A frontend with no build step

Date: 2026-09-10 · Status: accepted

**Trigger:** read before reaching for a framework, a bundler, npm, or
CodeMirror 6.

## Context

The VM has no npm and no right to install one, and the binary has to contain
the finished frontend (0001). Whatever ships must therefore be the source.

## Decision

`web/` is plain HTML, one CSS file and one JavaScript file wrapped in an IIFE,
plus `web/lineage.js`. Libraries are vendored as files under `web/vendor/`,
listed in `THIRD_PARTY_NOTICES.md`: CodeMirror 5.65.16 with the modes and
addons actually used, xterm.js 5.5.0, and diff-match-patch. State lives in one
object, `S`, and the DOM is built with `document.createElement`.

## Rejected

- **React, Vue, Svelte, Vite.** All need a build, which needs npm.
- **CodeMirror 6.** ES modules designed around a bundler; version 5 is one
  script tag and does everything needed here.
- **Monaco.** Far larger, and awkward to vendor.
- **A CDN for the libraries.** The VM may not reach it, and an offline tool
  should not depend on the network to open.

## Consequences

No JSX, no TypeScript, no tree shaking. Editing `web/app.js` and refreshing the
browser is the whole development loop (0005). The file is long, so pure logic is
kept in named functions that the test harnesses can slice out (0013).
