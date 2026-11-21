#!/usr/bin/env node
// One scorecard (docs/design/dogfood.md §4).
//
//   npm run dogfood [-- --mode quick|full|auto] [--compare-to <scorecard.json>] [--json] [--skip-gates]
//
// Writes tasks/dogfood/scorecard.json and appends one line to
// tasks/dogfood/history.jsonl. quick = gates, cli.guidelines, conformance
// fixtures, perf, Lighthouse, capture health ($0). full = quick + CLI suite
// validation and agent runs (dev + held-out, 2 drivers, k = 3), replays, smoke
// and council. auto = full when the last full entry is older than 24 h.
// Agent suites need API keys; without them they are skipped and the notes say so.
//
// Every script under scripts/dogfood/ and evals/ is scorer-owned: candidate
// diffs touching them are rejected by the loop (§4 guard 4).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { meets as perfMeets, runBenches, TARGETS as PERF_TARGETS } from "./bench.mjs";
import { driverKeyMissing, loadSuite, runSuite, validate } from "./cli-suite.mjs";
import { runGuidelines } from "./cli-guidelines.mjs";
import { captureHealth, fixtures, smoke } from "./conformance.mjs";
import { siteJs, siteLighthouse, SITE_TARGETS } from "./site.mjs";
import { DOGFOOD_TASKS, git, log, parseArgs, PKG, readJsonl, REPO, round, sh, shAsync, tempDir } from "./lib/util.mjs";
import { isMain } from "./lib/main.mjs";

export const WEIGHTS = {
  "cli.heldout.success": 30,
  "cli.invalidRate": 10,
  "cli.guidelines": 10,
  "replay.success": 15,
  conformance: 15,
  perf: 10,
  site: 10,
};

/** Normalize each weighted component to [0, 1] (doc §4 table). null = not measured. */
export function normalized(c) {
  const v = (k) => (c[k]?.value === undefined || c[k]?.value === null ? null : c[k].value);
  const mean = (xs) => {
    const ys = xs.filter((x) => x !== null);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };
  const inv = v("cli.invalidRate");
  const perfKeys = ["perf.hook", "perf.ingest", "perf.storeSize", "perf.viewerTti", "perf.help"];
  const perfMet = perfKeys.map((k) => (c[k]?.met === undefined ? null : c[k].met ? 1 : 0));
  const siteMet = ["site.lighthouse", "site.vitals", "site.js"].map((k) => (c[k]?.met === undefined ? null : c[k].met ? 1 : 0));
  const council = v("site.council");
  const siteFrac = mean(siteMet);
  return {
    "cli.heldout.success": v("cli.heldout.success"),
    "cli.invalidRate": inv === null ? null : 1 - Math.min(1, inv / 0.2),
    "cli.guidelines": v("cli.guidelines"),
    "replay.success": v("replay.success"),
    conformance: mean([v("conformance.fixtures"), v("conformance.smoke"), v("capture.health")]),
    perf: mean(perfMet),
    // Council missing: the site component is the budget fraction alone (reported in notes).
    site: siteFrac === null ? null : council === null ? siteFrac : 0.6 * siteFrac + 0.4 * Math.max(0, Math.min(1, (council + 2) / 4)),
  };
}

/**
 * Headline (0–100): null when a gate fails. Components that were not measured
 * (null) are left out and the remaining weights are rescaled; `coverage` is the
 * weight actually measured, so a headline over 40% of the weight is not read as
 * a headline over 100%.
 */
export function headline(gates, components) {
  const gated = Object.entries(gates).filter(([, ok]) => ok === false).map(([k]) => k);
  const norm = normalized(components);
  let w = 0;
  let s = 0;
  const missing = [];
  for (const [k, weight] of Object.entries(WEIGHTS)) {
    if (norm[k] === null || norm[k] === undefined) missing.push(k);
    else {
      w += weight;
      s += weight * norm[k];
    }
  }
  const coverage = w / 100;
  if (gated.length) return { headline: null, gated, coverage, missing, normalized: norm };
  return { headline: w ? round((s / w) * 100, 1) : null, headlineFullWeight: round(s, 1), coverage, missing, normalized: norm };
}

