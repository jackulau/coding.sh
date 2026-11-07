#!/usr/bin/env node
// `exp run` with a matrix spec, end to end against a local stub model: a
// command agent asks the model (the model name and the system prompt come from
// the cell) and a regex grader checks the answer is in capitals. Under a
// throwaway HOME:
//
//   a 2x2 matrix (model x prompt), baseline model=small,prompt=plain
//     -> exp run --plan prints 4 cells, stores nothing, calls no model
//     -> exp run runs 4 x 8 case-trials interleaved; each cell is stored as
//        its own experiment with metadata.matrix, compared with the baseline,
//        and the McNemar p-values are Holm-adjusted (p (Holm) >= p)
//     -> exp compare on two stored cells matches the matrix row and is
//        not flagged as run at different times
//     -> --cell runs a subset plus the baseline
//   a variants spec where a cell changes a path outside "vary"
//     -> exits 2 before any model call and stores nothing
//
// The stub plays the agent: in capitals when the system prompt says SHOUT, in
// capitals for every other question when the model is stub-big, else as given.
//
//   node scripts/e2e/exp-matrix.mjs [--keep]
//
// Runs coding.sh from source (Node 24 strips the types). No network. Never
// touches the real HOME. Exit 0 when every check passed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "packages", "coding.sh", "src", "cli", "main.ts");
const keep = process.argv.includes("--keep");
const QUESTIONS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

const log = (...a) => console.log("[exp-matrix]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

// ------------------------------------------------------------------ the stub's part

const counts = { agent: 0 };
const calls = [];
const systemText = (body) => (typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text ?? "").join("\n") : "");
const userText = (body) => body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function scenario(body) {
  if (!Array.isArray(body.messages)) return undefined;
  const sys = systemText(body);
  if (!sys.startsWith("AGENT:")) return { text: "ok" };
  counts.agent++;
  const q = userText(body).trim();
  calls.push(`${body.model}:${sys.includes("SHOUT") ? "shout" : "plain"}`);
  const caps = sys.includes("SHOUT") || (body.model === "stub-big" && QUESTIONS.indexOf(q) % 2 === 0);
  return { text: caps ? q.toUpperCase() : q };
}

// The agent: case input {q} on stdin; MODEL and PROMPT (a file) from the cell's env.
const AGENT = `import { readFileSync } from "node:fs";
let s = "";
for await (const c of process.stdin) s += c;
const q = JSON.parse(s).q;
const system = "AGENT: " + readFileSync(new URL("./" + process.env.PROMPT, import.meta.url), "utf8");
const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "sk-stub", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: process.env.MODEL, max_tokens: 64, system, messages: [{ role: "user", content: q }] }),
});
const j = await res.json();
process.stdout.write(j.content.map((c) => c.text ?? "").join(""));
`;

// ------------------------------------------------------------------ main

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-expmatrix-"));
const home = join(root, "home");
const proj = join(root, "proj");
mkdirSync(proj, { recursive: true });
mkdirSync(home, { recursive: true });
const stub = await startStub({ decide: scenario });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODING_SH)/i.test(k)) env[k] = v;
Object.assign(env, { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1", ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-stub" });
// Async: the stub answers from this process, so a blocking spawnSync would starve it.
const cli = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
const json = (r, what) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}: not JSON (exit ${r.status}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
  }
};
const base = {
  name: "shout-matrix",
  dataset: "qa",
  task: { kind: "command", command: process.execPath, args: [join(proj, "agent.mjs")], env: { MODEL: "stub-small", PROMPT: "plain.md" }, timeoutMs: 60_000 },
  graders: [{ kind: "regex", name: "caps", pattern: "^[A-Z]+$" }],
};
const MATRIX = {
  ...base,
  matrix: {
    model: { path: "/task/env/MODEL", values: [{ small: "stub-small" }, { big: "stub-big" }] },
    prompt: { path: "/task/env/PROMPT", values: [{ plain: "plain.md" }, { shout: "shout.md" }] },
  },
  baseline: { model: "small", prompt: "plain" },
};
const experiments = async () => json(await cli(["exp", "list", "--limit", "100", "--json"]), "exp list").experiments;

