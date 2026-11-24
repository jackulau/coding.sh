// Commands the viewer copies are pasted into a shell, so every value in them (a session id, a
// file path, a benchmark name) is quoted by the page's one quoting function, shq(), and the
// command itself is named for the shell by forShell(): codingsh on Windows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  for (const v of ["x’; calc; ’", "it's", "a&calc", "a|b", "x\u0015y", "a\nb"]) {
    await f.copy(f.shCmd("coding.sh eval new", v));
  }
  assert.deepEqual(copied, []);
  assert.equal(toasts.length, 6);
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
  assert.match(script, /" where " \+ forShell\("coding\.sh ui"\) \+ " runs\."/);
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
