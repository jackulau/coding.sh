import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { ablateBundle, applyBundle, bundleFromDir, bundleFromToml, bundleId, diffBundles, formatBundleDiff, normalizeBundlePath } from "../../src/runner/bundle.ts";
import { MemBlobs, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const d = await tempDir("csh-bundle-");
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), c);
  }
  return d;
}

describe("bundleFromDir", () => {
  it("collects includes (files, globs, dirs, ~/) and hashes content", async () => {
    const dir = await tree({
      "CLAUDE.md": "be terse",
      ".claude/settings.json": "{}",
      ".claude/skills/x/SKILL.md": "skill",
      "src/app.ts": "nope",
      "node_modules/.claude/x": "skip",
    });
    const home = await tree({ ".claude/CLAUDE.md": "user rules" });
    const blobs = new MemBlobs();
    const b = await bundleFromDir({ name: "a", agent: "claude-code", dir, home, include: ["CLAUDE.md", ".claude/**", "AGENTS.md", "~/.claude/CLAUDE.md"], blobs, now: 1 });
    assert.deepEqual(Object.keys(b.files), [".claude/settings.json", ".claude/skills/x/SKILL.md", "CLAUDE.md", "~/.claude/CLAUDE.md"]);
    assert.equal(await blobs.getText(b.files["CLAUDE.md"] ?? ""), "be terse");
    assert.match(b.id, /^[0-9a-f]{64}$/);
    assert.equal(b.id, bundleId(b));
    const again = await bundleFromDir({ name: "a", agent: "claude-code", dir, home, include: [".claude", "~/.claude/CLAUDE.md", "CLAUDE.md"], blobs, now: 99 });
    assert.equal(again.id, b.id, "order of includes and createdAt do not matter");
    await writeFile(join(dir, "CLAUDE.md"), "be verbose");
    const changed = await bundleFromDir({ name: "a", agent: "claude-code", dir, home, include: ["CLAUDE.md", ".claude/**", "~/.claude/CLAUDE.md"], blobs });
    assert.notEqual(changed.id, b.id, "content change changes the id");
    const renamed = await bundleFromDir({ name: "a2", agent: "claude-code", dir, home, include: ["CLAUDE.md", ".claude/**", "~/.claude/CLAUDE.md"], blobs });
    assert.notEqual(renamed.id, changed.id, "A/A arms with different names stay distinct");
    const flagged = await bundleFromDir({ name: "a", agent: "claude-code", dir, home, include: ["CLAUDE.md", ".claude/**", "~/.claude/CLAUDE.md"], blobs, flags: ["--x"] });
    assert.notEqual(flagged.id, changed.id);
  });
});

describe("bundleFromToml", () => {
  it("reads harness.toml with [env] and [files] variants", async () => {
    const dir = await tree({
      "harness.toml": [
        'name = "terse"',
        'agent = "claude-code"',
        'model = "sonnet"',
        'flags = ["--max-turns", "40"]',
        'include = [".claude/**"]',
        'remove = ["AGENTS.md"]',
        "[env]",
        'MAX_THINKING_TOKENS = "8000"',
        "[files]",
        '"CLAUDE.md" = "variants/terse.md"',
        "",
      ].join("\n"),
      "variants/terse.md": "terse rules",
      ".claude/settings.json": "{}",
    });
    const blobs = new MemBlobs();
    const b = await bundleFromToml(join(dir, "harness.toml"), { blobs });
    assert.equal(b.name, "terse");
    assert.equal(b.model, "sonnet");
    assert.deepEqual(b.flags, ["--max-turns", "40"]);
    assert.deepEqual(b.env, { MAX_THINKING_TOKENS: "8000" });
    assert.deepEqual(b.remove, ["AGENTS.md"]);
    assert.deepEqual(Object.keys(b.files), [".claude/settings.json", "CLAUDE.md"]);
    assert.equal(await blobs.getText(b.files["CLAUDE.md"] ?? ""), "terse rules");
  });
  it("accepts harness.json and validates fields", async () => {
    const dir = await tree({ "harness.json": JSON.stringify({ agent: "codex", include: [] }), "bad.json": JSON.stringify({ name: "x" }) });
    const b = await bundleFromToml(join(dir, "harness.json"), { blobs: new MemBlobs() });
    assert.equal(b.agent, "codex");
    assert.equal(b.name.length > 0, true);
    await assert.rejects(bundleFromToml(join(dir, "bad.json"), { blobs: new MemBlobs() }), /"agent" is required/);
  });
});

