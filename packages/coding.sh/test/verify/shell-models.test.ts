// The shell models in _shells.ts, checked against the real shells on this machine. The quoting proof
// (quoting-proof.test.ts) is only as good as these models, so each model runs here next to the shell
// it stands for, on command lines built from strings over the hostile alphabet (HOSTILE): the forms
// the quoting functions write, the same strings in single and double quotes, and the strings bare.
// The models answer undefined for what they leave out; every line a model answers for is run in the
// real shell, and the arguments the program gets must be the model's.
//
// - sh: Git for Windows' bash.exe and sh.exe, or /bin/sh, bash, dash and zsh where they are (zsh with
//   the `prompt` model). A shell function stands in for the program, so no path is converted.
// - The C runtime's argv: node.exe started with a command line given as is.
// - cmd.exe (`cmd /d /s /c`): node.exe and npm's .cmd shim, with variables set so that %NAME% expands.
// - Windows PowerShell 5.1 and PowerShell 7 (`-NoProfile -NonInteractive`): node.exe, npm's .ps1
//   shim and, from 5.1, its .cmd shim.
//
// FACTS are lines whose real result is known; they hold on the real shell, and on the model where it
// answers. A shell that is not installed is skipped (pwsh, and everything but sh outside Windows).
// The strings come from a fixed seed, so a run is repeatable. 20 to 40 seconds on Windows.
import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { quoteArg as hookQuote } from "../../src/adapters/_shared/hooks.ts";
import { shq } from "../../src/bench/schedule.ts";
import { shellQuote } from "../../src/cli/args.ts";
import { quoteArg } from "../../src/cli/next-steps.ts";
import { npmCmdShim } from "../_bin.ts";
import { cmdToNode, cmdToShim, crtArgv, HOSTILE, psToCmdShim, psToNode, psToShim, shWords, windowsEnv, type Env, type PsVersion } from "./_shells.ts";

const WIN = process.platform === "win32";
const SYS = process.env.SystemRoot ?? "C:\\Windows";
const PS51 = join(SYS, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PWSH = WIN ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), ...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "pwsh.exe"))].find((p) => p && existsSync(p)) : undefined;

/** `n` strings of length 0 to `max` over `alphabet`, from a fixed seed (mulberry32). */
function strings(seed: number, n: number, max: number, alphabet: readonly string[]): string[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => {
    let s = "";
    for (let len = Math.floor(next() * (max + 1)); len > 0; len--) s += alphabet[Math.floor(next() * alphabet.length)];
    return s;
  });
}

const RANDOM = strings(1, 100, 6, HOSTILE);
const CRT_TAILS = strings(2, 160, 8, ["\\", '"', " ", "\t", "a"]);
const PERCENT = strings(3, 60, 7, ["%", "a", '"', " ", "^", "é", "!", "\\"]);
const PS_WORDS = strings(4, 40, 6, ["'", '"', "\u2019", "\u201C", "$", " ", "a", "-", ":", ".", "\\", "%"]);
const sq = (s: string) => `'${s}'`;
const dq = (s: string) => `"${s}"`;

/** Lines that hold on the real shell. */
const FACTS: { shell: "ps51" | "cmd"; line: string; argv: string[] }[] = [
  // 5.1 passes an argument's inner double quotes unescaped, and drops an empty one.
  { shell: "ps51", line: `node argv.mjs 'a"b'`, argv: ["ab"] },
  { shell: "ps51", line: "node argv.mjs x '' y", argv: ["x", "y"] },
  // A bare parameter ends at `.`.
  { shell: "ps51", line: "node argv.mjs -a.b", argv: ["-a", ".b"] },
  // npm's .ps1 shim: the first bare `--` is dropped and a bare -name:value split.
  { shell: "ps51", line: "codingsh -- x -- y", argv: ["x", "--", "y"] },
  { shell: "ps51", line: "codingsh -a:b --c:d", argv: ["-a:", "b", "--c:d"] },
  // A .cmd gets a word with no space bare, and cmd reads ^, % and & in it.
  { shell: "ps51", line: "codingsh.cmd 'a^b'", argv: ["ab"] },
  { shell: "ps51", line: "codingsh.cmd '%fvA%'", argv: ["1"] },
  { shell: "ps51", line: "codingsh.cmd 'a&b'", argv: ["a"] },
  // cmd expands a set %NAME% inside double quotes and keeps an unset one; the .cmd shim reads ^ again.
  { shell: "cmd", line: 'node argv.mjs "%fvA%" %fvB%', argv: ["1", "%fvB%"] },
  { shell: "cmd", line: 'node argv.mjs x "" y --reply={}', argv: ["x", "", "y", "--reply={}"] },
  { shell: "cmd", line: "codingsh a^^^&b", argv: ["a&b"] },
];

