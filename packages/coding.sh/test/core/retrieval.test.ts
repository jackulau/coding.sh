// core/retrieval.ts: which tool calls read a file, search or go to the web, and
// the Session.stats.retrieval the session fold derives from them, on synthetic
// events and on the recorded adapter fixtures.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deserialize, serialize } from "node:v8";
import { classifyRetrieval, retrievalTotals } from "../../src/core/retrieval.ts";
import { buildSession, foldSession, sessionOf, sessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind, RetrievalStats, Session } from "../../src/schema/index.ts";
import { assertCpuUnder } from "../helpers-timing.ts";

let n = 0;
let clock = Date.UTC(2026, 10, 7, 9);
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => {
  clock += 1000;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", cwd: "/work/demo", kind, payload, ...o };
};
type CallOpts = { output?: unknown; ok?: boolean; id?: string; end?: Record<string, unknown>; at?: Partial<AgentEvent> };
/** A tool call: its start and its end. */
const call = (tool: string, input: unknown, o: CallOpts = {}): AgentEvent[] => {
  const id = o.id ?? `tu${n + 1}`;
  return [ev("tool.start", { tool, toolUseId: id, input }, o.at), ev("tool.end", { tool, toolUseId: id, ok: o.ok ?? true, output: o.output ?? "ok", ...o.end }, o.at)];
};
const read = (path: string, o: CallOpts = {}) => call("Read", { file_path: path }, { output: `contents of ${path}`, ...o });
const bash = (command: string, o: CallOpts = {}) => call("Bash", { command }, o);
/** An edit tool's change, as the adapters emit it. */
const edit = (path: string, o: Partial<AgentEvent> = {}) => ev("file.change", { path, op: "modify" }, o);
/** Session.stats.retrieval of the events, folded as one session. */
const retrieval = (...events: (AgentEvent | AgentEvent[])[]): RetrievalStats | undefined => buildSession(events.flat()).stats.retrieval;

/** A call as a short string: what it does, whether its searches are quiet or print counts, and the files it reads. */
const kind = (tool: string, input: unknown): string => {
  const c = classifyRetrieval(tool, input);
  if (!c) return "none";
  const what = [c.read && "read", c.search && "search", c.web && "web"].filter(Boolean).join("+");
  return [what + (c.quiet ? " (quiet)" : "") + (c.count ? " (count)" : ""), ...c.paths].join(" ");
};
const bashKinds = (rows: [string, string][]) => {
  for (const [command, want] of rows) assert.equal(kind("Bash", { command }), want, command);
};
const psKinds = (rows: [string, string][]) => {
  for (const [command, want] of rows) assert.equal(kind("PowerShell", { command }), want, command);
};