describe("applyBundle", () => {
  it("removes, then writes; ~/ goes to the isolated home", async () => {
    const blobs = new MemBlobs();
    const run = await tree({ "AGENTS.md": "old", ".claude/old.json": "x", "src/a.ts": "a" });
    const home = join(run, "..", `${basename(run)}-home`);
    dirs.push(home);
    const b = {
      id: "x",
      name: "x",
      agent: "claude-code",
      flags: [],
      env: {},
      createdAt: 0,
      remove: ["AGENTS.md", ".claude"],
      files: { "CLAUDE.md": await blobs.put("rules"), ".claude/settings.json": await blobs.put("{}"), "~/.claude/CLAUDE.md": await blobs.put("user") },
    };
    const r = await applyBundle(b, run, blobs, { home });
    assert.deepEqual(r.removed.sort(), [".claude", "AGENTS.md"]);
    assert.equal(r.usesHome, true);
    assert.ok(!existsSync(join(run, "AGENTS.md")));
    assert.ok(!existsSync(join(run, ".claude/old.json")));
    assert.equal(await readFile(join(run, ".claude/settings.json"), "utf8"), "{}");
    assert.equal(await readFile(join(home, ".claude/CLAUDE.md"), "utf8"), "user");
    assert.equal(await readFile(join(run, "src/a.ts"), "utf8"), "a");
  });
  it("refuses paths that escape, are absolute, touch .git, or go through symlinks", async () => {
    const blobs = new MemBlobs();
    const ref = await blobs.put("pwn");
    const outside = await tree({});
    const run = await tree({ "ok.txt": "" });
    await symlink(outside, join(run, "link"));
    const mk = (files: Record<string, string>) => ({ id: "x", name: "x", agent: "a", flags: [], env: {}, createdAt: 0, remove: [], files });
    for (const p of ["../evil", "/etc/evil", "a/../../evil", ".git/hooks/pre-commit", "link/evil", "~/../evil"]) {
      await assert.rejects(applyBundle(mk({ [p]: ref }), run, blobs, { home: join(run, "h") }), /refusing|escapes|outside|symlink/, p);
    }
    await assert.rejects(applyBundle({ ...mk({}), remove: ["../x"] }, run, blobs), /escapes/);
    assert.ok(!existsSync(join(outside, "evil")));
  });
});

describe("diffBundles", () => {
  it("reports file, model, flag, env and removal changes without echoing env values", () => {
    const base = { id: "a", name: "a", agent: "claude-code", model: "m1", flags: ["--a"], env: { K: "1", S: "secret" }, files: { "CLAUDE.md": "r1", "x.md": "r2" }, remove: [], createdAt: 0 };
    const cand = { ...base, id: "b", name: "b", model: "m2", flags: ["--a", "--b"], env: { K: "2", N: "3" }, files: { "CLAUDE.md": "r9", "y.md": "r3" }, remove: ["AGENTS.md"] };
    const d = diffBundles(base, cand);
    assert.equal(d.same, false);
    assert.deepEqual(d.files, { added: ["y.md"], removed: ["x.md"], changed: ["CLAUDE.md"] });
    assert.deepEqual(d.model, { from: "m1", to: "m2" });
    assert.deepEqual(d.flags?.added, ["--b"]);
    assert.deepEqual(d.env, { added: ["N"], removed: ["S"], changed: ["K"] });
    assert.deepEqual(d.remove.added, ["AGENTS.md"]);
    const text = formatBundleDiff(d).join("\n");
    assert.doesNotMatch(text, /secret/);
    assert.match(text, /~ CLAUDE\.md/);
    assert.equal(diffBundles(base, { ...base, id: "c", name: "c" }).same, true);
  });
});

