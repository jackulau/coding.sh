#!/usr/bin/env python3
"""List the runs of the A/B's experiment: <out>/runs.json, one row per run with arm and task names.

    python3 runs.py <out-dir>

Reads <out>/compare.json for the experiment id and <out>/csh/index.db (read-only) for the runs.
"""
import json
import sqlite3
import sys

out = sys.argv[1]
exp = json.load(open(f"{out}/compare.json"))["experimentId"]
db = sqlite3.connect(f"file:{out}/csh/index.db?mode=ro", uri=True)
tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}


def names(table):
    if table not in tables:
        return {}
    cols = [r[1] for r in db.execute(f"pragma table_info({table})")]
    res = {}
    for row in db.execute(f"select * from {table}"):
        d = dict(zip(cols, row))
        doc = json.loads(d.get("doc") or "{}")
        res[d["id"]] = doc.get("name") or d.get("name")
    return res


bundles, tasks = names("bundles"), names("tasks")
rows = []
for rid, tid, bid, ok, doc in db.execute("select id, task_id, bundle_id, pass, doc from runs where experiment_id=?", (exp,)):
    d = json.loads(doc)
    rows.append({"run": rid, "arm": bundles.get(bid, bid), "task": tasks.get(tid, tid), "attempt": d.get("attempt"),
                 "pass": bool(ok), "superseded": d.get("superseded"), "error": d.get("error"), "infra": d.get("infra")})
json.dump(rows, open(f"{out}/runs.json", "w"), indent=1)
print(f"experiment {exp}: {len(rows)} runs, arms {sorted({r['arm'] for r in rows})}")
