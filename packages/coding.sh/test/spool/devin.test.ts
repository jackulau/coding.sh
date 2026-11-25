// Devin CLI runs Claude Code's hooks too (src/spool/devin.ts): which `claude-code` hook calls
// Devin made, and which of those are copies of a line a coding.sh hook for Devin writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildHookCommand } from "../../src/adapters/_shared/hooks.ts";
import { DEVIN_PROJECT_HOOK_FILES, devinConfigDir, devinHookAgent, devinHookEvents } from "../../src/spool/devin.ts";

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
/** An installed hook: hook.mjs, with the sh fast path beside it. */
const install = (dir: string) => {
  write(join(dir, "hook.mjs"), "");
  write(join(dir, "hook.sh"), "");
  return join(dir, "hook.mjs");
};

let root: string;
let hook: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-devin-spool-"));
  hook = install(join(root, "bin"));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** A hook entry as `coding.sh init` writes it for Devin. */
const ours = (event: string, path = hook, platform: NodeJS.Platform = process.platform) => ({ type: "command", command: buildHookCommand(path, "devin", event, [], platform), timeout: 10 });

describe("devinConfigDir", () => {
  it("DEVIN_CONFIG_HOME, else %APPDATA% on Windows and ~/.config elsewhere", () => {
    assert.equal(devinConfigDir({ DEVIN_CONFIG_HOME: "/x", HOME: "/h" }, "linux"), join("/x", "devin"));
    assert.equal(devinConfigDir({ HOME: "/h" }, "linux"), join("/h", ".config", "devin"));
    assert.equal(devinConfigDir({ HOME: "/h" }, "darwin"), join("/h", ".config", "devin"));
    assert.equal(devinConfigDir({ APPDATA: "C:/Users/u/AppData/Roaming", HOME: "/h" }, "win32"), join("C:/Users/u/AppData/Roaming", "devin"));
    assert.equal(devinConfigDir({ HOME: "C:/Users/u" }, "win32"), join("C:/Users/u", "AppData", "Roaming", "devin"));
  });
});

describe("devinHookEvents", () => {
  it("reads the user config's hooks, with comments, and counts only a hook file that exists", () => {
    const home = join(root, "u1");
    const env = { HOME: home, DEVIN_CONFIG_HOME: join(home, "cfg") };
    const config = {
      hooks: {
        Stop: [{ hooks: [ours("Stop")] }],
        PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "./guard.sh" }] }],
        SessionEnd: [{ hooks: [ours("SessionEnd", join(root, "gone", "hook.mjs"))] }],
      },
    };
    write(join(home, "cfg", "devin", "config.json"), `// mine\n${JSON.stringify(config, null, 2).replace(/\n}$/, ",\n}")}`);
    assert.deepEqual([...devinHookEvents(env, join(root, "nowhere"))], ["Stop"]);
  });

  it("walks from the session's folder up to the project root, DEVIN_PROJECT_DIR, through every hooks file there", () => {
    // A session in repo/pkg/src, as Devin 3000.14 runs one: DEVIN_PROJECT_DIR is the repository root.
    const repo = join(root, "repo");
    // hooks.v1.json is the event map itself; config.json and config.local.json hold it under "hooks".
    write(join(repo, ".devin", "hooks.v1.json"), JSON.stringify({ UserPromptSubmit: [{ hooks: [ours("UserPromptSubmit")] }] }));
    write(join(repo, "pkg", ".devin", "config.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "", hooks: [ours("PostToolUse")] }] } }));
    write(join(repo, "pkg", ".devin", "config.local.json"), JSON.stringify({ hooks: { PostCompaction: [{ hooks: [ours("PostCompaction")] }] } }));
    // Above the project root: not read.
    write(join(root, ".devin", "hooks.v1.json"), JSON.stringify({ SessionStart: [{ hooks: [ours("SessionStart")] }] }));
    const home = join(root, "u2");
    const env = { HOME: home, DEVIN_PROJECT_DIR: repo };
    const deep = join(repo, "pkg", "src");
    mkdirSync(deep, { recursive: true });
    assert.deepEqual([...devinHookEvents(env, deep)].sort(), ["PostCompaction", "PostToolUse", "UserPromptSubmit"]);
    if (process.platform === "win32") assert.equal(devinHookEvents({ ...env, DEVIN_PROJECT_DIR: repo.toUpperCase() }, deep).size, 3, "Windows paths compare without case");
    // A project's own hook runs in the project root, which sees no folder below it.
    assert.deepEqual([...devinHookEvents(env, repo)], ["UserPromptSubmit"]);
    // A folder outside the project root: that folder and the root, not their parents.
    assert.deepEqual([...devinHookEvents(env, join(root, "nowhere"))], ["UserPromptSubmit"]);
    // No project root: the folder alone.
    assert.deepEqual([...devinHookEvents({ HOME: home }, join(repo, "pkg"))].sort(), ["PostCompaction", "PostToolUse"]);
    assert.deepEqual(DEVIN_PROJECT_HOOK_FILES, ["hooks.v1.json", "config.json", "config.local.json"]);
  });

  it("outside a repository the project root is the session's folder, so no parent is read; a broken file adds nothing", () => {
    const loose = join(root, "loose", "a");
    write(join(root, "loose", ".devin", "hooks.v1.json"), JSON.stringify({ Stop: [{ hooks: [ours("Stop")] }] }));
    write(join(loose, ".devin", "config.json"), "{ not json");
    assert.deepEqual([...devinHookEvents({ HOME: join(root, "u3"), DEVIN_PROJECT_DIR: loose }, loose)], []);
  });

  it("reads a quoted hook path as a shell does: a backslash escapes only a quote, a backslash, $ or `", () => {
    // Written by hand, so a backslash path stays raw (a folder named `hand\made` outside Windows).
    const hand = join(root, "hand\\made", "hook.mjs");
    write(hand, "");
    // buildHookCommand escapes the $ in a path for sh; it is read back without the escape. On
    // Windows init refuses such a path for Devin, so the command is the one built outside Windows.
    const dollar = install(join(root, "a$b"));
    const project = join(root, "p0");
    write(
      join(project, ".devin", "hooks.v1.json"),
      JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: `node "${hand}" devin Stop` }] }], SessionEnd: [{ hooks: [ours("SessionEnd", dollar, "linux")] }] }),
    );
    assert.deepEqual([...devinHookEvents({ HOME: join(root, "u5") }, project)].sort(), ["SessionEnd", "Stop"]);
  });

  it("finds a bare hook path, and a quoted one after quoted text with escaped quotes", (t) => {
    if (/\s/.test(hook)) return t.skip("a bare path cannot hold whitespace");
    const project = join(root, "p3");
    write(
      join(project, ".devin", "hooks.v1.json"),
      JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: `node ${hook} devin Stop` }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `echo "a \\"quoted\\" word \\\\" && ${ours("SessionEnd").command}` }] }],
      }),
    );
    assert.deepEqual([...devinHookEvents({ HOME: join(root, "u6") }, project)].sort(), ["SessionEnd", "Stop"]);
  });
});

