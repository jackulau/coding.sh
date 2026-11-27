import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { CliError } from "../../src/cli/output.ts";
import { UsageError } from "../../src/cli/args.ts";
import * as attribution from "../../src/cli/commands/attribution.ts";
import * as blame from "../../src/cli/commands/blame.ts";
import * as collector from "../../src/cli/commands/collector.ts";
import * as doctor from "../../src/cli/commands/doctor.ts";
import * as evalCmd from "../../src/cli/commands/eval.ts";
import * as expCmd from "../../src/cli/commands/exp.ts";
import * as expSession from "../../src/cli/commands/exp-session.ts";
import * as judgeCmd from "../../src/cli/commands/judge.ts";
import * as proxyCmd from "../../src/cli/commands/proxy.ts";
import * as refineDiag from "../../src/cli/commands/refine-diagnose.ts";
import * as searchCmd from "../../src/cli/commands/search.ts";
import * as showCmd from "../../src/cli/commands/show.ts";
import * as workCmd from "../../src/cli/commands/work.ts";
import * as workflowsCmd from "../../src/cli/commands/workflows.ts";
import { datasetVersion } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { signalsFile } from "../../src/refine/diagnose.ts";
import { refineDir } from "../../src/refine/ledger.ts";
import { catalogHash } from "../../src/refine/taxonomy.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { ganttRunFixture } from "../workflows/_fixtures.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const FAR = MAX_DATE_MS + 1;
const PAST = -MAX_DATE_MS - 1;

const sandboxes: Sandbox[] = [];
after(() => {
  for (const sb of sandboxes) sb.cleanup();
});
const makeSandbox = () => {
  const sb = sandbox();
  sandboxes.push(sb);
  return sb;
};

