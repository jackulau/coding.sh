// Checkable rules: directives in CLAUDE.md / AGENTS.md / SKILL.md that name a
// concrete token, and whether a trace acted on them (Wang et al., "Agent Skill
// Evolution", arXiv 2610.04832: §3.2 picks imperative lines that name a
// backticked command, flag, path or identifier; §5.2.2 scores compliance from
// actions alone, at 0.97-0.98 precision against human judges).
//
// Pure: no I/O. extractDirectives reads text, diffDirectives compares two
// harness versions, directiveOutcome reads a trace.
import { sha256Hex } from "./ids.ts";
import { commandOf } from "./sessions.ts";

export type DirectiveTokenKind = "command" | "flag" | "path" | "identifier";

export interface DirectiveToken {
  kind: DirectiveTokenKind;
  value: string;
}

export interface Directive {
  /** First 12 hex of sha256(path + "\n" + whitespace-normalized text): moving a line keeps it, editing a word changes it. */
  id: string;
  path: string;
  /** 1-based line in the file. */
  line: number;
  /** The line without list markers, numbering, heading marks or bold. */
  text: string;
  polarity: "require" | "forbid";
  /** The line has if/when/unless/before/after: compliance from actions alone is less certain. */
  conditional: boolean;
  tokens: DirectiveToken[];
}

const LEADING_VERBS = new Set(["run", "use", "call", "invoke", "execute", "read", "check", "add", "prefer", "keep", "put", "write", "import", "update", "set", "pass", "avoid", "edit", "create", "open", "install"]);
const MODAL = /\b(?:must|never|always|should|do not|don't|must not)\b/i;
const FORBID = /\b(?:never|do not|don't|must not|avoid)\b/i;
const CONDITIONAL = /\b(?:if|when|unless|before|after)\b/i;
const STOP = new Set(["true", "false", "null", "src", "test", "main", "readme"]);
const RUN_VERB = /\b(?:run|execute|invoke)\s*$/i;

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The line's prose: list marker, numbering, quote and heading marks, and bold dropped. */
function stripLine(raw: string): string {
  return raw
    .replace(/^\s*(?:>\s*)*/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/\*\*|__/g, "")
    .trim();
}

function tokenKind(value: string, before: string): DirectiveTokenKind {
  if (/^--?[\w-]+$/.test(value)) return "flag";
  if (/\s/.test(value)) return "command";
  if (value.includes("/") || value.startsWith("./") || value.startsWith("~/") || /\.[A-Za-z0-9]{1,8}$/.test(value)) return "path";
  if (RUN_VERB.test(before)) return "command";
  return "identifier";
}

/** Directives in one instruction file. Frontmatter and fenced code are skipped. */
export function extractDirectives(text: string, path: string): Directive[] {
  const lines = text.split(/\r?\n/);
  const out: Directive[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const raw = lines[i] as string;
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!fence) fence = f[1]![0];
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence || !raw.includes("`")) continue;
    const line = stripLine(raw);
    const first = /^[A-Za-z']+/.exec(line)?.[0]?.toLowerCase();
    if (!(first && LEADING_VERBS.has(first)) && !MODAL.test(line)) continue;
    const tokens: DirectiveToken[] = [];
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const value = (m[1] as string).trim();
      if (value.length < 3 || STOP.has(value.toLowerCase())) continue;
      if (tokens.some((t) => t.value === value)) continue;
      tokens.push({ kind: tokenKind(value, line.slice(0, m.index)), value });
    }
    if (!tokens.length) continue;
    const norm = normalize(line);
    out.push({
      id: sha256Hex(`${path}\n${norm}`).slice(0, 12),
      path,
      line: i + 1,
      text: norm,
      polarity: FORBID.test(line) ? "forbid" : "require",
      conditional: CONDITIONAL.test(line),
      tokens,
    });
  }
  return out;
}

export interface DirectiveDiff {
  /** In the new files only. `novel`: none of its tokens appears anywhere in the old instruction text. */
  added: (Directive & { novel: boolean })[];
  removed: Directive[];
  unchanged: Directive[];
}

function all(files: Readonly<Record<string, string>>): Directive[] {
  return Object.entries(files).flatMap(([p, t]) => extractDirectives(t, p));
}

/** Added, removed and unchanged directives between two versions of a harness's instruction files (path → text). */
export function diffDirectives(oldFiles: Readonly<Record<string, string>>, newFiles: Readonly<Record<string, string>>): DirectiveDiff {
  const before = all(oldFiles);
  const after = all(newFiles);
  const oldIds = new Set(before.map((d) => d.id));
  const newIds = new Set(after.map((d) => d.id));
  const oldText = Object.values(oldFiles).join("\n");
  return {
    added: after.filter((d) => !oldIds.has(d.id)).map((d) => ({ ...d, novel: !d.tokens.some((t) => oldText.includes(t.value)) })),
    removed: before.filter((d) => !newIds.has(d.id)),
    unchanged: after.filter((d) => oldIds.has(d.id)),
  };
}

// ---------------------------------------------------------------- outcomes

/** The fields of a trace event a rule check reads (AgentEvent and the eval TraceEvent both fit). */
export interface RuleEvent {
  id: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export type DirectiveSeen = "inline" | "displayed" | "not-displayed" | "not-loaded" | "unknown";

export interface DirectiveOutcome {
  /** require: some token was used; forbid: none was. null when the trace has no tool calls. */
  acted: boolean | null;
  /** require: the events that used a token; forbid: the violating events. */
  eventIds: string[];
  /** Whether the agent could have seen the rule. */
  seen: DirectiveSeen;
}

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"];
const WRITE_KEYS = ["content", "new_string", "new_source", "newString", "text"];
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const strOf = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `full` ends with `suffix` at a path boundary (`/repo/docs/A.md` ends with `docs/A.md`, not `cs/A.md`). */
export function pathEndsWith(full: string, suffix: string): boolean {
  const f = full.replaceAll("\\", "/");
  const s = suffix.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!s || !f.endsWith(s)) return false;
  return f.length === s.length || f[f.length - s.length - 1] === "/" || s.startsWith("/");
}

