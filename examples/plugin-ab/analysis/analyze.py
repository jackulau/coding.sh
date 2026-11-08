#!/usr/bin/env python3
"""Per-run metrics of the A/B, paired base vs plugin by (task, attempt), with 95% CIs from a
task-clustered bootstrap.

    python3 analyze.py <out-dir> [--marker TEXT]

Reads <out>/runs.json, <out>/answers/<run>.txt and .stdout.jsonl (Claude Code's stream-json) and,
if present, <out>/judge.json. Prints a table and writes <out>/summary.json.
--marker counts the runs whose stream shows TEXT, to check the plugin reached its arm only.
Cost split prices are USD per million tokens, from PRICES="in,out,cache_read,cache_write_5m,
cache_write_1h" (default: Claude Opus 5.5 list prices, 4,20,0.2,5,8).
"""
import json
import os
import random
import re
import statistics
import sys

args = sys.argv[1:]
OUT = args[0]
MARKER = args[args.index("--marker") + 1] if "--marker" in args else None
P_IN, P_OUT, P_CR, P_CW5, P_CW1H = (float(x) / 1e6 for x in os.environ.get("PRICES", "4,20,0.2,5,8").split(","))
ARMS = ["base", "plugin"]

runs = [r for r in json.load(open(f"{OUT}/runs.json")) if not r.get("superseded")]
judge = json.load(open(f"{OUT}/judge.json")) if os.path.exists(f"{OUT}/judge.json") else None


def prose(t):
    t = re.sub(r"```.*?```", " ", t, flags=re.S)
    t = re.sub(r"`[^`]*`", " ", t)
    return re.sub(r"https?://\S+", " ", t)


def metrics(run):
    p = f"{OUT}/answers/{run}.stdout.jsonl"
    if not os.path.exists(p):
        return None
    m = {"calls": set(), "marker": False, "text_words": 0}
    res = None
    for line in open(p, errors="replace"):
        if MARKER and MARKER in line:
            m["marker"] = True
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "assistant" and not e.get("parent_tool_use_id"):
            msg = e.get("message") or {}
            m["calls"].add(msg.get("id"))
            for b in msg.get("content") or []:
                if b.get("type") == "text":
                    m["text_words"] += len(prose(b.get("text", "")).split())
        if e.get("type") == "result":
            res = e
    if res is None:
        return None
    # Stream-json assistant events carry usage from message_start; the result event has the
    # run's true totals.
    u = res.get("usage") or {}
    cc = u.get("cache_creation") or {}
    cw = u.get("cache_creation_input_tokens") or 0
    cw1h = cc.get("ephemeral_1h_input_tokens", 0)
    cw5 = cc.get("ephemeral_5m_input_tokens", cw - cw1h)
    m.update(calls=len(m["calls"]), out=u.get("output_tokens") or 0, inp=u.get("input_tokens") or 0,
             cache_read=u.get("cache_read_input_tokens") or 0, cache_write=cw,
             cost=res.get("total_cost_usd") or 0.0, wall=(res.get("duration_ms") or 0) / 1000,
             split={"input": (u.get("input_tokens") or 0) * P_IN, "output": (u.get("output_tokens") or 0) * P_OUT,
                    "cache read": (u.get("cache_read_input_tokens") or 0) * P_CR, "cache write": cw5 * P_CW5 + cw1h * P_CW1H})
    a = f"{OUT}/answers/{run}.txt"
    m["reply_words"] = len(prose(open(a).read()).split()) if os.path.exists(a) else 0
    return m


for r in runs:
    r["m"] = metrics(r["run"])
if judge:
    scores = {p["run"]: p.get("score") for p in judge["point"]}
    for r in runs:
        r["judge"] = scores.get(r["run"])

print("runs per arm:", {a: sum(1 for r in runs if r["arm"] == a) for a in ARMS},
      "without a stream:", sum(1 for r in runs if r["m"] is None))