log(`temp root ${root}`);
log(`stub model on ${stub.url}`);
let exitCode = 0;
try {
  writeFileSync(join(proj, "agent.mjs"), AGENT);
  writeFileSync(join(proj, "plain.md"), "Answer with the word you are given.\n");
  writeFileSync(join(proj, "shout.md"), "SHOUT: answer with the word you are given.\n");
  writeFileSync(join(proj, "matrix.json"), `${JSON.stringify(MATRIX, null, 2)}\n`);
  const add = await cli(["dataset", "add", "qa", ...QUESTIONS.flatMap((q) => ["--case", JSON.stringify({ id: q, input: { q } })])]);
  check(add.status === 0, "dataset add qa", add.stderr);

  // 1. --plan: the cells, nothing run, nothing stored.
  const plan = await cli(["exp", "run", "matrix.json", "--plan"]);
  log(`exp run --plan:\n${plan.stdout}`);
  check(plan.status === 0 && plan.stdout.trim().split("\n").length === 4, "plan: 4 cells", plan.stdout + plan.stderr);
  check(/^model=small,prompt=plain {2}\(baseline\)$/m.test(plan.stdout), "plan: the baseline cell is marked", plan.stdout);
  check(/^model=big,prompt=shout +\/task\/env\/MODEL="stub-big" \/task\/env\/PROMPT="shout\.md"$/m.test(plan.stdout), "plan: a cell lists what it changes, in vary order", plan.stdout);
  check(counts.agent === 0 && (await experiments()).length === 0, "plan: no model call, nothing stored", { agent: counts.agent });

  // 2. The full run.
  const text = await cli(["exp", "run", "matrix.json", "--seed", "11"]);
  log(`exp run matrix.json:\n${text.stdout}`);
  check(text.status === 0, "run: exits 0", text.stderr);
  check(counts.agent === 32, "run: 4 cells x 8 cases, one model call each", counts.agent);
  check(new Set(calls.slice(0, 8)).size > 1, "run: the cells are interleaved, not run one after another", calls.slice(0, 8));
  check(/Holm-adjusted over 3 comparisons/.test(text.stdout), "run: the note says Holm over 3", text.stdout);
  const listed = await experiments();
  check(listed.length === 4 && listed.every((e) => e.name.startsWith("shout-matrix/model=")), "run: 4 experiments stored as <name>/<cell>", listed.map((e) => e.name));

  // 3. The same run as JSON (a second matrix run, same seed): ids, per-cell results, Holm.
  calls.length = 0;
  const r = json(await cli(["exp", "run", "matrix.json", "--seed", "11", "--json"]), "exp run --json");
  check(r.outcome === "completed" && /^mx_/.test(r.matrix?.id ?? "") && r.matrix.seed === 11, "json: outcome, matrix id and seed", r.matrix);
  check(r.plan?.baseline === "model=small,prompt=plain" && r.plan.cells.length === 4, "json: the plan", r.plan);
  const cmp = r.comparisons ?? {};
  check(Object.keys(cmp).length === 3 && !("model=small,prompt=plain" in cmp), "json: one comparison per non-baseline cell", Object.keys(cmp));
  const shout = cmp["model=small,prompt=shout"];
  const big = cmp["model=big,prompt=plain"];
  check(shout?.mcnemar.c === 8 && shout.mcnemar.b === 0 && shout.holmVerdict === "better", "json: SHOUT fixes 8 of 8, better after Holm", shout && { mcnemar: shout.mcnemar, pHolm: shout.pHolm });
  check(big?.mcnemar.c === 4 && big.holmVerdict === "inconclusive", "json: the big model fixes 4 of 8, inconclusive", big && { mcnemar: big.mcnemar, pHolm: big.pHolm });
  check(Object.values(cmp).every((c) => c.pHolm >= c.mcnemar.p - 1e-12), "json: p (Holm) >= p for every cell");
  check(Object.values(cmp).every((c) => c.timing.interleaved === true && c.timing.warning === undefined), "json: every comparison is interleaved, no timing warning");

  // 4. exp compare on two stored cells gives the matrix row.
  const again = json(await cli(["exp", "compare", r.experiments["model=small,prompt=plain"], r.experiments["model=small,prompt=shout"], "--json"]), "exp compare").comparison;
  check(again.diff.mean === shout.diff.mean && again.mcnemar.p === shout.mcnemar.p && again.timing.interleaved === true, "compare: the stored cells match the matrix row", { diff: again.diff, timing: again.timing });

  // 5. --cell: a subset plus the baseline.
  const before = counts.agent;
  const sub = json(await cli(["exp", "run", "matrix.json", "--cell", "model=big,prompt=shout", "--json"]), "exp run --cell");
  check(Object.keys(sub.experiments).join(" ") === "model=small,prompt=plain model=big,prompt=shout" && counts.agent - before === 16, "cell: the baseline and one cell, 16 calls", { cells: Object.keys(sub.experiments), calls: counts.agent - before });
  check(sub.comparisons["model=big,prompt=shout"].pHolm === sub.comparisons["model=big,prompt=shout"].mcnemar.p, "cell: a single comparison keeps its raw p");

  // 6. A variant that changes a path outside "vary" is refused before any call.
  const stored = (await experiments()).length;
  const calledBefore = counts.agent;
  writeFileSync(
    join(proj, "variants.json"),
    `${JSON.stringify({ ...base, vary: ["/task/env/PROMPT"], variants: { plain: {}, shout: { "/task/env/PROMPT": "shout.md", "/task/env/MODEL": "stub-big" } }, baseline: "plain" }, null, 2)}\n`,
  );
  const bad = await cli(["exp", "run", "variants.json"]);
  log(`exp run variants.json (vary violation):\n${bad.stderr}`);
  check(bad.status === 2, "vary: exits 2", { status: bad.status, stderr: bad.stderr });
  check(/outside "vary"/.test(bad.stderr) && /shout: \/task\/env\/MODEL/.test(bad.stderr), "vary: names the cell and the path", bad.stderr);
  check(counts.agent === calledBefore && (await experiments()).length === stored, "vary: no model call, nothing stored");
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