describe("CLI commands date range handling", () => {
  it("search --json returns null for an out-of-range event timestamp and keeps valid hits", async () => {
    const sb = makeSandbox();
    const sFar = mkSession("s-far", FAR);
    const sOk = mkSession("s-ok", T0);
    await sb.seed(
      [sFar, sOk],
      [
        { id: "e-far", v: 0, sessionId: sFar.id, ts: FAR, agent: "claude-code", kind: "user.message", payload: { text: "needle far" } },
        { id: "e-ok", v: 0, sessionId: sOk.id, ts: T0, agent: "claude-code", kind: "user.message", payload: { text: "needle ok" } },
      ],
    );
    const r = await runCmd(searchCmd, sb, { positionals: ["needle"], json: true });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    const hits = r.json.hits as { eventId: string; ts: string | null }[];
    assert.equal(hits.length, 2);
    assert.equal(hits.find((h) => h.eventId === "e-far")!.ts, null);
    assert.equal(hits.find((h) => h.eventId === "e-ok")!.ts, "2026-11-01T10:00:00.000Z");
  });

  it("show prints placeholders for out-of-range session and phase timestamps", async () => {
    const sb = makeSandbox();
    const s = mkSession("s-ph", FAR, {
      endedAt: undefined,
      stats: {
        events: 3,
        turns: 2,
        toolCalls: 0,
        toolErrors: 0,
        filesChanged: 0,
        phases: [
          { n: 1, kind: "start", startTs: FAR, endTs: FAR, from: 0, to: 1, eventId: "e1", events: 1, prompts: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, tokens: 0 },
          { n: 2, kind: "idle", startTs: T0, endTs: T0, from: 1, to: 3, eventId: "e2", events: 2, prompts: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, tokens: 0 },
        ],
      },
    });
    await sb.seed([s], [
      { id: "e1", v: 0, sessionId: s.id, ts: FAR, agent: "claude-code", kind: "user.message", payload: { text: "first" } },
      { id: "e2", v: 0, sessionId: s.id, ts: T0, agent: "claude-code", kind: "user.message", payload: { text: "second" } },
    ]);
    const r = await runCmd(showCmd, sb, { positionals: [s.id], flags: { limit: 1 } });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes("Invalid"));
    assert.ok(r.stdout.includes("Phases"));
  });

  it("doctor --json returns null for an out-of-range lastEventAt", async () => {
    const sb = makeSandbox();
    await sb.seed([mkSession("s-doc-far", FAR, { endedAt: 1e300 })]);
    const r = await runCmd(doctor, sb, { json: true, flags: { agent: "claude-code" } });
    assert.equal(r.error, undefined);
    const agent = (r.json.agents as { id: string; lastEventAt: string | null }[]).find((a) => a.id === "claude-code")!;
    assert.equal(agent.lastEventAt, null);
  });

  it("proxy status --json returns null for an out-of-range proxy.json startedAt", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(
      join(sb.env.CODING_SH_HOME!, "proxy.json"),
      JSON.stringify({ pid: 99999999, url: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, startedAt: FAR, upstreams: { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" } }),
    );
    const r = await runCmd(proxyCmd, sb, { action: "status", json: true });
    assert.equal(r.error, undefined);
    assert.equal(r.json.startedAt, null);
  });

  it("eval list --json returns null for an out-of-range task createdAt and keeps valid tasks", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    const index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
    try {
      await index.migrate();
      await index.putTask({ id: "t-far", name: "far", status: "draft", start: { repoRoot: sb.root, snapshot: "abc", head: "abc" }, instruction: "do", setup: [], verifier: { command: "true", timeoutMs: 10_000, hiddenFiles: {} }, tags: [], createdAt: FAR });
      await index.putTask({ id: "t-ok", name: "ok", status: "draft", start: { repoRoot: sb.root, snapshot: "abc", head: "abc" }, instruction: "do", setup: [], verifier: { command: "true", timeoutMs: 10_000, hiddenFiles: {} }, tags: [], createdAt: T0 });
    } finally {
      await index.close();
    }
    const r = await runCmd(evalCmd, sb, { action: "list", json: true });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    const tasks = r.json.tasks as { id: string; createdAt: string | null }[];
    assert.equal(tasks.find((t) => t.id === "t-far")!.createdAt, null);
    assert.equal(tasks.find((t) => t.id === "t-ok")!.createdAt, "2026-11-01T10:00:00.000Z");
  });

  it("exp list --json and exp session summary --json handle out-of-range createdAt", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    const index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
    try {
      await index.migrate();
      const store = new FileEvalStore({ root: sb.env.CODING_SH_HOME!, index });
      await store.putExperiment({
        id: "exp-far",
        name: "far",
        dataset: { id: "d1", name: "d", version: "v1" },
        task: { kind: "command", command: "true" } as never,
        graders: [],
        trials: 1,
        createdAt: FAR,
        runs: [],
        summary: { cases: 0, n: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0, n: 0 }, graders: {} },
      } as never);
      await store.putExperiment({
        id: "exp-ok",
        name: "ok",
        dataset: { id: "d1", name: "d", version: "v1" },
        task: { kind: "command", command: "true" } as never,
        graders: [],
        trials: 1,
        createdAt: T0,
        runs: [],
        summary: { cases: 0, n: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0, n: 0 }, graders: {} },
      } as never);
    } finally {
      await index.close();
    }
    const r = await runCmd(expCmd, sb, { action: "list", json: true });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    const exps = r.json.experiments as { id: string; createdAt: string | null }[];
    assert.equal(exps.find((e) => e.id === "exp-far")!.createdAt, null);
    assert.equal(exps.find((e) => e.id === "exp-ok")!.createdAt, "2026-11-01T10:00:00.000Z");

    const proj = join(sb.root, "proj");
    mkdirSync(join(proj, ".coding-sh"), { recursive: true });
    writeFileSync(join(proj, ".coding-sh", "session.json"), JSON.stringify({ id: "es_far", name: "s", createdAt: FAR }));
    const sr = await runCmd({ run: (c) => expSession.sessionCommand(c, new FileEvalStore({ root: sb.env.CODING_SH_HOME! })) }, sb, { positionals: ["summary"], cwd: proj, json: true });
    assert.equal(sr.error, undefined);
    assert.equal(sr.code, 0);
    assert.equal("createdAt" in sr.json.session, false);
  });

  it("refine signals show prints '-' for out-of-range firstSeen/lastSeen", async () => {
    const sb = makeSandbox();
    const repo = join(sb.root, "sig-repo");
    mkdirSync(repo, { recursive: true });
    const file = signalsFile(refineDir(sb.env, repo));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        catalog: catalogHash(),
        sessions: {},
        signals: [
          {
            id: "sig_far",
            key: "k",
            title: "Out of range signal",
            component: { type: "skill", name: "x" },
            typeIds: ["loop"],
            status: "open",
            firstSeen: PAST,
            lastSeen: FAR,
            analyzedSinceLastSeen: 0,
            population: { affected: 1, analyzed: 1 },
            severity: { score: 40, level: "medium", drivingNature: "inefficiency", parts: [{ nature: "inefficiency", score: 40 }] },
            occurrences: [],
          },
        ],
      }),
    );
    const r = await runCmd({ run: refineDiag.refineSignals }, sb, { positionals: ["show", "sig_far"], cwd: repo });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("- to -"), r.stdout);
  });

  it("work show and work snooze handle out-of-range timestamps and durations", async () => {
    const sb = makeSandbox();
    const now = Date.now();
    const parent = mkSession("wf-p", now - 3600_000, { cwd: sb.root, endedAt: undefined });
    const aFar = mkSession("wf-a-far", FAR, { cwd: sb.root, endedAt: undefined, parent: { sessionId: parent.id, workflowId: "wf1", phase: "p", label: "far" } });
    const aOk = mkSession("wf-a-ok", now - 60_000, { cwd: sb.root, endedAt: now - 30_000, parent: { sessionId: parent.id, workflowId: "wf1", phase: "p", label: "ok" } });
    await sb.seed([parent, aFar, aOk]);
    const { workItemId, workflowRunKey } = await import("../../src/core/work.ts");
    const runId = workItemId(workflowRunKey(parent.id, "wf1"));

    const shown = await runCmd(workCmd, sb, { action: "show", positionals: [runId], json: true });
    assert.equal(shown.error, undefined);
    assert.equal(shown.code, 0);
    const agents = shown.json.workflowAgents as { sessionId: string; startedAt: string | null }[];
    assert.equal(agents.find((a) => a.sessionId === aFar.id)!.startedAt, null);
    assert.equal(agents.find((a) => a.sessionId === aOk.id)!.startedAt, new Date(aOk.startedAt).toISOString());

    const sn = await runCmd(workCmd, sb, { action: "snooze", positionals: [runId, "999999999999999d"] });
    assert.ok(sn.error instanceof UsageError);
  });

  it("workflows show ambiguous error sets out-of-range startedAt to null and keeps valid runs", async () => {
    const sb = makeSandbox();
    const store = new WorkflowStore(join(sb.env.CODING_SH_HOME!, "workflows"));
    const fx = ganttRunFixture();
    await store.putRun({ ...fx.run, id: "wf_ambig_far", startedAt: FAR, endedAt: undefined }, []);
    await store.putRun({ ...fx.run, id: "wf_ambig_ok", startedAt: T0, endedAt: T0 + 1000 }, []);
    const r = await runCmd(workflowsCmd, sb, { action: "show", positionals: ["wf_ambig_"], json: true });
    assert.ok(r.error instanceof CliError);
    const candidates = (r.error.data as { candidates: { id: string; startedAt: string | null }[] }).candidates;
    assert.equal(candidates.find((c) => c.id === "wf_ambig_far")!.startedAt, null);
    assert.equal(candidates.find((c) => c.id === "wf_ambig_ok")!.startedAt, "2026-11-01T10:00:00.000Z");
  });

  it("attribution and blame --json return null for an out-of-range session startedAt", async () => {
    const sb = makeSandbox();
    const repo = join(sb.root, "git-repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Dev"]);
    writeFileSync(join(repo, "file.ts"), "export const answer = 42;\n");
    execFileSync("git", ["-C", repo, "add", "file.ts"]);
    const farSec = 8_640_000_001_000;
    const farMs = farSec * 1000;
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add answer"], {
      env: { ...process.env, GIT_AUTHOR_DATE: `@${farSec} +0000`, GIT_COMMITTER_DATE: `@${farSec} +0000` },
    });

    const sFar = mkSession("attr-far", farMs, { cwd: repo, repo: { root: repo, head: "" }, endedAt: farMs + 1000 });
    await sb.seed(
      [sFar],
      [
        {
          id: "fc1",
          v: 0,
          sessionId: sFar.id,
          ts: farMs + 500,
          agent: "claude-code",
          kind: "tool.start",
          cwd: repo,
          repo: { root: repo, head: "" },
          payload: { tool: "Write", toolUseId: "w1", input: { file_path: join(repo, "file.ts"), content: "export const answer = 42;\n" } },
        },
        {
          id: "fc2",
          v: 0,
          sessionId: sFar.id,
          ts: farMs + 600,
          agent: "claude-code",
          kind: "tool.end",
          cwd: repo,
          repo: { root: repo, head: "" },
          payload: { tool: "Write", toolUseId: "w1", ok: true },
        },
      ],
    );
    const ar = await runCmd(attribution, sb, { cwd: repo, flags: { all: true }, json: true });
    assert.equal(ar.error, undefined);
    assert.equal(ar.code, 0);
    assert.equal(ar.json.since, null);
    const aSess = (ar.json.sessions as { id: string; startedAt: string | null }[]).find((s) => s.id === sFar.id);
    assert.equal(aSess?.startedAt, null);
    const aCommit = (ar.json.commits as { committedAt: string | null; authoredAt: string | null }[])[0];
    assert.equal(aCommit?.committedAt, null);
    assert.equal(aCommit?.authoredAt, null);

    const br = await runCmd(blame, sb, { cwd: repo, positionals: ["file.ts"], json: true });
    assert.equal(br.error, undefined);
    assert.equal(br.code, 0);
    const bSess = (br.json.sessions as { id: string; startedAt: string | null }[]).find((s) => s.id === sFar.id);
    assert.equal(bSess?.startedAt, null);
  });

  it("collector import omits the cursor note when the returned cursor timestamp is out of the Date range", async () => {
    const sb = makeSandbox();
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (body.includes("system.columns")) {
          res.end(JSON.stringify({ data: [{ name: "SpanAttributes", type: "Map(String, String)" }] }));
          return;
        }
        // Return one span row whose timestamp_ns is beyond MAX_DATE_MS * 1e6.
        const hugeNs = String(BigInt(MAX_DATE_MS + 10) * 1_000_000n);
        res.end(
          JSON.stringify({
            Timestamp: hugeNs,
            TraceId: "1".repeat(32),
            SpanId: "2".repeat(16),
            ParentSpanId: "",
            SpanName: "chat",
            SpanKind: "SPAN_KIND_CLIENT",
            ServiceName: "demo",
            Duration: "1000000",
            StatusCode: "STATUS_CODE_OK",
            StatusMessage: "",
            ResourceAttributes: { "service.name": "demo" },
            ScopeName: "demo",
            ScopeVersion: "1.0",
            SpanAttributes: { "gen_ai.system": "openai" },
            EventsTimestamp: [],
            EventsName: [],
            EventsAttributes: [],
          }) + "\n",
        );
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = srv.address() as AddressInfo;
      const r = await runCmd(collector, sb, { action: "import", flags: { clickhouse: `http://127.0.0.1:${port}/?database=otel`, since: "1d" } });
      assert.equal(r.error, undefined);
      assert.ok(!r.stderr.includes("Next run starts after"));
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("judge calibrate omits an out-of-range prior calibration date from the warning", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    const index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
    try {
      await index.migrate();
      const store = new FileEvalStore({ root: sb.env.CODING_SH_HOME!, index });
      const cases = [{ id: "c1", input: "x", split: "test" as const }];
      const version = datasetVersion(cases);
      await store.putDataset({ id: "ds1", name: "ds1", version, createdAt: T0, cases });
      await store.putJudge({
        id: "gv1",
        name: "quality",
        version: "gv1",
        rubric: "good?",
        model: "mock",
        status: "calibrated",
        createdAt: T0,
        calibration: { state: "calibrated", n: 20, kappa: 0.9, sensitivity: 0.9, specificity: 0.9, ts: FAR } as never,
      } as never);
      await store.putExperiment({
        id: "exp_jfar",
        name: "e",
        dataset: { id: "ds1", name: "ds1", version },
        task: { kind: "command", command: "true" } as never,
        graders: [{ id: "g1", name: "quality", kind: "llm", version: "gv1", judgeId: "j_far" }],
        trials: 1,
        createdAt: T0,
        runs: [{ caseId: "c1", trial: 1, latencyMs: 1, pass: true, grades: [{ graderId: "g1", result: { score: 1, pass: true } }] }],
        summary: { cases: 1, n: 1, passed: 1, errors: 0, passRate: { p: 1, lo: 0, hi: 1, n: 1 }, graders: {} },
      } as never);
    } finally {
      await index.close();
    }
    const r = await runCmd(judgeCmd, sb, { action: "calibrate", positionals: ["exp_jfar"] });
    assert.equal(r.error, undefined);
    assert.match(r.stderr, /Kept the judge's stored calibration \(calibrated, n=20\):/);
  });
});
