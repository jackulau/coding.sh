// Every `coding.sh …` command in a guide's sh blocks must parse against the CLI registry: the
// command and action exist, every flag is one the command takes with a valid value, and the
// positionals fit. docs/guides/terse-mode.md is also checked end to end: its two harness TOMLs
// snapshot into arms that differ by one rule file, and its SQL reads per-arm tokens from a store.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GraderDelta } from "../../src/experiments/compare.ts";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import { extractGlobals } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";
import type { HarnessBundle } from "../../src/core/types.ts";
import { bundleItemChange } from "../../src/runner/harness-report.ts";
import { fixtureBundle, fixtureRun } from "../../src/store/conformance.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok } from "../query/_seed.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(repo, "docs", rel), "utf8");

/** Guides whose commands are checked. */
const GUIDES = ["guides/terse-mode.md", "how-to/does-this-plugin-help.md", "how-to/test-agents-md-change.md"];

/** The ```sh blocks of a Markdown doc. */
function shBlocks(md: string): string[] {
  return [...md.matchAll(/^```(?:sh|bash|shell)\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
}

/**
 * Split shell text into commands of words, the way sh would for the subset docs use: single and
 * double quotes (a quoted newline stays in the word), backslash-newline joins lines, `#` at the
 * start of a word comments out the rest of the line. A command's words stop at the first `|`,
 * `>`, `>>`, `2>`, `&&` or `;`. Expansions in double quotes are refused: the docs must not need them.
 */
function shellCommands(text: string): string[][] {
  const cmds: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  const end = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCmd = () => {
    end();
    if (words.length) cmds.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) throw new Error(`unclosed ' in: ${text.slice(i, i + 60)}`);
      word = (word ?? "") + text.slice(i + 1, j);
      i = j;
    } else if (c === '"') {
      let s = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && '"\\$`'.includes(text[j + 1] ?? "")) s += text[++j];
        else if (text[j] === "$" && /[({A-Za-z_0-9@*#?!-]/.test(text[j + 1] ?? "")) throw new Error(`shell would expand ${text.slice(j, j + 12)}`);
        else if (text[j] === "`") throw new Error("backticks in a double-quoted word");
        else s += text[j];
      }
      if (j >= text.length) throw new Error(`unclosed " in: ${text.slice(i, i + 60)}`);
      word = (word ?? "") + s;
      i = j;
    } else if (c === "\\" && text[i + 1] === "\n") {
      i++;
    } else if (c === "\\") {
      word = (word ?? "") + (text[++i] ?? "");
    } else if (c === "#" && word === undefined) {
      while (i < text.length && text[i] !== "\n") i++;
      endCmd();
    } else if (c === "\n") {
      endCmd();
    } else if (c === " " || c === "\t") {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  endCmd();
  return cmds.map((w) => {
    const stop = w.findIndex((x) => ["|", ">", ">>", "2>", "&&", ";", "||"].includes(x));
    return stop < 0 ? w : w.slice(0, stop);
  });
}

/** What main() checks before it runs a command; throws the UsageError it would raise. */
function checkArgs(argv: readonly string[]): void {
  const { globals, rest } = extractGlobals(argv);
  let [name, ...tail] = rest;
  if (name === "help") return;
  if (name === undefined) throw new UsageError("no command");
  const cmd = findCommand(name);
  if (!cmd) throw new UsageError(`unknown command ${name}`);
  let action;
  if (cmd.actions && !(cmd.actionOptional && (tail[0] === undefined || tail[0].startsWith("-")) && !globals.help)) {
    action = cmd.actions.find((a) => a.name === tail[0]);
    if (!action) throw new UsageError(`unknown action ${cmd.name} ${tail[0]}`);
    tail = tail.slice(1);
  }
  if (globals.help) return;
  const args = action ? (action.args ?? []) : (cmd.args ?? []);
  const flags = action ? (action.flags ?? []) : (cmd.flags ?? []);
  const variadic = args.some((a) => a.variadic) && !cmd.passthrough;
  const parsed = parseArgs(tail, flags, { maxPositionals: cmd.passthrough ? 0 : variadic ? undefined : args.length, sensitive: cmd.sensitive === true });
  if (cmd.passthrough) {
    if (!parsed.rest.length) throw new UsageError("missing command after --");
    return;
  }
  if (parsed.sawDashDash) parsed.positionals.push(...parsed.rest);
  const required = args.filter((a) => a.required).length;
  if (parsed.positionals.length < required) throw new UsageError(`missing <${args.filter((a) => a.required)[parsed.positionals.length]!.name}>`);
}

/** The guide's `coding.sh` commands, without the program name. */
function commandsOf(md: string): string[][] {
  return shBlocks(md)
    .flatMap(shellCommands)
    .filter((w) => w[0] === "coding.sh")
    .map((w) => w.slice(1));
}

/** The fenced block that follows a line naming `path`: (e.g. "`terse-ab/base.toml`:"). */
function fileBlock(md: string, path: string): string {
  const m = new RegExp("^`" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`:\\n\\n```\\w*\\n([\\s\\S]*?)^```", "m").exec(md);
  assert.ok(m, `the guide shows ${path}`);
  return m[1]!;
}

describe("guide commands", () => {
  it("splits shell text like sh", () => {
    assert.deepEqual(shellCommands(`coding.sh a --b 'x y' # note\ncoding.sh c \\\n  --d "e\nf" > out.json`), [
      ["coding.sh", "a", "--b", "x y"],
      ["coding.sh", "c", "--d", "e\nf"],
    ]);
    assert.deepEqual(shellCommands(`coding.sh show latest#-1 --all`), [["coding.sh", "show", "latest#-1", "--all"]]);
    assert.throws(() => shellCommands(`coding.sh sql "select $HOME"`), /expand/);
  });

  it("rejects what main() rejects", () => {
    assert.throws(() => checkArgs(["compare", "base", "--k"]), UsageError);
    assert.throws(() => checkArgs(["compare", "base", "--nope"]), UsageError);
    assert.throws(() => checkArgs(["harness", "snap"]), UsageError);
    assert.throws(() => checkArgs(["sessions", "a", "b", "c"]), UsageError);
    assert.doesNotThrow(() => checkArgs(["compare", "base", "--k", "3", "--json"]));
  });

  for (const guide of GUIDES) {
    it(`${guide}: every coding.sh command parses`, () => {
      const cmds = commandsOf(read(guide));
      assert.ok(cmds.length >= 3, "found the commands");
      for (const argv of cmds) {
        assert.doesNotThrow(() => checkArgs(argv), (e: unknown) => `coding.sh ${argv.join(" ")}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  it("terse-mode.md names the flags its report reading depends on", () => {
    const cmds = commandsOf(read("guides/terse-mode.md"));
    const compare = cmds.filter((c) => c[0] === "compare");
    for (const flag of ["--gate", "--promote", "--with", "--dry-run", "--max-cost"]) assert.ok(compare.some((c) => c.includes(flag)), flag);
    assert.ok(cmds.some((c) => c[0] === "exp" && c[1] === "replay" && c.includes("system=@terse-system.md")));
    assert.ok(cmds.some((c) => c[0] === "sql"));
  });
});

describe("terse-mode.md end to end", () => {
  let env: TmpEnv;
  const md = read("guides/terse-mode.md");
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  it("its two TOMLs snapshot into arms that differ by one always-on rule", async () => {
    const proj = join(env.root, "proj");
    mkdirSync(join(proj, "terse-ab"), { recursive: true });
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), "Run the tests before you say you are done.\n");
    writeFileSync(join(proj, ".claude", "settings.json"), "{}\n");
    for (const f of ["terse-ab/base.toml", "terse-ab/concise.toml", "terse-ab/concise.md"]) writeFileSync(join(proj, f), fileBlock(md, f));
    for (const argv of commandsOf(md).filter((c) => c[0] === "harness")) {
      ok(argv.map((a) => (a.startsWith("terse-ab/") ? join(proj, a) : a)));
    }
    const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    let base: HarnessBundle | undefined;
    let concise: HarnessBundle | undefined;
    try {
      base = await store.getBundle("base");
      concise = await store.getBundle("concise");
    } finally {
      await store.close();
    }
    assert.ok(base && concise);
    assert.deepEqual(Object.keys(base.files).sort(), [".claude/settings.json", "CLAUDE.md"]);
    assert.deepEqual(bundleItemChange(base, concise), { mode: "add", path: ".claude/rules/concise.md" });
    assert.match(fileBlock(md, "terse-ab/concise.md"), /^Be concise\./);
  });

  it("its SQL reads each arm's tokens and cost from the latest comparison", async () => {
    const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    const usage = (out: number, cw: number, cost: number) => ({ inputTokens: 10, outputTokens: out, cacheReadTokens: 1000, cacheWriteTokens: cw, costUsd: cost });
    const agent = (u: ReturnType<typeof usage>) => ({ exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "", usage: u });
    try {
      await store.putBundle(fixtureBundle({ id: "bA", name: "base" }));
      await store.putBundle(fixtureBundle({ id: "bB", name: "concise" }));
      // An older comparison, left out by the subquery.
      await store.putRun(fixtureRun({ id: "old", experimentId: "x1", bundleId: "bA", startedAt: 1, agent: agent(usage(9999, 9999, 9)) }));
      await store.putRun(fixtureRun({ id: "a1", experimentId: "x2", bundleId: "bA", startedAt: 10, agent: agent(usage(200, 1000, 0.1)) }));
      await store.putRun(fixtureRun({ id: "a2", experimentId: "x2", bundleId: "bA", startedAt: 11, pass: false, agent: agent(usage(100, 1000, 0.2)) }));
      await store.putRun(fixtureRun({ id: "b1", experimentId: "x2", bundleId: "bB", startedAt: 12, agent: agent(usage(120, 1500, 0.15)) }));
      // A superseded, a cancelled and an infra-failed run don't count.
      await store.putRun(fixtureRun({ id: "b2", experimentId: "x2", bundleId: "bB", startedAt: 13, superseded: true, agent: agent(usage(9999, 9999, 9)) }));
      await store.putRun(fixtureRun({ id: "b3", experimentId: "x2", bundleId: "bB", startedAt: 14, cancelled: true, agent: agent(usage(9999, 9999, 9)) }));
      await store.putRun(fixtureRun({ id: "b4", experimentId: "x2", bundleId: "bB", startedAt: 15, infra: "rate-limit", agent: agent(usage(9999, 9999, 9)) }));
    } finally {
      await store.close();
    }
    const sql = commandsOf(md).find((c) => c[0] === "sql");
    assert.ok(sql);
    const r = ok([...sql, "--json"]);
    const doc = JSON.parse(r.stdout) as { columns: string[]; rows: unknown[][] } | { rows: Record<string, unknown>[] };
    const rows = (doc.rows as unknown[]).map((row) => (Array.isArray(row) ? Object.fromEntries((doc as { columns: string[] }).columns.map((c, i) => [c, row[i]])) : row)) as Record<string, unknown>[];
    assert.deepEqual(rows, [
      { arm: "base", runs: 2, passed: 1, output: 150, input: 10, cache_write: 1000, cache_read: 1000, cost: 0.15 },
      { arm: "concise", runs: 1, passed: 1, output: 120, input: 10, cache_write: 1500, cache_read: 1000, cost: 0.15 },
    ]);
  });
});

/** The part of evals.md under one `###` heading. */
function section(md: string, heading: string): string {
  const m = new RegExp("^### " + heading + "\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))", "m").exec(md);
  assert.ok(m, `evals.md has a section "${heading}"`);
  return m[1]!;
}

describe("evals.md: compare an edited model with its base", () => {
  let env: TmpEnv;
  const md = read("guides/evals.md");
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  it("runs on a stub model: terminated and correct are two paired deltas, and --given conditions on the first", () => {
    const recipe = section(md, "Compare an edited model with its base");
    const proj = join(env.root, "recipe");
    mkdirSync(proj, { recursive: true });
    // A stub for generate.py: base finishes m1 and m2, edited finishes every case and misses m3;
    // a cut answer is wrong.
    writeFileSync(
      join(proj, "gen.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=Number(JSON.parse(s).slice(1));const edited=process.env.MODEL==="edited";
const done=edited||n<=2;const right=edited?n!==3:n<=2;
process.stdout.write(JSON.stringify({answer:right?String(n):"?",finish_reason:done?"stop":"length"}))});\n`,
    );
    writeFileSync(join(proj, "math.jsonl"), [1, 2, 3, 4].map((n) => JSON.stringify({ id: `m${n}`, input: `m${n}`, expected: { answer: String(n) } })).join("\n") + "\n");
    for (const f of ["base.json", "edited.json", "terminated.json", "correct.json"]) {
      const spec = JSON.parse(fileBlock(recipe, f)) as { kind: string; command?: string; args?: string[] };
      if (spec.kind === "command") Object.assign(spec, { command: process.execPath, args: [join(proj, "gen.mjs")] });
      writeFileSync(join(proj, f), JSON.stringify(spec));
    }
    assert.equal((JSON.parse(fileBlock(recipe, "terminated.json")) as { name: string }).name, "terminated");
    assert.equal((JSON.parse(fileBlock(recipe, "correct.json")) as { name: string }).name, "correct");

    const cmds = commandsOf(recipe);
    for (const argv of cmds) assert.doesNotThrow(() => checkArgs(argv), `coding.sh ${argv.join(" ")} parses`);
    assert.deepEqual(cmds.map((c) => c.slice(0, 2).join(" ")), ["dataset import", "exp run", "exp run", "exp compare", "exp compare"]);
    assert.ok(cmds[4]!.includes("--given") && cmds[4]!.includes("terminated"));
    const out: string[] = [];
    for (const argv of cmds) {
      out.push(ok([...argv.map((a) => (/^(?:math\.jsonl|\w+\.json)$/.test(a) ? join(proj, a) : a)), "--json"]).stdout);
    }
    const graders = (stdout: string) => (JSON.parse(stdout) as { comparison: { graders: GraderDelta[]; given?: { kept: number; dropped: number } } }).comparison;
    const plain = graders(out[3]!);
    assert.deepEqual(plain.graders.map((g) => g.id), ["terminated", "correct"]);
    for (const g of plain.graders) assert.ok(g.diff.mean > 0, `${g.id} is up: ${JSON.stringify(plain)}`);
    assert.equal(plain.given, undefined);
    // Among the two answers both finish, base and edited are both right.
    const given = graders(out[4]!);
    assert.deepEqual([given.given?.kept, given.given?.dropped], [2, 2]);
    assert.equal(given.graders.find((g) => g.id === "correct")!.diff.mean, 0);
  });

  it("fails when the section is gone", () => {
    const without = md.replace(/^### Compare an edited model with its base\n[\s\S]*?(?=^### )/m, "");
    assert.throws(() => section(without, "Compare an edited model with its base"), /has a section/);
  });
});
