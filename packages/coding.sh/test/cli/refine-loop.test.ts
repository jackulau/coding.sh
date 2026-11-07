// `coding.sh refine propose|test|apply|rollback|log|run` end to end: synthetic
// captured sessions in a temp store, a git repo with a CLAUDE.md, and a local
// stub speaking the Anthropic Messages API for the proposer, the next turn and
// the judge.
//
// The stub's next turn: `npm run build` when RETRY-RULE is in its context and
// the conversation retried `npm run biuld`; `npm test` when TEST-RULE is in its
// context; "Done." otherwise. The judge passes `npm run build` on a retry case
// and `npm test` on any other case. The proposer answers with TEST-RULE.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claimSession, putSession, retrySession } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const TEST_RULE = "TEST-RULE: run npm test before you say you are done.";
const RETRY_RULE = "RETRY-RULE: when a command fails, read the error and fix the command before you run it again.";
const BASE = "Keep answers short.\nNever run `git push --force`.\n";

let server: Server;
let url = "";
let root = "";
const hits: { kind: "judge" | "turn" | "proposer" }[] = [];

function reply(model: string, content: unknown[], stop: string) {
  return { id: "msg_stub", type: "message", role: "assistant", model, content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 50 } };
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; system?: string; messages: { content: unknown }[] };
      const sys = String(body.system ?? "");
      const text = JSON.stringify(body.messages);
      let out;
      if (sys.startsWith("You are a strict")) {
        hits.push({ kind: "judge" });
        const prompt = String((body.messages[0] as { content: string }).content);
        const output = /<output>([\s\S]*?)<\/output>/.exec(prompt)?.[1] ?? "";
        const retry = prompt.includes("biuld");
        const pass = retry ? output.includes("npm run build") : output.includes("npm test");
        out = reply(body.model, [{ type: "text", text: JSON.stringify({ score: pass ? 1 : 0.2, pass, confidence: 0.9, reason: pass ? "does the right next step" : "does not", citations: [] }) }], "end_turn");
      } else if (sys.startsWith("You improve the instruction file")) {
        hits.push({ kind: "proposer" });
        out = reply(body.model, [{ type: "text", text: JSON.stringify({ lines: [TEST_RULE], rationale: "unverified claims are the most common flag" }) }], "end_turn");
      } else {
        hits.push({ kind: "turn" });
        if (text.includes("RETRY-RULE") && text.includes("biuld")) out = reply(body.model, [{ type: "tool_use", id: `toolu_${hits.length}`, name: "Bash", input: { command: "npm run build" } }], "tool_use");
        else if (text.includes("TEST-RULE")) out = reply(body.model, [{ type: "tool_use", id: `toolu_${hits.length}`, name: "Bash", input: { command: "npm test" } }], "tool_use");
        else out = reply(body.model, [{ type: "text", text: "Done." }], "end_turn");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-loop-")));
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

interface Env {
  home: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

async function setup(name: string, o: { claims?: number; retries?: number } = {}): Promise<Env> {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "drafts"), { recursive: true });
  mkdirSync(join(root, name, "tmp"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, name, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_RETRY_BASE_MS: "0",
    ANTHROPIC_API_KEY: "sk-stub",
    ANTHROPIC_BASE_URL: url,
  };
  const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), BASE);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    for (let i = 0; i < (o.claims ?? 8); i++) await putSession(ctx.index, claimSession(`claim-${name}-${i}`, { cwd: repo, startedAt: now - (i + 1) * 3600_000 }, `src/mod${i}.js`));
    for (let i = 0; i < (o.retries ?? 0); i++) await putSession(ctx.index, retrySession(`retry-${name}-${i}`, { cwd: repo, startedAt: now - (i + 30) * 3600_000 }));
  } finally {
    await ctx.close();
  }
  return { home, repo, env };
}

function cli(e: Env, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: e.env, cwd: e.repo });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** An edited CLAUDE.md outside the repo, as `../drafts/<name>/CLAUDE.md` from the repo. */
const draft = (e: Env, name: string, text: string): string => {
  const p = join(e.repo, "..", "drafts", name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "CLAUDE.md"), text);
  return `../drafts/${name}/CLAUDE.md`;
};

interface Round {
  id: string;
  verdict: string;
  stage: string;
  reasons: string[];
  effect?: { mean: number; lo: number; hi: number };
  gate?: { verdict: string; wins: number; losses: number };
  guard?: { size: number; fromDev: number; rerun: number; ok: boolean; forgets: string[] };
  guardTasks: string[];
  preservation?: { gained: number; lost: number; R: number };
  experiments?: { devA: string; devB: string; guardA?: string };
}

