// Commands the viewer copies are pasted into a shell, so every value in them (a session id, a
// file path, a benchmark name) is quoted by the page's one quoting function, shq(), and the
// command itself is named for the shell by forShell(): codingsh on Windows.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const script = html.slice(html.indexOf("<script"), html.lastIndexOf("</script>"));

// The constants shCmd() and forShell() read, PASTE_UNSAFE to IS_WIN.
const consts = script.slice(script.indexOf("const PASTE_UNSAFE = "), script.indexOf("\n", script.indexOf("const IS_WIN = ")));

function fn(name: string): string {
  let a = script.indexOf(`function ${name}(`);
  assert.ok(a >= 0, `function ${name} is in the page`);
  if (script.slice(a - 6, a) === "async ") a -= 6;
  const b = script.indexOf("\n}\n", a);
  return script.slice(a, b + 2);
}

/** The page's command functions as a browser with this navigator runs them; h() makes plain objects. */
function page(nav: Record<string, unknown>) {
  const copied: string[] = [];
  const toasts: string[] = [];
  const ctx = {
    String,
    Set,
    navigator: { ...nav, clipboard: { writeText: async (t: string) => void copied.push(t) } },
    toast: (m: string) => toasts.push(m),
    h: (tag: string, attrs: unknown, ...kids: any[]) => ({ tag, attrs, kids }),
  };
  const names = ["forShell", "indexText", "shq", "shCmd", "copy", "cmdBlock", "workNextParts", "workNext"];
  const f: any = runInNewContext(`${consts}\n${names.map((n) => fn(n)).join("\n")}\n({ IS_WIN, ${names.join(", ")} })`, ctx);
  return { f, copied, toasts };
}

/** workNext's parts as text, with each code part in <>. */
const plain = (parts: any[]) => Array.from(parts, (p) => (typeof p === "string" ? p : `<${p.kids.join("")}>`)).join("");

test("shq leaves plain words alone and quotes anything a shell would read", () => {
  const { f } = page({ platform: "Linux x86_64" });
  assert.equal(f.shq("team/chat-1"), "team/chat-1");
  assert.equal(f.shq("a1b2c3d4-e5f6"), "a1b2c3d4-e5f6");
  assert.equal(f.shq("x; touch pwned"), "'x; touch pwned'");
  assert.equal(f.shq("$(id)"), "'$(id)'");
  assert.equal(f.shq("it's"), "'it'\\''s'");
  assert.equal(f.shq(""), "''");
  assert.equal(f.shCmd("coding.sh eval new", "a`b`"), "coding.sh eval new 'a`b`'");
  assert.equal(f.shCmd("coding.sh replay", "s1", "--step", 3), "coding.sh replay s1 --step 3");
  if (process.platform !== "win32") {
    // What sh hands the command is the value itself.
    for (const v of ["x; touch pwned", "it's", "$(id) `id` \\ \"q\"", "a\nb"]) {
      assert.equal(execFileSync("sh", ["-c", `printf %s ${f.shq(v)}`], { encoding: "utf8" }), v);
    }
  }
});

test("a command whose value no quoting makes safe in every shell is shown but not copied", async () => {
  const { f, copied, toasts } = page({ platform: "MacIntel" });
  // PowerShell ends a single-quoted string at a curly quote; cmd.exe runs what follows &.
  for (const v of ["x’; calc; ’", "it's", "a&calc", "a|b", "x\u0015y", "x\u0085y", "a\nb"]) {
    await f.copy(f.shCmd("coding.sh eval new", v));
  }
  assert.deepEqual(copied, []);
  assert.equal(toasts.length, 7);
  assert.match(toasts[0]!, /^Not copied/);
  await f.copy(f.shCmd("coding.sh eval new", "team/chat 1"));
  assert.deepEqual(copied, ["coding.sh eval new 'team/chat 1'"]);
});

