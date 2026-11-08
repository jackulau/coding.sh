#!/usr/bin/env python3
"""Check each task: the start tree fails its verifier and a reference fix passes.

    python3 examples/plugin-ab/check-tasks.py [tasks-dir]

Exits 1 if any task is not like that. Needs Node and Python, no agent and no key.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

TASKS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks")
REF = {
"c1-paginate": {"src/paginate.js": """
function paginate(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages, total: items.length };
}
module.exports = { paginate };
"""},
"c2-duration": {"src/duration.js": """
function formatDuration(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${s % 60}s`; }
const U = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
function parseDuration(text) {
  const t = String(text).replace(/\\s+/g, "");
  if (!t || !/^(\\d+(ms|d|h|m|s))+$/.test(t)) throw new RangeError("bad duration: " + text);
  let total = 0;
  for (const [, n, u] of t.matchAll(/(\\d+)(ms|d|h|m|s)/g)) total += Number(n) * U[u];
  return total;
}
module.exports = { formatDuration, parseDuration };
"""},
"c3-cache": {"src/users.js": """
const cache = new Map();
function makeGetUser(fetchUser) {
  return function getUser(id) {
    if (cache.has(id)) return cache.get(id);
    const p = fetchUser(id).catch((e) => { cache.delete(id); throw e; });
    cache.set(id, p);
    return p;
  };
}
function clearCache() { cache.clear(); }
module.exports = { makeGetUser, clearCache };
"""},
"c4-csv": {"src/csv.js": """
function parseLine(line) {
  const out = []; let f = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
  }
  out.push(f); return out;
}
module.exports = { parseLine };
"""},
"c5-semver": {"src/semver.js": """
function parse(v) { const [core, pre] = v.split("+")[0].split(/-(.*)/s); return { nums: core.split(".").map(Number), pre: pre ? pre.split(".") : [] }; }
function compareVersions(a, b) {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  if (!A.pre.length || !B.pre.length) return B.pre.length - A.pre.length;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1; if (y === undefined) return 1;
    const nx = /^\\d+$/.test(x), ny = /^\\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; }
    else if (nx) return -1; else if (ny) return 1; else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
module.exports = { compareVersions };
"""},
"e2-flaky": {"src/report.js": """
function dayKey(iso) { return new Date(iso).toISOString().slice(0, 10); }
function groupByDay(isoList) { const out = {}; for (const iso of isoList) (out[dayKey(iso)] ??= []).push(iso); return out; }
module.exports = { dayKey, groupByDay };
"""},
}
CLI_PATCH = ("const [cmd, ...rest] = process.argv.slice(2);", "const [cmd, ...rest0] = process.argv.slice(2);\nconst json = rest0.includes('--json');\nconst rest = rest0.filter((a) => a !== '--json');")
CLI_PATCH2 = ("  console.log(`files: ${s.files}`);", "  if (json) { console.log(JSON.stringify(s)); process.exit(0); }\n  console.log(`files: ${s.files}`);")
ANSWERS = {
"e1-review": "Not safe. 1) SQL injection: status is interpolated into the query; use a $1 placeholder. 2) DELETE has no await, so errors are lost. 3) payments is undefined and the refund amount is not checked or authorized.",
"e3-retry": "It calls fn, and on error waits with exponential backoff (baseMs * 2 ** attempt). Bug: `!isRetryable` checks the function itself, which is always truthy, so isRetryable(err) is never called.",
"e4-crash": "SMTP_URL is not set, so config.smtpUrl is undefined and parseSmtpUrl calls split on it. Validate required config at startup and fail fast.",
}

def run(task):
    d = os.path.join(TASKS, task)
    spec = json.load(open(os.path.join(d, "task.json")))
    res = {}
    for mode in ("start", "ref"):
        w = tempfile.mkdtemp()
        if os.path.isdir(os.path.join(d, "repo")):
            shutil.copytree(os.path.join(d, "repo"), w, dirs_exist_ok=True)
        if mode == "ref":
            for p, t in REF.get(task, {}).items():
                open(os.path.join(w, p), "w").write(t)
            if task == "c6-cli-json":
                s = open(os.path.join(w, "cli.js")).read()
                for a, b in (CLI_PATCH, CLI_PATCH2):
                    assert a in s; s = s.replace(a, b)
                open(os.path.join(w, "cli.js"), "w").write(s)
        shutil.copytree(os.path.join(d, "tests"), w, dirs_exist_ok=True)  # as coding.sh does: tests/<p> -> <p>
        ans = os.path.join(w, "..", os.path.basename(w) + "-answer.txt")
        open(ans, "w").write(ANSWERS.get(task, "") if mode == "ref" else "Looks fine to me.")
        r = subprocess.run(spec["verifier"]["command"], shell=True, cwd=w, env={**os.environ, "CODING_SH_AGENT_OUTPUT": ans}, capture_output=True, text=True)
        res[mode] = r.returncode
        if mode == "ref" and r.returncode != 0:
            print(task, "REF FAIL", (r.stdout + r.stderr)[-800:])
        shutil.rmtree(w)
    ok = res["start"] != 0 and res["ref"] == 0
    print(f"{task:14} start={res['start']} ref={res['ref']} {'OK' if ok else 'BAD'}")
    return ok

bad = [t for t in sorted(os.listdir(TASKS)) if not run(t)]
sys.exit(1 if bad else 0)
