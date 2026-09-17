#!/usr/bin/env python3
"""Snowflake column-level lineage for dbt-lens.

dbt-lens is a single static binary with no HTTP client, no TLS and no credential
handling, and it has to stay that way to keep cross-compiling to one dependency
free .exe. So this script owns the Snowflake connection, and dbt-lens talks to it
over a pipe.

It reads the dbt profile, so SSO, key-pair and password targets all work without
anything specific here.

    probe   check what this role is actually allowed to read
    serve   answer JSON Lines requests on stdin, one per line
    dump    warm the cache for a set of models

Column lineage comes from SNOWFLAKE.CORE.GET_LINEAGE with the COLUMN domain,
which takes one column per call. A whole project is hundreds of thousands of
calls, so `serve` is the normal mode and `dump` is always scoped.
"""

import argparse
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

CACHE_VERSION = 1


# --------------------------------------------------------------- profile ----
def load_profile(profile: str, target: str | None, profiles_dir: str | None):
    """Returns the connection kwargs for a dbt target, secrets included but never logged."""
    try:
        import yaml
    except ImportError:
        die("PyYAML is not installed in this interpreter: pip install pyyaml")

    base = Path(profiles_dir or os.environ.get("DBT_PROFILES_DIR") or Path.home() / ".dbt")
    path = base / "profiles.yml"
    if not path.exists():
        die(f"no profiles.yml at {path}")

    doc = yaml.safe_load(path.read_text()) or {}
    if profile not in doc:
        die(f"profile {profile!r} not in {path} (found: {', '.join(k for k in doc if k != 'config')})")
    block = doc[profile]
    target = target or block.get("target")
    outputs = block.get("outputs", {})
    if target not in outputs:
        die(f"target {target!r} not in profile {profile!r} (found: {', '.join(outputs)})")

    cfg = dict(outputs[target])
    if cfg.get("type") != "snowflake":
        die(f"target {target!r} is type {cfg.get('type')!r}, not snowflake")

    kwargs = {
        "account": cfg["account"],
        "user": cfg.get("user"),
        "role": cfg.get("role"),
        "warehouse": cfg.get("warehouse"),
        "database": cfg.get("database"),
        "schema": cfg.get("schema"),
        # One browser prompt per machine rather than one per process.
        "client_store_temporary_credential": True,
        "application": "dbt_lens",
    }
    if cfg.get("authenticator"):
        kwargs["authenticator"] = cfg["authenticator"]
    if cfg.get("password"):
        kwargs["password"] = cfg["password"]
    if cfg.get("private_key_path"):
        kwargs["private_key_file"] = cfg["private_key_path"]
        if cfg.get("private_key_passphrase"):
            kwargs["private_key_file_pwd"] = cfg["private_key_passphrase"]
    return {k: v for k, v in kwargs.items() if v is not None}, target


def connect(kwargs):
    try:
        import snowflake.connector
    except ImportError:
        die("snowflake-connector-python is not installed in this interpreter")
    import logging

    # The connector is chatty on stdout in some paths; stdout is the protocol.
    logging.getLogger("snowflake").setLevel(logging.ERROR)
    return snowflake.connector.connect(**kwargs)


def profile_from_project():
    """The profile named by the dbt project in the working directory, if any."""
    path = Path("dbt_project.yml")
    if not path.exists():
        return None
    try:
        import yaml
        return (yaml.safe_load(path.read_text()) or {}).get("profile")
    except Exception:  # noqa: BLE001 - an unreadable project just means no default
        return None


def die(msg: str, code: int = 2):
    print(f"sf_lineage: {msg}", file=sys.stderr)
    sys.exit(code)


# --------------------------------------------------------------- queries ----
def column_lineage(cur, relation: str, column: str, direction: str, distance: int):
    """One GET_LINEAGE call for one column. Returns raw rows."""
    sql = (
        "select distance, "
        "source_object_database, source_object_schema, source_object_name, source_column_name, "
        "target_object_database, target_object_schema, target_object_name, target_column_name, "
        "source_object_domain, target_object_domain "
        "from table(snowflake.core.get_lineage(%s, 'COLUMN', %s, %s))"
    )
    cur.execute(sql, (f"{relation}.{column}", direction, distance))
    return cur.fetchall()