test("on Windows each command the page shows or copies starts with codingsh, which PowerShell and cmd run", async () => {
  for (const nav of [{ platform: "Win32" }, { userAgentData: { platform: "Windows" } }]) {
    const { f, copied, toasts } = page(nav);
    assert.equal(f.IS_WIN, true);
    assert.equal(f.forShell("coding.sh doctor"), "codingsh doctor");
    assert.equal(f.forShell("coding.sh"), "codingsh");
    // npx runs its command through cmd, so it gets the codingsh bin of the coding.sh package.
    assert.equal(f.forShell("npx coding.sh init"), "npx -p coding.sh codingsh init");
    // Only the command word: values, other commands and other words stay as they are.
    assert.equal(f.shCmd("coding.sh eval new", "coding.sh"), "codingsh eval new coding.sh");
    assert.equal(f.forShell("git -C /work/demo diff"), "git -C /work/demo diff");
    assert.equal(f.forShell("coding.shx run"), "coding.shx run");
    // A second pass changes nothing, so cmdBlock(shCmd(...)) shows and copies what shCmd built.
    assert.equal(f.forShell(f.forShell("npx coding.sh init")), "npx -p coding.sh codingsh init");
    const block = f.cmdBlock(f.shCmd("coding.sh replay", "s1", "--step", 2));
    assert.equal(block.kids[0].attrs.text, "codingsh replay s1 --step 2");
    await block.kids[1].attrs.onclick();
    assert.deepEqual(copied, ["codingsh replay s1 --step 2"]);
    assert.equal(f.cmdBlock("coding.sh doctor").kids[0].attrs.text, "codingsh doctor");
    // A value no quoting makes safe is still refused after the rename.
    await f.cmdBlock(f.shCmd("coding.sh eval new", "a&calc")).kids[1].attrs.onclick();
    assert.deepEqual(copied, ["codingsh replay s1 --step 2"]);
    assert.match(toasts.at(-1)!, /^Not copied/);
    // The work queue's next step comes from the server, with its commands in backticks.
    assert.equal(plain(f.workNext("`coding.sh show a`, then `claude --resume a`")), "<codingsh show a>, then <claude --resume a>");
    // A backticked file named coding.sh is not a command, as the CLI reads it.
    assert.equal(plain(f.workNext("review: `coding.sh`, `src/a.ts`")), "review: <coding.sh>, <src/a.ts>");
    // The index's age line, in the CLI's words (src/viewer/work.ts, src/core/ingest-health.ts).
    assert.equal(f.indexText("index updated 40m ago; run coding.sh ingest"), "index updated 40m ago; run codingsh ingest");
    assert.equal(f.indexText("index updated 3h ago: waits and stalls are as of then; run coding.sh ingest"), "index updated 3h ago: waits and stalls are as of then; run codingsh ingest");
    assert.equal(f.indexText("index updated 4m ago"), "index updated 4m ago");
  }
  for (const nav of [{ platform: "MacIntel" }, { platform: "Linux x86_64" }, { userAgentData: { platform: "macOS" }, platform: "MacIntel" }, {}]) {
    const { f } = page(nav);
    assert.equal(f.IS_WIN, false);
    assert.equal(f.forShell("npx coding.sh init"), "npx coding.sh init");
    assert.equal(f.cmdBlock("coding.sh doctor").kids[0].attrs.text, "coding.sh doctor");
    assert.equal(plain(f.workNext("`coding.sh show a`, then `claude --resume a`")), "<coding.sh show a>, then <claude --resume a>");
    assert.equal(f.indexText("index updated 40m ago; run coding.sh ingest"), "index updated 40m ago; run coding.sh ingest");
  }
});

test("on Windows a value goes in double quotes, and a value PowerShell, cmd or Git Bash would still read is shown but not copied", async () => {
  const { f, copied, toasts } = page({ platform: "Win32" });
  for (const v of ["team/chat-1", "a1b2c3d4-e5f6", "C:/work/demo/a.ts", "x=1", "--step", "3"]) assert.equal(f.shq(v), v);
  // cmd.exe reads no single quotes, PowerShell drops a word that starts with @, and Git Bash
  // drops a backslash outside quotes.
  assert.equal(f.shq("team/chat 1"), '"team/chat 1"');
  assert.equal(f.shq("@abc"), '"@abc"');
  assert.equal(f.shq("a,b"), '"a,b"');
  assert.equal(f.shq("src\\a.ts"), '"src\\a.ts"');
  assert.equal(f.shq("it's"), '"it\'s"');
  // A leading - unless the value is a plain flag: PowerShell splits -a.b in two, and through
  // npm's codingsh.ps1 it also splits -a:b and drops a bare --.
  for (const v of ["-a.b", "-a:b", "--", "-1", "--x=1"]) assert.equal(f.shq(v), `"${v}"`);
  for (const v of ["-g", "--no-color"]) assert.equal(f.shq(v), v);
  assert.equal(f.shCmd("coding.sh replay", "s1", "--with", "C:\\work\\my file.ts"), 'codingsh replay s1 --with "C:\\work\\my file.ts"');
  const ok = ["team/chat 1", "it's", "C:\\work\\my file.ts", "x\u2019y"];
  for (const v of ok) await f.copy(f.shCmd("coding.sh eval new", v));
  assert.deepEqual(copied, ok.map((v) => `codingsh eval new "${v}"`));
  const before = toasts.length;
  // In double quotes PowerShell reads $ and `, Git Bash reads $, ` and !, and cmd.exe reads %.
  // When PowerShell runs a .cmd file (npm's codingsh.cmd typed by name, or with no codingsh.ps1
  // beside it), it passes a word with no space without its quotes, so cmd.exe also reads
  // & | < > ^ there. A backslash before the closing quote escapes it, Git Bash reads two
  // backslashes as one, and Windows PowerShell drops an empty value.
  const refused = ['a"b', "\u201cq\u201d", "x\u201dy", "x\u201ey", "$x", "a`b", "a!b", "50%", "a&calc", "a|b", "a<b", "a>b", "a^b", "x\u0015y", "x\u0085y", "a\nb", "C:\\dir\\", "\\\\server\\share", ""];
  for (const v of refused) await f.copy(f.shCmd("coding.sh eval new", v));
  assert.equal(copied.length, ok.length);
  const notCopied = toasts.slice(before);
  assert.equal(notCopied.length, refused.length);
  for (const t of notCopied) assert.match(t, /^Not copied: .*PowerShell, cmd or Git Bash/);
});