type Got = string[] | string;
interface Case {
  line: string;
  want: string[];
}

/** The distinct lines a model answers for, with its answer. */
function cases(lines: readonly string[], model: (line: string) => string[] | undefined): Case[] {
  const out: Case[] = [];
  for (const line of new Set(lines)) {
    const want = model(line);
    if (want) out.push({ line, want });
  }
  return out;
}

function agree(cs: readonly Case[], got: readonly Got[], min: number): void {
  const bad = cs.flatMap((c, i) => (JSON.stringify(got[i]) === JSON.stringify(c.want) ? [] : [{ line: c.line, model: c.want, shell: got[i] }]));
  assert.deepEqual(bad, []);
  assert.ok(cs.length >= min, `${cs.length} lines checked, fewer than ${min}`);
}

function run(file: string, args: readonly string[], o: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(file, args, { ...o, encoding: "utf8", timeout: 120_000, maxBuffer: 64 << 20 }, (_err, stdout, stderr) => done({ stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function pool<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  }));
  return out;
}

/** The one argv the stand-in printed, or what went wrong. */
function single(text: string, stderr: string): Got {
  const runs = text.split(/\r?\n/).filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  return runs.length === 1 ? runs[0]! :`${runs.length} runs ${JSON.stringify(runs)} ${stderr.slice(0, 300)}`;
}

const STAND_IN = `import { appendFileSync } from "node:fs";
const j = JSON.stringify({ tag: process.env.ARGV_TAG ?? "", argv: process.argv.slice(2) }).replace(/[\\u007f-\\uffff]/g, (c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
if (process.env.ARGV_OUT) appendFileSync(process.env.ARGV_OUT, j + "\\n");
else process.stdout.write(j + "\\n");
`;

// Each line comes in a variable, so nothing here quotes it; argv prints each argument and a mark.
const SH_RUNNER = `argv() {
  for a in "$@"; do printf '%s\\037' "$a"; done
  printf '\\036'
}
i=0
while [ "$i" -lt "$FV_N" ]; do
  eval "line=\\\${FV_L$i}"
  printf '\\035%s\\035' "$i"
  eval "$line"
  i=$((i + 1))
done
`;

