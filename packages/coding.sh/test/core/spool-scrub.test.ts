import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { scrubRawFile } from "../../src/core/spool-scrub.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// Built from parts so no secret-looking literal sits in the source.
const SECRET = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-scrub-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const config = defaultConfig(env);
  const raw = join(env.CODING_SH_HOME, "spool", "claude-code", "raw");
  mkdirSync(raw, { recursive: true });
  const spool = join(env.CODING_SH_HOME, "spool", "claude-code", "2026-11-06.1.jsonl");
  const payload = (stdout: string, pretty = false) => {
    const doc = { hook_event_name: "PostToolUse", session_id: "s1", cwd: join(root, "work"), tool_name: "Bash", tool_input: { command: "env" }, tool_response: { stdout } };
    return pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
  };
  const hook = (name: string, text: string, n: number) => {
    const rawFile = join(raw, name);
    writeFileSync(rawFile, text, { mode: 0o600 });
    return JSON.stringify({ v: 0, agent: "claude-code", event: "PostToolUse", ts: 1_700_000_000_000 + n, pid: n, cwd: join(root, "work"), rawFile }) + "\n";
  };
  const run = () => ingest({ config, index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), adapters: new Map([[claudeCode.id, claudeCode]]), env, lock: false });
  return { root, env, raw, spool, payload, hook, run };
}

describe("a spool side file after ingest", () => {
  it("holds the payload with the secret redacted, in the same mode, and its line still names it", async () => {
    const t = setup();
    const text = t.payload(`A=1\nAWS_SECRET_ACCESS_KEY=${SECRET}\nB=2`, true);
    writeFileSync(t.spool, t.hook("1-1-sh.json", text, 1));
    const file = join(t.raw, "1-1-sh.json");
    assert.ok(readFileSync(file, "utf8").includes(SECRET));
    const r = await t.run();
    assert.equal(r.lines, 1);
    const after = readFileSync(file, "utf8");
    assert.ok(!after.includes(SECRET), after);
    assert.equal(JSON.parse(after).hook_event_name, "PostToolUse");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(t.spool, "utf8")).rawFile, file);
  });

  it("is left byte for byte when it holds nothing to redact", async () => {
    const t = setup();
    const text = t.payload("hello", true);
    writeFileSync(t.spool, t.hook("2-2-sh.json", text, 2));
    await t.run();
    assert.equal(readFileSync(join(t.raw, "2-2-sh.json"), "utf8"), text);
  });

  it("is not touched while its line is not ingested", async () => {
    const t = setup();
    const text = t.payload(`X=1\nAWS_SECRET_ACCESS_KEY=${SECRET}`);
    writeFileSync(join(t.raw, "3-3-sh.json"), text); // no spool line names it
    await t.run();
    assert.equal(readFileSync(join(t.raw, "3-3-sh.json"), "utf8"), text);
  });

  it("scrubRawFile redacts a payload that is not JSON as text and reports whether it wrote", async () => {
    const t = setup();
    const f = join(t.raw, "4.txt");
    writeFileSync(f, `A=1\nAWS_SECRET_ACCESS_KEY=${SECRET}\n`);
    const r = createRedactor({ redact: ["secrets"] });
    assert.equal(await scrubRawFile(f, r), true);
    assert.ok(!readFileSync(f, "utf8").includes(SECRET));
    assert.equal(await scrubRawFile(f, r), false);
    assert.equal(await scrubRawFile(join(t.raw, "missing.json"), r), false);
  });
});