if MARKER:
    print(f"runs whose stream shows {MARKER!r}:", {a: sum(1 for r in runs if r["arm"] == a and r["m"] and r["m"]["marker"]) for a in ARMS})

FIELDS = [
    ("pass rate", lambda r: None if r.get("pass") is None else float(r["pass"])),
    ("output tokens", lambda r: r["m"]["out"]),
    ("LLM calls", lambda r: r["m"]["calls"]),
    ("cache read tokens", lambda r: r["m"]["cache_read"]),
    ("cache write tokens", lambda r: r["m"]["cache_write"]),
    ("cost USD (API-equivalent)", lambda r: r["m"]["cost"]),
    ("wall s", lambda r: r["m"]["wall"]),
    ("final reply words", lambda r: r["m"]["reply_words"]),
    ("all assistant text words", lambda r: r["m"]["text_words"]),
    ("judge clarity (0-1)", lambda r: r.get("judge")),
]

pairs = {}
for r in runs:
    if r["m"] is not None:
        pairs.setdefault((r["task"], r["attempt"]), {})[r["arm"]] = r
paired = [(k, v) for k, v in sorted(pairs.items()) if all(a in v for a in ARMS)]
print(f"pairs (task, attempt): {len(paired)} over {len({k[0] for k, _ in paired})} tasks")


def boot(by_task, stat, n=5000, seed=7):
    rnd = random.Random(seed)
    keys = list(by_task)
    vals = sorted(stat([x for k in (rnd.choice(keys) for _ in keys) for x in by_task[k]]) for _ in range(n))
    return vals[int(0.025 * n)], vals[int(0.975 * n)]


def rel(s):
    a = statistics.mean(x for x, _ in s)
    return (statistics.mean(y for _, y in s) / a - 1) * 100 if a else 0.0


summary = {}
print(f"\n{'metric':28} {'base':>10} {'plugin':>10} {'change':>8}  95% CI")
for name, f in FIELDS:
    by_task = {}
    for (task, _), v in paired:
        a, b = f(v["base"]), f(v["plugin"])
        if a is not None and b is not None:
            by_task.setdefault(task, []).append((a, b))
    allv = [x for xs in by_task.values() for x in xs]
    if not allv:
        continue
    ma, mb = statistics.mean(a for a, _ in allv), statistics.mean(b for _, b in allv)
    if name in ("pass rate", "judge clarity (0-1)"):
        lo, hi = boot(by_task, lambda s: statistics.mean(b - a for a, b in s))
        change, ci = f"{mb - ma:+.3f}", f"[{lo:+.3f}, {hi:+.3f}]"
    else:
        lo, hi = boot(by_task, rel)
        change, ci = f"{rel(allv):+.1f}%", f"[{lo:+.1f}%, {hi:+.1f}%]"
    summary[name] = {"base": ma, "plugin": mb, "change": change, "ci": ci, "n": len(allv)}
    print(f"{name:28} {ma:10.3f} {mb:10.3f} {change:>8}  {ci}")

print("\ncost per run by token type (list prices), base -> plugin")
split = {}
for part in ("input", "output", "cache read", "cache write"):
    a = statistics.mean(v["base"]["m"]["split"][part] for _, v in paired)
    b = statistics.mean(v["plugin"]["m"]["split"][part] for _, v in paired)
    split[part] = {"base": a, "plugin": b, "change": b - a}
    print(f"  {part:12} ${a:.4f} -> ${b:.4f}  ({b - a:+.4f})")
net = sum(s["change"] for s in split.values())
print(f"  {'net':12} {net:+.4f}")
summary["cost split"] = split

if judge:
    w = [p for p in judge["pairs"] if p.get("winner")]
    counts = {k: sum(1 for p in w if p["winner"] == k) for k in ("a", "b", "tie")}
    print(f"\npairwise judge (a = base, b = plugin): {counts}, same verdict in both orders {sum(1 for p in w if p.get('consistent'))}/{len(w)}")
    summary["pairwise"] = counts
json.dump(summary, open(f"{OUT}/summary.json", "w"), indent=1)
