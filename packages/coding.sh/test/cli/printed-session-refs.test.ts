// Every session reference a command prints, in a command or in a sentence, opens the session it
// names when pasted back. Each store holds sessions the old text got wrong: two ids that share
// their first 8 characters (a printed prefix opens neither), and ids that a pasted full id can't
// open (one holding a space, one spelled `latest`, which opens the newest session).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { which } from "../../src/adapters/_shared/detect.ts";
import * as evalCmd from "../../src/cli/commands/eval.ts";
import * as improve from "../../src/cli/commands/improve.ts";
import * as show from "../../src/cli/commands/show.ts";
import { posixShell } from "../../src/core/spawn.ts";
import type { AgentEvent } from "../../src/core/types.ts";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { createViewerHandler, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { CLI } from "../_cli.ts";
import { improveWorld } from "../helpers-improve.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

/** The id of the session `ref` opens with `coding.sh show`, or the error it gets. */
async function opens(sb: Sandbox, ref: string): Promise<string> {
  const r = await runCmd(show, sb, { positionals: [ref], json: true, flags: { fields: "session.id" } });
  return r.error ? `error: ${r.error.message}` : r.json.session.id;
}

/**
 * The words a POSIX shell passes for a printed command line: split on blanks, grouped by quotes, a
 * backslash keeping the next character, and an unquoted or double-quoted `$name` expanded to nothing.
 */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (ch === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (ch === " " || ch === "\t")) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    const variable = ch === "$" ? /^\$(\{[^}]*\}|[A-Za-z_]\w*|[0-9?#@*!$-])/.exec(line.slice(i)) : null;
    if (variable) i += variable[0].length - 1;
    else if (!quote && (ch === "'" || ch === '"')) quote = ch;
    else if (ch === "\\") word += line[++i] ?? "";
    else word += ch;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** The session reference in a printed `coding.sh <cmd...> <ref> [--flag ...]`, as a shell passes it: one word, or the test fails. */
function refIn(line: string, ...cmd: string[]): string {
  const [bin, ...args] = shellWords(line.trim());
  assert.match(bin ?? "", /^coding\.?sh$/, line);
  assert.deepEqual(args.slice(0, cmd.length), cmd, line);
  const [ref, next] = args.slice(cmd.length);
  assert.ok(ref !== undefined && (next === undefined || next.startsWith("-")), `${line}: the shell passes ${JSON.stringify(args.slice(cmd.length))}`);
  return ref;
}

/** One MCP tool call against the sandbox's store, from `cwd`: its text, its structured result and whether it failed. */
async function mcpCall(sb: Sandbox, cwd: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; data?: any }> {
  // In-process MCP reads resolve agent homes through process.env: point them at the sandbox.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  const mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd, log: () => {}, autoIngest: async () => ({ pendingFiles: 0, indexing: false }) });
  try {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    return { isError: res.isError, text: res.content[0]!.text, data: res.structuredContent };
  } finally {
    await mcp.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A git repository with one commit under the sandbox. */
function gitRepo(sb: Sandbox): { root: string; head: string } {
  const root = join(sb.root, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "test.js"), "process.exit(0);\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "start");
  return { root, head: git("rev-parse", "HEAD") };
}

let seq = 0;
function ev(sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-${++seq}`, v: 0, sessionId, ts: 1_000 + seq, agent: "claude-code", kind, payload, ...extra };
}

const A = "abcd1234-aaaa-4000-8000-000000000001";
const B = "abcd1234-bbbb-4000-8000-000000000002";
const SPACED = "team chat 1";

describe("eval init names each session by a reference that opens it", () => {
  let sb: Sandbox;
  let repo: { root: string; head: string };
  /** What eval init printed, stdout and stderr. */
  let out = "";
  before(async () => {
    sb = sandbox();
    repo = gitRepo(sb);
    const now = Date.now();
    const at = { repo: { root: repo.root, head: repo.head } };
    await sb.seed(
      [mkSession(A, now - 3000, at), mkSession(B, now - 2000, at), mkSession(SPACED, now - 1000, at)],
      [
        ev(A, "session.start", {}, at),
        ev(A, "user.message", { text: "make the first test pass" }),
        ev(B, "session.start", {}, at),
        ev(B, "user.message", { text: "make the second test pass" }),
        // No prompt: init skips it and names `eval new <ref> --instruction`.
        ev(SPACED, "session.start", {}, at),
      ],
    );
    const r = await runCmd(evalCmd, sb, { action: "init", positionals: ["refs"], flags: { session: [A, B, SPACED], verifier: "node test.js" }, cwd: repo.root });
    assert.equal(r.error, undefined, String(r.error?.message));
    out = r.stdout + r.stderr;
  });
  after(() => sb.cleanup());

  test("each task row's from-session reference opens its session", async () => {
    const rows = [...out.matchAll(/from session (\S+)/g)].map((m) => m[1]!);
    assert.equal(rows.length, 2, out);
    assert.deepEqual(await Promise.all(rows.map((ref) => opens(sb, ref))), [A, B]);
  });

  test("the note for a session with no prompt names it, and the eval new command, by a reference that opens it", async () => {
    const skipped = /skipped session (\S+):/.exec(out)?.[1];
    const draft = /eval new (\S+) --instruction/.exec(out)?.[1];
    assert.ok(skipped && draft, out);
    assert.equal(await opens(sb, skipped), SPACED);
    assert.equal(await opens(sb, draft), SPACED);
  });

  test("eval_init over MCP names the eval new command by a reference that opens the session", async () => {
    const r = await mcpCall(sb, repo.root, "eval_init", { name: "mcp-refs", confirm: true, source: "sessions", sessionIds: [SPACED] });
    assert.equal(r.isError, true, r.text);
    const draft = /eval new (\S+) --instruction/.exec(r.text)?.[1];
    assert.ok(draft, r.text);
    assert.equal(await opens(sb, draft), SPACED);
  });
});

describe("eval new names a session whose id is latest by its alias when the ledger fails", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    const now = Date.now();
    const at = { repo: { root: "/work/demo", head: "abc1234" } };
    await sb.seed(
      [mkSession("latest", now - 3000, at), mkSession(B, now - 1000, at)],
      [ev("latest", "session.start", {}, at), ev("latest", "user.message", { text: "add a --json flag to the report command" }), ev("latest", "user.message", { text: "and keep the text output as it is" })],
    );
  });
  after(() => sb.cleanup());

  test("the error and its next step open the session the command drafted from", async () => {
    // The mock judge writes no ledger, offline: the draft fails the way a model's bad answer does.
    const r = await runCmd(evalCmd, sb, { action: "new", positionals: ["x_brf2qjp3"], flags: { statement: "ledger", judge: '{"provider":"mock"}' } });
    assert.equal(r.error?.reason, "draft_failed", String(r.error?.message));
    const named = /requirement ledger for (\S+):/.exec(r.error.message)?.[1];
    const again = /eval new (\S+) --statement ledger/.exec(r.error.next.join("\n"))?.[1];
    assert.ok(named && again, `${r.error.message}\n${r.error.next}`);
    assert.equal(await opens(sb, named), "latest");
    assert.equal(await opens(sb, again), "latest");
  });
});

describe("improve names each session by a reference that opens it", () => {
  let sb: Sandbox;
  /** improveWorld stores: every session lost prompt cache; and every session went wrong after the CLAUDE.md change. */
  let cost: Sandbox & { repo: string };
  let regressed: Sandbox & { repo: string };
  before(async () => {
    sb = sandbox();
    // The two newest sessions after the change: one whose id holds a space, one whose id is `latest`.
    const ids = { "after-5": SPACED, "after-4": "latest" };
    const on = async (name: string, o: Parameters<typeof improveWorld>[2]) => {
      const w = await improveWorld(sb.root, name, { ...o, ids });
      return { ...sb, env: { ...sb.env, ...w.env, SHELL: "/bin/sh" }, repo: w.repo };
    };
    cost = await on("cost", { afterFlagged: 0, cacheBreaks: true });
    regressed = await on("regressed", { afterFlagged: 6, beforeTested: true });
  });
  after(() => sb.cleanup());

  test("the See it happen steps, in text and --json, and the first next step open each issue's example", async () => {
    const j = await runCmd(improve, cost, { json: true, cwd: cost.repo });
    const issues = j.json.issues as { examples: { sessionId: string }[]; next: { label: string; command: string }[] }[];
    const examples = issues.map((i) => i.examples[0]!.sessionId);
    assert.equal(examples[0], SPACED, "the top issue's example is a session the old text got wrong");
    const inJson = issues.map((i) => refIn(i.next.find((s) => s.label === "See it happen")!.command, "show"));
    const t = await runCmd(improve, cost, { cwd: cost.repo });
    const inText = [...t.stdout.matchAll(/See it happen: (.+)$/gm)].map((m) => refIn(m[1]!, "show"));
    for (const refs of [inJson, inText]) assert.deepEqual(await Promise.all(refs.map((ref) => opens(cost, ref))), examples);
    const first = /Start with the first one:\n(.+)$/m.exec(t.stderr)?.[1];
    assert.ok(first, t.stderr);
    assert.equal(await opens(cost, refIn(first, "show")), SPACED);
  });

  test("improve fix on an issue with no line to add names the session to see by a reference that opens it", async () => {
    const r = await runCmd(improve, cost, { action: "fix", positionals: ["1"], cwd: cost.repo });
    assert.equal(r.error?.reason, "no_rule", String(r.error?.message));
    assert.equal(await opens(cost, refIn(r.error.next[1], "show")), SPACED);
  });

  test("improve check lists the sessions still flagged, and names the one to see, by references that open them", async () => {
    const j = await runCmd(improve, regressed, { action: "check", json: true, cwd: regressed.repo });
    const flagged = (j.json.changes[0].after.flaggedSessions as { id: string }[]).map((s) => s.id).slice(0, 5);
    assert.deepEqual(flagged.slice(0, 2), [SPACED, "latest"], "the newest flagged sessions are the ones the old text got wrong");
    const t = await runCmd(improve, regressed, { action: "check", cwd: regressed.repo });
    assert.equal(t.code, 1, t.stderr);
    const list = /Still flagged after it[^\n]*\n((?: {4}.*\n)+)/.exec(t.stdout)?.[1] ?? "";
    const rows = [...list.matchAll(/^ {4}(\S+) {2}/gm)].map((m) => m[1]!);
    assert.deepEqual(await Promise.all(rows.map((ref) => opens(regressed, ref))), flagged, t.stdout);
    const see = /See the sessions that went wrong after it:\n(.+)$/m.exec(t.stderr)?.[1];
    assert.ok(see, t.stderr);
    assert.equal(await opens(regressed, refIn(see, "show")), SPACED);
  });

  test("the improve tool over MCP names each example in its next commands by a reference that opens it", async () => {
    const r = await mcpCall(cost, cost.repo, "improve", {});
    assert.notEqual(r.isError, true, r.text);
    const issues = r.data.issues as { example: { sessionId: string }; next: string[] }[];
    assert.equal(issues[0]!.example.sessionId, SPACED);
    const refs = issues.map((i) => refIn(i.next.find((n) => / show /.test(n))!, "show"));
    assert.deepEqual(await Promise.all(refs.map((ref) => opens(cost, ref))), issues.map((i) => i.example.sessionId));
  });
});

/** A fake `claude -p` that names as its session the one `ids` gives for a word in its instruction. */
const FAKE_CLAUDE = (ids: Record<string, string>) => `if (process.argv.includes("--version")) {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}
const ids = ${JSON.stringify(ids)};
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const session_id = ids[Object.keys(ids).find((k) => input.includes(k))] || "a-session-of-its-own";
  for (const o of [{ type: "system", subtype: "init", session_id }, { type: "result", subtype: "success", is_error: false, result: "Done.", session_id }]) console.log(JSON.stringify(o));
});
`;

describe("eval run names each failed trial's session, and each captured failure's, by a reference that opens it", () => {
  // The twin task's session shares its first 14 characters with a newer one, so a 12-character
  // prefix opens neither; the named task's session is spelled `latest`, which opens the newest.
  const TWIN = "abcd1234-aaaa-4000-8000-00000000000a";
  const NEWER = "abcd1234-aaaa-5000-8000-00000000000b";
  const failed = [["twin", TWIN], ["named", "latest"]] as const;
  let sb: Sandbox;
  /** The report eval run printed; then, run with --json --summary, its JSON and the Markdown it wrote. */
  let text = "";
  let json: any;
  let markdown = "";
  before(async () => {
    sb = sandbox();
    const repo = gitRepo(sb);
    const now = Date.now();
    await sb.seed([mkSession(TWIN, now - 4000), mkSession("latest", now - 3000), mkSession(SPACED, now - 2000), mkSession(NEWER, now - 1000)]);
    const suite = join(repo.root, "evals", "refs");
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "refs", purpose: "regression", trials: 1, tasks: "tasks" }));
    const task = (name: string, instruction: string, exit: number, extra: Record<string, unknown> = {}) => {
      const dir = join(suite, "tasks", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "task.json"), JSON.stringify({ name, verifier: { command: `"${process.execPath}" -e "process.exit(${exit})"`, timeoutMs: 60_000 }, ...extra }));
      writeFileSync(join(dir, "instruction.md"), `${instruction}\n`);
    };
    task("twin", "Fix TASK-TWIN.", 1);
    task("named", "Fix TASK-LATEST.", 1);
    // Drafted from a session that went wrong, and passing now: the line under the report names that session.
    task("fixed", "Keep it working.", 0, { tags: ["captured-failure"], sourceSessionId: SPACED });
    // The agent is the fake on PATH, driven through the claude-code adapter, which reads its session from the result.
    const bin = join(sb.root, "bin");
    nodeBin(bin, "claude", FAKE_CLAUDE({ "TASK-TWIN": TWIN, "TASK-LATEST": "latest" }));
    const git = which("git");
    const shell = process.platform === "win32" ? posixShell() : undefined;
    mkdirSync(join(sb.root, "tmp"));
    writeFileSync(join(sb.root, "hook-source.mjs"), "// test hook\n");
    const env = {
      ...sb.env,
      PATH: pathOf(bin, dirname(process.execPath), git ? dirname(git) : undefined, shell ? dirname(shell) : undefined, "/usr/bin", "/bin"),
      TMPDIR: join(sb.root, "tmp"),
      GIT_CONFIG_NOSYSTEM: "1",
      CODING_SH_HOOK_SOURCE: join(sb.root, "hook-source.mjs"),
    };
    const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, "eval", "run", "refs", "--yes", ...args], { env, cwd: repo.root, encoding: "utf8", timeout: 120_000 });
    const t = run();
    assert.equal(t.status, 1, `two tasks fail the regression suite\n${t.stdout}${t.stderr}`);
    text = t.stdout;
    const file = join(sb.root, "summary.md");
    const j = run("--json", "--summary", file);
    assert.equal(j.status, 1, j.stdout + j.stderr);
    json = JSON.parse(j.stdout);
    markdown = readFileSync(file, "utf8");
  });
  after(() => sb.cleanup());

  test("each failed task's show command opens the session its trial ran", async () => {
    for (const [name, id] of failed) {
      const line = new RegExp(`^${name}\\s.*?(coding\\.?sh show .*)$`, "m").exec(text)?.[1];
      assert.ok(line, text);
      assert.equal(await opens(sb, refIn(line, "show")), id, line);
    }
  });

  test("the captured-failures line names the task's source session by a reference that opens it", async () => {
    const ref = /^captured failures: 1 of 1 now pass: fixed \(session (.+)\)$/m.exec(text)?.[1];
    assert.ok(ref, text);
    assert.equal(await opens(sb, refIn(`coding.sh show ${ref}`, "show")), SPACED);
  });

  test("with --json, the --summary Markdown names each session the same way, and the JSON keeps whole ids", async () => {
    const rows = json.report.rows as { name: string; failedSession?: string }[];
    assert.deepEqual(rows.filter((r) => r.failedSession).map((r) => [r.name, r.failedSession]).sort(), [...failed].map(([n, id]) => [n, id]).sort());
    for (const [name, id] of failed) {
      const line = new RegExp(`^\\| ${name} \\|.*\`(coding\\.?sh show [^\`]*)\``, "m").exec(markdown)?.[1];
      assert.ok(line, markdown);
      assert.equal(await opens(sb, refIn(line, "show")), id, line);
    }
    const ref = /^- captured failures: 1 of 1 now pass: fixed \(session (.+)\)$/m.exec(markdown)?.[1];
    assert.ok(ref, markdown);
    assert.equal(await opens(sb, refIn(`coding.sh show ${ref}`, "show")), SPACED);
  });
});

