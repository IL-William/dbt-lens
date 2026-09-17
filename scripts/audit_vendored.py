#!/usr/bin/env python3
"""The vendored frontend libraries against the OSV database.

cargo audit and Dependabot read Cargo.lock and the workflows, never web/vendor/,
so this is the only thing that looks there. Each library is asked about twice,
as an npm package and as a tag of its git repository, because advisories are
filed either way: CVE-2025-6493 is recorded against CodeMirror's commits, and
an npm query never finds it.

A clean run means OSV maps nothing to these versions, not that there is nothing.
OSV lists CVE-2025-6493 up to CodeMirror 5.65.20, yet 5.65.21 still carries it:
its markdown.js is byte-identical. SECURITY.md is where accepted issues live.

Standard library only. Exit 0 when clean, 1 on an advisory not accepted or a
version that disagrees with THIRD_PARTY_NOTICES.md, 2 when OSV cannot be reached.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# What web/vendor/ holds. Bump a version here, in THIRD_PARTY_NOTICES.md and in
# the file itself together: the checks below fail when they disagree.
LIBRARIES = [
    {
        "name": "CodeMirror",
        "version": "5.65.21",
        "npm": "codemirror",
        "git": "https://github.com/codemirror/codemirror5",
        # The one vendored file that states its own version.
        "declared_in": ("web/vendor/codemirror.js", 'CodeMirror.version = "5.65.21"'),
    },
    {
        "name": "xterm.js",
        "version": "5.5.0",
        "npm": "@xterm/xterm",
        "git": "https://github.com/xtermjs/xterm.js",
    },
    {
        "name": "@xterm/addon-fit",
        "version": "0.10.0",
        "npm": "@xterm/addon-fit",
    },
    {
        # Copied from the upstream javascript/ build, which has no release: every
        # advisory ever filed against the repository is reported.
        "name": "diff-match-patch",
        "version": None,
        "git": "https://github.com/google/diff-match-patch",
    },
]

# Advisories judged acceptable, each explained in SECURITY.md under Known issues.
ACCEPTED = {"CVE-2025-6493"}


def osv(query):
    req = urllib.request.Request(
        "https://api.osv.dev/v1/query",
        data=json.dumps(query).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res).get("vulns", [])


def queries(lib):
    version = {"version": lib["version"]} if lib["version"] else {}
    if lib.get("npm"):
        yield f"npm {lib['npm']}", {**version, "package": {"name": lib["npm"], "ecosystem": "npm"}}
    if lib.get("git"):
        yield f"git {lib['git']}", {**version, "package": {"name": lib["git"], "ecosystem": "GIT"}}


def main():
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text()
    security = (ROOT / "SECURITY.md").read_text()
    failed = 0

    for cve in sorted(ACCEPTED):
        if cve not in security:
            print(f"FAILED  {cve} is accepted here but not explained in SECURITY.md")
            failed += 1

    for lib in LIBRARIES:
        label = f"{lib['name']} {lib['version'] or '(unversioned)'}"
        problems = []
        if lib["version"] and lib["version"] not in notices:
            problems.append("THIRD_PARTY_NOTICES.md names another version")
        if "declared_in" in lib:
            path, needle = lib["declared_in"]
            if needle not in (ROOT / path).read_text():
                problems.append(f"{path} does not declare this version")

        # The same advisory can come back from both queries under two ids, a CVE
        # from one and its GHSA from the other: merged when their names overlap.
        found = []
        for source, query in queries(lib):
            try:
                vulns = osv(query)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                print(f"cannot reach OSV ({e}), nothing was checked")
                return 2
            for vuln in vulns:
                names = {vuln["id"], *vuln.get("aliases", [])}
                same = next((f for f in found if f["names"] & names), None)
                if same:
                    same["names"] |= names
                else:
                    summary = (vuln.get("summary") or vuln.get("details") or "").strip()
                    found.append({"names": names, "source": source, "summary": summary.splitlines()[0][:100]})

        for f in found:
            names = ", ".join(sorted(f["names"]))
            if f["names"] & ACCEPTED:
                print(f"known   {label}: {names}, accepted in SECURITY.md")
            else:
                problems.append(f"{names} via {f['source']}: {f['summary']}")

        for problem in problems:
            print(f"FAILED  {label}: {problem}")
        if not found and not problems:
            print(f"ok      {label}")
        failed += len(problems)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
