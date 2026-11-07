// Cross-agent tool-call semantics: which tools are shells, which edit files,
// and the derived file.change / test.result events they imply.
import { isAbsolute, relative } from "node:path";
import { diffHeader, editStats, parsePatch, parseTestOutput, patchDiffs, structuredPatchDiff, unifiedDiff, type FileChangeInfo } from "./heuristics.ts";
import { arr, blobList, fieldLimit, isObj, obj, outputText, str, type Emitter } from "./normalize.ts";

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "local_shell_call", "run_terminal_cmd", "terminal", "command_execution", "run_shell_command", "execute_command", "powershell"]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file", "writefile", "write_to_file"]);
const EDIT_TOOLS = new Set(["edit", "str_replace", "str_replace_editor", "str_replace_based_edit_tool", "search_replace", "replace", "edit_file", "strreplace", "replace_in_file"]);
const MULTIEDIT_TOOLS = new Set(["multiedit", "multi_edit"]);
const PATCH_TOOLS = new Set(["apply_patch", "patch", "applypatch"]);
const DELETE_TOOLS = new Set(["delete_file", "delete", "deletefile"]);
const NOTEBOOK_TOOLS = new Set(["notebookedit", "notebook_edit", "edit_notebook"]);

const lc = (s: string) => s.toLowerCase();

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(lc(tool));
}

/** The command line of a shell tool call (string, argv array, or bash -lc wrapper). */
export function shellCommandOf(tool: string, input: unknown): string | undefined {
  if (!isShellTool(tool) && !(isObj(input) && (typeof input.command === "string" || Array.isArray(input.command)) && lc(tool).includes("shell"))) return undefined;
  if (typeof input === "string") return input;
  const i = obj(input);
  const c = i.command ?? i.cmd ?? i.commandLine ?? i.script;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === "string");
    // ["bash","-lc","npm test"] → "npm test"
    if (parts.length >= 3 && /(^|\/)(ba|z|)sh$/.test(parts[0]!) && /^-\w*c$/.test(parts[1]!)) return parts.slice(2).join(" ");
    return parts.join(" ");
  }
  return undefined;
}

function relPath(p: string, cwd?: string): string {
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return r.split("\\").join("/");
  }
  return p;
}

const pathOf = (i: Record<string, unknown>) => str(i.file_path) ?? str(i.filePath) ?? str(i.path) ?? str(i.target_file) ?? str(i.targetFile) ?? str(i.notebook_path) ?? str(i.file);

const countLines = (s: string) => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);

/** Patch text from apply_patch-style inputs. */
export function patchTextOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const i = obj(input);
  const viaCommand = str(i.command); // Codex hooks: apply_patch tool_input = { command: <patch> }
  return str(i.input) ?? str(i.patch) ?? str(i.patchText) ?? str(i.patch_text) ?? str(i.diff) ?? (viaCommand && /^\*\*\* Begin Patch|^diff --git /m.test(viaCommand) ? viaCommand : undefined);
}

/** `info` with `diff` set when one could be built. */
function withDiff(info: FileChangeInfo, diff: string | undefined): FileChangeInfo {
  return diff ? { ...info, diff } : info;
}

/**
 * File changes implied by an edit-like tool call. `output` refines add-vs-modify
 * when the agent reports it (e.g. Claude Code Write → {type:"create"|"update"}),
 * and its structuredPatch (Claude Code) gives the diff real line numbers.
 */
export function fileChangesOf(tool: string, input: unknown, output?: unknown, cwd?: string): FileChangeInfo[] {
  const t = lc(tool);
  const i = obj(input);
  const out = obj(output);
  const path = pathOf(i);
  const rel = path ? relPath(path, cwd) : "";
  if (WRITE_TOOLS.has(t) && path) {
    const content = str(i.content) ?? str(i.contents) ?? str(i.text) ?? "";
    const op = out.type === "update" ? "modify" : "add";
    if (op === "modify" && typeof out.originalFile === "string") {
      return [withDiff({ path: rel, op, ...editStats(out.originalFile, content) }, structuredPatchDiff(rel, out.structuredPatch) ?? unifiedDiff(rel, out.originalFile, content))];
    }
    return [withDiff({ path: rel, op, additions: countLines(content), deletions: 0 }, op === "modify" ? structuredPatchDiff(rel, out.structuredPatch) : unifiedDiff(rel, "", content, "add"))];
  }
  if (EDIT_TOOLS.has(t) && path) {
    const oldS = str(i.old_string) ?? str(i.oldString) ?? str(i.old_str) ?? str(i.search) ?? "";
    const newS = str(i.new_string) ?? str(i.newString) ?? str(i.new_str) ?? str(i.replace) ?? str(i.content) ?? "";
    const op = oldS === "" && (i.command === "create" || out.type === "create") ? "add" : "modify";
    return [withDiff({ path: rel, op, ...editStats(oldS, newS) }, structuredPatchDiff(rel, out.structuredPatch, op) ?? unifiedDiff(rel, oldS, newS, op))];
  }
  if (MULTIEDIT_TOOLS.has(t) && path) {
    let additions = 0;
    let deletions = 0;
    const hunks: string[] = [];
    for (const e of arr(i.edits)) {
      const before = str(obj(e).old_string) ?? str(obj(e).oldString) ?? "";
      const after = str(obj(e).new_string) ?? str(obj(e).newString) ?? "";
      const s = editStats(before, after);
      additions += s.additions;
      deletions += s.deletions;
      const d = unifiedDiff(rel, before, after);
      if (d) hunks.push(d.slice(d.indexOf("@@")));
    }
    const diff = structuredPatchDiff(rel, out.structuredPatch) ?? (hunks.length ? diffHeader(rel) + hunks.join("") : undefined);
    return [withDiff({ path: rel, op: "modify", additions, deletions }, diff)];
  }
  if (NOTEBOOK_TOOLS.has(t) && path) {
    return [{ path: relPath(path, cwd), op: "modify" }];
  }
  if (DELETE_TOOLS.has(t) && path) return [{ path: relPath(path, cwd), op: "delete" }];
  if (SHELL_TOOLS.has(t) && isObj(out.bashEditDiff)) return bashEditChanges(out.bashEditDiff, cwd);
  if (PATCH_TOOLS.has(t)) {
    const text = patchTextOf(input);
    if (!text) return [];
    const diffs = patchDiffs(text);
    return parsePatch(text).map((c) => withDiff({ ...c, path: relPath(c.path, cwd) }, diffs.get(c.path)));
  }
  return [];
}