describe("classifyRetrieval", () => {
  it("a shell line: `cd` and prefixes looked through, each pipeline decided by its first command", () => {
    bashKinds([
      ["cd src && grep -rn x . | head -20", "search"],
      ["cd /work/demo/pkg && grep -rn x src | head -20", "search"],
      ["grep -rn x src | head -20", "search"],
      ["cat a.ts | grep foo", "search"],
      ["cat a.ts | head -20", "read a.ts"],
      ["cat a.ts && grep -n foo b.ts", "read+search a.ts"],
      ["FOO=1 export X=2; set -e; source .env; cat a.ts", "read a.ts"],
      ["set -e\nexport A=1\ncd src\ncat a.ts", "read src/a.ts"],
      ["cd /work/demo/pkg && cat ../README.md && rg foo", "read+search /work/demo/README.md"],
      ["head -n 20 src/a.ts src/b.ts", "read src/a.ts src/b.ts"],
      ["less +G log.txt", "read log.txt"],
      ["cat $FILE", "read"],
      ["cat /dev/null", "none"],
      ["ls -la", "search"],
      ["find . -name '*.ts' | xargs cat", "search"],
      ["git grep -n foo", "search"],
      ["git ls-files src", "search"],
      ["git show HEAD:src/a.ts", "read src/a.ts"],
      // A tree: git lists the folder.
      ["git show HEAD:src/", "search"],
      ["git show HEAD:", "search"],
      ["git show HEAD~1", "none"],
      ["npm test", "none"],
    ]);
  });

  it("a search that prints nothing by design, or sends its matches elsewhere, is quiet", () => {
    bashKinds([
      ["grep -q foo a.ts && echo yes", "search (quiet)"],
      ["rg foo > out.txt", "search (quiet)"],
      ["grep foo a.ts > out.txt", "search (quiet)"],
      ["grep foo a.ts 2>/dev/null", "search"],
      ["grep foo a.ts || true", "search"],
      // Another command's redirect is its own: grep's matches still print.
      ["grep -rn zzz src; echo done > log.txt", "search"],
      // A flag's value is not a flag: `-e -q` searches for "-q". grep's `-T` takes no value; ripgrep's does.
      ["grep -e -q foo a.ts", "search"],
      ["grep -T -q foo a.ts", "search (quiet)"],
      ["rg -T -q foo", "search"],
    ]);
    psKinds([
      ["Select-String foo a.txt | Out-File o.txt", "search (quiet)"],
      ["Get-ChildItem -Recurse | Out-File list.txt", "search (quiet)"],
    ]);
  });

  it("a search whose pipeline ends in a count (`grep -c`, `| wc -l`) is marked so; a read piped into `wc` stays a read", () => {
    bashKinds([
      ["grep -c foo a.ts", "search (count)"],
      ["grep -rc foo src", "search (count)"],
      ["rg --count foo", "search (count)"],
      ["rg --count-matches foo", "search (count)"],
      ["grep -rn foo src | wc -l", "search (count)"],
      ["find . -name '*.ts' | wc -l", "search (count)"],
      ["cat a.ts | grep -c foo", "search (count)"],
      ["grep -q foo a.ts && grep -c bar b.ts", "search (count)"],
      // `-e -c` searches for "-c"; `-C` is context, not a count.
      ["grep -e -c foo a.ts", "search"],
      ["grep -C 3 foo a.ts", "search"],
      ["grep -c foo a.ts; ls", "search"],
      ["findstr /c:foo a.ts", "search"],
      ["cat a.ts | wc -l", "read a.ts"],
      // The pipeline's last command decides: a later grep counts only with `-c`, and any other command reshapes the counts.
      ["grep -rn foo src | grep -c bar", "search (count)"],
      ["grep -rn foo src | head -5 | wc -l", "search (count)"],
      ["grep -c foo a.ts b.ts | tail -1", "search"],
      ["grep -c foo a.ts b.ts | grep ':0$'", "search"],
      // ripgrep's `-r` takes a value (`-rc` replaces each match with "c"); ag's `-r` recurses.
      ["rg -rc foo src", "search"],
      ["ag -rc foo src", "search (count)"],
    ]);
  });

  it("a search keeps the lines that a literal `echo` alone in its pipeline prints", () => {
    const rows: [string, string, string[] | undefined][] = [
      ["Bash", "grep -rn foo src || echo 'no matches'", ["no matches"]],
      ["Bash", 'echo "--- a.ts ---"; grep -n foo a.ts; echo -n done; echo "--- a.ts ---"', ["--- a.ts ---", "done"]],
      ["Bash", "grep -rn foo src && echo found || echo not found", ["found", "not found"]],
      ["Bash", 'grep -rn foo src || echo "none" >&2', ["none"]],
      // A word that is not literal, a backslash (zsh's echo reads escapes), output to a file or into a pipe, and no search.
      ["Bash", 'grep -rn foo src; echo "exit $?"', undefined],
      ["Bash", "grep -rn foo src || echo 'a\\tb'", undefined],
      ["Bash", "grep -rn foo src; echo none > log.txt", undefined],
      ["Bash", "grep -rn foo src; echo foo | grep foo", undefined],
      ["Bash", "cat a.ts; echo done", undefined],
      ["PowerShell", 'Write-Host "=== a ==="; Select-String foo a.ts', ["=== a ==="]],
      ["PowerShell", "Select-String foo a.ts; if (-not $?) { echo 'no matches' }", ["no matches"]],
      // Write-Output prints each word on its own line; a parameter; a pipe into a cmdlet.
      ["PowerShell", 'Select-String foo a.ts; Write-Output "a" "b"', undefined],
      ["PowerShell", 'Select-String foo a.ts; Write-Host "x" -ForegroundColor Red', undefined],
      ["PowerShell", 'Select-String foo a.ts; Write-Output "none" | Out-Null', undefined],
    ];
    for (const [tool, command, want] of rows) assert.deepEqual(classifyRetrieval(tool, { command })?.echoed, want, command);
  });

  it("a read whose output goes to a file reads nothing", () => {
    bashKinds([
      ["cat a.ts > b.ts", "none"],
      ["cat a.ts >> b.ts", "none"],
      ["cat a.ts >& b.ts", "none"],
      ["cat a.ts &> /dev/null", "none"],
      ["cat a.ts > b.ts && cat c.ts", "read c.ts"],
      ["cat a.ts 2>/dev/null", "read a.ts"],
      ["cat a.ts >&2", "read a.ts"],
      ["cat a.ts > /dev/stderr", "read a.ts"],
      ["cat a.ts | tee b.ts", "read a.ts"],
    ]);
    psKinds([
      ["Get-Content a.ts > b.ts", "none"],
      ["Get-Content a.ts | Set-Content b.ts", "none"],
      ["Get-Content a.ts | Out-Null", "none"],
      ["Get-Content a.ts 2> $null", "read a.ts"],
    ]);
  });

  it("a long line of quotes, `cd`s or `git -C`s is read in linear time", () => {
    const t0 = performance.now();
    assert.equal(kind("Bash", { command: `grep "${'\\"'.repeat(20000)}` }), "search");
    assert.equal(kind("Bash", { command: `grep "${'\\"'.repeat(20000)}\\` }), "search");
    // Past 4,096 characters the folder is unknown, so the file has no path.
    assert.equal(kind("Bash", { command: `${"cd a && ".repeat(20000)}cat x` }), "read");
    assert.equal(kind("Bash", { command: `git ${"-C a ".repeat(50000)}show HEAD:x` }), "read");
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `${Math.round(ms)} ms`);
  });

  it("a PowerShell list of 20,000 files, with a space after or before each comma, is read in linear time", () => {
    const files = Array.from({ length: 20000 }, (_, i) => `f${i}.ts`);
    for (const comma of [", ", " ,"]) {
      const input = { command: `Get-Content ${files.join(comma)}` };
      assertCpuUnder(JSON.stringify(comma), () => classifyRetrieval("PowerShell", input));
      assert.deepEqual(classifyRetrieval("PowerShell", input)?.paths, files);
    }
  });

  it("a pipeline that removes or edits what it found, or the files a list names, is neither a search nor a read", () => {
    bashKinds([
      ["find . -name '*.tmp' -delete", "none"],
      ["find . -name '*.ts' | xargs rm", "none"],
      ["find . -name '*.ts' -exec sed -i s/a/b/ {} +", "none"],
      ["grep -rl foo src | xargs sed -i 's/foo/bar/g'", "none"],
      ["rg -l foo | xargs perl -pi -e 's/foo/bar/g'", "none"],
      // The list's lines go to rm or sed, not to the agent.
      ["cat list.txt | xargs rm", "none"],
      ["cat list.txt | xargs -I {} rm {}", "none"],
      ["head -n 5 files.txt | xargs sed -i 's/a/b/'", "none"],
      ["cat list.txt | xargs rm && cat a.ts", "read a.ts"],
      ["cat a.ts | sed -n 1,10p", "read a.ts"],
    ]);
    psKinds([
      ["Get-ChildItem *.tmp | Remove-Item", "none"],
      ["Get-Content list.txt | Remove-Item", "none"],
    ]);
  });

  it("a quoted `cd` into a folder with spaces, and Windows paths", () => {
    bashKinds([
      ['cd "C:/path with spaces" && cat a.ts', "read C:/path with spaces/a.ts"],
      ["cd 'C:/path with spaces'; cat a.ts", "read C:/path with spaces/a.ts"],
      ['cat "notes (1).md"', "read notes (1).md"],
    ]);
    psKinds([["cd C:\\work\\demo; Get-Content .\\src\\a.ts", "read C:/work/demo/src/a.ts"]]);
    assert.equal(kind("shell", { command: ["cat", "README.md"], workdir: "/work/demo/sub" }), "read /work/demo/sub/README.md");
    assert.equal(kind("Read", { file_path: "C:\\work\\demo\\a.ts" }), "read C:/work/demo/a.ts");
  });

  it("`sed -n` prints a file (a read); `sed -i` edits it (not a read)", () => {
    bashKinds([
      ["sed -n 1,80p f.ts", "read f.ts"],
      ["sed -n '1,80p' f.ts", "read f.ts"],
      ["sed -i 's/a/b/' f.ts", "none"],
      ["sed -i.bak -e 's/a/b/' f.ts", "none"],
    ]);
  });

  it("PowerShell: Get-Content reads; Select-String and Get-ChildItem search", () => {
    psKinds([
      ["Get-Content -Path src\\a.ts -TotalCount 40", "read src/a.ts"],
      ["Get-Content src\\a.ts | Select-Object -First 40", "read src/a.ts"],
      ["Get-Content a.ts | Select-String foo", "search"],
      ["Select-String -Path src\\*.ts -Pattern foo", "search"],
      ["Select-String -Pattern foo -Path a.ts -Quiet", "search (quiet)"],
      ["Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 5", "search"],
      ["Get-Content $env:TEMP\\x.txt", "read"],
      ["gci env:", "none"],
    ]);
  });

  it("a heredoc's body is text, not commands", () => {
    bashKinds([
      ["cat > notes.md <<'EOF'\nuse grep -rn to find\nEOF", "none"],
      ["cat <<EOF > x.ts\ngrep foo\nEOF", "none"],
      ["git commit -q -F - <<'EOF'\ngrep the logs, cat the file\nEOF", "none"],
    ]);
  });

  it("tools by name: reads, searches and web calls; MCP tools and edits are none", () => {
    const rows: [string, unknown, string][] = [
      ["Read", { file_path: "/work/demo/src/a.ts" }, "read /work/demo/src/a.ts"],
      ["read_many_files", { paths: ["a.ts", "b/*.ts"] }, "read a.ts"],
      ["str_replace_based_edit_tool", { command: "view", path: "/work/demo/a.ts" }, "read /work/demo/a.ts"],
      ["str_replace_based_edit_tool", { command: "str_replace", path: "/work/demo/a.ts" }, "none"],
      ["Grep", { pattern: "x" }, "search"],
      ["Glob", { pattern: "**/*.ts" }, "search"],
      ["LS", { path: "." }, "search"],
      ["WebSearch", { query: "x" }, "web"],
      ["WebFetch", { url: "https://example.com" }, "web"],
      ["web_search", { query: "x" }, "web"],
      ["mcp__fs__read_file", { path: "a.ts" }, "none"],
      ["Edit", { file_path: "a.ts" }, "none"],
      // Antigravity's views of a file's outline and of one of its classes or functions.
      ["view_file_outline", { AbsolutePath: "/work/demo/src/a.ts", ItemOffset: 0 }, "read /work/demo/src/a.ts"],
      ["view_code_item", { File: "/work/demo/src/a.ts", NodePaths: ["Parser.parse"] }, "read /work/demo/src/a.ts"],
      // Antigravity's and Droid's shell tools.
      ["run_command", { CommandLine: "cat a.ts", Cwd: "/work/demo/sub" }, "read /work/demo/sub/a.ts"],
      ["Execute", { command: "grep -rn x src" }, "search"],
      ["shell", { command: ["bash", "-lc", "sed -n '1,80p' SKILL.md && cat README.md"] }, "read SKILL.md README.md"],
      // Gemini's shell tool runs in `dir_path` (`directory` in older versions), relative to the project folder.
      ["run_shell_command", { command: "cat a.ts", dir_path: "src" }, "read src/a.ts"],
      ["run_shell_command", { command: "cat a.ts", directory: "src" }, "read src/a.ts"],
    ];
    for (const [tool, input, want] of rows) assert.equal(kind(tool, input), want, `${tool} ${JSON.stringify(input)}`);
  });
});