def rows_to_edges(rows, resolve):
    """Normalises GET_LINEAGE rows into cache edges, dropping self and empty pairs."""
    edges = []
    for r in rows:
        (_dist, sdb, ssc, snm, scol, tdb, tsc, tnm, tcol, sdom, tdom) = r[:11]
        if not scol or not tcol:
            continue  # object-level row, no column information
        src = resolve(f"{sdb}.{ssc}.{snm}")
        dst = resolve(f"{tdb}.{tsc}.{tnm}")
        if src == dst and scol.lower() == tcol.lower():
            continue
        edges.append(
            {
                "from": src,
                "from_col": scol.lower(),
                "to": dst,
                "to_col": tcol.lower(),
                "kind": (tdom or sdom or "").lower(),
            }
        )
    return edges


# ----------------------------------------------------------------- probe ----
PROBE_SQL = [
    (
        "edition",
        "current account edition",
        "select current_version() as v, current_account() as a, current_role() as r",
    ),
]


def cmd_probe(args):
    kwargs, target = load_profile(args.profile, args.target, args.profiles_dir)
    print(f"connecting to profile {args.profile!r} target {target!r} "
          f"as role {kwargs.get('role')} ({kwargs.get('authenticator', 'password')})")
    conn = connect(kwargs)
    cur = conn.cursor()

    def attempt(label, sql, params=None):
        t0 = time.time()
        try:
            cur.execute(sql, params) if params else cur.execute(sql)
            rows = cur.fetchall()
            print(f"  OK    {label}: {len(rows)} row(s) in {time.time() - t0:.1f}s")
            return rows
        except Exception as e:  # noqa: BLE001 - the whole point is to report any failure
            first = str(e).strip().splitlines()[0][:160]
            print(f"  FAIL  {label}: {first}")
            return None

    print("\n[1] session")
    attempt("current_role / version", "select current_version(), current_account(), current_role()")

    relation = args.relation
    print(f"\n[2] GET_LINEAGE, TABLE domain on {relation}")
    tbl = attempt(
        "table lineage",
        "select distance, source_object_name, target_object_name, source_object_domain "
        "from table(snowflake.core.get_lineage(%s, 'TABLE', 'UPSTREAM', 2))",
        (relation,),
    )

    print(f"\n[3] GET_LINEAGE, COLUMN domain on {relation}.{args.column}")
    col = attempt(
        "column lineage",
        "select distance, source_object_name, source_column_name, target_column_name "
        "from table(snowflake.core.get_lineage(%s, 'COLUMN', 'UPSTREAM', 2))",
        (f"{relation}.{args.column}",),
    )
    if col:
        for row in col[:5]:
            print(f"        d={row[0]}  {row[1]}.{row[2]} -> {row[3]}")

    print("\n[4] ACCOUNT_USAGE.ACCESS_HISTORY (bulk path, needs IMPORTED PRIVILEGES)")
    acc = attempt(
        "access_history",
        "select count(*) from snowflake.account_usage.access_history "
        "where query_start_time > dateadd(day, -1, current_timestamp())",
    )

    print("\nverdict")
    if col:
        print("  column lineage works: on-demand mode is viable")
    elif tbl is not None:
        print("  GET_LINEAGE works but returned no column rows for this object.")
        print("  Either the object was not built by a query Snowflake could analyse,")
        print("  or this dev object has no lineage yet. Try a model you rebuilt recently.")
    else:
        print("  GET_LINEAGE is unavailable to this role. Ask for VIEW LINEAGE,")
        print("  and check the account is Enterprise Edition or higher.")
    if acc:
        print("  ACCESS_HISTORY is readable: a bulk load of the whole project is possible,")
        print("  which is much cheaper than one call per column. Tell dbt-lens about it.")
    else:
        print("  ACCESS_HISTORY is not readable: stay with per-column calls.")
    cur.close()
    conn.close()


# ----------------------------------------------------------------- serve ----
def cmd_serve(args):
    kwargs, target = load_profile(args.profile, args.target, args.profiles_dir)
    resolve = make_resolver(args.manifest)
    conn = None
    cur = None
    out = sys.stdout

    def reply(obj):
        out.write(json.dumps(obj, separators=(",", ":")) + "\n")
        out.flush()

    reply({"event": "ready", "target": target, "role": kwargs.get("role")})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        if req.get("op") == "quit":
            break
        try:
            if conn is None:
                conn = connect(kwargs)
                cur = conn.cursor()
            rows = column_lineage(
                cur,
                req["relation"],
                req["column"],
                req.get("direction", "UPSTREAM"),
                int(req.get("depth", 1)),
            )
            reply({"id": rid, "edges": rows_to_edges(rows, resolve)})
        except Exception as e:  # noqa: BLE001
            reply({"id": rid, "error": str(e).strip().splitlines()[0][:300]})

    if conn:
        conn.close()