// The viewer's copied commands, built by the page's own functions (src/viewer/ui/index.html) from the
// session record the viewer sends.
const page = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const script = page.slice(page.indexOf("<script"), page.lastIndexOf("</script>"));
// The constants shCmd() reads.
const pageConsts = script.slice(script.indexOf("const PASTE_UNSAFE = "), script.indexOf("\n", script.indexOf("const unsafeCmds = ")));

/** The page's definition of function `name`: its one line, or through the closing brace at the start of a line. */
function pageFunction(name: string): string {
  const a = script.indexOf(`function ${name}(`);
  assert.ok(a >= 0, `function ${name} is in the page`);
  const line = script.slice(a, script.indexOf("\n", a));
  return line.endsWith("}") ? line : script.slice(a, script.indexOf("\n}\n", a) + 2);
}

/** The call that starts at script[a], through its closing parenthesis. */
function pageCall(a: number): string {
  let depth = 0;
  for (let i = script.indexOf("(", a); i < script.length; i++) {
    const ch = script[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < script.length && script[i] !== ch; i++) if (script[i] === "\\") i++;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return script.slice(a, i + 1);
  }
  throw new Error(`the call at ${a} does not end`);
}

/** Each copied command of the page that names a session: the call that builds it, and the words before the session in it. */
function pageSessionCommands(): { call: string; words: string[] }[] {
  const found: { call: string; words: string[] }[] = [];
  for (const [start, words] of [['shCmd("coding.sh eval new", ', ["eval", "new"]], ['shCmd("coding.sh replay", ', ["replay"]]] as const) {
    for (let a = script.indexOf(start); a >= 0; a = script.indexOf(start, a + 1)) found.push({ call: pageCall(a), words: [...words] });
  }
  return found;
}