// npm's .ps1 shim for a bin (cmd-shim), as `npm install` writes it.
const PS1_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/coding.sh/dist/cli.mjs" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/coding.sh/dist/cli.mjs" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/node_modules/coding.sh/dist/cli.mjs" $args
  } else {
    & "node$exe"  "$basedir/node_modules/coding.sh/dist/cli.mjs" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

const PS_RUNNER = `$cases = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:FV_CASES | ConvertFrom-Json
foreach ($c in $cases) {
  $env:ARGV_TAG = [string]$c.tag
  try { Invoke-Expression $c.line } catch { [Console]::Error.WriteLine("case $($c.tag): $_") }
}
`;

function shShells(): { name: string; file: string; args: string[]; prompt: boolean }[] {
  const all = WIN
    ? [
        { name: "Git bash.exe", file: join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), args: ["--noprofile", "--norc"], prompt: false },
        { name: "Git sh.exe", file: join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"), args: ["--noprofile", "--norc"], prompt: false },
      ]
    : [
        { name: "/bin/sh", file: "/bin/sh", args: [], prompt: false },
        { name: "bash", file: "/bin/bash", args: ["--noprofile", "--norc"], prompt: false },
        { name: "dash", file: "/bin/dash", args: [], prompt: false },
        { name: "zsh", file: "/bin/zsh", args: ["-f"], prompt: true },
      ];
  return all.filter((s) => existsSync(s.file));
}

describe("the shell models agree with the real shells", () => {
  let dir = "";
  let winEnv: Record<string, string> = {};
  let env: Env = () => undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "csh-shell-models-"));
    const home = join(dir, "home");
    mkdirSync(join(home, "AppData", "Local"), { recursive: true });
    mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(dir, "tmp"));
    mkdirSync(join(dir, "node_modules", "coding.sh", "dist"), { recursive: true });
    writeFileSync(join(dir, "argv.mjs"), STAND_IN);
    writeFileSync(join(dir, "node_modules", "coding.sh", "dist", "cli.mjs"), STAND_IN);
    writeFileSync(join(dir, "codingsh.cmd"), npmCmdShim("node_modules\\coding.sh\\dist\\cli.mjs"));
    writeFileSync(join(dir, "codingsh.ps1"), PS1_SHIM);
    writeFileSync(join(dir, "argv.sh"), SH_RUNNER);
    writeFileSync(join(dir, "run.ps1"), PS_RUNNER);
    winEnv = {
      SystemRoot: SYS,
      windir: SYS,
      ComSpec: process.env.ComSpec ?? join(SYS, "System32", "cmd.exe"),
      PATH: [dir, dirname(process.execPath), join(SYS, "System32"), SYS, dirname(PS51)].join(";"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: home,
      HOME: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TEMP: join(dir, "tmp"),
      TMP: join(dir, "tmp"),
      a: "Q",
      fvA: "1",
      // Keep PowerShell 7 from sending telemetry or checking for updates when it starts.
      POWERSHELL_TELEMETRY_OPTOUT: "1",
      POWERSHELL_UPDATECHECK: "Off",
    };
    env = windowsEnv(winEnv);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const sh of shShells()) {
    test(`sh: ${sh.name}`, async () => {
      const lines = RANDOM.flatMap((s) => [shellQuote(s), hookQuote(s), shq(s), dq(s), sq(s), s].map((w) => `argv ${w}`));
      lines.push(`argv ${RANDOM.map(shellQuote).join(" ")}`, "argv '' \"\" a\\ b \"\\$\\`\\\"\\\\\"");
      const cs = cases(lines, (l) => {
        const w = shWords(l, { prompt: sh.prompt });
        return w && w[0] === "argv" ? w.slice(1) : undefined;
      });
      const got: Got[] = [];
      for (let start = 0; start < cs.length; ) {
        const vars: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, FV_N: "0", MSYS_NO_PATHCONV: "1" };
        if (WIN) vars.LC_ALL = "C.UTF-8";
        let n = 0;
        for (let size = 0; start + n < cs.length && size < 12_000; n++) {
          vars[`FV_L${n}`] = cs[start + n]!.line;
          size += cs[start + n]!.line.length + 8;
        }
        vars.FV_N = String(n);
        const r = await run(sh.file, [...sh.args, join(dir, "argv.sh")], { cwd: dir, env: vars });
        const parts = r.stdout.split("\x1d");
        const body = new Map<number, string>();
        for (let k = 1; k + 1 < parts.length; k += 2) body.set(Number(parts[k]), parts[k + 1]!);
        for (let i = 0; i < n; i++) {
          const b = body.get(i);
          got.push(b !== undefined && b.indexOf("\x1e") === b.length - 1 ? b.slice(0, -1).split("\x1f").slice(0, -1) : `no single run: ${JSON.stringify(b)} ${r.stderr.slice(0, 300)}`);
        }
        start += n;
      }
      agree(cs, got, 150);
    });
  }

  test("the C runtime's argv (node.exe)", { skip: !WIN && "Windows only" }, async () => {
    const cs = cases(CRT_TAILS.map((t) => `node argv.mjs ${t}`), (l) => crtArgv(l).slice(2));
    const got = await pool(cs, 8, async (c) => {
      // `node`, found on PATH: the command line starts with the file as given, unquoted.
      const r = await run("node", ["argv.mjs", c.line.slice("node argv.mjs ".length)], { cwd: dir, env: winEnv, windowsVerbatimArguments: true });
      return single(r.stdout, r.stderr);
    });
    agree(cs, got, 100);
  });

  test("cmd.exe", { skip: !WIN && "Windows only" }, async () => {
    const words = [...RANDOM, ...PERCENT].flatMap((s) => [quoteArg(s, {}, "win32"), hookQuote(s), dq(s), s]);
    const shim = [...RANDOM, ...PERCENT].flatMap((s) => [quoteArg(s, {}, "win32"), dq(s), s]);
    const cs = [...cases(words.map((w) => `node argv.mjs ${w}`), (l) => cmdToNode(l, env)), ...cases(shim.map((w) => `codingsh ${w}`), (l) => cmdToShim(l, env))];
    const got = await pool(cs, 8, async (c) => {
      const r = await run(winEnv.ComSpec!,["/d", "/s", "/c", `"${c.line}"`], { cwd: dir, env: winEnv, windowsVerbatimArguments: true });
      return single(r.stdout, r.stderr);
    });
    agree(cs, got, 250);
  });

  const powershell = async (exe: string, cs: readonly Case[], tag: string): Promise<Got[]> => {
    const runs = new Map<number, string[][]>();
    const batches = 4;
    await Promise.all(Array.from({ length: batches }, async (_, b) => {
      const file = join(dir, `${tag}-cases-${b}.json`);
      const out = join(dir, `${tag}-out-${b}.jsonl`);
      writeFileSync(file, JSON.stringify(cs.flatMap((c, i) => (i % batches === b ? [{ tag: i, line: c.line }] : []))));
      await run(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "run.ps1")], { cwd: dir, env: { ...winEnv, FV_CASES: file, ARGV_OUT: out } });
      if (!existsSync(out)) return;
      for (const l of readFileSync(out, "utf8").split(/\r?\n/)) {
        if (!l) continue;
        const j = JSON.parse(l) as { tag: string; argv: string[] };
        const list = runs.get(Number(j.tag)) ?? [];
        list.push(j.argv);
        runs.set(Number(j.tag), list);
      }
    }));
    return cs.map((_, i) => {
      const r = runs.get(i) ?? [];
      return r.length === 1 ? r[0]! :`${r.length} runs ${JSON.stringify(r)}`;
    });
  };

  const psCases = (v: PsVersion): Case[] => {
    const all = [...RANDOM, ...PS_WORDS];
    const cs = [
      ...cases(all.flatMap((s) => [quoteArg(s, {}, "win32"), sq(s), dq(s), s].map((w) => `node argv.mjs ${w}`)), (l) => psToNode(l, v)),
      ...cases(all.map((s) => `& node argv.mjs ${hookQuote(s)}`), (l) => psToNode(l, v)),
      ...cases(all.flatMap((s) => [quoteArg(s, {}, "win32"), s].map((w) => `codingsh ${w}`)), (l) => psToShim(l, v)),
    ];
    // The model follows a .cmd run from Windows PowerShell 5.1 only.
    if (v === "5.1") cs.push(...cases(all.map((s) => `codingsh.cmd ${quoteArg(s, {}, "win32")}`), (l) => psToCmdShim(l, env)));
    return cs;
  };

  test("Windows PowerShell 5.1", { skip: (!WIN || !existsSync(PS51)) && "no powershell.exe" }, async () => {
    const cs = psCases("5.1");
    agree(cs, await powershell(PS51, cs, "ps51"), 250);
  });

  test("PowerShell 7", { skip: !PWSH && "pwsh is not installed" }, async () => {
    const cs = psCases("7");
    agree(cs, await powershell(PWSH!, cs, "ps7"), 250);
  });

  test("the known facts hold on the real shell and the model", { skip: !WIN && "Windows only" }, async () => {
    const model = (f: (typeof FACTS)[number]) => {
      if (f.shell === "cmd") return f.line.startsWith("codingsh ") ? cmdToShim(f.line, env) : cmdToNode(f.line, env);
      if (f.line.startsWith("codingsh.cmd ")) return psToCmdShim(f.line, env);
      return f.line.startsWith("codingsh ") ? psToShim(f.line, "5.1") : psToNode(f.line, "5.1");
    };
    for (const f of FACTS) {
      const m = model(f);
      if (m) assert.deepEqual(m, f.argv, `model: ${f.line}`);
    }
    const cmd = FACTS.filter((f) => f.shell === "cmd");
    const got = await pool(cmd, 4, async (f) => single((await run(winEnv.ComSpec!,["/d", "/s", "/c", `"${f.line}"`], { cwd: dir, env: winEnv, windowsVerbatimArguments: true })).stdout, ""));
    assert.deepEqual(got, cmd.map((f) => f.argv));
    if (existsSync(PS51)) {
      const ps = FACTS.filter((f) => f.shell === "ps51").map((f) => ({ line: f.line, want: f.argv }));
      assert.deepEqual(await powershell(PS51, ps, "facts"), ps.map((f) => f.want));
    }
  });
});
