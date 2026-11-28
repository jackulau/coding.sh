// Unit tests for the local-first versioned prompt registry (src/prompts/store.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  diffPrompts,
  extractVariables,
  FilePromptStore,
  normalizePromptVersion,
  PromptNotFoundError,
  PromptRenderError,
  PromptValidationError,
  renderPrompt,
  renderTemplate,
  validatePromptLabel,
  validatePromptSlug,
} from "../../src/prompts/store.ts";

const tempDirs: string[] = [];

function makeStore(): { dir: string; store: FilePromptStore } {
  const dir = mkdtempSync(join(tmpdir(), "csh-prompts-unit-"));
  tempDirs.push(dir);
  return { dir, store: new FilePromptStore({ root: dir }) };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prompt validation", () => {
  it("accepts valid slugs and rejects path traversal and invalid characters", () => {
    assert.equal(validatePromptSlug("triage"), "triage");
    assert.equal(validatePromptSlug("support_triage-v1.0"), "support_triage-v1.0");
    assert.equal(validatePromptSlug("CodeReview"), "CodeReview");

    for (const bad of ["", " ", "../escape", "a/../b", "a/b", "a\\b", ".hidden", "-leading", "a..b", "has space", "a\0b", "x".repeat(81)]) {
      assert.throws(() => validatePromptSlug(bad), PromptValidationError, `expected rejection for slug ${JSON.stringify(bad)}`);
    }
  });

  it("accepts valid labels and rejects traversal, invalid chars and version-like labels", () => {
    assert.equal(validatePromptLabel("production"), "production");
    assert.equal(validatePromptLabel("staging-1"), "staging-1");
    assert.equal(validatePromptLabel("canary_2.0"), "canary_2.0");

    for (const bad of ["", "../prod", "a/b", "a\\b", ".dot", "-dash", "a..b", "bad label", "v1", "v42", "V2", "x".repeat(65)]) {
      assert.throws(() => validatePromptLabel(bad), PromptValidationError, `expected rejection for label ${JSON.stringify(bad)}`);
    }
  });

  it("normalizes and validates version inputs", () => {
    assert.equal(normalizePromptVersion("v1"), "v1");
    assert.equal(normalizePromptVersion("2"), "v2");
    for (const bad of ["", "v0", "0", "-1", "../v1", "v1.2", "latest", "abc"]) {
      assert.throws(() => normalizePromptVersion(bad), PromptValidationError, `expected rejection for version ${JSON.stringify(bad)}`);
    }
  });
});

describe("prompt variables and single-pass rendering", () => {
  it("extracts sorted unique mustache variables from text and chat prompts", () => {
    assert.deepEqual(extractVariables("Hello {{user}}, ticket {{ ticket.id }} for {{user}} and {{_env}}"), ["_env", "ticket.id", "user"]);
    assert.deepEqual(extractVariables("No vars here: {single} {{}} {{123bad}}"), []);
    assert.deepEqual(
      extractVariables({
        type: "chat",
        messages: [
          { role: "system", content: "You assist {{org}}." },
          { role: "user", content: "Handle {{issue}} for {{org}} ({{priority}})." },
        ],
      }),
      ["issue", "org", "priority"],
    );
  });

  it("renders templates in a single pass without recursive re-substitution", () => {
    const out = renderTemplate("A={{a}}, B={{b}}", { a: "{{b}}", b: "EXPANDED" });
    assert.equal(out, "A={{b}}, B=EXPANDED");

    const chatOut = renderPrompt(
      {
        type: "chat",
        messages: [
          { role: "system", content: "Mode: {{mode}}" },
          { role: "user", content: "Input: {{input}}" },
        ],
      },
      { mode: "strict", input: "contains {{mode}} literally" },
    );
    assert.deepEqual(chatOut, {
      type: "chat",
      messages: [
        { role: "system", content: "Mode: strict" },
        { role: "user", content: "Input: contains {{mode}} literally" },
      ],
    });
  });

  it("throws PromptRenderError on missing required variables and respects allowMissing", () => {
    assert.throws(
      () => renderPrompt({ type: "text", template: "{{a}} {{b}} {{c}}" }, { b: "ok" }),
      (e: unknown) => e instanceof PromptRenderError && e.missing.join(",") === "a,c",
    );

    // Prototype properties must never satisfy a variable lookup.
    assert.throws(
      () => renderTemplate("Key={{toString}}", {}),
      (e: unknown) => e instanceof PromptRenderError && e.missing.join(",") === "toString",
    );

    const partial = renderPrompt({ type: "text", template: "{{a}} {{b}}" }, { a: "hello" }, { allowMissing: true });
    assert.deepEqual(partial, { type: "text", text: "hello {{b}}" });
  });
});