/** The command `call` builds for the session `record`, with the page's functions it calls. */
function pageCommand(call: string, record: unknown): string {
  const named = new Set([...call.matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]!));
  const helpers = [...named].filter((name) => name !== "shCmd" && script.includes(`function ${name}(`)).map(pageFunction);
  const code = [pageConsts, pageFunction("shq"), pageFunction("shCmd"), ...helpers, `(${call})`].join("\n");
  return runInNewContext(code, { session: record, s: record, n: 3, withs: [], String, Set });
}

/** The page's path for a session record (sessionRecordPath). */
const recordPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}?missing=null`;

/** The JSON a viewer on `port` answers GET `path` with. */
function getJson(port: number, path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`GET ${path}: ${res.statusCode} ${body}`))));
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end();
  });
}

describe("the viewer's copied commands name the session by a reference that opens it", () => {
  // The newest session is the one `latest` opens.
  const ids = [SPACED, "latest", A, B, "f00dcafe-cccc-4000-8000-000000000003"];
  let sb: Sandbox;
  let index: SqliteIndexStore;
  let viewer: Viewer;
  before(async () => {
    sb = sandbox();
    await sb.seed(ids.map((id, i) => mkSession(id, 1_000 * (i + 1))));
    index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
    viewer = await startViewer({ index, blobs: new MemoryBlobStore(), port: 0, env: sb.env });
  });
  after(async () => {
    await viewer?.close();
    await index?.close();
    sb.cleanup();
  });

  test("the local viewer sends each session record with a short reference that opens it", async () => {
    const records = await Promise.all(ids.map((id) => getJson(viewer.port, recordPath(id), viewer.token)));
    assert.deepEqual(records.map((r) => r.id), ids);
    assert.deepEqual(await Promise.all(records.map((r) => (typeof r.shortId === "string" ? opens(sb, r.shortId) : `no shortId in ${r.id}`))), ids);
    // A viewer of another store (`coding.sh serve`) sends none: on a team store it would read every id.
    const handler = await createViewerHandler({ index, blobs: new MemoryBlobStore(), authorize: () => ({}), checkHost: () => true, updateStatus: async () => ({ current: "0.0.0" }) as never });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const record = await getJson((server.address() as AddressInfo).port, recordPath(A));
      assert.equal(record.id, A);
      assert.equal("shortId" in record, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("each command the page copies for a session opens that session when pasted", async () => {
    const commands = pageSessionCommands();
    assert.ok(commands.filter((c) => c.words[0] === "eval").length >= 2 && commands.some((c) => c.words[0] === "replay"), JSON.stringify(commands));
    const wrong: string[] = [];
    for (const id of ids) {
      const record = await getJson(viewer.port, recordPath(id), viewer.token);
      for (const { call, words } of commands) {
        const line = pageCommand(call, record);
        const got = await opens(sb, refIn(line, ...words));
        if (got !== id) wrong.push(`${line} opens ${got}, not ${id}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});
