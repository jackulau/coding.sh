// init then uninstall gives the home back as it was. The folders init made to hold its files go
// once nothing is left in them; a folder that was there before init, or that holds a file of the
// user's, stays. doctor counts an agent as installed when its folder exists, so it lists the same
// agents before init and after uninstall.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { printBin } from "../_bin.ts";
import { CLI } from "../_cli.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

/** The program each agent's detect looks for, and the version it prints. */
const BINS: Record<string, string> = {
  claude: "2.1.0 (Claude Code)",
  codex: "codex-cli 0.50.0",
  // Cursor's detect takes a date-style version.
  "cursor-agent": "2026.01.15-1a2b3c4",
  opencode: "1.0.0",
  gemini: "0.20.0",
  agy: "1.3.0",
  copilot: "1.0.0",
  amp: "1.0.0",
  pi: "1.0.0",
  droid: "1.0.0",
  goose: "1.0.0",
  devin: "1.0.0",
};

let t: TmpEnv;
let work: string;
let hook: string;
let bins: string;
let nobin: string;

beforeEach(() => {
  t = tmpEnv();
  work = join(t.home, "work");
  mkdirSync(work);
  hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  bins = join(t.root, "bin");
  for (const [name, version] of Object.entries(BINS)) printBin(bins, name, version);
  nobin = join(t.root, "nobin");
  mkdirSync(nobin);
});
afterEach(() => t.restore());

/** The CLI with PATH set to `path`: the fake agents, or a folder with nothing in it. */
function run(args: string[], path: string) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    cwd: work,
    env: { ...process.env, PATH: path, USERPROFILE: t.home, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** Every file under `root` with its text, and every folder (its path ends in "/"). */
function tree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) {
        m.set(`${relative(root, p)}/`, "");
        walk(p);
      } else m.set(relative(root, p), readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return m;
}

/** The agents doctor lists as installed with no agent program on PATH: those whose folder exists. */
function installed(): string[] {
  const r = run(["doctor", "--json"], nobin);
  return (JSON.parse(r.stdout) as { agents: { id: string; installed: boolean }[] }).agents.filter((a) => a.installed).map((a) => a.id);
}

describe("uninstall after init", () => {
  test("leaves the files and folders that were there before init, and doctor lists the same agents", () => {
    // Claude Code, Codex and Gemini CLI set up by the user, and a Copilot CLI folder with nothing in it yet.
    writeFile(join(t.home, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
    writeFile(join(t.home, ".claude.json"), '{\n  "numStartups": 3\n}\n');
    writeFile(join(t.home, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFile(join(t.home, ".gemini", "settings.json"), '{\n  "ui": {}\n}\n');
    mkdirSync(join(t.home, ".copilot"));
    const before = tree(t.home);
    const agents = installed();

    // Every agent is on PATH while init and uninstall run, as when they are all installed.
    const i = run(["init", "--yes", "--json", "--no-import"], bins);
    assert.equal(i.status, 0, i.stderr);
    const setUp = (JSON.parse(i.stdout) as { agents: { id: string; changes: unknown[] }[] }).agents.filter((a) => a.changes.length).map((a) => a.id);
    for (const id of ["cursor", "opencode", "antigravity", "copilot-cli", "amp", "pi", "droid", "goose", "devin"]) assert.ok(setUp.includes(id), `init set up ${id}: ${setUp.join(", ")}`);
    assert.ok(tree(t.home).size > before.size, "init made files and folders");

    const u = run(["uninstall", "--yes"], bins);
    assert.equal(u.status, 0, u.stderr);
    assert.deepEqual({ home: [...tree(t.home)].sort(), installed: installed() }, { home: [...before].sort(), installed: agents });
  });

  test("keeps a folder init made while it holds a file of the user's, and removes it with the next uninstall once it is empty", () => {
    const ext = join(t.home, ".pi", "agent", "extensions");
    const pi = ["--yes", "--agent", "pi"];
    assert.equal(run(["init", ...pi, "--no-import"], nobin).status, 0);
    assert.ok(existsSync(join(ext, "coding-sh.ts")), "init wrote Pi's extension");
    writeFile(join(ext, "mine.ts"), "// mine\n");
    assert.equal(run(["uninstall", ...pi], nobin).status, 0);
    assert.deepEqual(readdirSync(ext), ["mine.ts"]);

    rmSync(join(ext, "mine.ts"));
    assert.equal(run(["init", ...pi, "--no-import"], nobin).status, 0);
    assert.equal(run(["uninstall", ...pi], nobin).status, 0);
    assert.equal(existsSync(join(t.home, ".pi")), false, "every folder the first init made is gone");
  });

  test("leaves the folders of an install made before init recorded them", () => {
    const ext = join(t.home, ".pi", "agent", "extensions");
    const pi = ["--yes", "--agent", "pi"];
    assert.equal(run(["init", ...pi, "--no-import"], nobin).status, 0);
    // installs.json as coding.sh 0.1.7 and older wrote it: the files only.
    const file = join(t.dataHome, "installs.json");
    const rec = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as { dirs?: unknown };
    assert.ok(rec.dirs, "init recorded the folders it made");
    delete rec.dirs;
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    assert.equal(run(["uninstall", ...pi], nobin).status, 0);
    assert.equal(existsSync(join(ext, "coding-sh.ts")), false);
    assert.deepEqual(readdirSync(ext), []);
  });
});