describe("FilePromptStore", () => {
  it("stores immutable versions, deduplicates consecutive writes, and updates labels", async () => {
    const { dir, store } = makeStore();

    const r1 = await store.putPrompt({
      name: "triage",
      type: "text",
      template: "Classify: {{ticket}}",
      config: { model: "claude-sonnet-4-5", temperature: 0 },
      note: "initial version",
      labels: ["production"],
      now: 1700000000000,
    });
    assert.equal(r1.created, true);
    assert.equal(r1.version.version, "v1");
    assert.equal(r1.version.versionNumber, 1);
    assert.equal(r1.version.hash.length, 64);
    assert.deepEqual(r1.version.variables, ["ticket"]);
    assert.deepEqual(r1.labels, { latest: "v1", production: "v1" });

    // Identical content + config (with different key order) deduplicates against latest and still applies new label.
    const r1Dup = await store.putPrompt({
      name: "triage",
      type: "text",
      template: "Classify: {{ticket}}",
      config: { temperature: 0, model: "claude-sonnet-4-5" },
      labels: ["staging"],
      now: 1700000005000,
    });
    assert.equal(r1Dup.created, false);
    assert.equal(r1Dup.version.version, "v1");
    assert.equal(r1Dup.version.hash, r1.version.hash);
    assert.deepEqual(r1Dup.labels, { latest: "v1", production: "v1", staging: "v1" });

    // Config change creates v2 even when template text matches.
    const r2 = await store.putPrompt({
      name: "triage",
      type: "text",
      template: "Classify: {{ticket}}",
      config: { model: "claude-sonnet-4-5", temperature: 0.2 },
      labels: ["staging"],
      now: 1700000010000,
    });
    assert.equal(r2.created, true);
    assert.equal(r2.version.version, "v2");
    assert.notEqual(r2.version.hash, r1.version.hash);
    assert.deepEqual(r2.labels, { latest: "v2", production: "v1", staging: "v2" });

    // v1 file on disk remains immutable.
    const v1Disk = JSON.parse(readFileSync(join(dir, "prompts", "triage", "versions", "v1.json"), "utf8")) as { hash: string; version: string };
    assert.equal(v1Disk.version, "v1");
    assert.equal(v1Disk.hash, r1.version.hash);

    // Writing v1's content again after v2 creates v3 (non-consecutive).
    const r3 = await store.putPrompt({
      name: "triage",
      type: "text",
      template: "Classify: {{ticket}}",
      config: { model: "claude-sonnet-4-5", temperature: 0 },
      now: 1700000020000,
    });
    assert.equal(r3.created, true);
    assert.equal(r3.version.version, "v3");
    assert.equal(r3.version.hash, r1.version.hash);

    const listing = await store.listPrompts();
    assert.equal(listing.length, 1);
    assert.equal(listing[0]!.slug, "triage");
    assert.equal(listing[0]!.latest, "v3");
    assert.equal(listing[0]!.versions, 3);
    assert.equal(listing[0]!.updatedAt, 1700000020000);
  });

  it("supports chat prompts and rejects invalid messages or configs", async () => {
    const { store } = makeStore();

    const saved = await store.putPrompt({
      name: "reviewer",
      type: "chat",
      messages: [
        { role: "system", content: "Review code for {{lang}}." },
        { role: "user", content: "Diff:\n{{diff}}" },
      ],
      config: { model: "gpt-5", maxTokens: 1024 },
      now: 1700000000000,
    });
    assert.equal(saved.created, true);
    assert.equal(saved.version.type, "chat");
    assert.deepEqual(saved.version.variables, ["diff", "lang"]);

    const loaded = await store.getPrompt("reviewer");
    assert.ok(loaded && loaded.type === "chat");
    assert.equal(loaded.messages.length, 2);

    await assert.rejects(
      () => store.putPrompt({ name: "bad-chat", type: "chat", messages: [] }),
      PromptValidationError,
    );
    await assert.rejects(
      () => store.putPrompt({ name: "bad-text", type: "text", template: "" }),
      PromptValidationError,
    );
    await assert.rejects(
      () => store.putPrompt({ name: "bad-cfg", type: "text", template: "hi", config: { temperature: -1 } }),
      PromptValidationError,
    );
  });

  it("moves and deletes labels and protects reserved latest label", async () => {
    const { store } = makeStore();
    await store.putPrompt({ name: "greet", type: "text", template: "Hi {{name}}", now: 1000 });
    await store.putPrompt({ name: "greet", type: "text", template: "Hello {{name}}", now: 2000 });

    const moved = await store.setLabel("greet", "production", "v1");
    assert.deepEqual(moved.labels, { latest: "v2", production: "v1" });
    assert.equal((await store.getPrompt("greet", { label: "production" }))?.version, "v1");

    const promoted = await store.setLabel("greet", "production", "2");
    assert.equal(promoted.version, "v2");
    assert.equal((await store.getPrompt("greet", { label: "production" }))?.version, "v2");

    const deleted = await store.deleteLabel("greet", "production");
    assert.deepEqual(deleted.labels, { latest: "v2" });
    assert.equal(await store.getPrompt("greet", { label: "production" }), undefined);

    await assert.rejects(() => store.setLabel("greet", "latest", "v1"), PromptValidationError);
    await assert.rejects(() => store.deleteLabel("greet", "latest"), PromptValidationError);
    await assert.rejects(() => store.setLabel("greet", "staging", "v99"), PromptNotFoundError);
    await assert.rejects(() => store.deleteLabel("greet", "missing"), PromptNotFoundError);
    await assert.rejects(() => store.setLabel("unknown", "prod", "v1"), PromptNotFoundError);
  });

  it("computes unified line diffs across text, chat and config changes", async () => {
    const { store } = makeStore();
    const v1 = (
      await store.putPrompt({
        name: "summarizer",
        type: "text",
        template: "Line 1\nSummarize {{doc}}\nKeep it short.",
        now: 1000,
      })
    ).version;
    const v2 = (
      await store.putPrompt({
        name: "summarizer",
        type: "text",
        template: "Line 1\nSummarize {{doc}} carefully.\nKeep it short.\nCite sources.",
        now: 2000,
      })
    ).version;

    const same = diffPrompts(v1, v1);
    assert.equal(same.identical, true);
    assert.equal(same.added, 0);
    assert.equal(same.removed, 0);
    assert.equal(same.unified, "");

    const diff = diffPrompts(v1, v2, { fromRef: "production", toRef: "staging" });
    assert.equal(diff.identical, false);
    assert.equal(diff.removed, 1);
    assert.equal(diff.added, 2);
    assert.match(diff.unified, /^--- summarizer@production \(v1\)\n\+\+\+ summarizer@staging \(v2\)\n@@ /);
    assert.ok(diff.unified.includes("-Summarize {{doc}}"));
    assert.ok(diff.unified.includes("+Summarize {{doc}} carefully."));
    assert.ok(diff.unified.includes("+Cite sources."));
  });
});