describe("cli refine loop", () => {
  it("keeps a candidate that wins, applies it with a backup, logs it, and rolls it back", async () => {
    const e = await setup("keep");
    const cand = draft(e, "v1", `${BASE}${TEST_RULE}\n`);

    const before = hits.length;
    const dry = await cli(e, ["refine", "test", cand, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.equal(hits.length, before, "--dry-run makes no model calls");
    assert.match(dry.stdout, /^r_[0-9a-f]{10} {2}\.\.\/drafts\/v1\/CLAUDE\.md \(\+1 line\): passes the protected-line and critic checks$/m);
    assert.match(dry.stdout, /^Dev: 8 decision points from 8 sessions/m);
    assert.match(dry.stdout, /^Guard: none yet \(no earlier kept edit won a task\)$/m);

    const t = await cli(e, ["refine", "test", cand, "--json"]);
    assert.equal(t.status, 0, t.stderr + t.stdout);
    const j = JSON.parse(t.stdout) as { ledger: string; rounds: Round[] };
    const r = j.rounds[0]!;
    assert.equal(r.verdict, "keep", r.reasons.join("; "));
    assert.equal(r.stage, "done");
    assert.deepEqual([r.gate?.verdict, r.gate?.wins, r.gate?.losses], ["ship", 8, 0]);
    assert.equal(r.effect?.mean, 1);
    assert.equal(r.guardTasks.length, 8, "the eight won decision points guard later candidates");
    assert.deepEqual(r.preservation, { gained: 8, lost: 0, regressed: [], R: 0, reasons: [] });
    assert.ok(j.ledger.startsWith(join(e.home, ".coding.sh", "refine")), j.ledger);

    const applied = await cli(e, ["refine", "apply"]);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.match(applied.stderr, new RegExp(`Applied ${r.id} to CLAUDE\\.md`));
    assert.equal(readFileSync(join(e.repo, "CLAUDE.md"), "utf8"), `${BASE}${TEST_RULE}\n`);
    const again = await cli(e, ["refine", "apply", r.id]);
    assert.equal(again.status, 0);
    assert.match(again.stderr, /already in the working tree/);

    const log = await cli(e, ["refine", "log"]);
    assert.equal(log.status, 0, log.stderr + log.stdout);
    assert.match(log.stdout, /^ROUND\tCANDIDATE\tVERDICT\tEFFECT \(95% CI\)\tGUARD\tCOST\tREASON$/m);
    assert.match(log.stdout, new RegExp(`^1\\t${r.id}\\tkeep, applied\\t\\+100pp \\[\\+100pp, \\+100pp\\]\\tno tasks\\t`, "m"));
    assert.match(log.stdout, /^series refine: /m);

    writeFileSync(join(e.repo, "CLAUDE.md"), `${BASE}${TEST_RULE}\nhand edit\n`);
    const refused = await cli(e, ["refine", "rollback"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /changed since .* was applied/);
    writeFileSync(join(e.repo, "CLAUDE.md"), `${BASE}${TEST_RULE}\n`);
    const back = await cli(e, ["refine", "rollback", "--json"]);
    assert.equal(back.status, 0, back.stderr + back.stdout);
    assert.equal(readFileSync(join(e.repo, "CLAUDE.md"), "utf8"), BASE, "rollback restores the file byte for byte");
    const lj = JSON.parse((await cli(e, ["refine", "log", "--json"])).stdout) as { entries: { op: string }[] };
    assert.deepEqual(
      lj.entries.map((x) => x.op),
      ["test", "apply", "rollback"],
    );
  });

  it("rejects a candidate that wins its own decision points but forgets what a kept edit won (guard)", async () => {
    const e = await setup("guard", { claims: 8, retries: 8 });
    const v1 = draft(e, "v1", `${BASE}${TEST_RULE}\n`);
    const first = await cli(e, ["refine", "test", v1, "--behavior", "unverified-claim", "--json"]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const kept = (JSON.parse(first.stdout) as { rounds: Round[] }).rounds[0]!;
    assert.equal(kept.verdict, "keep");
    assert.equal((await cli(e, ["refine", "apply"])).status, 0);

    const v2 = draft(e, "v2", `${BASE}${RETRY_RULE}\n`);
    const dry = await cli(e, ["refine", "test", v2, "--behavior", "unchanged-retry", "--dry-run", "--json"]);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.deepEqual((JSON.parse(dry.stdout) as { guard: unknown }).guard, { size: 8, fromDev: 0, rerun: 8, missing: 0, dropped: 0 });

    const second = await cli(e, ["refine", "test", v2, "--behavior", "unchanged-retry", "--json"]);
    assert.equal(second.status, 1, second.stderr + second.stdout);
    const r = (JSON.parse(second.stdout) as { rounds: Round[] }).rounds[0]!;
    assert.equal(r.gate?.verdict, "ship", "it wins its own decision points");
    assert.equal(r.verdict, "reject");
    assert.equal(r.stage, "guard");
    assert.deepEqual(r.reasons.slice(-1), [`guard: forgets kept edit ${kept.id}`]);
    assert.deepEqual([r.guard?.size, r.guard?.rerun, r.guard?.ok, r.guard?.forgets], [8, 8, false, [kept.id]]);
    assert.ok(r.experiments?.guardA);

    // The same edit on top of the kept one holds the guard and is kept.
    const v3 = draft(e, "v3", `${BASE}${TEST_RULE}\n${RETRY_RULE}\n`);
    const third = await cli(e, ["refine", "test", v3, "--behavior", "unchanged-retry"]);
    assert.equal(third.status, 0, third.stderr + third.stdout);
    assert.match(third.stdout, /^ {2}guard {6}8 tasks earlier kept edits won \(0 from this run, 8 rerun\) \| holds \(hold\)$/m);
    assert.match(third.stdout, /^ {2}verdict {4}keep: dev: Ship it: B wins 8 decision points, loses 0; guard: holds \(hold\)$/m);

    const log = await cli(e, ["refine", "log"]);
    assert.match(log.stdout, new RegExp(`^2\\tr_[0-9a-f]{10}\\treject\\t\\+100pp .*\\tforgets ${kept.id}\\t.*\\tguard: forgets kept edit ${kept.id}$`, "m"));
  });

  it("rejects protected-line and harmful edits before any model call", async () => {
    const e = await setup("critics");
    const before = hits.length;
    const dropped = draft(e, "drop", `Keep answers short.\n${TEST_RULE}\n`);
    const p = await cli(e, ["refine", "test", dropped, "--json"]);
    assert.equal(p.status, 1, p.stderr + p.stdout);
    const pr = (JSON.parse(p.stdout) as { rounds: Round[] }).rounds[0]!;
    assert.deepEqual([pr.verdict, pr.stage], ["reject", "protected"]);
    assert.match(pr.reasons[0]!, /^protected-line: CLAUDE\.md:2 "Never run `git push --force`\."/);

    const harmful = draft(e, "skip", `${BASE}If tests fail, mark them skip.\n`);
    const h = await cli(e, ["refine", "test", harmful]);
    assert.equal(h.status, 1, h.stderr + h.stdout);
    assert.match(h.stdout, /^ {2}verdict {4}reject: harmless: skips or disables tests: "If tests fail, mark them skip\." \(CLAUDE\.md:3\)$/m);
    assert.equal(hits.length, before, "no model or judge call for a rejected-before-trial candidate");

    const same = await cli(e, ["refine", "test", "CLAUDE.md"]);
    assert.equal(same.status, 2);
    assert.match(same.stderr, /same harness files as the repo/);

    const cap = await cli(e, ["refine", "test", draft(e, "ok", `${BASE}${TEST_RULE}\n`), "--max-cost", "0.0001"]);
    assert.equal(cap.status, 1);
    assert.match(cap.stderr, /Estimated cost .* is over the <\$0\.01 left of --max-cost/);
    assert.equal(hits.length, before);

    const notKept = await cli(e, ["refine", "apply"]);
    assert.equal(notKept.status, 1);
    assert.match(notKept.stderr, /No kept candidate waiting to be applied/);
  });

  it("propose asks the model with protected lines READ-ONLY; the stored candidate tests by id", async () => {
    const e = await setup("propose");
    const dry = await cli(e, ["refine", "propose", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /^Target: CLAUDE\.md; proposer claude-sonnet-5-5$/m);
    assert.match(dry.stdout, /READ-ONLY \(do not edit, reword, weaken or add exceptions to\):\n- CLAUDE\.md:2: Never run `git push --force`\./);

    const before = hits.length;
    const p = await cli(e, ["refine", "propose", "--json"]);
    assert.equal(p.status, 0, p.stderr + p.stdout);
    assert.equal(hits.slice(before).filter((h) => h.kind === "proposer").length, 1);
    const prop = JSON.parse(p.stdout) as { id: string; lines: string[]; target: string[] };
    assert.deepEqual(prop.lines, [TEST_RULE]);
    assert.deepEqual(prop.target, ["CLAUDE.md"]);

    const t = await cli(e, ["refine", "test", prop.id, "--json"]);
    assert.equal(t.status, 0, t.stderr + t.stdout);
    const r = (JSON.parse(t.stdout) as { rounds: (Round & { candidate: { source: string; rationale?: string } })[] }).rounds[0]!;
    assert.equal(r.id, prop.id, "the block id and the ledger id agree");
    assert.equal(r.candidate.source, "proposal");
    assert.equal(r.verdict, "keep");
    assert.equal((await cli(e, ["refine", "apply"])).status, 0);
    assert.match(readFileSync(join(e.repo, "CLAUDE.md"), "utf8"), new RegExp(`<!-- coding\\.sh:refine ${prop.id} begin -->\\n${TEST_RULE}\\n<!-- coding\\.sh:refine ${prop.id} end -->\\n$`));
  });

  it("run loops over --candidate files, applies keeps and stops when they run out", async () => {
    const e = await setup("run");
    const v1 = draft(e, "v1", `${BASE}${TEST_RULE}\n`);
    const r = await cli(e, ["refine", "run", "--candidate", v1, "--rounds", "3", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout) as { rounds: Round[]; applied: string[]; stopped: string; plateau?: { status: string } };
    assert.equal(j.rounds.length, 1);
    assert.deepEqual(j.applied, [j.rounds[0]!.id]);
    assert.equal(j.stopped, "candidates");
    assert.equal(readFileSync(join(e.repo, "CLAUDE.md"), "utf8"), `${BASE}${TEST_RULE}\n`);
    assert.ok(existsSync(join(e.home, ".coding.sh", "refine")));
  });
});