// Values the shell tests below pass as the page quotes them on Windows: each must reach the
// program as it is.
const ROUTE_VALUES = ["team/chat 1", "it's", "C:\\work\\my file.ts", "@abc", "a,b", "src\\a.ts", "(x)", "a;b", "{y}", "#z", "x=1", "3", "-a.b", "-a:b", "--", "--step", "-g", "x\u2019y", "caf\u00e9 \u65e5\u672c"];

/** A temp folder with argv.cjs, which prints its arguments as JSON, and npm-style shims that run it. */
function argvDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "csh-copyquote-"));
  // Non-ASCII goes out as \u escapes: PowerShell reads a program's output in the console's code page.
  writeFileSync(join(dir, "argv.cjs"), String.raw`console.log(JSON.stringify(process.argv.slice(2)).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));` + "\n");
  // npm's codingsh.cmd hands its arguments to node with %*, and its codingsh.ps1 with $args.
  writeFileSync(join(dir, "shim.cmd"), `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  writeFileSync(join(dir, "shim.ps1"), `\ufeff& "${process.execPath}" "$PSScriptRoot\\argv.cjs" $args\r\n`);
  return dir;
}

/** Each line a program printed, read back as JSON. */
function printed(r: ReturnType<typeof spawnSync>): unknown[] {
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
  return String(r.stdout).trim().split(/\r?\n/).map((l) => JSON.parse(l));
}

test("PowerShell and cmd hand a program each value as the page quotes it, also through .cmd and .ps1 files like npm's codingsh shims", { skip: process.platform !== "win32" && "PowerShell and cmd.exe: Windows" }, () => {
  const { f } = page({ platform: "Win32" });
  const args = ROUTE_VALUES.map((v) => f.shq(v)).join(" ");
  const dir = argvDir();
  try {
    const node = process.execPath;
    const shim = join(dir, "shim.cmd");
    // -EncodedCommand hands PowerShell the line as typed. Typing codingsh in PowerShell runs
    // npm's codingsh.ps1, or its codingsh.cmd when that is typed by name or has no .ps1 beside it.
    const ps = `& '${node}' argv.cjs ${args}; & '${shim}' ${args}; & '${join(dir, "shim.ps1")}' ${args}`;
    const opts = { cwd: dir, encoding: "utf8" as const, timeout: 60_000 };
    const viaPs = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], opts);
    assert.deepEqual(printed(viaPs), [ROUTE_VALUES, ROUTE_VALUES, ROUTE_VALUES]);
    const viaCmd = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${node}" argv.cjs ${args} & "${shim}" ${args}"`], { ...opts, windowsVerbatimArguments: true });
    assert.deepEqual(printed(viaCmd), [ROUTE_VALUES, ROUTE_VALUES]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Git for Windows' own bash.exe, by its path: a bare `bash` on Windows can be WSL's.
const GIT_BASH = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");

test("Git Bash hands a program each value as the page quotes it on Windows", { skip: (process.platform !== "win32" || !existsSync(GIT_BASH)) && "Git Bash: Git for Windows" }, () => {
  const { f } = page({ platform: "Win32" });
  const dir = argvDir();
  try {
    // The line goes in a file, so only bash reads its quotes; npm's codingsh sh shim runs node with "$@".
    writeFileSync(join(dir, "run.sh"), `'${process.execPath.replace(/\\/g, "/")}' argv.cjs ${ROUTE_VALUES.map((v) => f.shq(v)).join(" ")}\n`);
    const r = spawnSync(GIT_BASH, ["run.sh"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.deepEqual(printed(r), [ROUTE_VALUES]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Windows the empty Experiments page gives exp run a task file, since PowerShell and cmd change JSON typed into an argument", () => {
  // The one copied command with JSON in an argument: its Windows form comes first.
  const inline = [...script.matchAll(/cmdBlock\("coding\.sh [^"\n]*'\{/g)];
  assert.equal(inline.length, 1);
  const before = script.slice(inline[0]!.index! - 400, inline[0]!.index);
  assert.match(before, /IS_WIN\s+\? \[cmdBlock\("coding\.sh exp run -d <dataset> --task task\.json", "Copy experiment command"\)/);
  assert.match(before, /h\("code", null, "\{\\"kind\\":\\"command\\",\\"command\\":\\"<cmd>\\"\}"\)/);
  assert.match(before, /\]\s+: $/);
});

test("no copied command is built by joining a value onto a coding.sh string", () => {
  const bad: string[] = [];
  script.split("\n").forEach((line, i) => {
    // "coding.sh ..." + value, or a template with ${...}: a value that skips shq().
    if (/["']coding\.sh [^"']*["']\s*\+/.test(line) || /`coding\.sh [^`]*\$\{/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(bad, [], "build commands with shCmd(), which quotes each value");
});

test("a command the page writes into code goes through forShell, the page's one platform check", () => {
  assert.equal(script.match(/\/Win\/\.test\(/g)?.length, 1);
  const bad: string[] = [];
  script.split("\n").forEach((line, i) => {
    if (/h\("code", (?:null, |\{\s*text:\s*)["'`](?:npx )?coding\.sh\b/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(bad, [], "show commands as h(\"code\", null, forShell(...)), or with cmdBlock()");
});

test("text the page writes that names a command goes through forShell: the index's age and the token and API key messages", () => {
  // The age line on the Work page, a work item's page and the session list's header.
  assert.equal(script.match(/indexText\((?:doc\.index|ix)\.text\)/g)?.length, 3);
  assert.doesNotMatch(script, /\}, doc\.index\.text\)|: ix\.text;/);
  assert.match(script, /Reopen the URL printed by " \+ forShell\("coding\.sh ui"\) \+ "\."/);
  // The Fork from here hint, which names the key a provider needs.
  assert.match(script, /" or CLAUDE_CODE_OAUTH_TOKEN" : ""\) \+ " and restart " \+ forShell\("coding\.sh ui"\) \+ "\."/);
});

test("every copy( call copies a command named for the shell, or text that is not a command", () => {
  const calls = [...script.matchAll(/\b(copy|cmdBlock|copyBtn)\(/g)];
  assert.ok(calls.length >= 15, `found ${calls.length} copy calls`);
  for (const m of calls) {
    // The first argument, up to its top-level comma or the closing paren.
    let depth = 0;
    let end = m.index! + m[0].length;
    for (; end < script.length; end++) {
      const c = script[end];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    let arg = script.slice(m.index! + m[0].length, end).trim();
    // A name: check what it was last set to before the call.
    const def = /^[A-Za-z_$][\w$]*$/.test(arg) ? script.lastIndexOf(`const ${arg} = `, m.index) : -1;
    if (def >= 0) arg = script.slice(def + `const ${arg} = `.length, script.indexOf(";", def)).trim();
    // A command the server built, like a review item's, names coding.sh too.
    assert.ok(!/^[\w$.]+\.command$/.test(arg), `a command from the server must go through forShell: ${arg}`);
    if (!/coding\.sh /.test(arg)) continue;
    const literal = /^"(?:[^"\\]|\\.)*"$|^'(?:[^'\\]|\\.)*'$/.test(arg) || (/^`[^`]*`$/.test(arg) && !arg.includes("${"));
    // cmdBlock names a literal command for the shell itself; copy and copyBtn copy what they get.
    const named = arg.startsWith("shCmd(") || arg.startsWith("forShell(") || (literal && m[1] === "cmdBlock");
    assert.ok(named, `a copied command must be shCmd(...), forShell(...), or a literal given to cmdBlock: ${arg}`);
  }
});