/** Paths a tool call's input names (Read, Edit, Write, NotebookEdit and look-alikes). */
export function inputPaths(input: unknown): string[] {
  const o = obj(input);
  if (!o) return [];
  return PATH_KEYS.map((k) => strOf(o[k])).filter((x): x is string => !!x);
}

/** A tool.start's shell command, whitespace-collapsed. */
export function commandText(e: RuleEvent): string | undefined {
  if (e.kind !== "tool.start") return undefined;
  const c = commandOf(e.payload?.input);
  return c === undefined ? undefined : normalize(c);
}

/**
 * Text an event wrote, when it is inline: the `+` lines of a file.change diff,
 * or the new content of a Write / Edit / MultiEdit / NotebookEdit call.
 * undefined when the event carries none (a diff kept only as a blob).
 */
export function writtenText(e: RuleEvent): string | undefined {
  const p = e.payload ?? {};
  if (e.kind === "file.change") {
    const diff = strOf(p.diff) ?? strOf(p.patch) ?? strOf(p.unifiedDiff);
    if (diff === undefined) return undefined;
    return diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
  }
  if (e.kind !== "tool.start") return undefined;
  const o = obj(p.input);
  if (!o) return undefined;
  const parts = WRITE_KEYS.map((k) => strOf(o[k])).filter((x): x is string => x !== undefined);
  if (Array.isArray(o.edits)) for (const ed of o.edits) parts.push(...WRITE_KEYS.map((k) => strOf(obj(ed)?.[k])).filter((x): x is string => x !== undefined));
  return parts.length ? parts.join("\n") : undefined;
}

/** Events that used a token (empty when none did). */
export function tokenUses(t: DirectiveToken, events: readonly RuleEvent[]): RuleEvent[] {
  const hits: RuleEvent[] = [];
  for (const e of events) {
    const cmd = commandText(e);
    let used = false;
    switch (t.kind) {
      case "command":
        used = cmd !== undefined && cmd.includes(normalize(t.value));
        break;
      case "flag":
        used = cmd !== undefined && cmd.split(" ").some((a) => a === t.value || a.startsWith(`${t.value}=`));
        break;
      case "path":
        used =
          (e.kind === "tool.start" && inputPaths(e.payload?.input).some((p) => pathEndsWith(p, t.value))) ||
          (cmd !== undefined && cmd.includes(t.value.replace(/^\.\//, ""))) ||
          (e.kind === "file.change" && pathEndsWith(strOf(e.payload?.path) ?? "", t.value));
        break;
      case "identifier":
        used = (cmd !== undefined && cmd.includes(t.value)) || (writtenText(e)?.includes(t.value) ?? false);
        break;
    }
    if (used) hits.push(e);
  }
  return hits;
}

const INLINE = /(?:^|\/)(?:CLAUDE|AGENTS|GEMINI)\.md$|(?:^|\/)\.cursor\/rules(?:\/|$)/i;

function skillRead(d: Directive, events: readonly RuleEvent[]): boolean {
  const path = d.path.replaceAll("\\", "/");
  const dir = path.replace(/\/?SKILL\.md$/i, "");
  const name = dir.split("/").pop() ?? "";
  return events.some((e) => {
    if (e.kind !== "tool.start" && e.kind !== "tool.end") return false;
    const p = e.payload ?? {};
    if (typeof p.skill === "string" && p.skill && (p.skill === name || p.skill === dir || pathEndsWith(dir, p.skill))) return true;
    if (e.kind !== "tool.start") return false;
    if (inputPaths(p.input).some((x) => pathEndsWith(x, path) || (name && pathEndsWith(x, `${name}/SKILL.md`)))) return true;
    const o = obj(p.input);
    return p.tool === "Skill" && !!name && (o?.skill === name || o?.command === name);
  });
}

function seenOf(d: Directive, events: readonly RuleEvent[]): DirectiveSeen {
  const path = d.path.replaceAll("\\", "/");
  if (INLINE.test(path)) return "inline";
  if (!/(?:^|\/)SKILL\.md$/i.test(path)) return "unknown";
  const outputs = events.filter((e) => e.kind === "tool.end" && e.payload?.output !== undefined).map((e) => e.payload!.output);
  if (!outputs.length) return "unknown";
  const want = d.text.toLowerCase();
  const shown = outputs.some((o) => normalize((typeof o === "string" ? o : JSON.stringify(o)).replace(/\*\*|__/g, "")).toLowerCase().includes(want));
  if (shown) return "displayed";
  return skillRead(d, events) ? "not-displayed" : "not-loaded";
}

/** Did the trace act on the directive, and could the agent have seen it? */
export function directiveOutcome(d: Directive, events: readonly RuleEvent[]): DirectiveOutcome {
  const seen = seenOf(d, events);
  if (!events.some((e) => e.kind === "tool.start")) return { acted: null, eventIds: [], seen };
  const ids = new Set<string>();
  for (const t of d.tokens) for (const e of tokenUses(t, events)) ids.add(e.id);
  const eventIds = [...ids];
  return { acted: d.polarity === "require" ? eventIds.length > 0 : eventIds.length === 0, eventIds, seen };
}