# ------------------------------------------------------------------ dump ----
def cmd_dump(args):
    kwargs, target = load_profile(args.profile, args.target, args.profiles_dir)
    resolve = make_resolver(args.manifest)
    manifest = json.loads(Path(args.manifest).read_text())

    wanted = [w.strip() for w in args.select.split(",") if w.strip()]
    targets = []
    for uid, node in manifest.get("nodes", {}).items():
        if node.get("resource_type") != "model" or not node.get("relation_name"):
            continue
        if wanted and node["name"] not in wanted and uid not in wanted:
            continue
        cols = sorted(node.get("columns", {}))
        if cols:
            targets.append((uid, node["relation_name"], cols))
    if not targets:
        die("no model matched --select, or the matched models declare no columns in YAML")

    total_cols = sum(len(c) for _, _, c in targets)
    print(f"{len(targets)} model(s), {total_cols} column(s), {args.threads} thread(s)", file=sys.stderr)

    work = queue.Queue()
    for uid, rel, cols in targets:
        for c in cols:
            work.put((rel, c))
    found, errors, done = [], [], [0]
    lock = threading.Lock()

    def worker():
        conn = connect(kwargs)
        cur = conn.cursor()
        while True:
            try:
                rel, col = work.get_nowait()
            except queue.Empty:
                break
            try:
                edges = rows_to_edges(column_lineage(cur, rel, col, "UPSTREAM", 1), resolve)
            except Exception as e:  # noqa: BLE001
                with lock:
                    errors.append(f"{rel}.{col}: {str(e).splitlines()[0][:120]}")
                edges = []
            with lock:
                found.extend(edges)
                done[0] += 1
                if done[0] % 25 == 0:
                    print(f"  {done[0]}/{total_cols} columns, {len(found)} edges", file=sys.stderr)
        cur.close()
        conn.close()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.threads)]
    [t.start() for t in threads]
    [t.join() for t in threads]

    write_cache(args.out, found, target, errors)
    print(f"wrote {args.out}: {len(found)} edges, {len(errors)} error(s)", file=sys.stderr)
    for e in errors[:5]:
        print(f"  {e}", file=sys.stderr)


def make_resolver(manifest_path: str | None):
    """Maps DB.SCHEMA.OBJECT back to a dbt unique_id, so the cache is environment neutral."""
    by_rel = {}
    if manifest_path and Path(manifest_path).exists():
        doc = json.loads(Path(manifest_path).read_text())
        for coll in ("nodes", "sources"):
            for uid, node in doc.get(coll, {}).items():
                rel = node.get("relation_name")
                if rel:
                    by_rel[rel.replace('"', "").upper()] = uid

    def resolve(relation: str) -> str:
        return by_rel.get(relation.replace('"', "").upper(), "rel:" + relation.lower())

    return resolve


def write_cache(path, edges, target, errors):
    seen, unique = set(), []
    for e in edges:
        key = (e["from"], e["from_col"], e["to"], e["to_col"])
        if key not in seen:
            seen.add(key)
            unique.append(e)
    Path(path).write_text(
        json.dumps(
            {
                "version": CACHE_VERSION,
                "source": "snowflake",
                "target": target,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "errors": errors[:50],
                "edges": unique,
            },
            indent=1,
        )
    )


# ------------------------------------------------------------------ main ----
def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["probe", "serve", "dump"])
    p.add_argument("--profile", default=None, help="dbt profile (default: read from ./dbt_project.yml)")
    p.add_argument("--target", default=None)
    p.add_argument("--profiles-dir", default=None)
    p.add_argument("--manifest", default="target/manifest.json")
    p.add_argument("--out", default="target/column_lineage.json")
    p.add_argument("--select", default="", help="dump: comma separated model names")
    p.add_argument("--threads", type=int, default=6)
    p.add_argument("--relation", default=None, help="probe: fully qualified object")
    p.add_argument("--column", default=None, help="probe: column of that object")
    args = p.parse_args()
    args.profile = args.profile or profile_from_project()
    if not args.profile:
        die("no --profile given and no dbt_project.yml in the current directory to read it from")

    if args.command == "probe":
        if not args.relation or not args.column:
            die("probe needs --relation DB.SCHEMA.TABLE and --column NAME")
        cmd_probe(args)
    elif args.command == "serve":
        cmd_serve(args)
    else:
        cmd_dump(args)


if __name__ == "__main__":
    main()
