// End-to-end CLI tests for `coding.sh prompt set|get|list|label|diff`.
// Uses throwaway temp HOME / USERPROFILE / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CLI as MAIN } from "../_cli.ts";

let root = "";
let env: Record<string, string> = {};

function runCli(args: string[], opts: { input?: string } = {}) {
  const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  };
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  return spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], spawnOpts);
}

function runJson<T = Record<string, unknown>>(args: string[], opts: { input?: string } = {}): T {
  const r = runCli([...args, "--json"], opts);
  assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout) as T;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-prompt-cli-")));
  const home = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(home, { recursive: true });
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    PATH: dirname(process.execPath),
    NO_COLOR: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
  };
  mkdirSync(env.CODING_SH_HOME!, { recursive: true });
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("coding.sh prompt CLI", () => {
  it("lists empty store cleanly", () => {
    const emptyJson = runJson<{ prompts: unknown[] }>(["prompt", "list"]);
    assert.deepEqual(emptyJson, { prompts: [] });

    const emptyText = runCli(["prompt", "list"]);
    assert.equal(emptyText.status, 0);
    assert.match(emptyText.stderr, /No prompts/);
  });

  it("sets text, file, stdin and chat prompts with labels, config and deduplication", () => {
    // 1. Inline --text with --label and --config
    const set1 = runJson<{
      outcome: string;
      prompt: { slug: string; version: string; type: string; variables: string[]; config: { model: string; temperature: number }; note: string };
      labels: Record<string, string>;
    }>([
      "prompt",
      "set",
      "triage",
      "--text",
      "Classify ticket for {{team}}: {{ticket}}",
      "--label",
      "production,canary",
      "--config",
      '{"model":"claude-sonnet-4-5","temperature":0}',
      "--note",
      "initial triage prompt",
    ]);
    assert.equal(set1.outcome, "created");
    assert.equal(set1.prompt.slug, "triage");
    assert.equal(set1.prompt.version, "v1");
    assert.equal(set1.prompt.type, "text");
    assert.deepEqual(set1.prompt.variables, ["team", "ticket"]);
    assert.deepEqual(set1.prompt.config, { model: "claude-sonnet-4-5", temperature: 0 });
    assert.equal(set1.prompt.note, "initial triage prompt");
    assert.deepEqual(set1.labels, { canary: "v1", latest: "v1", production: "v1" });

    // 2. Identical consecutive write deduplicates and attaches staging label
    const setDup = runJson<{ outcome: string; prompt: { version: string }; labels: Record<string, string> }>([
      "prompt",
      "set",
      "triage",
      "--text",
      "Classify ticket for {{team}}: {{ticket}}",
      "--config",
      '{"temperature":0,"model":"claude-sonnet-4-5"}',
      "--label",
      "staging",
    ]);
    assert.equal(setDup.outcome, "unchanged");
    assert.equal(setDup.prompt.version, "v1");
    assert.deepEqual(setDup.labels, { canary: "v1", latest: "v1", production: "v1", staging: "v1" });

    // 3. --file updates to v2 and moves staging
    const filePath = join(root, "triage-v2.txt");
    writeFileSync(filePath, "Classify ticket for {{team}}.\nTicket: {{ticket}}\nReturn JSON.\n", "utf8");
    const cfgPath = join(root, "triage-cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ model: "claude-sonnet-4-5", temperature: 0.1 }), "utf8");

    const set2 = runJson<{ outcome: string; prompt: { version: string }; labels: Record<string, string> }>([
      "prompt",
      "set",
      "triage",
      "--file",
      filePath,
      "--config",
      cfgPath,
      "--label",
      "staging",
    ]);
    assert.equal(set2.outcome, "created");
    assert.equal(set2.prompt.version, "v2");
    assert.deepEqual(set2.labels, { canary: "v1", latest: "v2", production: "v1", staging: "v2" });

    // 4. --messages chat prompt
    const chat = runJson<{
      outcome: string;
      prompt: { version: string; type: string; messages: { role: string; content: string }[]; variables: string[] };
    }>([
      "prompt",
      "set",
      "reviewer",
      "--messages",
      '[{"role":"system","content":"Review {{lang}} code."},{"role":"user","content":"Patch: {{patch}}"}]',
      "--label",
      "production",
    ]);
    assert.equal(chat.outcome, "created");
    assert.equal(chat.prompt.version, "v1");
    assert.equal(chat.prompt.type, "chat");
    assert.deepEqual(chat.prompt.variables, ["lang", "patch"]);

    // 5. Piped stdin prompt
    const fromStdin = runJson<{ outcome: string; prompt: { version: string; template: string } }>(
      ["prompt", "set", "piped"],
      { input: "Piped hello {{who}}" },
    );
    assert.equal(fromStdin.outcome, "created");
    assert.equal(fromStdin.prompt.version, "v1");
    assert.equal(fromStdin.prompt.template, "Piped hello {{who}}");
  });

  it("gets prompts by version or label, renders vars in single pass, and supports --raw and --json", () => {
    // Raw rendered output with single-pass safety ({{ticket}} inside team value is NOT re-expanded).
    const raw = runCli([
      "prompt",
      "get",
      "triage",
      "--label",
      "production",
      "--var",
      "team={{ticket}}",
      "--var",
      "ticket=login fails",
      "--raw",
    ]);
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal(raw.stdout, "Classify ticket for {{ticket}}: login fails\n");
    assert.equal(raw.stderr, "");

    // Fetch explicit version v2 as JSON
    const v2Json = runJson<{
      prompt: { version: string };
      rendered: { type: string; text: string };
    }>(["prompt", "get", "triage", "--version", "v2", "--var", "team=billing", "--var", "ticket=invoice"]);
    assert.equal(v2Json.prompt.version, "v2");
    assert.equal(v2Json.rendered.type, "text");
    assert.match(v2Json.rendered.text, /Classify ticket for billing\./);
    assert.match(v2Json.rendered.text, /Ticket: invoice/);

    // Chat prompt --raw prints valid JSON messages array only
    const chatRaw = runCli([
      "prompt",
      "get",
      "reviewer",
      "--var",
      "lang=TypeScript",
      "--var",
      "patch=+const x = 1;",
      "--raw",
    ]);
    assert.equal(chatRaw.status, 0, chatRaw.stderr);
    const parsedMsgs = JSON.parse(chatRaw.stdout) as { role: string; content: string }[];
    assert.deepEqual(parsedMsgs, [
      { role: "system", content: "Review TypeScript code." },
      { role: "user", content: "Patch: +const x = 1;" },
    ]);

    // Human-readable get shows metadata and body
    const human = runCli(["prompt", "get", "triage", "--label", "production"]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /triage@v1 \(text\)/);
    assert.match(human.stdout, /Classify ticket for \{\{team\}\}: \{\{ticket\}\}/);
  });

  it("lists prompts, moves and deletes labels, and diffs versions and labels", () => {
    const listed = runJson<{ prompts: { slug: string; latest: string; versions: number; labels: Record<string, string> }[] }>([
      "prompt",
      "list",
    ]);
    const triage = listed.prompts.find((p) => p.slug === "triage");
    assert.ok(triage);
    assert.equal(triage.latest, "v2");
    assert.equal(triage.versions, 2);
    assert.equal(triage.labels.production, "v1");
    assert.equal(triage.labels.staging, "v2");

    const tableOut = runCli(["prompt", "list"]);
    assert.equal(tableOut.status, 0);
    assert.match(tableOut.stdout, /PROMPT\tTYPE\tLATEST\tVERSIONS\tLABELS\tUPDATED/);
    assert.match(tableOut.stdout, /triage\ttext\tv2\t2\t/);

    // Diff by labels
    const diffJson = runJson<{
      identical: boolean;
      added: number;
      removed: number;
      from: { ref: string; version: string };
      to: { ref: string; version: string };
      unified: string;
    }>(["prompt", "diff", "triage", "production", "staging"]);
    assert.equal(diffJson.identical, false);
    assert.equal(diffJson.from.ref, "production");
    assert.equal(diffJson.from.version, "v1");
    assert.equal(diffJson.to.ref, "staging");
    assert.equal(diffJson.to.version, "v2");
    assert.ok(diffJson.added > 0);
    assert.ok(diffJson.removed > 0);
    assert.ok(diffJson.unified.includes("--- triage@production (v1)"));
    assert.ok(diffJson.unified.includes("+++ triage@staging (v2)"));

    const diffText = runCli(["prompt", "diff", "triage", "v1", "v2"]);
    assert.equal(diffText.status, 0);
    assert.match(diffText.stdout, /--- triage@v1/);
    assert.match(diffText.stdout, /\+\+\+ triage@v2/);

    // Promote production -> v2, then diff production vs staging should be identical
    const promoted = runJson<{ outcome: string; version: string; labels: Record<string, string> }>([
      "prompt",
      "label",
      "triage",
      "production",
      "v2",
    ]);
    assert.equal(promoted.outcome, "updated");
    assert.equal(promoted.version, "v2");
    assert.equal(promoted.labels.production, "v2");

    const sameDiff = runJson<{ identical: boolean }>(["prompt", "diff", "triage", "production", "staging"]);
    assert.equal(sameDiff.identical, true);

    // Delete canary label
    const deleted = runJson<{ outcome: string; version: null; labels: Record<string, string> }>([
      "prompt",
      "label",
      "triage",
      "canary",
      "--delete",
    ]);
    assert.equal(deleted.outcome, "deleted");
    assert.equal(deleted.version, null);
    assert.equal("canary" in deleted.labels, false);
  });

  it("returns exit 2 on validation errors and exit 1 on missing prompts, versions or labels", () => {
    // Path traversal slug
    const badSlug = runCli(["prompt", "set", "../escape", "--text", "hi"]);
    assert.equal(badSlug.status, 2);

    // Version-shaped label
    const badLabel = runCli(["prompt", "set", "okname", "--text", "hi", "--label", "v1"]);
    assert.equal(badLabel.status, 2);

    // Multiple content sources
    const bothSources = runCli(["prompt", "set", "okname", "--text", "hi", "--messages", "[]"]);
    assert.equal(bothSources.status, 2);

    // Missing content (empty stdin)
    const missingContent = runCli(["prompt", "set", "okname"], { input: "" });
    assert.equal(missingContent.status, 2);

    // Mutually exclusive --version and --label on get
    const bothRefs = runCli(["prompt", "get", "triage", "--version", "v1", "--label", "production"]);
    assert.equal(bothRefs.status, 2);

    // Missing required variable when rendering
    const missingVar = runCli(["prompt", "get", "triage", "--var", "team=ops"]);
    assert.equal(missingVar.status, 2);
    assert.match(missingVar.stderr, /Missing required prompt variable.*ticket/);

    // Malformed --var
    const badVar = runCli(["prompt", "get", "triage", "--var", "noequals"]);
    assert.equal(badVar.status, 2);

    // Label command: both version and --delete, or neither
    const badLabelCombo = runCli(["prompt", "label", "triage", "staging", "v1", "--delete"]);
    assert.equal(badLabelCombo.status, 2);
    const missingVer = runCli(["prompt", "label", "triage", "staging"]);
    assert.equal(missingVer.status, 2);

    // Reserved latest label cannot be deleted
    const delLatest = runCli(["prompt", "label", "triage", "latest", "--delete"]);
    assert.equal(delLatest.status, 2);

    // Missing prompt / version / label -> exit 1 (not_found)
    const missingPrompt = runCli(["prompt", "get", "does-not-exist", "--json"]);
    assert.equal(missingPrompt.status, 1);
    assert.equal((JSON.parse(missingPrompt.stderr) as { reason: string }).reason, "not_found");

    const missingVersion = runCli(["prompt", "get", "triage", "--version", "v99"]);
    assert.equal(missingVersion.status, 1);

    const missingLabel = runCli(["prompt", "label", "triage", "nonexistent", "--delete"]);
    assert.equal(missingLabel.status, 1);
  });
});
