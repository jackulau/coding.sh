// An eval run is laid out as runs/<id>/{work,home}: the runner writes the bundle's "~/" files and
// the carried state into home/, then commits work/ as the start. An overlay that put the agent's
// home in the work tree (work/home) missed those files, committed the user's logins into the start
// and the verifier's copy of it, and showed the agent's own files in its diff.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { ADAPTERS, getAdapter } from "../../src/adapters/index.ts";
import type { AgentRunOutput, HarnessBundle, RunSpec } from "../../src/core/types.ts";
import { git, START_REF } from "../../src/runner/git.ts";
import { runTask } from "../../src/runner/run.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
import { snapshotDir } from "../adapters/more/_helpers.ts";
import { cleanupWorlds, FIXED, toyWorld } from "../helpers-eval.ts";

/** Stands in for a login; built from pieces so no token-shaped literal sits in the source. */
const SECRET = ["fake", "-login-", "0123456789"].join("");

/** Where each agent keeps its login (or, for Goose, its provider config) in the user's home. */
const LOGINS = [
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".cursor/cli-config.json",
  ".gemini/oauth_creds.json",
  ".gemini/google_accounts.json",
  ".gemini/installation_id",
  ".copilot/config.json",
  ".factory/auth.json",
  ".pi/agent/auth.json",
  ".config/goose/config.yaml",
  "AppData/Roaming/Block/goose/config/config.yaml",
  ".config/devin/credentials.toml",
  "AppData/Roaming/devin/credentials.toml",
];

let env: TmpEnv;
let root: string;
before(() => {
  // The user's home: every agent config variable unset, HOME and USERPROFILE at a temp dir.
  env = tmpEnv();
  process.env.USERPROFILE = env.home;
  for (const rel of LOGINS) writeFile(join(env.home, rel), `${JSON.stringify({ token: SECRET })}\n`);
  writeFile(join(env.home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  root = mkdtempSync(join(tmpdir(), "eval-home-"));
});
after(async () => {
  await cleanupWorlds();
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

describe("eval overlays keep the agent's home out of the work tree", () => {
  // User files that make an overlay name a path in a flag (Aider's -c, Amp's --settings-file).
  const bundle = { id: "b", name: "b", agent: "any", flags: [], env: {}, files: { "~/.aider.conf.yml": "ref", "~/.config/amp/settings.json": "ref" }, remove: [], createdAt: 0 } as HarnessBundle;
  let path: string | undefined;
  before(() => {
    // No agent binary on PATH, so no overlay finds or runs one (OpenCode's asks for a version).
    path = process.env.PATH;
    process.env.PATH = join(root, "no-agents");
    mkdirSync(process.env.PATH, { recursive: true });
  });
  after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  });

  const withOverlay = ADAPTERS.filter((a) => a.overlay);
  it("covers every adapter with an overlay", () => {
    for (const id of ["aider", "copilot-cli", "droid", "gemini-cli", "goose", "pi", "amp"]) assert.ok(withOverlay.some((a) => a.id === id), id);
  });

  for (const adapter of withOverlay) {
    it(`${adapter.id} writes nothing into the work tree and points no path into it`, async () => {
      const work = join(root, adapter.id, "work");
      writeFile(join(work, "README.md"), "repo\n");
      const home = snapshotDir(env.home);
      const o = await adapter.overlay!(bundle, work);
      assert.deepEqual(readdirSync(work, { recursive: true }), ["README.md"]);
      for (const [k, v] of Object.entries(o.env)) if (isAbsolute(v)) assert.ok(!inside(work, v), `${k}=${v} is in the work tree`);
      for (const f of o.flags) if (isAbsolute(f)) assert.ok(!inside(work, f), `flag ${f} is in the work tree`);
      assert.deepEqual(snapshotDir(env.home), home, "the user's home is unchanged");
    });
  }
});

describe("eval runs give the agent the run's home", () => {
  const ok = (): AgentRunOutput => ({ exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "done", stderrTail: "" });
  const read = (p: string | undefined) => (p && existsSync(p) ? readFileSync(p, "utf8") : undefined);

  it("Gemini CLI reads the bundle's ~/ file and the carried state; logins and its own files stay out of the start and the diff", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("gemini", "fix", { agent: "gemini-cli", files: { "~/.gemini/GEMINI.md": await w.blobs.put("user-level rules\n") } });
    const carry = join(root, "carry");
    writeFile(join(carry, ".gemini", "memory", "notes.md"), "carried\n");
    const seen: { rules?: string; notes?: string } = {};
    const adapter = {
      ...getAdapter("gemini-cli")!,
      async run(spec: RunSpec) {
        const h = spec.env.GEMINI_CLI_HOME;
        seen.rules = read(h && join(h, ".gemini", "GEMINI.md"));
        seen.notes = read(h && join(h, ".gemini", "memory", "notes.md"));
        // Gemini CLI keeps its chats in its home.
        if (h) writeFile(join(h, ".gemini", "tmp", "chat.json"), "{}\n");
        writeFile(join(spec.cwd, "src", "add.js"), FIXED["src/add.js"]!);
        writeFile(join(spec.cwd, "src", "mul.js"), FIXED["src/mul.js"]!);
        return ok();
      },
    };
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, keep: true, carry: { paths: ["~/.gemini/memory"], dir: carry } });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true);
    assert.equal(seen.rules, "user-level rules\n");
    assert.equal(seen.notes, "carried\n");
    const diff = (await w.blobs.getText(r.diffBlob ?? "")) ?? "";
    assert.deepEqual([...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ["src/add.js", "src/mul.js"]);
    // git grep exits 1 when the start commit holds no copy of the login.
    const grep = await git(["grep", "-l", SECRET, START_REF], join(w.runsDir, r.id, "work"));
    assert.equal(grep.exitCode, 1, grep.stdoutTail + grep.stderrTail);
  });

  it("Aider's -c names the ~/.aider.conf.yml the runner wrote", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("aider", "fix", { agent: "aider", files: { "~/.aider.conf.yml": await w.blobs.put("model: sonnet\n") } });
    let conf: string | undefined;
    const adapter = {
      ...getAdapter("aider")!,
      async run(spec: RunSpec) {
        conf = read(spec.flags.includes("-c") ? spec.flags[spec.flags.indexOf("-c") + 1] : undefined);
        return ok();
      },
    };
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.error, undefined);
    assert.equal(conf, "model: sonnet\n");
  });
});