describe("Session.stats.retrieval", () => {
  it("counts reads, distinct files, searches and web calls", () => {
    const r = retrieval(read("/work/demo/a.ts"), read("a.ts"), read("b.ts"), call("Grep", { pattern: "x" }, { output: "a.ts" }), call("WebSearch", { query: "x" }, { output: "results" }));
    assert.deepEqual(r, { reads: 3, filesRead: 2, editedAfterRead: 0, searches: 1, web: 1 });
  });

  it("is absent when the session read, searched and fetched nothing", () => {
    assert.equal(retrieval(ev("user.message", { text: "hi" }), bash("npm test"), call("Edit", { file_path: "a.ts" }), edit("a.ts")), undefined);
    assert.equal(retrieval(call("mcp__fs__read_file", { path: "a.ts" }, { output: "x" })), undefined);
  });

  it("a session that only went to the web keeps its web calls", () => {
    assert.deepEqual(retrieval(call("WebFetch", { url: "https://example.com" }, { output: "page" })), { reads: 0, filesRead: 0, editedAfterRead: 0, searches: 0, web: 1 });
  });

  it("precision: a file read and later edited, by an edit tool or a shell write", () => {
    const r = retrieval(read("a.ts"), read("/work/demo/b.ts"), read("c.ts"), edit("/work/demo/a.ts"), bash("sed -i 's/x/y/' b.ts"), edit("d.ts"));
    assert.deepEqual(r, { reads: 3, filesRead: 3, editedAfterRead: 2, searches: 0, beforeFirstEdit: 3 });
  });

  it("a shell write through Droid's Execute or Antigravity's run_command edits the file it names", () => {
    for (const [tool, input] of [["Execute", { command: "sed -i 's/x/y/' a.ts" }], ["run_command", { CommandLine: "sed -i 's/x/y/' a.ts", Cwd: "/work/demo" }]] as const) {
      const s = buildSession([...read("a.ts"), ...call(tool, input)]);
      assert.equal(s.stats.filesChanged, 1, tool);
      assert.deepEqual(s.stats.retrieval, { reads: 1, filesRead: 1, editedAfterRead: 1, searches: 0, beforeFirstEdit: 1 }, tool);
    }
  });

  it("a shell write through run_command resolves against its Cwd, as its reads do", () => {
    const s = buildSession([...call("view_file", { AbsolutePath: "/work/demo/src/a.ts" }), ...call("run_command", { CommandLine: "sed -i 's/x/y/' a.ts", Cwd: "/work/demo/src" }), ...call("run_command", { CommandLine: "cat b.ts", Cwd: "/work/demo/src" }), edit("src/b.ts")]);
    assert.equal(s.stats.filesChanged, 2);
    // The sed's a.ts is the src/a.ts read before it.
    assert.deepEqual(s.stats.retrieval, { reads: 2, filesRead: 2, editedAfterRead: 2, searches: 0, beforeFirstEdit: 1 });
  });

  it("a Gemini shell call in a subfolder (dir_path, directory) reads and writes the files under it", () => {
    const s = buildSession([...read("src/b.ts"), ...call("run_shell_command", { command: "cat a.ts", dir_path: "src" }), ...call("run_shell_command", { command: "sed -i 's/x/y/' b.ts", directory: "src" }), edit("src/a.ts")]);
    assert.equal(s.stats.filesChanged, 2);
    assert.deepEqual(s.stats.retrieval, { reads: 2, filesRead: 2, editedAfterRead: 2, searches: 0, beforeFirstEdit: 2 });
  });

  it("a relative read from an event with no cwd resolves against the session's", () => {
    const r = retrieval(ev("user.message", { text: "hi" }), read("../README.md", { at: { cwd: undefined } }), edit("/work/README.md"));
    assert.deepEqual(r, { reads: 1, filesRead: 1, editedAfterRead: 1, searches: 0, beforeFirstEdit: 1 });
  });

  it("an edit before the read does not count, and the first edit is placed by the calls before it", () => {
    assert.deepEqual(retrieval(edit("d.ts"), read("d.ts")), { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0, beforeFirstEdit: 0 });
    // A call that reads and searches counts once before the edit.
    const r = retrieval(bash("cat a.ts && grep -n foo b.ts", { output: "1: x\nb.ts:3: foo" }), call("Grep", { pattern: "x" }, { output: "a.ts" }), read("x.ts"), edit("y.ts"), read("y.ts"));
    assert.deepEqual(r, { reads: 3, filesRead: 3, editedAfterRead: 0, searches: 2, beforeFirstEdit: 3 });
  });

  it("a subagent's reads count in the session, each thread's calls matched to its own", () => {
    const sub = { subagentId: "sub1" };
    assert.deepEqual(retrieval(read("a.ts"), read("b.ts", { at: sub }), call("Grep", { pattern: "x" }, { output: "b.ts", at: sub })), {
      reads: 2,
      filesRead: 2,
      editedAfterRead: 0,
      searches: 1,
    });
    // Calls with no id end in order per thread: the subagent's failed read takes back its own file, not the main thread's.
    const start = (path: string, o: Partial<AgentEvent> = {}) => ev("tool.start", { tool: "Read", input: { file_path: path } }, o);
    const end = (ok: boolean, o: Partial<AgentEvent> = {}) => ev("tool.end", { tool: "Read", ok, output: ok ? "x" : "File not found" }, o);
    const r = retrieval(start("a.ts"), start("b.ts", sub), end(false, sub), end(true), edit("a.ts"));
    assert.deepEqual(r, { reads: 2, filesRead: 1, editedAfterRead: 1, searches: 0, beforeFirstEdit: 2 });
  });

  it("a call seen twice (live and from its transcript) counts once; an end with no start counts from its own input", () => {
    assert.deepEqual(retrieval(read("a.ts", { id: "dup" }), read("a.ts", { id: "dup" })), { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0 });
    const late = ev("tool.end", { tool: "Read", toolUseId: "late", input: { file_path: "a.ts" }, ok: true, output: "x" });
    assert.deepEqual(retrieval(late), { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0 });
  });

  it("a read that failed or was stopped reads no file", () => {
    assert.deepEqual(retrieval(read("gone.ts", { ok: false, output: "File does not exist." })), { reads: 1, filesRead: 0, editedAfterRead: 0, searches: 0 });
    assert.deepEqual(retrieval(read("a.ts", { end: { interrupted: true } })), { reads: 1, filesRead: 0, editedAfterRead: 0, searches: 0 });
    // A shell line fails as a whole: only the file its error names was not read.
    const r = retrieval(bash("cat a.ts b.ts", { ok: false, output: "Exit code 1\nx\ncat: b.ts: No such file or directory" }), edit("a.ts"));
    assert.deepEqual(r, { reads: 1, filesRead: 1, editedAfterRead: 1, searches: 0, beforeFirstEdit: 1 });
  });

  it("a failed shell line drops only the files an error line names whole", () => {
    const failed = (command: string, error: string) => retrieval(bash(command, { ok: false, output: `Exit code 1\n${error}` }))?.filesRead;
    // A longer name holds `a.ts` but names another file: `a.ts` was read.
    assert.equal(failed("cat a.ts data.ts", "cat: data.ts: No such file or directory"), 1);
    assert.equal(failed("cat a.ts a.tsx", "cat: a.tsx: No such file or directory"), 1);
    assert.equal(failed("cat a.ts a.ts.orig", "cat: a.ts.orig: No such file or directory"), 1);
    assert.equal(failed("cat a.ts .a.ts", "cat: .a.ts: No such file or directory"), 1);
    assert.equal(failed("cat a.ts \u00f1a.ts", "cat: \u00f1a.ts: No such file or directory"), 1);
    // A directory, quotes, a Windows path, the end of a sentence or of the line: these name `a.ts`.
    for (const error of [
      "cat: src/a.ts: No such file or directory",
      "head: cannot open 'a.ts' for reading: No such file or directory",
      "Get-Content : Cannot find path 'C:\\work\\a.ts' because it does not exist.",
      "cannot read a.ts.",
      "zsh: no such file or directory: a.ts",
    ]) assert.equal(failed("cat a.ts b.ts", error), 1, error);
    // Two paths with one base name: an error that names it drops both.
    assert.equal(failed("cat src/a.ts lib/a.ts b.ts", "cat: lib/a.ts: No such file or directory"), 1);
  });

  it("a failed `cat` of 5,000 files, its error naming each missing one, is folded in linear time", () => {
    const files = Array.from({ length: 5000 }, (_, i) => `f${i}.ts`);
    const missing = (gone: (i: number) => boolean) => {
      const output = ["Exit code 1", ...files.filter((_, i) => gone(i)).map((f) => `cat: ${f}: No such file or directory`)].join("\n");
      return bash(`cat ${files.join(" ")}`, { ok: false, output });
    };
    const all = missing(() => true);
    assertCpuUnder("every file missing", () => buildSession(all));
    assert.deepEqual(buildSession(all).stats.retrieval, { reads: 1, filesRead: 0, editedAfterRead: 0, searches: 0 });
    const odd = missing((i) => i % 2 === 1);
    assertCpuUnder("every other file missing", () => buildSession(odd));
    assert.equal(buildSession(odd).stats.retrieval?.filesRead, 2500);
  });

  it("an empty search: no output, No matches found, No files found, or exit 1 with nothing printed", () => {
    const empty = (...events: AgentEvent[][]) => retrieval(...events)?.emptySearches ?? 0;
    // Claude Code's transcript and hook results for a command that printed nothing.
    assert.equal(empty(bash("grep -rn foo src", { output: "(Bash completed with no output)" })), 1);
    assert.equal(empty(bash("grep -rn foo src", { output: '{"stdout":"","stderr":"","interrupted":false,"isImage":false}' })), 1);
    assert.equal(empty(call("Grep", { pattern: "x" }, { output: "No matches found" })), 1);
    assert.equal(empty(call("Glob", { pattern: "*.x" }, { output: "No files found" })), 1);
    assert.equal(empty(call("Grep", { pattern: "x" }, { output: { mode: "files_with_matches", filenames: [], numFiles: 0 } })), 1);
    // grep's and rg's exit 1 is "no match": Claude Code's and Codex's failure text, nothing else printed.
    assert.equal(empty(bash("grep -rn foo src", { ok: false, output: "Exit code 1" })), 1);
    assert.equal(empty(call("exec_command", { cmd: "rg -n foo" }, { ok: false, output: "Exit code: 1\nWall time: 0.1 seconds\nOutput:\n" })), 1);
    assert.equal(empty(bash("grep -q foo a.ts", { ok: false, output: "Exit code 1" })), 1);
    // findstr's exit 1 is "no match" too, though core/failures.ts counts it as a real failure.
    assert.equal(empty(bash("findstr /s /n foo *.ts", { ok: false, output: "Exit code 1" })), 1);
    // A search tool that reports "No files found" as a failure.
    assert.equal(empty(call("Glob", { pattern: "*.x" }, { ok: false, output: "No files found" })), 1);
    assert.equal(empty(bash("ls src", { output: "\n<shellId: 0 completed with exit code 0>" })), 1);
    // grep's warnings on stderr are not output: a stray `\` in the pattern, egrep's notice that it is obsolescent.
    assert.equal(empty(bash("grep -rn 'a\\-b' src", { ok: false, output: "Exit code 1\ngrep: warning: stray \\ before -" })), 1);
    assert.equal(empty(bash("egrep -rn 'a|b' src", { ok: false, output: "Exit code 1\negrep: warning: egrep is obsolescent; using grep -E" })), 1);
    assert.equal(empty(bash("grep -rn 'a\\-b' src | head", { output: '{"stdout":"","stderr":"grep: warning: stray \\\\ before -\\n","interrupted":false,"isImage":false}' })), 1);
    // A search that prints counts and counted nothing: `grep -c` prints 0 for each file and exits 1, `| wc -l` prints 0.
    assert.equal(empty(bash("grep -c foo a.ts", { ok: false, output: "Exit code 1\n0" })), 1);
    assert.equal(empty(bash("grep -rc foo src", { ok: false, output: "Exit code 1\nsrc/a.ts:0\nsrc/b.ts:0" })), 1);
    assert.equal(empty(bash("grep -rn foo src | wc -l", { output: '{"stdout":"0\\n","stderr":"","interrupted":false,"isImage":false}' })), 1);
    assert.equal(empty(bash("ls src | wc -l", { output: "       0" })), 1);
    assert.equal(empty(bash("grep -rn foo src | wc", { output: "      0       0       0" })), 1);
    assert.equal(empty(bash("grep -rn foo src | grep -c bar", { ok: false, output: "Exit code 1\n0" })), 1);
    // The lines a literal `echo` in the command prints are not what the search found.
    assert.equal(empty(bash("grep -rn foo src || echo 'no matches'", { output: "no matches" })), 1);
    assert.equal(empty(bash('echo "--- src ---"; grep -rn foo src', { ok: false, output: "Exit code 1\n--- src ---" })), 1);
    assert.equal(empty(bash('grep -rn foo src || echo "none" >&2', { output: '{"stdout":"","stderr":"none\\n","interrupted":false,"isImage":false}' })), 1);
  });

  it("a search that found something, printed nothing by design, or was cut is not empty", () => {
    const empty = (...events: AgentEvent[][]) => retrieval(...events)?.emptySearches ?? 0;
    assert.equal(empty(bash("grep -rn foo src", { output: "src/a.ts:3: foo" })), 0);
    assert.equal(empty(call("Grep", { pattern: "x" }, { output: { mode: "files_with_matches", filenames: ["a.ts"], numFiles: 1 } })), 0);
    // `grep -q` and `> out.txt` print nothing when they match.
    assert.equal(empty(bash("grep -q foo a.ts", { output: '{"stdout":"","stderr":"","interrupted":false,"isImage":false}' })), 0);
    assert.equal(empty(bash("grep -q foo a.ts", { output: "(Bash completed with no output)" })), 0);
    assert.equal(empty(bash("rg foo > out.txt", { output: "(Bash completed with no output)" })), 0);
    // Any other failure, a cut output, a stopped call, and a call that also read are not "found nothing".
    assert.equal(empty(bash("grep -rn foo src", { ok: false, output: "Exit code 2\ngrep: src: No such file or directory" })), 0);
    assert.equal(empty(bash("findstr /s /n foo *.ts", { ok: false, output: "Exit code 1\nFINDSTR: Cannot open x.ts" })), 0);
    // A grep warning beside matches or beside an error.
    assert.equal(empty(bash("grep -rn 'a\\-b' src", { output: "grep: warning: stray \\ before -\nsrc/a.ts:3: a-b" })), 0);
    assert.equal(empty(bash("grep -rn 'a\\-b' src", { ok: false, output: "Exit code 2\ngrep: warning: stray \\ before -\ngrep: src: No such file or directory" })), 0);
    assert.equal(empty(bash("grep -rn 'a\\-b' src | head", { output: '{"stdout":"src/a.ts:3: a-b\\n","stderr":"grep: warning: stray \\\\ before -\\n","interrupted":false,"isImage":false}' })), 0);
    assert.equal(empty(bash("grep -rn foo src", { output: "", end: { cut: { bytes: 1_000_000 } } })), 0);
    assert.equal(empty(bash("grep -rn foo src", { output: "", end: { interrupted: true } })), 0);
    assert.equal(empty(bash("cat a.ts && grep foo b.ts", { output: "(Bash completed with no output)" })), 0);
    // A shell search's matches that start like "No files found" are matches.
    assert.equal(empty(bash('grep "No files found" msgs.txt', { output: "No files found in src\nNo files found in lib" })), 0);
    assert.equal(empty(bash('grep -h "No matches found" a.log', { output: "No matches found for x" })), 0);
    // A count that is not zero, a 0 that grep matched, and a count beside an error.
    assert.equal(empty(bash("grep -rc foo src", { output: "src/a.ts:0\nsrc/b.ts:2" })), 0);
    assert.equal(empty(bash("grep -rn foo src | wc -l", { output: "3" })), 0);
    assert.equal(empty(bash("grep 0 nums.txt", { output: "0" })), 0);
    assert.equal(empty(bash("grep -c foo a.ts b.ts", { ok: false, output: "Exit code 2\na.ts:0\ngrep: b.ts: No such file or directory" })), 0);
    // Counts a later command reshaped: one file's (`| tail -1`), or the files that counted none.
    assert.equal(empty(bash("grep -c foo a.ts b.ts | tail -1", { output: "b.ts:0" })), 0);
    assert.equal(empty(bash("grep -c foo a.ts b.ts | grep ':0$'", { output: "b.ts:0" })), 0);
    // A match or an error beside what an `echo` printed, and a quiet search, whose status says nothing here.
    assert.equal(empty(bash("grep -rn foo src || echo 'no matches'", { output: "src/a.ts:3: foo" })), 0);
    assert.equal(empty(bash("grep -rn foo src || echo 'no matches'", { output: "grep: src: No such file or directory\nno matches" })), 0);
    assert.equal(empty(bash("grep -q foo a.ts && echo yes", { output: "yes" })), 0);
  });

  it("a read after `cd` into a Windows folder with spaces keys like the edit of the same file", () => {
    const at = { cwd: "C:/path with spaces" };
    const r = retrieval(bash('cd "C:/path with spaces" && cat a.ts', { at }), bash('cat "/c/path with spaces/b.ts"', { at }), edit("C:\\path with spaces\\a.ts", at), edit("b.ts", at));
    assert.deepEqual(r, { reads: 2, filesRead: 2, editedAfterRead: 2, searches: 0, beforeFirstEdit: 2 });
  });

  it("an edit named the Git Bash way (`/c/x`) keys like a read of `C:\\x`", () => {
    const at = { cwd: "C:\\work\\demo" };
    const r = retrieval(read("C:\\work\\demo\\a.ts", { at }), bash("cat /c/other/b.ts", { at }), edit("/c/work/demo/a.ts", at), edit("/c/other/b.ts", at));
    assert.deepEqual(r, { reads: 2, filesRead: 2, editedAfterRead: 2, searches: 0, beforeFirstEdit: 2 });
  });

  it("a file a shell call reads and then writes the Git Bash way (`/c/x`) is a file changed after it was read", () => {
    const at = { cwd: "C:\\proj" };
    const s = buildSession([...bash("cat /c/proj/b.ts", { at }), ...bash("sed -i 's/x/y/' /c/proj/b.ts", { at })]);
    assert.equal(s.stats.filesChanged, 1);
    assert.deepEqual(s.stats.retrieval, { reads: 1, filesRead: 1, editedAfterRead: 1, searches: 0, beforeFirstEdit: 1 });
  });

  it("the fold saved between events (as ingest does) ends where one pass does", () => {
    const events = [...read("a.ts"), ...bash("grep -rn foo src", { output: "(Bash completed with no output)" }), ...read("b.ts"), edit("a.ts"), ...call("WebSearch", { query: "x" })];
    for (let cut = 1; cut < events.length; cut++) {
      let st = sessionState();
      for (const e of events.slice(0, cut)) foldSession(st, e);
      st = deserialize(serialize(st));
      for (const e of events.slice(cut)) foldSession(st, e);
      assert.deepEqual(sessionOf(st).stats.retrieval, buildSession(events).stats.retrieval, `saved after ${cut} events`);
    }
    assert.deepEqual(buildSession(events).stats.retrieval, { reads: 2, filesRead: 2, editedAfterRead: 1, searches: 1, emptySearches: 1, web: 1, beforeFirstEdit: 3 });
  });
});