// Every perf budget that is a ceiling, from bench.mjs, plus the rest: LCP in ms, the dev − heldout gap.
const LOWER_IS_BETTER = new Set([
  ...Object.entries(PERF_TARGETS).filter(([, t]) => t.dir === "max").map(([k]) => k),
  ...["cli.invalidRate", "cli.dev.invalidRate", "cli.costPerSuccess", "cli.wallMs", "cli.gap", "site.js", "site.vitals"],
]);

export function compare(cur, prev) {
  const out = {};
  for (const [k, c] of Object.entries(cur.components)) {
    const p = prev.components?.[k];
    if (typeof c?.value !== "number" || typeof p?.value !== "number") continue;
    const d = c.value - p.value;
    const better = LOWER_IS_BETTER.has(k) ? d < 0 : d > 0;
    out[k] = { prev: p.value, cur: c.value, delta: round(d, 4), direction: d === 0 ? "same" : better ? "better" : "worse" };
  }
  return { headline: { prev: prev.headline, cur: cur.headline }, components: out };
}

/**
 * The test files that scripts/test-ci.mjs says failed in the full run and passed when run alone,
 * from its output, each once.
 */
export function passedAlone(output) {
  const files = new Set();
  for (const line of output.split("\n")) {
    const m = /::warning title=Passed when run alone::(\S+)/.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files];
}

async function gate(name, cmd, args, opts = {}) {
  const r = await shAsync(cmd, args, { timeoutMs: 900_000, ...opts });
  const out = r.stdout + r.stderr;
  log(`gate ${name}: ${r.code === 0 ? "pass" : `FAIL (exit ${r.code})`} ${Math.round(r.ms / 1000)} s`);
  // Name what failed: the test runner marks each failing test with ✖.
  if (r.code !== 0) for (const l of [...new Set(out.split("\n").filter((x) => /^\s*✖/.test(x)).map((x) => x.trim()))].slice(0, 10)) log(`  ${l}`);
  const alone = passedAlone(out);
  for (const f of alone) log(`  ${f} failed in the full run and passed alone`);
  const result = { ok: r.code === 0, ms: Math.round(r.ms), tail: r.code === 0 ? undefined : out.slice(-1500) };
  if (alone.length) result.passedAlone = alone;
  return result;
}

/**
 * Env for the tests gate: HOME, USERPROFILE and the agent homes under `tmp`, no background ingest.
 * LOCALAPPDATA sits inside the moved profile, as in scripts/gate.mjs: on Windows, Chrome refuses
 * --remote-debugging-port when it does not, and every browser test hangs until the gate times out.
 * SHARD, TEST_SELECT and TEST_DURATIONS_OUT are dropped, so test-ci.mjs runs every test file.
 */
export function gateTestEnv(env, tmp) {
  const home = join(tmp, "home");
  const out = { ...env };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "SHARD", "TEST_SELECT", "TEST_DURATIONS_OUT"]) delete out[k];
  return {
    ...out,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    CODING_SH_NO_AUTO_INGEST: "1",
    NO_COLOR: "1",
  };
}

/**
 * The tests gate: every test file under `cwd`, run as CI and `npm run gate` run them. When five or
 * fewer files fail, each is run again alone, and one that passes then does not fail the gate:
 * timing tests assume an idle machine, and the scorer's machine is busy. The result names such
 * files in `passedAlone`.
 */
export function testsGate(env, cwd = PKG) {
  return gate("tests", process.execPath, ["--no-warnings", join(PKG, "scripts", "test-ci.mjs")], { cwd, env });
}