/**
 * Files a Claude Code Bash call changed (`sed -i`, a heredoc, `tee`, a script),
 * from its result's `bashEditDiff`: `files[{filePath, hunks, created?, deleted?}]`
 * with structuredPatch-style hunks, plus `changedFiles` naming every changed
 * path when `files` was cut short (`moreFiles` > 0). `unavailable: true` (no
 * diff could be taken) gives nothing. Hooks see the same object as tool_response.
 */
function bashEditChanges(diff: Record<string, unknown>, cwd?: string): FileChangeInfo[] {
  if (diff.unavailable === true) return [];
  const out: FileChangeInfo[] = [];
  const seen = new Set<string>();
  for (const f of arr(diff.files)) {
    const o = obj(f);
    const path = str(o.filePath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const rel = relPath(path, cwd);
    const op = o.created === true ? "add" : o.deleted === true ? "delete" : "modify";
    let additions = 0;
    let deletions = 0;
    for (const h of arr(o.hunks)) {
      for (const l of arr(obj(h).lines)) {
        if (typeof l !== "string") continue;
        if (l.startsWith("+")) additions++;
        else if (l.startsWith("-")) deletions++;
      }
    }
    out.push(withDiff({ path: rel, op, additions, deletions }, structuredPatchDiff(rel, o.hunks, op)));
  }
  for (const p of arr(diff.changedFiles)) {
    if (typeof p !== "string" || !p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: relPath(p, cwd), op: "modify" });
  }
  return out;
}

export interface DerivedOpts {
  tool: string;
  toolUseId: string;
  input: unknown;
  output?: unknown;
  ok: boolean;
  cwd?: string;
  /** Extra event fields (ts, parentId, …). */
  extra?: Parameters<Emitter["emit"]>[2];
}

/** Inline budget for payload.diff; longer diffs are cut at a line break and kept whole in a blob. */
export const DIFF_INLINE_BYTES = 2560;

/** payload.diff (cut to the inline budget at a line boundary) + the blob holding the whole diff when cut. */
export async function clipDiff(ctx: Emitter["ctx"], diff: string | undefined): Promise<{ diff?: string; diffTruncated?: true; blob?: string }> {
  if (!diff) return {};
  const limit = fieldLimit(ctx, DIFF_INLINE_BYTES);
  if (Buffer.byteLength(diff) <= limit) return { diff };
  let cut = Buffer.from(diff).subarray(0, limit).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { diff: cut, diffTruncated: true, blob: await ctx.blob(diff) };
}

/**
 * Emits file.change (one per touched file, with a unified diff when the call
 * carries enough to build one) and test.result (when a shell tool ran a test
 * suite) for a finished tool call. Ids use natural keys, so the same call seen
 * live and in a backfilled transcript dedupes.
 */
export async function emitDerived(em: Emitter, o: DerivedOpts): Promise<void> {
  // A shell call that failed after editing files still edited them (Claude Code's bashEditDiff says which).
  if (o.ok || isObj(obj(o.output).bashEditDiff)) {
    for (const c of fileChangesOf(o.tool, o.input, o.output, o.cwd)) {
      const d = await clipDiff(em.ctx, c.diff);
      em.emit(
        "file.change",
        { path: c.path, op: c.op, additions: c.additions, deletions: c.deletions, movedTo: c.movedTo, tool: o.tool, toolUseId: o.toolUseId, diff: d.diff, diffTruncated: d.diffTruncated },
        { ...o.extra, key: [o.toolUseId, c.path], blobs: blobList(...(o.extra?.blobs ?? []), d.blob) },
      );
    }
  }
  const cmd = shellCommandOf(o.tool, o.input);
  if (cmd !== undefined) {
    const s = parseTestOutput(outputText(o.output), cmd);
    if (s) em.emit("test.result", { runner: s.runner, passed: s.passed, failed: s.failed, skipped: s.skipped, toolUseId: o.toolUseId }, { ...o.extra, key: [o.toolUseId] });
  }
}