describe("devinHookAgent", () => {
  const payload = { hook_event_name: "Stop", session_id: "brave-otter", prompt_id: "p1", stop_hook_active: false };

  it("is not Devin's without DEVIN_PROJECT_DIR, or with a Claude Code transcript in the payload", () => {
    const project = join(root, "p1");
    assert.equal(devinHookAgent("Stop", payload, JSON.stringify(payload), { HOME: project }, project), undefined);
    const claude = { ...payload, session_id: "0c3f5e1a-2b4d-4c6e-8f00-112233445566", transcript_path: "/home/user/.claude/projects/-work-demo/0c3f5e1a-2b4d-4c6e-8f00-112233445566.jsonl" };
    const env = { HOME: project, DEVIN_PROJECT_DIR: project };
    assert.equal(devinHookAgent("Stop", claude, JSON.stringify(claude), env, project), undefined);
    // An unparsed payload: the transcript is found in the text.
    assert.equal(devinHookAgent("Stop", undefined, JSON.stringify(claude), env, project), undefined);
  });

  it("is Devin's when no coding.sh hook for Devin fires for the event; a copy when one does", () => {
    const project = join(root, "p2");
    const env = { HOME: join(root, "u4"), DEVIN_PROJECT_DIR: project };
    assert.equal(devinHookAgent("Stop", payload, JSON.stringify(payload), env, project), "devin");
    write(join(project, ".devin", "config.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [ours("Stop")] }], PostCompaction: [{ hooks: [ours("PostCompaction")] }] } }));
    assert.equal(devinHookAgent("Stop", payload, JSON.stringify(payload), env, project), "drop");
    // The payload's event name counts, else the hook's argument.
    assert.equal(devinHookAgent("Stop", { ...payload, hook_event_name: "SessionEnd" }, "", env, project), "devin");
    assert.equal(devinHookAgent("UserPromptSubmit", undefined, "", env, project), "devin");
    // Claude Code's PreCompact hook and Devin's PostCompaction hook fire for one compaction.
    assert.equal(devinHookAgent("PreCompact", { hook_event_name: "PreCompact", session_id: "brave-otter" }, "", env, project), "drop");
  });
});