describe("retrievalTotals", () => {
  const s = (id: string, retrieval?: RetrievalStats): Session => {
    const x: Session = { id, agent: "claude-code", startedAt: 0, title: id, stats: { events: 1, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 }, flags: [] };
    if (retrieval) x.stats.retrieval = retrieval;
    return x;
  };

  it("sums the sessions that read or searched; the first edit over the sessions that edited", () => {
    const t = retrievalTotals([
      s("a", { reads: 2, filesRead: 2, editedAfterRead: 1, searches: 1, emptySearches: 1, beforeFirstEdit: 3 }),
      s("b", { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0, web: 2 }),
      s("c"),
      s("d", { reads: 0, filesRead: 0, editedAfterRead: 0, searches: 0, web: 1 }),
    ]);
    assert.deepEqual(t, { sessions: 3, reads: 3, filesRead: 3, editedAfterRead: 1, searches: 1, emptySearches: 1, web: 3, beforeFirstEdit: 3, editedSessions: 1 });
    assert.equal(retrievalTotals([s("c")]), undefined);
    assert.equal(retrievalTotals([]), undefined);
  });
});

describe("Session.stats.retrieval on the recorded adapter fixtures", () => {
  const fixtures = join(import.meta.dirname, "..", "fixtures", "adapters");
  const golden = (rel: string): AgentEvent[] => {
    const agent = rel.split("/")[0]!;
    return (JSON.parse(readFileSync(join(fixtures, rel), "utf8")) as AgentEvent[]).map((e) => ({ ...e, agent: e.agent ?? agent }));
  };
  const sessionIn = (rel: string, id: string) => buildSession(golden(rel).filter((e) => e.sessionId === id).sort((a, b) => a.ts - b.ts));
  const none = { reads: 0, filesRead: 0, editedAfterRead: 0, searches: 0 };
  const failedRead = { ...none, reads: 1, beforeFirstEdit: 0 };
  const table: [string, string, RetrievalStats | undefined][] = [
    // Read a file, then edited one of the two.
    ["antigravity/golden/backfill-db.golden.json", "agy-conv-2", { ...none, reads: 2, filesRead: 2, editedAfterRead: 1, beforeFirstEdit: 1 }],
    ["cursor/golden/hooks.golden.json", "c0ffee00-1111-4222-8333-444455556666", { ...none, reads: 1, filesRead: 1, editedAfterRead: 1, beforeFirstEdit: 1 }],
    // Subagents: each stored as its own session with its own reads and searches.
    ["claude-code/golden/backfill.golden.json", "11111111-2222-4333-8444-555555555555", undefined],
    ["claude-code/golden/backfill.golden.json", "11111111-2222-4333-8444-555555555555:sub:abc123", { ...none, searches: 1 }],
    ["claude-code/golden/hooks.golden.json", "11111111-2222-4333-8444-555555555555:sub:abc123", { ...none, searches: 1 }],
    ["claude-code/golden/fork.golden.json", "3237ea33-26be-4229-b1c2-c8fb71d0b32c:sub:a863ace31075f5115", { ...none, reads: 1, filesRead: 1 }],
    ["claude-code/golden/subagents.golden.json", "36d2966a-1c53-47f1-891d-aae1827d0e95", { ...none, reads: 2, filesRead: 2 }],
    ["claude-code/golden/subagents.golden.json", "36d2966a-1c53-47f1-891d-aae1827d0e95:sub:afa77c104e92d121e", { ...none, reads: 1, filesRead: 1 }],
    ["opencode/golden/v2.golden.json", "ses_child", { ...none, searches: 1 }],
    // Shell reads and searches: `rg`, `sed -n`, `cat`, `head`.
    ["codex/golden/backfill.golden.json", "0193bbbb-1111-7222-8333-444455556666", { ...none, searches: 1 }],
    ["codex/golden/hooks.golden.json", "0193bbbb-1111-7222-8333-444455556666", { ...none, searches: 1 }],
    ["codex/golden/skill.golden.json", "01a1be94-bd43-7302-aa30-9fe348846093", { ...none, reads: 2, filesRead: 2 }],
    ["gemini-cli/golden/skills.golden.json", "gem-skill-1", { ...none, reads: 4, filesRead: 5 }],
    // `ls` in an empty folder (Copilot CLI's shell result with no output).
    ["copilot-cli/golden/otel.golden.json", "30b31f8e-efe1-43bd-b49c-ea31a3a8d520", { ...none, searches: 1, emptySearches: 1 }],
    // A read of a missing file: counted, with no file read.
    ["copilot-cli/golden/hooks.golden.json", "cop-sess-1", failedRead],
    ["devin/golden/hooks.golden.json", "brave-otter", failedRead],
    ["droid/golden/hooks.golden.json", "droid-sess-1", failedRead],
    ["gemini-cli/golden/backfill.golden.json", "gem-sess-1", failedRead],
    ["gemini-cli/golden/hooks.golden.json", "gem-sess-1", failedRead],
    // Tests, edits and MCP tools only.
    ["pi/golden/backfill.golden.json", "pi-sess-1", undefined],
    ["goose/golden/backfill.golden.json", "20260921_1", undefined],
  ];

  it("the sessions' reads, searches and edited files", () => {
    for (const [rel, id, want] of table) assert.deepEqual(sessionIn(rel, id).stats.retrieval, want, `${rel} ${id}`);
  });

  it("every golden session's retrieval is consistent with its other stats", () => {
    let sessions = 0;
    let withRetrieval = 0;
    for (const agent of readdirSync(fixtures)) {
      let files: string[] = [];
      try {
        files = readdirSync(join(fixtures, agent, "golden")).filter((f) => f.endsWith(".golden.json"));
      } catch {
        continue;
      }
      for (const f of files) {
        const by = new Map<string, AgentEvent[]>();
        for (const e of golden(`${agent}/golden/${f}`)) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
        for (const [id, evs] of by) {
          sessions++;
          const s = buildSession(evs.sort((a, b) => a.ts - b.ts));
          const r = s.stats.retrieval;
          if (!r) continue;
          withRetrieval++;
          const at = `${agent}/${f} ${id}`;
          assert.ok(r.reads + r.searches + (r.web ?? 0) > 0, at);
          // A call that reads and searches counts in both.
          assert.ok(Math.max(r.reads, r.searches) <= s.stats.toolCalls, at);
          assert.ok(r.editedAfterRead <= Math.min(r.filesRead, s.stats.filesChanged), at);
          assert.ok((r.emptySearches ?? 0) <= r.searches, at);
          // An edit sets beforeFirstEdit; filesChanged counts the same edits.
          assert.equal(r.beforeFirstEdit !== undefined, s.stats.filesChanged > 0, at);
          assert.ok((r.beforeFirstEdit ?? 0) <= r.reads + r.searches, at);
        }
      }
    }
    assert.ok(sessions >= 20 && withRetrieval >= table.filter((t) => t[2]).length, `${withRetrieval} of ${sessions} sessions`);
  });
});
