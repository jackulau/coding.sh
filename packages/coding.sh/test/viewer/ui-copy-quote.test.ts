// Commands the viewer copies are pasted into a shell, so every value in them (a session id, a
// file path, a benchmark name) is quoted by the page's one quoting function, shq().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const script = html.slice(html.indexOf("<script"), html.lastIndexOf("</script>"));

// The constants shCmd() reads.
const consts = script.slice(script.indexOf("const PASTE_UNSAFE = "), script.indexOf("\n", script.indexOf("const unsafeCmds = ")));

function fn(name: string): string {
  let a = script.indexOf(`function ${name}(`);
  assert.ok(a >= 0, `function ${name} is in the page`);
  if (script.slice(a - 6, a) === "async ") a -= 6;
  const b = script.indexOf("\n}\n", a);
  return script.slice(a, b + 2);
}

test("shq leaves plain words alone and quotes anything a shell would read", () => {
  const f: any = runInNewContext(`${consts}\n${fn("shq")}\n${fn("shCmd")}\n({ shq, shCmd })`, { String, Set });
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
  const copied: string[] = [];
  const toasts: string[] = [];
  const ctx = { String, Set, navigator: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, toast: (m: string) => toasts.push(m) };
  const f: any = runInNewContext(`${consts}\n${fn("shq")}\n${fn("shCmd")}\n${fn("copy")}\n({ shCmd, copy })`, ctx);
  // PowerShell ends a single-quoted string at a curly quote; cmd.exe runs what follows &.
  for (const v of ["x’; calc; ’", "it's", "a&calc", "a|b", "x\u0015y", "a\nb"]) {
    await f.copy(f.shCmd("coding.sh eval new", v));
  }
  assert.deepEqual(copied, []);
  assert.equal(toasts.length, 6);
  assert.match(toasts[0]!, /^Not copied/);
  await f.copy(f.shCmd("coding.sh eval new", "team/chat 1"));
  assert.deepEqual(copied, ["coding.sh eval new 'team/chat 1'"]);
});

test("no copied command is built by joining a value onto a coding.sh string", () => {
  const bad: string[] = [];
  script.split("\n").forEach((line, i) => {
    // "coding.sh ..." + value, or a template with ${...}: a value that skips shq().
    if (/["']coding\.sh [^"']*["']\s*\+/.test(line) || /`coding\.sh [^`]*\$\{/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(bad, [], "build commands with shCmd(), which quotes each value");
});

test("every copy( call copies a literal, a quoted command, or text that is not a command", () => {
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
    // A name: check what it was set to.
    const def = /^[A-Za-z_$][\w$]*$/.test(arg) ? new RegExp(`const ${arg} = ([^;]+);`).exec(script) : null;
    if (def) arg = def[1]!;
    if (!/coding\.sh /.test(arg)) continue;
    const literal = /^"(?:[^"\\]|\\.)*"$|^'(?:[^'\\]|\\.)*'$/.test(arg) || (/^`[^`]*`$/.test(arg) && !arg.includes("${"));
    assert.ok(literal || arg.startsWith("shCmd("), `copied command must be a literal or shCmd(...): ${arg}`);
  }
});