describe("ablateBundle", () => {
  async function pdfBundle(blobs: MemBlobs) {
    const files = {
      ".claude/skills/pdf/SKILL.md": await blobs.put("pdf skill"),
      ".claude/skills/pdf/forms.md": await blobs.put("forms"),
      ".claude/skills/pdfx/SKILL.md": await blobs.put("not under pdf/"),
      "AGENTS.md": await blobs.put("agents"),
      "~/.claude/skills/pdf/SKILL.md": await blobs.put("user pdf skill"),
    };
    const body = { name: "base", agent: "claude-code", flags: [], env: {}, files, remove: [] as string[] };
    return { id: bundleId(body), createdAt: 1, ...body };
  }

  it("drops the dir's files, keeps the rest, adds the path to remove, deterministic id", async () => {
    const blobs = new MemBlobs();
    const b = await pdfBundle(blobs);
    const a = ablateBundle(b, ["./.claude/skills/pdf/"], { now: 5 });
    assert.deepEqual(a.paths, [".claude/skills/pdf"]);
    assert.deepEqual(a.dropped, [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/forms.md"]);
    assert.deepEqual(a.unmatched, []);
    assert.deepEqual(Object.keys(a.bundle.files).sort(), [".claude/skills/pdfx/SKILL.md", "AGENTS.md", "~/.claude/skills/pdf/SKILL.md"]);
    assert.ok(a.bundle.remove.includes(".claude/skills/pdf"));
    assert.equal(a.bundle.name, "base-without-claude-skills-pdf");
    assert.match(a.bundle.note ?? "", /ablation of base: without \.claude\/skills\/pdf/);
    assert.equal(a.bundle.id, bundleId(a.bundle));
    assert.notEqual(a.bundle.id, b.id);
    assert.equal(ablateBundle(b, [".claude/skills/pdf"], { now: 99 }).bundle.id, a.bundle.id, "same input, same id");
    assert.deepEqual(b.remove, [], "input untouched");
  });

  it("~/ paths drop only user-level keys; globs match keys and stay globs in remove", async () => {
    const blobs = new MemBlobs();
    const b = await pdfBundle(blobs);
    const home = ablateBundle(b, ["~/.claude/skills/pdf"]);
    assert.deepEqual(home.dropped, ["~/.claude/skills/pdf/SKILL.md"]);
    assert.deepEqual(home.bundle.remove, ["~/.claude/skills/pdf"]);
    const glob = ablateBundle(b, [".claude/skills/*/SKILL.md"]);
    assert.deepEqual(glob.dropped, [".claude/skills/pdf/SKILL.md", ".claude/skills/pdfx/SKILL.md"]);
    assert.deepEqual(glob.bundle.remove, [".claude/skills/*/SKILL.md"]);
    const some = ablateBundle(b, ["src/notes.md", "AGENTS.md"]);
    assert.deepEqual(some.dropped, ["AGENTS.md"]);
    assert.deepEqual(some.unmatched, ["src/notes.md"]);
    assert.equal(normalizeBundlePath("a\\b\\..\\c/"), "a/c");
    assert.equal(normalizeBundlePath("~/./.claude//x/"), "~/.claude/x");
  });

  it("applyBundle of the ablation removes the dir from the repo and keeps AGENTS.md", async () => {
    const blobs = new MemBlobs();
    const b = await pdfBundle(blobs);
    const run = await tree({ ".claude/skills/pdf/SKILL.md": "repo copy", ".claude/skills/pdf/extra.md": "repo only", "src/a.ts": "x" });
    const r = await applyBundle(ablateBundle(b, [".claude/skills/pdf"]).bundle, run, blobs, { home: join(run, ".h") });
    assert.equal(existsSync(join(run, ".claude/skills/pdf")), false, "removed, and the bundle's own copy is not written back");
    assert.equal(await readFile(join(run, "AGENTS.md"), "utf8"), "agents");
    assert.equal(existsSync(join(run, ".claude/skills/pdfx/SKILL.md")), true);
    assert.ok(r.removed.includes(".claude/skills/pdf"));
  });
});
