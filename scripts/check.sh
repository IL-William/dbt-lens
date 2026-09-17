#!/usr/bin/env bash
# Everything that has to pass before a change is done: Rust tests, the browser
# harnesses, and a syntax check on the frontend the harnesses cannot catch.
#
# JavaScriptCore ships with macOS. Elsewhere, set JSC to a JavaScript shell
# (jsc, d8, node) or accept that the browser half is skipped.
set -uo pipefail
cd "$(dirname "$0")/.."

JSC=${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc}
failed=0
pass=0

echo "== cargo test =="
if cargo test --quiet; then
  echo "rust ok"
else
  echo "RUST FAILED"
  failed=$((failed + 1))
fi

echo
echo "== cargo audit =="
# The lockfile against the RustSec advisory database. Optional here, like jsc,
# because it needs a crate installed and the network; CI runs it every time.
if cargo audit --version > /dev/null 2>&1; then
  if cargo audit --quiet; then
    echo "audit ok"
  else
    echo "AUDIT FAILED"
    failed=$((failed + 1))
  fi
else
  echo "SKIPPED: no cargo-audit. Install it with: cargo install cargo-audit --locked"
fi

echo
echo "== browser tests =="
if [ ! -x "$JSC" ] && ! command -v "$JSC" > /dev/null 2>&1; then
  echo "SKIPPED: no JavaScript shell at $JSC. Set JSC to one to run these."
else
  # A harness slices web/app.js between two function names. A rename that breaks
  # a slice shows up here as an error, not as a quietly empty test file.
  for t in web/tests/*.js; do
    out=$("$JSC" "$t" 2>&1)
    n=$(printf '%s\n' "$out" | grep -c '^PASS' || true)
    bad=$(printf '%s\n' "$out" | grep -c 'FAIL' || true)
    if [ "$bad" -gt 0 ] || [ "$n" -eq 0 ]; then
      echo "FAILED  $t"
      printf '%s\n' "$out" | grep -v '^PASS' | head -20
      failed=$((failed + 1))
    else
      echo "ok      $t ($n)"
      pass=$((pass + n))
    fi
  done

  echo
  echo "== web/app.js parses =="
  syntax=$(mktemp)
  cat > "$syntax" <<'EOF'
try { new Function(read('web/app.js')); print('ok'); }
catch (e) { print('SYNTAX ERROR ' + e); }
EOF
  if [ "$("$JSC" "$syntax")" = "ok" ]; then
    echo "ok      web/app.js"
  else
    "$JSC" "$syntax"
    failed=$((failed + 1))
  fi
  rm -f "$syntax"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "all good: $pass browser assertions, plus the Rust suite"
else
  echo "$failed check(s) failed"
fi
exit $((failed > 0))