async function runGates() {
  const tmp = tempDir("cs-gates-");
  try {
    // Tests run with every home in a temp dir, on top of the tests' own isolation. On Windows Node
    // takes the home from USERPROFILE, so HOME alone isolates nothing there.
    const testEnv = gateTestEnv(process.env, tmp);
    mkdirSync(testEnv.LOCALAPPDATA, { recursive: true });
    const g = {};
    g.typecheck = await gate("typecheck", "npm", ["run", "typecheck", "-w", "coding.sh"], { cwd: REPO });
    g.tests = await testsGate(testEnv);
    g.build = await gate("build", "npm", ["run", "build", "-w", "coding.sh"], { cwd: REPO });
    g.siteBuild = await gate("siteBuild", "npm", ["run", "build", "-w", "@coding.sh/site"], { cwd: REPO });
    return g;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Versions of the agent CLIs on PATH, from `<cli> --version`. CODING_SH_DOGFOOD_SKIP_AGENTS is a
 * comma list of agent ids (e.g. "codex") whose CLI is never started: a machine where that CLI must
 * not run records null for it.
 */
export function agentVersions(env = process.env, run = sh) {
  const skip = new Set((env.CODING_SH_DOGFOOD_SKIP_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const v = (id, cmd) => {
    if (skip.has(id)) return null;
    const r = run(cmd, ["--version"], { timeout: 15_000 });
    return r.code === 0 ? (/\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? r.stdout.trim()) : null;
  };
  return { "claude-code": v("claude-code", "claude"), codex: v("codex", "codex") };
}

/** invalidTasks (ids) and invalidReasons (id → the check that failed, command, exit code, error line). */
export function invalidSummary(tasks) {
  const bad = tasks.filter((t) => t.status !== "blocked" && !t.ok);
  return { invalidTasks: bad.map((t) => t.id), invalidReasons: Object.fromEntries(bad.map((t) => [t.id, t.reason ?? { check: "unknown", why: [...(t.errors ?? []), ...(t.referenceFailures ?? [])].join(" | ").slice(0, 300) || "no reason recorded" }])) };
}

/** Notes for cli.guidelines: the modes it skipped and why, and the cases whose process did not start. */
export function guidelinesNotes(g) {
  const out = [];
  if (g.skipped) out.push(`cli.guidelines: modes ${g.skipped.modes.join(", ")} skipped, not scored: ${g.skipped.reason}`);
  if (g.scorerErrors?.length) out.push(`cli.guidelines: ${g.scorerErrors.length} case(s) not scored, the scorer could not start them: ${g.scorerErrors.slice(0, 5).map((e) => `${e.id}/${e.mode} (${e.error})`).join(", ")}`);
  return out;
}

/** Notes for capture.health: the coding.sh that wrote the copied index, and the incomplete sessions by agent and what they miss. */
export function healthNotes(h) {
  const out = [];
  if (h.writer?.version) out.push(`capture.health: the index was last written by coding.sh ${h.writer.version}${h.writer.schema === undefined ? "" : ` (schema v${h.writer.schema})`}`);
  const by = h.incompleteCounts?.byAgent ?? {};
  const agents = Object.keys(by).sort((a, b) => by[b] - by[a] || a.localeCompare(b));
  if (agents.length) {
    const what = (a) => Object.entries(h.incompleteCounts.byMissing?.[a] ?? {}).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ");
    out.push(`capture.health incomplete of ${h.n}: ${agents.map((a) => `${a} ${by[a]} (${what(a)})`).join("; ")}`);
  }
  return out;
}

function lastFull(history) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].mode === "full") return history[i];
  return undefined;
}

const comp = (value, extra = {}) => ({ value: value ?? null, ...extra });

export async function score(opts = {}) {
  const t0 = Date.now();
  const historyPath = join(DOGFOOD_TASKS, "history.jsonl");
  const history = readJsonl(historyPath);
  const prevFull = lastFull(history);
  let mode = opts.mode ?? "auto";
  if (mode === "auto") mode = !prevFull || t0 - prevFull.ts > 24 * 3600e3 ? "full" : "quick";
  const notes = [];
  const components = {};
  const ran = new Set();
  const put = (k, c) => {
    components[k] = c;
    ran.add(k);
  };

  // ---- gates
  let gates;
  let gateDetail = {};
  if (opts.skipGates) {
    gates = { typecheck: null, tests: null, build: null, siteBuild: null };
    notes.push("gates skipped (--skip-gates): headline is not decision-grade");
  } else {
    gateDetail = await runGates();
    gates = Object.fromEntries(Object.entries(gateDetail).map(([k, v]) => [k, v.ok]));
    for (const [k, v] of Object.entries(gateDetail)) if (v.passedAlone) notes.push(`gate ${k}: failed in the full run and passed alone, so it passes: ${v.passedAlone.join(", ")}`);
  }
  const built = gates.build !== false;

  // ---- cli.guidelines
  if (built) {
    try {
      const g = runGuidelines();
      put("cli.guidelines", comp(g.value, { n: g.n, passed: g.passed, skippedModes: g.skipped, scorerErrors: g.scorerErrors?.length ? g.scorerErrors.map((e) => `${e.id}/${e.mode}: ${e.error}`) : undefined, target: 1, weight: WEIGHTS["cli.guidelines"], unit: "rate", failures: g.failures.slice(0, 20).map((f) => `${f.id}/${f.mode}: ${f.fails.join("; ")}`), source: "scripts/dogfood/cli-guidelines.mjs (scorer-owned; test/cli/guidelines.test.ts does not exist yet)" }));
      notes.push(...guidelinesNotes(g));
    } catch (e) {
      put("cli.guidelines", comp(null, { error: e.message }));
    }
  }

  // ---- conformance
  const fx = await fixtures();
  put("conformance.fixtures", comp(fx.value, { n: fx.n, pass: fx.pass, fail: fx.fail, failures: fx.failures, group: "conformance", unit: "rate", target: 1 }));
  let health;
  try {
    health = captureHealth();
  } catch (e) {
    health = { value: null, error: e.message };
  }
  put("capture.health", comp(health.value, { n: health.n, reason: health.reason, error: health.error, writer: health.writer, incomplete: health.incomplete, incompleteCounts: health.incompleteCounts, excluded: health.excluded, warning: health.warning, group: "conformance", unit: "rate", target: 1 }));
  if (health.warning) notes.push(`capture.health: ${health.warning}`);
  notes.push(...healthNotes(health));
  if (health.value === null) notes.push(`capture.health not measured: ${health.reason ?? health.error}`);

  // ---- perf
  if (built) {
    const b = await runBenches(["hook", "ingest", "help", "viewer"], { baseline: opts.baseline });
    const r = b.results;
    const perf = (k, v, extra = {}) => put(k, comp(v, { target: PERF_TARGETS[k].target, unit: PERF_TARGETS[k].unit, weight: 0, group: "perf", met: v === null || v === undefined ? undefined : perfMeets(k, v), ...extra }));
    if (r.hook) {
      const met = perfMeets("perf.hook", r.hook["perf.hook"]) && perfMeets("perf.hookP95", r.hook["perf.hookP95"]) && perfMeets("perf.hook1mb", r.hook["perf.hook1mb"]);
      perf("perf.hook", r.hook["perf.hook"], { met, p95: r.hook["perf.hookP95"], mb1: r.hook["perf.hook1mb"], detail: r.hook.detail, paired: r.hook.paired });
    } else perf("perf.hook", null, { error: b.errors.hook });
    perf("perf.ingest", r.ingest?.["perf.ingest"], { detail: r.ingest?.detail, error: b.errors.ingest });
    perf("perf.storeSize", r.ingest?.["perf.storeSize"], { error: b.errors.ingest });
    perf("perf.help", r.help?.["perf.help"], { detail: r.help?.detail, paired: r.help?.paired, error: b.errors.help });
    perf("perf.viewerTti", r.viewer?.["perf.viewerTti"], { method: r.viewer?.method, skipped: r.viewer?.skipped, detail: r.viewer?.detail, error: b.errors.viewer });
    perf("perf.replayIndex", r.replay?.["perf.replayIndex"], { detail: r.replay?.detail, error: b.errors.replay });
    perf("perf.replayStep", r.replay?.["perf.replayStep"], { error: b.errors.replay });
    if (r.viewer?.method?.startsWith("cdp-proxy")) notes.push("perf.viewerTti is a Chrome DevTools proxy, not Lighthouse `interactive` (lighthouse CLI not installed)");
    if (!opts.baseline) notes.push("perf ran without --baseline: no interleaved A/B pairing (single build)");
  }

  // ---- site
  if (gates.siteBuild !== false) {
    try {
      const js = siteJs();
      put("site.js", comp(js.value, { kb: js.kb, target: js.target, unit: "bytes gzip", met: js.value <= js.target, group: "site", files: js.files.map((f) => f.file) }));
    } catch (e) {
      put("site.js", comp(null, { error: e.message, group: "site" }));
    }
    const lh = await siteLighthouse();
    if (lh.value === null) {
      put("site.lighthouse", comp(null, { skipped: lh.skipped, error: lh.error, group: "site" }));
      put("site.vitals", comp(null, { skipped: lh.skipped, error: lh.error, group: "site" }));
      notes.push(`site.lighthouse and site.vitals ${lh.skipped ? `skipped: ${lh.skipped}` : `not measured: ${lh.error}`}`);
    } else {
      put("site.lighthouse", comp(lh.value, { categories: lh.categories, met: lh.lighthouseMet, target: SITE_TARGETS.lighthouse, group: "site" }));
      put("site.vitals", comp(lh.vitals.lcpMs, { ...lh.vitals, met: lh.vitalsMet, target: SITE_TARGETS.vitals, unit: "ms LCP", group: "site" }));
    }
  }

  // ---- full-only suites
  let costUsd = 0;
  if (mode === "full") {
    const v = await validate({ concurrency: 8 });
    put("cli.tasks", comp(v.valid, { unit: "fraction of active tasks whose reference passes, no-op fails, no leakage", ...v.counts, ...invalidSummary(v.tasks), blockedTasks: v.tasks.filter((t) => t.status === "blocked").map((t) => `${t.id}: ${t.blockedBy}`), weight: 0 }));
    const { suite } = loadSuite();
    const drivers = suite.drivers?.list ?? [];
    const missing = drivers.map((d) => [d, driverKeyMissing(d)]).filter(([, m]) => m);
    if (missing.length === drivers.length) {
      notes.push(`CLI agent suite skipped: no API key set (${missing.map(([d, m]) => `${d} needs ${m}`).join(", ")}); cli.heldout.success and cli.invalidRate not measured`);
    } else {
      const run = await runSuite({ split: "all", driver: drivers.filter((d) => !driverKeyMissing(d)) });
      for (const s of run.skipped) notes.push(`CLI driver ${s.driver} skipped: ${s.reason}`);
      const h = run.summary.heldout;
      const d = run.summary.dev;
      put("cli.heldout.success", comp(h.n ? h.success : null, { ci: h.ci, n: h.n, target: 0.9, weight: 30, unit: "rate", runId: run.runId }));
      put("cli.invalidRate", comp(h.n ? h.invalidRate : null, { n: h.n, target: 0.05, weight: 10, unit: "rate" }));
      put("cli.dev.success", comp(d.n ? d.success : null, { ci: d.ci, n: d.n, weight: 0, unit: "rate" }));
      put("cli.dev.invalidRate", comp(d.n ? d.invalidRate : null, { weight: 0, unit: "rate" }));
      put("cli.costPerSuccess", comp(h.costPerSuccess, { weight: 0, unit: "usd" }));
      put("cli.wallMs", comp(h.wallMs, { weight: 0, unit: "ms" }));
      costUsd += (h.costUsd ?? 0) + (d.costUsd ?? 0);
      if (h.n && d.n) put("cli.gap", comp(round((d.success - h.success) * 100, 1), { unit: "points (dev − heldout)", weight: 0, flagged: d.success - h.success > 0.15 }));
    }
    put("replay.success", comp(null, { skipped: "session harvest (§3.2) not built yet: no promoted replay tasks", weight: 15 }));
    notes.push("replay.success skipped: session harvest (§3.2) not built yet");
    const sm = await smoke();
    put("conformance.smoke", comp(sm.value, { skipped: sm.skipped, error: sm.error, group: "conformance" }));
    if (sm.value === null) notes.push(`conformance.smoke skipped: ${sm.skipped ?? sm.error}`);
    const gemini = sh("sh", ["-c", "command -v gemini"]).code === 0;
    put("site.council", comp(null, { skipped: "council needs fresh chrome-devtools screenshots and member runs (Agent + codex exec), which this script cannot drive; run the council skill by hand", group: "site" }));
    notes.push(`site.council skipped (not automatable from this script)${gemini ? "" : "; gemini CLI not installed, so a council would have 2 members"}`);
  }

  // ---- stale carry-over (quick mode keeps the last full value of anything it did not run)
  if (prevFull) {
    for (const [k, c] of Object.entries(prevFull.components ?? {})) {
      if (ran.has(k) || c?.value === null || c?.value === undefined) continue;
      components[k] = { ...c, stale: true, ageHours: round((t0 - prevFull.ts) / 3600e3, 1) };
    }
  }

  const h = headline(gates, components);
  if (h.coverage < 1) notes.push(`headline covers ${Math.round(h.coverage * 100)}% of the weight; not measured: ${h.missing.join(", ")}`);
  for (const [k, w] of Object.entries(WEIGHTS)) if (components[k]) components[k].weight = w;

  const status = git(["status", "--porcelain"]);
  const card = {
    v: 1,
    ts: t0,
    commit: git(["rev-parse", "HEAD"]) ?? null,
    dirty: status === undefined ? null : status.length > 0,
    mode,
    agents: agentVersions(),
    gates,
    ...(h.gated ? { gated: h.gated } : {}),
    headline: h.headline,
    headlineFullWeight: h.headlineFullWeight ?? null,
    coverage: h.coverage,
    normalized: h.normalized,
    components,
    costUsd: round(costUsd, 4),
    durationMs: Date.now() - t0,
    notes,
  };
  if (Object.values(gateDetail).some((g) => !g.ok)) card.gateFailures = Object.fromEntries(Object.entries(gateDetail).filter(([, g]) => !g.ok).map(([k, g]) => [k, g.tail]));
  if (opts.compareTo) card.compare = compare(card, JSON.parse(readFileSync(resolve(opts.compareTo), "utf8")));
  if (!card.commit) notes.push("no git commit yet: commit is null");

  if (!opts.dryRun) {
    mkdirSync(DOGFOOD_TASKS, { recursive: true });
    const prevCard = existsSync(join(DOGFOOD_TASKS, "scorecard.json")) ? readFileSync(join(DOGFOOD_TASKS, "scorecard.json"), "utf8") : undefined;
    if (prevCard && !card.compare) {
      try {
        card.compare = compare(card, JSON.parse(prevCard));
      } catch {}
    }
    writeFileSync(join(DOGFOOD_TASKS, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
    appendFileSync(historyPath, JSON.stringify(card) + "\n");
  }
  return card;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json", "skip-gates", "dry-run"] });
  const mode = args.mode ?? "auto";
  if (!["quick", "full", "auto"].includes(mode)) {
    process.stderr.write(`unknown --mode ${mode} (quick|full|auto)\n`);
    process.exit(2);
  }
  const card = await score({ mode, compareTo: args["compare-to"], skipGates: args["skip-gates"], dryRun: args["dry-run"], baseline: args.baseline ? resolve(args.baseline) : undefined });
  if (args.json) process.stdout.write(JSON.stringify(card) + "\n");
  else {
    const fmt = (c) => (c.value === null ? `- (${c.skipped ?? c.reason ?? c.error ?? "not measured"})`.slice(0, 110) : `${typeof c.value === "number" ? round(c.value, 3) : c.value}${c.unit ? ` ${c.unit}`.slice(0, 20) : ""}${c.met === undefined ? "" : c.met ? "  ok" : "  MISS"}${c.stale ? "  (stale)" : ""}`);
    process.stdout.write(`mode ${card.mode}  gates ${JSON.stringify(card.gates)}\nheadline ${card.headline ?? "null"}${card.gated ? ` (gated: ${card.gated.join(", ")})` : ""}  coverage ${Math.round(card.coverage * 100)}%\n\n`);
    for (const [k, c] of Object.entries(card.components)) process.stdout.write(`  ${k.padEnd(22)} ${fmt(c)}\n`);
    process.stdout.write(`\nnotes:\n${card.notes.map((n) => `  - ${n}`).join("\n")}\n\nwrote ${join(DOGFOOD_TASKS, "scorecard.json")}\n`);
  }
  process.exitCode = card.gated ? 1 : 0;
}
