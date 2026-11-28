// Deterministic $0 context-reset handoff packets for a single session or a multi-day
// work item. Summarizes original goal, direction pivots, verified progress, unresolved
// dead ends, supervision risk, multi-day timeline, and formal-verification status with
// full secret redaction and no LLM call.
import type { AgentEvent, ProofLang, Session, SupervisionRisk } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import { isoMs } from "./dates.ts";
import { failureState, foldFailure } from "./failures.ts";
import { checkOutcome, outText, proofCheck, type ProofCheck } from "./proof.ts";
import { buildProofReport, type ProofTamperFinding, type ProofVerdict } from "./proof-report.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import { byTime, commandOf, isRealPrompt, isVerifyCommand } from "./sessions.ts";
import { normalizeTracePath, shellCommand, shellWrites } from "./shell-diff.ts";
import type { WorkItem } from "./work.ts";

export const DEFAULT_MAX_DEAD_ENDS = 8;
export const DEFAULT_MAX_WORK_DEAD_ENDS = 10;
export const DEFAULT_MAX_WORK_SESSIONS = 20;
export const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_CHECKS = 12;
const GOAL_MAX = 1500;
const TITLE_MAX = 120;
const CMD_MAX = 200;
const ERROR_MAX = 180;
const DAY_MS = 86_400_000;
/** Short acknowledgements skipped when looking for a meaningful direction pivot across sessions. */
const TRIVIAL_ACK = /^(?:ok|okay|yes|yep|yeah|y|lgtm|thanks|thank you|thx|continue|go ahead|sounds good|proceed|do it|ship it)[.!?\s]*$/i;
const RISK_RANK: Record<SupervisionRisk, number> = { medium: 1, high: 2 };

/** Additional mechanical verification commands beyond sessions.ts VERIFY_COMMAND. */
const EXTRA_VERIFY = /\b(?:go\s+(?:build|vet)|biome\s+(?:check|lint)|flake8|pylint|black\s+--check|prettier\s+--check|cargo\s+fmt\s+--check)\b/i;
/** ANSI CSI escape sequences stripped from command output tails. */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Harness framing lines skipped when extracting the user task prompt. */
const HARNESS_FRAME = /^[ \t]*\[Workflow harness\b/;
const PROJECT_HEADER = /^[ \t]*Project:/;
const PASTE_OPEN = "<pasted_content";
const PASTE_CLOSE = "</pasted_content>";
/** Harness wrapper header lines stripped from failed tool outputs. */
const OUTPUT_HEADER_LINE = /^(?:Error: )?Exit code:? -?\d+[^\n]*$|^Process exited with code -?\d+[^\n]*$|^Wall time:[^\n]*$|^Original token count:[^\n]*$|^Chunk ID:[^\n]*$|^Output:\s*$/;
/** Error signal lines prioritized when extracting a 1-line error summary. */
const ERROR_HINT_LINE = /\b(?:error|err|fail|failed|exception|traceback|assertion|typeerror|syntaxerror|referenceerror|cannot|unsolved goals|type mismatch|violated|postcondition|unable to unify)\b/i;

export interface HandoffCheck {
  command: string;
  at: string;
  outcome: "passed";
  kind: "verify" | "proof" | "test";
}

export interface HandoffProgress {
  filesChanged: string[];
  passingChecks: HandoffCheck[];
  unverifiedTailEdits?: number;
}

export interface HandoffDeadEnd {
  command: string;
  count: number;
  error?: string;
  lastAt: string;
  postCompactionRepeat?: boolean;
}

export interface HandoffRisk {
  level: "medium" | "high";
  reasons: string[];
  compactions?: number;
  postCompactionFailedRepeats?: number;
  deadEndStreak?: number;
}

export interface HandoffProof {
  verdict: Exclude<ProofVerdict, "no-proof">;
  langs: ProofLang[];
  specUntouched: boolean;
  escapesRemaining: number;
  escapeKinds: string[];
  tamperFindings: ProofTamperFinding[];
  verifyHints: string[];
}

export interface HandoffPacket {
  sessionId: string;
  agent: string;
  repo?: string;
  branch?: string;
  title?: string;
  goal?: string;
  progress: HandoffProgress;
  deadEnds: HandoffDeadEnd[];
  risk?: HandoffRisk;
  proof?: HandoffProof;
  markdown: string;
}

export interface HandoffOptions {
  maxDeadEnds?: number;
  maxFiles?: number;
  redact?: Redactor;
}

export type EventsBySession = ReadonlyMap<string, readonly AgentEvent[]> | Readonly<Record<string, readonly AgentEvent[]>>;

export type WorkHandoffItem = Pick<WorkItem, "id" | "sessionIds"> &
  Partial<Pick<WorkItem, "primaryId" | "title" | "repo" | "cwd" | "branch" | "agents" | "supervisionRisk" | "riskReasons" | "proof">>;

export interface WorkTimelineEntry {
  sessionId: string;
  shortId?: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  day: string;
  title: string;
  turns: number;
  compactions: number;
  verificationChecks: number;
  unverifiedTailEdits: number;
  risk?: SupervisionRisk;
  proofVerdict?: Exclude<ProofVerdict, "no-proof">;
  deadEnds: number;
  summary: string;
}

export interface WorkTimeline {
  firstStartedAt?: string;
  lastEndedAt?: string;
  spanDays: number;
  totalSessions: number;
  omittedSessions?: number;
  entries: WorkTimelineEntry[];
}

export interface WorkTimelineOptions {
  maxSessions?: number;
  shortId?: (id: string) => string;
  redact?: Redactor;
}

export interface WorkContextResets {
  compactions: number;
  sessionHandoffs: number;
  total: number;
}

export interface WorkHandoffRisk extends HandoffRisk {
  sessionHandoffs?: number;
  contextResets?: number;
}

export interface WorkHandoffProof extends HandoffProof {
  oscillatingChecks?: number;
}

export interface WorkHandoffPacket {
  workId: string;
  title?: string;
  repo?: string;
  branch?: string;
  agents: string[];
  firstStartedAt?: string;
  lastEndedAt?: string;
  spanDays: number;
  totalSessions: number;
  omittedSessions?: number;
  goal?: string;
  latestDirection?: string;
  timeline: WorkTimelineEntry[];
  progress: HandoffProgress;
  deadEnds: HandoffDeadEnd[];
  risk?: WorkHandoffRisk;
  contextResets: WorkContextResets;
  proof?: WorkHandoffProof;
  markdown: string;
}

export interface WorkHandoffOptions extends HandoffOptions {
  maxSessions?: number;
  shortId?: (id: string) => string;
}

interface OpenCall {
  tool: string;
  actionKey?: string;
  display: string;
  verify: boolean;
  proof?: ProofCheck;
  isEdit: boolean;
}

interface DeadEndAcc {
  key: string;
  command: string;
  count: number;
  error?: string;
  lastTs: number;
  postCompactionRepeat: boolean;
  resolved: boolean;
}

interface PassingAcc extends HandoffCheck {
  ts: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function formatTs(ts: number): string {
  return isoMs(ts) ?? "-";
}

function isVerifyCmd(cmd: string | undefined): boolean {
  return !!cmd && (isVerifyCommand(cmd) || EXTRA_VERIFY.test(cmd));
}

function cutPastes(text: string, pastes: string[]): string {
  let out = "";
  let from = 0;
  let at = text.indexOf(PASTE_OPEN);
  while (at >= 0) {
    const after = at + PASTE_OPEN.length;
    if (/\w/.test(text.charAt(after))) {
      at = text.indexOf(PASTE_OPEN, at + 1);
      continue;
    }
    const gt = text.indexOf(">", after);
    if (gt < 0) break;
    const close = text.indexOf(PASTE_CLOSE, gt + 1);
    const end = close < 0 ? text.length : close;
    pastes.push(text.slice(gt + 1, end));
    out += `${text.slice(from, at)}\n`;
    from = close < 0 ? text.length : close + PASTE_CLOSE.length;
    at = text.indexOf(PASTE_OPEN, from);
  }
  return out + text.slice(from);
}

/** Strips harness frame lines and pasted blocks, matching core/sessions.ts task extraction. */
function extractTaskPrompt(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const pastes: string[] = [];
  const outside = cutPastes(normalized, pastes);
  const lines = outside.split("\n");
  const framed = lines.some((l) => HARNESS_FRAME.test(l));
  const kept = lines
    .filter((l) => !HARNESS_FRAME.test(l) && !(framed && PROJECT_HEADER.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (kept) return kept;
  for (const p of pastes) {
    const line = p.split("\n").find((l) => l.trim());
    if (line) return line.trim();
  }
  return undefined;
}

function extractGoal(session: Pick<Session, "title">, sorted: readonly AgentEvent[], redact: (s: string) => string): string | undefined {
  let raw: string | undefined;
  for (const e of sorted) {
    if (!isRealPrompt(e) || e.payload.from === "agent") continue;
    const text = str(e.payload.text);
    if (!text) continue;
    const task = extractTaskPrompt(text);
    if (task) {
      raw = task;
      break;
    }
  }
  if (!raw) {
    for (const e of sorted) {
      if (!isRealPrompt(e)) continue;
      const text = str(e.payload.text);
      if (!text) continue;
      const task = extractTaskPrompt(text);
      if (task) {
        raw = task;
        break;
      }
    }
  }
  if (!raw && session.title?.trim()) raw = session.title.trim();
  if (!raw) return undefined;
  return clip(redact(raw), GOAL_MAX);
}

function editPathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "target_file", "filename", "file"]) {
    const v = str(o[k]);
    if (v) return v;
  }
  return undefined;
}

function extractErrorTail(payload: Record<string, unknown>, redact: (s: string) => string): string | undefined {
  const raw = outText(payload.output ?? payload.error);
  if (!raw) return undefined;
  const cleaned = redact(raw.slice(0, 16_384).replace(ANSI_RE, ""));
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !OUTPUT_HEADER_LINE.test(l));
  if (!lines.length) return undefined;
  const preferred = lines.find((l) => ERROR_HINT_LINE.test(l)) ?? lines[lines.length - 1]!;
  return clip(preferred.replace(/\s+/g, " ").trim(), ERROR_MAX);
}

function classifyCall(e: AgentEvent, cwd: string | undefined): OpenCall | undefined {
  const p = e.payload;
  const tool = str(p.tool) ?? "";
  const input = p.input;
  const shell = isShellCall(tool, input);
  const cmd = shell ? (shellCommand(tool, input) ?? commandOf(input)) : undefined;
  const isEdit = !!tool && isFileEditTool(tool);
  const verify = p.verify === true || isVerifyCmd(cmd);
  const proof = shell && cmd ? proofCheck(cmd, input) : undefined;

  if (cmd?.trim()) {
    const norm = cmd.replace(/\s+/g, " ").trim();
    return { tool, actionKey: `cmd:${norm}`, display: norm, verify, proof, isEdit };
  }
  if (isEdit) {
    const rawPath = editPathOf(input);
    const rel = rawPath ? normalizeTracePath(rawPath, cwd) : undefined;
    const display = rel ? `${tool} ${rel}` : tool;
    return { tool, actionKey: `edit:${tool.toLowerCase()}:${rel ?? ""}`, display, verify, proof, isEdit };
  }
  if (tool) {
    return { tool, actionKey: `tool:${tool.toLowerCase()}`, display: tool, verify, proof, isEdit };
  }
  return undefined;
}

function scopeSet(map: Map<string, Set<string>>, scope: string): Set<string> {
  let set = map.get(scope);
  if (!set) {
    set = new Set();
    map.set(scope, set);
  }
  return set;
}

function buildRisk(session: Pick<Session, "stats">): HandoffRisk | undefined {
  const ch = session.stats.contextHygiene;
  if (!ch || (ch.supervisionRisk !== "medium" && ch.supervisionRisk !== "high")) return undefined;
  const risk: HandoffRisk = {
    level: ch.supervisionRisk,
    reasons: [...(ch.riskReasons ?? [])],
  };
  if (ch.compactions && ch.compactions > 0) risk.compactions = ch.compactions;
  if (ch.postCompactionFailedRepeats && ch.postCompactionFailedRepeats > 0) {
    risk.postCompactionFailedRepeats = ch.postCompactionFailedRepeats;
  }
  if (ch.deadEndStreak && ch.deadEndStreak > 0) risk.deadEndStreak = ch.deadEndStreak;
  return risk;
}

function buildProofSummary(
  session: Pick<Session, "id" | "cwd" | "repo">,
  sorted: readonly AgentEvent[],
  redact: (s: string) => string,
): HandoffProof | undefined {
  const report = buildProofReport(session, sorted);
  if (report.verdict === "no-proof") return undefined;
  const tamperFindings: ProofTamperFinding[] = report.tamperFindings.map((f) => {
    const item: ProofTamperFinding = { kind: f.kind, detail: redact(f.detail) };
    if (f.file) item.file = redact(f.file);
    return item;
  });
  return {
    verdict: report.verdict,
    langs: report.langs,
    specUntouched: report.specUntouched,
    escapesRemaining: report.escapes.remaining,
    escapeKinds: report.escapes.kinds,
    tamperFindings,
    verifyHints: report.verifyHints.map(redact),
  };
}

/** Formats a HandoffPacket into a copy-paste-ready Markdown brief for a fresh agent session. */
export function formatHandoffMarkdown(packet: Omit<HandoffPacket, "markdown"> | HandoffPacket): string {
  const lines: string[] = [
    "# Context Handoff",
    "",
    "Continue this task in a fresh session. Keep the verified progress below and avoid repeating failed approaches.",
    "",
    `- **Session:** \`${packet.sessionId}\` (${packet.agent})`,
  ];

  if (packet.repo) {
    const branchPart = packet.branch ? ` (\`${packet.branch}\`)` : "";
    lines.push(`- **Repo:** \`${packet.repo}\`${branchPart}`);
  } else if (packet.branch) {
    lines.push(`- **Branch:** \`${packet.branch}\``);
  }
  if (packet.title) {
    lines.push(`- **Title:** ${packet.title}`);
  }

  lines.push("", "## Goal", "");
  lines.push(packet.goal ?? "(no user prompt recorded)");

  if (packet.risk) {
    lines.push("", "## Context Risk", "");
    const reasonText = packet.risk.reasons.length ? ` (${packet.risk.reasons.join(", ")})` : "";
    lines.push(`- **Supervision risk:** \`${packet.risk.level}\`${reasonText}`);
    const signals: string[] = [];
    if (packet.risk.compactions) signals.push(`${packet.risk.compactions} compaction${packet.risk.compactions === 1 ? "" : "s"}`);
    if (packet.risk.postCompactionFailedRepeats) {
      signals.push(`${packet.risk.postCompactionFailedRepeats} post-compaction failed repeat${packet.risk.postCompactionFailedRepeats === 1 ? "" : "s"}`);
    }
    if (packet.risk.deadEndStreak) signals.push(`dead-end streak of ${packet.risk.deadEndStreak}`);
    if (signals.length) lines.push(`- **Signals:** ${signals.join(", ")}`);
  }

  lines.push("", "## Verified Progress", "", "### Files Changed", "");
  if (packet.progress.filesChanged.length) {
    for (const f of packet.progress.filesChanged) lines.push(`- \`${f}\``);
  } else {
    lines.push("None recorded.");
  }

  lines.push("", "### Passing Checks", "");
  if (packet.progress.passingChecks.length) {
    for (const c of packet.progress.passingChecks) {
      lines.push(`- \`${c.command}\` (${c.outcome} at ${c.at})`);
    }
  } else {
    lines.push("None recorded.");
  }

  if (packet.progress.unverifiedTailEdits && packet.progress.unverifiedTailEdits > 0) {
    const n = packet.progress.unverifiedTailEdits;
    lines.push("", `- **Unverified tail edits:** ${n} edit${n === 1 ? "" : "s"} after the last check`);
  }

  if (packet.proof) {
    lines.push("", "## Formal Proof Status", "");
    const langText = packet.proof.langs.length ? ` (${packet.proof.langs.join(", ")})` : "";
    lines.push(`- **Verdict:** \`${packet.proof.verdict}\`${langText}`);
    lines.push(`- **Spec files:** ${packet.proof.specUntouched ? "untouched" : "modified"}`);
    const kindText = packet.proof.escapeKinds.length ? ` (${packet.proof.escapeKinds.join(", ")})` : "";
    lines.push(`- **Remaining escapes:** ${packet.proof.escapesRemaining}${kindText}`);
    if (packet.proof.tamperFindings.length) {
      lines.push("- **Tamper findings:**");
      for (const f of packet.proof.tamperFindings) {
        const where = f.file ? `\`${f.file}\`: ` : "";
        lines.push(`  - [${f.kind}] ${where}${f.detail}`);
      }
    }
    if (packet.proof.verifyHints.length) {
      lines.push("- **Verify hints:**");
      for (const h of packet.proof.verifyHints) lines.push(`  - \`${h}\``);
    }
  }

  if (packet.deadEnds.length) {
    lines.push("", "## Do Not Repeat", "");
    for (const d of packet.deadEnds) {
      const tags: string[] = [`failed ${d.count}x`];
      if (d.postCompactionRepeat) tags.push("repeated after compaction");
      const errPart = d.error ? `: ${d.error}` : "";
      lines.push(`- \`${d.command}\` (${tags.join(", ")})${errPart}`);
    }
  }

  lines.push("", "## Next Steps", "");
  lines.push("1. Inspect `git status` and `git diff` for the changed files before editing.");
  if (packet.deadEnds.length) {
    lines.push("2. Avoid the failed approaches listed under Do Not Repeat and try a different strategy.");
  } else {
    lines.push("2. Continue from the verified state above and keep changes scoped to the goal.");
  }
  if (packet.proof && (packet.proof.escapesRemaining > 0 || packet.proof.verdict !== "verified")) {
    lines.push("3. Eliminate remaining proof escapes without weakening specs, then run the verify hints above.");
  } else {
    lines.push("3. Run verification checks after each focused edit.");
  }

  return lines.join("\n");
}

interface TraceAccumulator {
  filesSet: Set<string>;
  passingByKey: Map<string, PassingAcc>;
  deadEndsByKey: Map<string, DeadEndAcc>;
  editsSinceCheck: number;
  checksRun: number;
  compactionsSeen: number;
}

function createAccumulator(): TraceAccumulator {
  return {
    filesSet: new Set(),
    passingByKey: new Map(),
    deadEndsByKey: new Map(),
    editsSinceCheck: 0,
    checksRun: 0,
    compactionsSeen: 0,
  };
}

/**
 * Folds one chronologically sorted session's events into `acc`.
 * Per-session call-tracking maps stay local so toolUseIds never collide across sessions,
 * while files, passing checks, dead ends and tail edits accumulate across sessions.
 */
function foldSessionEvents(
  sorted: readonly AgentEvent[],
  baseCwd: string | undefined,
  redact: (s: string) => string,
  acc: TraceAccumulator,
): void {
  const fState = failureState();
  const openCalls = new Map<string, OpenCall>();
  const seenStartIds = new Set<string>();
  const endedIds = new Set<string>();
  const fileChangeIds = new Set<string>();
  const countedTestIds = new Set<string>();
  const currentFailed = new Map<string, Set<string>>();
  const preCompactFailed = new Map<string, Set<string>>();

  const markResolved = (scope: string, key: string | undefined): void => {
    if (!key) return;
    currentFailed.get(scope)?.delete(key);
    preCompactFailed.get(scope)?.delete(key);
    const existing = acc.deadEndsByKey.get(key);
    if (existing) existing.resolved = true;
  };

  const recordDeadEnd = (scope: string, call: OpenCall, e: AgentEvent): void => {
    const key = call.actionKey;
    if (!key) return;
    const pre = preCompactFailed.get(scope);
    const repeatedAfterCompact = pre?.has(key) === true;
    if (repeatedAfterCompact) pre.delete(key);
    scopeSet(currentFailed, scope).add(key);

    const errTail = extractErrorTail(e.payload, redact);
    const existing = acc.deadEndsByKey.get(key);
    if (existing) {
      existing.count++;
      existing.lastTs = Math.max(existing.lastTs, e.ts);
      existing.resolved = false;
      if (repeatedAfterCompact) existing.postCompactionRepeat = true;
      if (errTail) existing.error = errTail;
    } else {
      const entry: DeadEndAcc = {
        key,
        command: clip(redact(call.display), CMD_MAX),
        count: 1,
        lastTs: e.ts,
        postCompactionRepeat: repeatedAfterCompact,
        resolved: false,
      };
      if (errTail) entry.error = errTail;
      acc.deadEndsByKey.set(key, entry);
    }
  };

  for (const e of sorted) {
    const p = e.payload ?? {};
    const scope = e.subagentId ?? "";
    const cwd = baseCwd ?? e.cwd;

    if (e.kind === "context.compact") {
      acc.compactionsSeen++;
      const cur = currentFailed.get(scope);
      if (cur?.size) {
        const pre = scopeSet(preCompactFailed, scope);
        for (const k of cur) pre.add(k);
        cur.clear();
      }
      continue;
    }

    if (e.kind === "file.change") {
      const raw = str(p.path);
      if (!raw) continue;
      const rel = normalizeTracePath(raw, cwd);
      if (rel) acc.filesSet.add(rel);
      const moved = str(p.movedTo);
      if (moved) {
        const movedRel = normalizeTracePath(moved, cwd);
        if (movedRel) acc.filesSet.add(movedRel);
      }
      const id = str(p.toolUseId);
      if (id) fileChangeIds.add(id);
      acc.editsSinceCheck++;
      continue;
    }

    if (e.kind === "test.result") {
      const id = str(p.toolUseId);
      if (id && countedTestIds.has(id)) continue;
      if (id) countedTestIds.add(id);
      acc.editsSinceCheck = 0;
      acc.checksRun++;
      const failed = num(p.failed) ?? 0;
      if (failed === 0) {
        const runner = str(p.runner);
        const passed = num(p.passed);
        const label = runner
          ? passed !== undefined ? `${runner} (${passed} passed)` : runner
          : passed !== undefined ? `tests (${passed} passed)` : "tests";
        const key = `test:${(runner ?? "tests").toLowerCase()}`;
        acc.passingByKey.set(key, {
          command: clip(redact(label), CMD_MAX),
          at: formatTs(e.ts),
          outcome: "passed",
          kind: "test",
          ts: e.ts,
        });
      }
      continue;
    }

    if ((e.kind !== "tool.start" && e.kind !== "tool.end") || p.wrapper === true) continue;

    const failure = foldFailure(fState, e);
    const id = str(p.toolUseId);

    if (e.kind === "tool.start") {
      if (id && seenStartIds.has(id)) continue;
      if (id) seenStartIds.add(id);
      const tool = str(p.tool);
      const cmd = isShellCall(tool ?? "", p.input) ? (shellCommand(tool, p.input) ?? commandOf(p.input)) : undefined;
      if (cmd) {
        for (const w of shellWrites(cmd)) {
          const target = normalizeTracePath(w.renamedTo ?? w.path, cwd);
          if (target) acc.filesSet.add(target);
        }
      }
      const call = classifyCall(e, cwd);
      if (id && call) openCalls.set(id, call);
      continue;
    }

    // tool.end
    if (id) {
      if (endedIds.has(id)) continue;
      endedIds.add(id);
    }

    let call = id ? openCalls.get(id) : undefined;
    if (id && call) openCalls.delete(id);
    if (!call && p.input !== undefined) call = classifyCall(e, cwd);
    if (!call) continue;

    if (call.isEdit) {
      if (p.ok !== false) {
        const rawPath = editPathOf(p.input);
        if (rawPath) {
          const rel = normalizeTracePath(rawPath, cwd);
          if (rel) acc.filesSet.add(rel);
        }
        if (!(id && fileChangeIds.has(id))) acc.editsSinceCheck++;
        markResolved(scope, call.actionKey);
      } else if (!failure || failure.cls === "real") {
        recordDeadEnd(scope, call, e);
      }
      continue;
    }

    if (call.proof) {
      const outcome = checkOutcome(call.proof, p);
      if (outcome === "green" && !call.proof.bypass) {
        acc.editsSinceCheck = 0;
        acc.checksRun++;
        if (id) countedTestIds.add(id);
        if (call.actionKey) {
          acc.passingByKey.set(call.actionKey, {
            command: clip(redact(call.display), CMD_MAX),
            at: formatTs(e.ts),
            outcome: "passed",
            kind: "proof",
            ts: e.ts,
          });
          markResolved(scope, call.actionKey);
        }
      } else if (outcome === "red" || p.ok === false) {
        acc.editsSinceCheck = 0;
        acc.checksRun++;
        if (call.actionKey) acc.passingByKey.delete(call.actionKey);
        if (!failure || failure.cls === "real") recordDeadEnd(scope, call, e);
      }
      continue;
    }

    if (call.verify) {
      if (p.interrupted === true || failure?.cls === "interrupted") continue;
      acc.editsSinceCheck = 0;
      acc.checksRun++;
      if (p.ok !== false) {
        if (id) countedTestIds.add(id);
        if (call.actionKey) {
          acc.passingByKey.set(call.actionKey, {
            command: clip(redact(call.display), CMD_MAX),
            at: formatTs(e.ts),
            outcome: "passed",
            kind: "verify",
            ts: e.ts,
          });
          markResolved(scope, call.actionKey);
        }
      } else if (!failure || failure.cls === "real") {
        if (call.actionKey) acc.passingByKey.delete(call.actionKey);
        recordDeadEnd(scope, call, e);
      }
      continue;
    }

    if (p.ok !== false) {
      markResolved(scope, call.actionKey);
    } else if (!failure || failure.cls === "real") {
      recordDeadEnd(scope, call, e);
    }
  }
}

function finalizeDeadEnds(deadEndsByKey: ReadonlyMap<string, DeadEndAcc>, maxDeadEnds: number): HandoffDeadEnd[] {
  return [...deadEndsByKey.values()]
    .filter((d) => !d.resolved)
    .sort((a, b) => Number(b.postCompactionRepeat) - Number(a.postCompactionRepeat) || b.count - a.count || b.lastTs - a.lastTs)
    .slice(0, maxDeadEnds)
    .map((d) => {
      const item: HandoffDeadEnd = {
        command: d.command,
        count: d.count,
        lastAt: formatTs(d.lastTs),
      };
      if (d.error) item.error = d.error;
      if (d.postCompactionRepeat) item.postCompactionRepeat = true;
      return item;
    });
}

function finalizePassingChecks(passingByKey: ReadonlyMap<string, PassingAcc>): HandoffCheck[] {
  return [...passingByKey.values()]
    .sort((a, b) => a.ts - b.ts)
    .slice(-DEFAULT_MAX_CHECKS)
    .map(({ command, at, outcome, kind }) => ({ command, at, outcome, kind }));
}

/**
 * Builds a deterministic, fully redacted context-reset handoff packet for a session.
 * Pure: performs no disk, git, or network I/O and makes no LLM calls.
 */
export function buildHandoff(
  session: Pick<Session, "id" | "agent" | "cwd" | "repo" | "title" | "stats">,
  events: readonly AgentEvent[],
  opts: HandoffOptions = {},
): HandoffPacket {
  const maxDeadEnds = opts.maxDeadEnds ?? DEFAULT_MAX_DEAD_ENDS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const redactor = opts.redact ?? createRedactor();
  const redact = (s: string) => redactor.string(s);

  const sorted = byTime([...events]);
  const baseCwd = session.repo?.root ?? session.cwd;

  const acc = createAccumulator();
  foldSessionEvents(sorted, baseCwd, redact, acc);

  const filesChanged = [...new Set([...acc.filesSet].map(redact))].sort().slice(0, maxFiles);
  const passingChecks = finalizePassingChecks(acc.passingByKey);

  const progress: HandoffProgress = { filesChanged, passingChecks };
  const tailEdits = session.stats.verification !== undefined
    ? session.stats.verification.unverifiedTailEdits
    : acc.editsSinceCheck > 0 ? acc.editsSinceCheck : undefined;
  if (tailEdits !== undefined && tailEdits > 0) progress.unverifiedTailEdits = tailEdits;

  const deadEnds = finalizeDeadEnds(acc.deadEndsByKey, maxDeadEnds);

  const base: Omit<HandoffPacket, "markdown"> = {
    sessionId: session.id,
    agent: session.agent,
    progress,
    deadEnds,
  };

  const repoPath = session.repo?.root ?? session.cwd;
  if (repoPath) base.repo = redact(repoPath);
  if (session.repo?.branch) base.branch = redact(session.repo.branch);
  if (session.title?.trim()) base.title = redact(session.title.trim());

  const goal = extractGoal(session, sorted, redact);
  if (goal) base.goal = goal;

  const risk = buildRisk(session);
  if (risk) base.risk = risk;

  const proof = buildProofSummary(session, sorted, redact);
  if (proof) base.proof = proof;

  const markdown = redact(formatHandoffMarkdown(base));
  return { ...base, markdown };
}

// ------------------------------------------------------------ multi-day work timeline & handoff

function eventsFor(eventsBySession: EventsBySession | undefined, sessionId: string): readonly AgentEvent[] {
  if (!eventsBySession) return [];
  if (eventsBySession instanceof Map) return eventsBySession.get(sessionId) ?? [];
  const rec = eventsBySession as Readonly<Record<string, readonly AgentEvent[]>>;
  return rec[sessionId] ?? [];
}

function isOrganicSession(s: Session): boolean {
  return !s.parent?.subagentId && !s.id.includes(":sub:");
}

function orderWorkSessions(item: Pick<WorkItem, "sessionIds">, sessions: readonly Session[]): Session[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const picked: Session[] = [];
  const seen = new Set<string>();
  for (const id of item.sessionIds) {
    if (seen.has(id)) continue;
    const s = byId.get(id);
    if (s) {
      seen.add(id);
      picked.push(s);
    }
  }
  const base = picked.length > 0 ? picked : [...sessions];
  return base.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function dayOf(ts: number): string {
  const iso = isoMs(ts);
  return iso ? iso.slice(0, 10) : "-";
}

function spanDaysBetween(firstTs: number, lastTs: number): number {
  const firstDay = Date.parse(`${dayOf(firstTs)}T00:00:00.000Z`);
  const lastDay = Date.parse(`${dayOf(Math.max(firstTs, lastTs))}T00:00:00.000Z`);
  if (!Number.isFinite(firstDay) || !Number.isFinite(lastDay)) return 1;
  return Math.max(1, Math.floor((lastDay - firstDay) / DAY_MS) + 1);
}

function inferProofVerdictFromStats(s: Session): Exclude<ProofVerdict, "no-proof"> | undefined {
  const p = s.stats.verification?.proof;
  if (!p) return undefined;
  if (s.flags.includes("test-tamper")) return "tampered";
  if ((p.escapeRemaining ?? 0) > 0 || p.passed === 0 || p.failed > 0) return "incomplete";
  return "verified";
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split(/\r?\n/).find((l) => l.trim());
  return line?.trim();
}

function summarizeTimelineEntry(
  s: Session,
  acc: TraceAccumulator,
  compactions: number,
  verificationChecks: number,
  unverifiedTailEdits: number,
  deadEndCount: number,
  risk: SupervisionRisk | undefined,
  proofVerdict: Exclude<ProofVerdict, "no-proof"> | undefined,
  redact: (s: string) => string,
): string {
  const parts: string[] = [];
  const filesCount = acc.filesSet.size > 0 ? acc.filesSet.size : (s.stats.filesChanged ?? 0);
  if (filesCount > 0) parts.push(`${filesCount} ${filesCount === 1 ? "file" : "files"}`);

  const v = s.stats.verification;
  if (v && v.checks > 0) {
    parts.push(`${v.passed}/${v.checks} ${v.checks === 1 ? "check" : "checks"} passed`);
  } else if (verificationChecks > 0) {
    const passed = acc.passingByKey.size;
    parts.push(passed > 0 ? `${passed}/${verificationChecks} ${verificationChecks === 1 ? "check" : "checks"} passed` : `${verificationChecks} ${verificationChecks === 1 ? "check" : "checks"}`);
  }

  if (compactions > 0) parts.push(`${compactions} ${compactions === 1 ? "compaction" : "compactions"}`);
  if (risk) parts.push(`risk:${risk}`);
  if (proofVerdict) parts.push(`proof:${proofVerdict}`);
  if (deadEndCount > 0) parts.push(`${deadEndCount} dead ${deadEndCount === 1 ? "end" : "ends"}`);
  if (unverifiedTailEdits > 0) parts.push(`${unverifiedTailEdits} unverified tail ${unverifiedTailEdits === 1 ? "edit" : "edits"}`);

  if (!parts.length) {
    const turns = s.stats.turns ?? 0;
    parts.push(turns > 0 ? `${turns} ${turns === 1 ? "turn" : "turns"}` : "no changes recorded");
  }
  return clip(redact(parts.join(", ")), ERROR_MAX);
}

function buildTimelineEntry(
  s: Session,
  sortedEvents: readonly AgentEvent[],
  redact: (s: string) => string,
  shortId?: (id: string) => string,
): WorkTimelineEntry {
  const acc = createAccumulator();
  if (sortedEvents.length > 0) {
    foldSessionEvents(sortedEvents, s.repo?.root ?? s.cwd, redact, acc);
  }
  const compactions = Math.max(s.stats.contextHygiene?.compactions ?? 0, acc.compactionsSeen);
  const verificationChecks = s.stats.verification?.checks ?? (acc.checksRun > 0 ? acc.checksRun : (s.stats.testsPassed ?? 0) + (s.stats.testsFailed ?? 0));
  const unverifiedTailEdits = s.stats.verification?.unverifiedTailEdits ?? (sortedEvents.length > 0 ? acc.editsSinceCheck : 0);
  const unresolvedDeadEnds = [...acc.deadEndsByKey.values()].filter((d) => !d.resolved).length;
  const deadEnds = sortedEvents.length > 0 ? unresolvedDeadEnds : (s.stats.contextHygiene?.deadEndStreak ? 1 : 0);
  const risk = s.stats.contextHygiene?.supervisionRisk;

  let proofVerdict: Exclude<ProofVerdict, "no-proof"> | undefined;
  if (sortedEvents.length > 0) {
    const proof = buildProofSummary(s, sortedEvents, redact);
    proofVerdict = proof?.verdict;
  }
  proofVerdict ??= inferProofVerdictFromStats(s);

  const goalLine = sortedEvents.length > 0 ? firstLine(extractGoal(s, sortedEvents, redact)) : undefined;
  const rawTitle = s.title?.trim() || goalLine || "(untitled)";
  const title = clip(redact(rawTitle).replace(/\s+/g, " ").trim(), TITLE_MAX);
  const summary = summarizeTimelineEntry(s, acc, compactions, verificationChecks, unverifiedTailEdits, deadEnds, risk, proofVerdict, redact);

  const entry: WorkTimelineEntry = {
    sessionId: s.id,
    agent: s.agent,
    startedAt: formatTs(s.startedAt),
    day: dayOf(s.startedAt),
    title,
    turns: s.stats.turns ?? 0,
    compactions,
    verificationChecks,
    unverifiedTailEdits,
    deadEnds,
    summary,
  };
  const sid = shortId?.(s.id);
  if (sid) entry.shortId = sid;
  const endedAt = isoMs(s.endedAt);
  if (endedAt) entry.endedAt = endedAt;
  if (risk) entry.risk = risk;
  if (proofVerdict) entry.proofVerdict = proofVerdict;
  return entry;
}

/**
 * Builds a chronological multi-day continuity timeline for a work item.
 * Orders sessions by `startedAt` ascending, computes multi-day span across ALL member
 * sessions, and caps `entries` to the newest `maxSessions` (default 20).
 */
export function buildWorkTimeline(
  item: Pick<WorkItem, "id" | "sessionIds">,
  sessions: readonly Session[],
  eventsBySession?: EventsBySession,
  opts: WorkTimelineOptions = {},
): WorkTimeline {
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_WORK_SESSIONS;
  const redactor = opts.redact ?? createRedactor();
  const redact = (s: string) => redactor.string(s);

  const ordered = orderWorkSessions(item, sessions);
  if (!ordered.length) {
    return { spanDays: 0, totalSessions: 0, entries: [] };
  }

  let lastTs = ordered[0]!.startedAt;
  const sortedById = new Map<string, AgentEvent[]>();
  for (const s of ordered) {
    const evs = byTime([...eventsFor(eventsBySession, s.id)]);
    sortedById.set(s.id, evs);
    const evLast = evs.length ? evs[evs.length - 1]!.ts : s.startedAt;
    const candidate = Math.max(s.startedAt, s.endedAt ?? s.startedAt, evLast);
    if (candidate > lastTs) lastTs = candidate;
  }

  const firstTs = ordered[0]!.startedAt;
  const shown = ordered.length > maxSessions ? ordered.slice(-maxSessions) : ordered;
  const entries = shown.map((s) => buildTimelineEntry(s, sortedById.get(s.id) ?? [], redact, opts.shortId));

  const firstStartedAt = isoMs(firstTs);
  const lastEndedAt = isoMs(lastTs);
  const out: WorkTimeline = {
    spanDays: spanDaysBetween(firstTs, lastTs),
    totalSessions: ordered.length,
    entries,
  };
  if (firstStartedAt) out.firstStartedAt = firstStartedAt;
  if (lastEndedAt) out.lastEndedAt = lastEndedAt;
  if (ordered.length > shown.length) out.omittedSessions = ordered.length - shown.length;
  return out;
}

function normalizePromptCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?\s]+$/g, "")
    .trim();
}

interface PromptPick {
  eventId?: string;
  text: string;
}

function extractWorkGoals(
  item: WorkHandoffItem,
  ordered: readonly Session[],
  sortedById: ReadonlyMap<string, readonly AgentEvent[]>,
  redact: (s: string) => string,
): { goal?: string; latestDirection?: string } {
  const organic = ordered.filter(isOrganicSession);
  const searchOrder = organic.length > 0 ? [organic, ordered] : [ordered];

  let first: PromptPick | undefined;
  for (const pool of searchOrder) {
    for (const s of pool) {
      for (const e of sortedById.get(s.id) ?? []) {
        if (!isRealPrompt(e) || e.payload.from === "agent") continue;
        const text = str(e.payload.text);
        if (!text) continue;
        const task = extractTaskPrompt(text);
        if (task) {
          first = { eventId: e.id, text: task };
          break;
        }
      }
      if (first) break;
    }
    if (first) break;
  }
  if (!first) {
    for (const s of ordered) {
      for (const e of sortedById.get(s.id) ?? []) {
        if (!isRealPrompt(e)) continue;
        const text = str(e.payload.text);
        if (!text) continue;
        const task = extractTaskPrompt(text);
        if (task) {
          first = { eventId: e.id, text: task };
          break;
        }
      }
      if (first) break;
    }
  }
  if (!first) {
    const fallbackTitle = item.title?.trim() || ordered.find((s) => s.title?.trim())?.title?.trim();
    if (fallbackTitle) first = { text: fallbackTitle };
  }

  let latest: PromptPick | undefined;
  for (const pool of searchOrder) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const s = pool[i]!;
      const evs = sortedById.get(s.id) ?? [];
      for (let j = evs.length - 1; j >= 0; j--) {
        const e = evs[j]!;
        if (!isRealPrompt(e) || e.payload.from === "agent") continue;
        const text = str(e.payload.text);
        if (!text) continue;
        const task = extractTaskPrompt(text);
        if (!task || TRIVIAL_ACK.test(task)) continue;
        latest = { eventId: e.id, text: task };
        break;
      }
      if (latest) break;
    }
    if (latest) break;
  }

  const goal = first ? clip(redact(first.text), GOAL_MAX) : undefined;
  let latestDirection: string | undefined;
  if (latest && first) {
    const sameEvent = first.eventId !== undefined && first.eventId === latest.eventId;
    const sameText = normalizePromptCompare(first.text) === normalizePromptCompare(latest.text);
    if (!sameEvent && !sameText) {
      latestDirection = clip(redact(latest.text), GOAL_MAX);
    }
  }
  return { goal, latestDirection };
}

function namespaceEventsForProof(ordered: readonly Session[], sortedById: ReadonlyMap<string, readonly AgentEvent[]>): AgentEvent[] {
  const merged: AgentEvent[] = [];
  for (const s of ordered) {
    for (const e of sortedById.get(s.id) ?? []) {
      const tid = str(e.payload?.toolUseId);
      if (tid) {
        merged.push({ ...e, payload: { ...e.payload, toolUseId: `${s.id}\u0000${tid}` } });
      } else {
        merged.push(e);
      }
    }
  }
  return byTime(merged);
}

function buildWorkProofRollup(
  item: WorkHandoffItem,
  ordered: readonly Session[],
  sortedById: ReadonlyMap<string, readonly AgentEvent[]>,
  redact: (s: string) => string,
): WorkHandoffProof | undefined {
  const merged = namespaceEventsForProof(ordered, sortedById);
  const firstWithRepo = ordered.find((s) => s.repo?.root) ?? ordered[0];
  const proofTarget: Pick<Session, "id" | "cwd" | "repo"> = {
    id: item.id,
    cwd: item.cwd ?? firstWithRepo?.cwd,
    repo: item.repo ? { root: item.repo, head: firstWithRepo?.repo?.head ?? "", branch: item.branch } : firstWithRepo?.repo,
  };
  const oscillating = ordered.reduce((sum, s) => sum + (s.stats.verification?.proof?.oscillatingChecks ?? 0), 0) || (item.proof?.oscillatingChecks ?? 0);

  const fromEvents = merged.length > 0 ? buildProofSummary(proofTarget, merged, redact) : undefined;
  if (fromEvents) {
    const out: WorkHandoffProof = { ...fromEvents };
    if (oscillating > 0) out.oscillatingChecks = oscillating;
    return out;
  }

  // Fallback when only aggregated stats exist (e.g. stats-only work items).
  const langs = new Set<ProofLang>(item.proof?.langs ?? []);
  let hasStatsProof = !!item.proof;
  let escapesRemaining = 0;
  let passed = 0;
  let failed = 0;
  let tampered = false;
  for (const s of ordered) {
    const p = s.stats.verification?.proof;
    if (!p) continue;
    hasStatsProof = true;
    for (const l of p.langs) langs.add(l);
    escapesRemaining += p.escapeRemaining ?? 0;
    passed += p.passed;
    failed += p.failed;
    if (s.flags.includes("test-tamper")) tampered = true;
  }
  if (!hasStatsProof) return undefined;
  if (escapesRemaining === 0 && item.proof?.escapeRemaining) escapesRemaining = item.proof.escapeRemaining;
  if (passed === 0 && failed === 0 && item.proof) {
    passed = item.proof.passed;
    failed = item.proof.failed;
  }
  const verdict: Exclude<ProofVerdict, "no-proof"> = tampered ? "tampered" : escapesRemaining > 0 || passed === 0 || failed > 0 ? "incomplete" : "verified";
  const out: WorkHandoffProof = {
    verdict,
    langs: [...langs].sort(),
    specUntouched: !tampered,
    escapesRemaining,
    escapeKinds: [],
    tamperFindings: [],
    verifyHints: [],
  };
  if (oscillating > 0) out.oscillatingChecks = oscillating;
  return out;
}

function buildWorkRiskRollup(
  item: WorkHandoffItem,
  ordered: readonly Session[],
  contextResets: WorkContextResets,
): WorkHandoffRisk | undefined {
  let level: SupervisionRisk | undefined = item.supervisionRisk;
  const reasons = new Set<string>(item.riskReasons ?? []);
  let postCompactionFailedRepeats = 0;
  let deadEndStreak = 0;
  for (const s of ordered) {
    const ch = s.stats.contextHygiene;
    if (!ch) continue;
    if (ch.supervisionRisk && (!level || RISK_RANK[ch.supervisionRisk] > RISK_RANK[level])) {
      level = ch.supervisionRisk;
    }
    for (const r of ch.riskReasons ?? []) if (r) reasons.add(r);
    postCompactionFailedRepeats += ch.postCompactionFailedRepeats ?? 0;
    if ((ch.deadEndStreak ?? 0) > deadEndStreak) deadEndStreak = ch.deadEndStreak!;
  }
  if (!level) return undefined;
  const risk: WorkHandoffRisk = {
    level,
    reasons: [...reasons].sort(),
  };
  if (contextResets.compactions > 0) risk.compactions = contextResets.compactions;
  if (contextResets.sessionHandoffs > 0) risk.sessionHandoffs = contextResets.sessionHandoffs;
  if (contextResets.total > 0) risk.contextResets = contextResets.total;
  if (postCompactionFailedRepeats > 0) risk.postCompactionFailedRepeats = postCompactionFailedRepeats;
  if (deadEndStreak > 0) risk.deadEndStreak = deadEndStreak;
  return risk;
}

function cell(text: string, max = 80): string {
  return clip(text.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").replace(/\s+/g, " ").trim(), max);
}

/** Formats a multi-day WorkHandoffPacket into a copy-paste-ready Markdown brief for a fresh session. */
export function formatWorkHandoffMarkdown(packet: Omit<WorkHandoffPacket, "markdown"> | WorkHandoffPacket): string {
  const titlePart = packet.title ? ` — ${packet.title}` : "";
  const lines: string[] = [
    "# Work Handoff",
    "",
    "Continue this work item in a fresh session. Keep the verified progress below and avoid repeating failed approaches.",
    "",
    `- **Work:** \`${packet.workId}\`${titlePart}`,
  ];

  if (packet.repo) {
    const branchPart = packet.branch ? ` (\`${packet.branch}\`)` : "";
    lines.push(`- **Repo:** \`${packet.repo}\`${branchPart}`);
  } else if (packet.branch) {
    lines.push(`- **Branch:** \`${packet.branch}\``);
  }

  const sessWord = packet.totalSessions === 1 ? "session" : "sessions";
  const dayWord = packet.spanDays === 1 ? "day" : "days";
  const rangePart =
    packet.firstStartedAt && packet.lastEndedAt
      ? packet.firstStartedAt.slice(0, 10) === packet.lastEndedAt.slice(0, 10)
        ? ` (${packet.firstStartedAt.slice(0, 10)})`
        : ` (${packet.firstStartedAt.slice(0, 10)} to ${packet.lastEndedAt.slice(0, 10)})`
      : "";
  lines.push(`- **Span:** ${packet.totalSessions} ${sessWord} across ${packet.spanDays} ${dayWord}${rangePart}`);

  if (packet.agents.length) {
    lines.push(`- **Agents:** ${packet.agents.join(", ")}`);
  }

  const cr = packet.contextResets;
  const compWord = cr.compactions === 1 ? "compaction" : "compactions";
  const hoWord = cr.sessionHandoffs === 1 ? "session handoff" : "session handoffs";
  lines.push(`- **Context resets:** ${cr.total} (${cr.compactions} ${compWord}, ${cr.sessionHandoffs} ${hoWord})`);

  if (packet.risk) {
    const reasonText = packet.risk.reasons.length ? ` (${packet.risk.reasons.join(", ")})` : "";
    lines.push(`- **Supervision risk:** \`${packet.risk.level}\`${reasonText}`);
  }

  lines.push("", "## Goal", "");
  if (packet.goal && packet.latestDirection) {
    lines.push(`**Original goal:** ${packet.goal}`);
    lines.push("");
    lines.push(`**Latest direction:** ${packet.latestDirection}`);
  } else {
    lines.push(packet.goal ?? "(no user prompt recorded)");
  }

  lines.push("", "## Multi-Day Timeline", "");
  if (packet.timeline.length) {
    if (packet.omittedSessions && packet.omittedSessions > 0) {
      lines.push(
        `_Showing newest ${packet.timeline.length} of ${packet.totalSessions} sessions (${packet.omittedSessions} older omitted; original goal preserved from the first session)._`,
        "",
      );
    }
    lines.push("| Date | Session | Agent | Checks | Compactions | Status | Summary |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const e of packet.timeline) {
      const idLabel = `\`${e.shortId ?? e.sessionId}\``;
      const flags: string[] = [];
      if (e.risk) flags.push(`risk:${e.risk}`);
      if (e.proofVerdict) flags.push(`proof:${e.proofVerdict}`);
      const status = flags.length ? flags.join(", ") : "ok";
      lines.push(
        `| ${e.day} | ${idLabel} | ${cell(e.agent, 24)} | ${e.verificationChecks} | ${e.compactions} | ${status} | ${cell(e.summary, 90)} |`,
      );
    }
  } else {
    lines.push("No sessions recorded.");
  }

  lines.push("", "## Files Changed", "");
  if (packet.progress.filesChanged.length) {
    for (const f of packet.progress.filesChanged) lines.push(`- \`${f}\``);
  } else {
    lines.push("None recorded.");
  }
  if (packet.progress.unverifiedTailEdits && packet.progress.unverifiedTailEdits > 0) {
    const n = packet.progress.unverifiedTailEdits;
    lines.push("", `- **Unverified tail edits:** ${n} edit${n === 1 ? "" : "s"} after the last check`);
  }

  lines.push("", "## Passing Checks", "");
  if (packet.progress.passingChecks.length) {
    for (const c of packet.progress.passingChecks) {
      lines.push(`- \`${c.command}\` (${c.outcome} at ${c.at})`);
    }
  } else {
    lines.push("None recorded.");
  }

  if (packet.proof) {
    lines.push("", "## Formal Proofs", "");
    const langText = packet.proof.langs.length ? ` (${packet.proof.langs.join(", ")})` : "";
    lines.push(`- **Verdict:** \`${packet.proof.verdict}\`${langText}`);
    lines.push(`- **Spec files:** ${packet.proof.specUntouched ? "untouched" : "modified"}`);
    const kindText = packet.proof.escapeKinds.length ? ` (${packet.proof.escapeKinds.join(", ")})` : "";
    lines.push(`- **Remaining escapes:** ${packet.proof.escapesRemaining}${kindText}`);
    if (packet.proof.oscillatingChecks) {
      lines.push(`- **Oscillating checks:** ${packet.proof.oscillatingChecks}`);
    }
    if (packet.proof.tamperFindings.length) {
      lines.push("- **Tamper findings:**");
      for (const f of packet.proof.tamperFindings) {
        const where = f.file ? `\`${f.file}\`: ` : "";
        lines.push(`  - [${f.kind}] ${where}${f.detail}`);
      }
    }
    if (packet.proof.verifyHints.length) {
      lines.push("- **Verify hints:**");
      for (const h of packet.proof.verifyHints) lines.push(`  - \`${h}\``);
    }
  }

  if (packet.deadEnds.length) {
    lines.push("", "## Do Not Repeat", "");
    for (const d of packet.deadEnds) {
      const tags: string[] = [`failed ${d.count}x`];
      if (d.postCompactionRepeat) tags.push("repeated after compaction");
      const errPart = d.error ? `: ${d.error}` : "";
      lines.push(`- \`${d.command}\` (${tags.join(", ")})${errPart}`);
    }
  }

  lines.push("", "## Next Step", "");
  lines.push("1. Inspect `git status` and `git diff` for the changed files before editing.");
  if (packet.latestDirection) {
    lines.push("2. Follow the latest direction above while staying consistent with the original goal.");
  } else if (packet.deadEnds.length) {
    lines.push("2. Avoid the failed approaches listed under Do Not Repeat and try a different strategy.");
  } else {
    lines.push("2. Continue from the verified state above and keep changes scoped to the goal.");
  }
  if (packet.proof && (packet.proof.escapesRemaining > 0 || packet.proof.verdict !== "verified")) {
    lines.push("3. Eliminate remaining proof escapes without weakening specs, then run the verify hints above.");
  } else if (packet.deadEnds.length && packet.latestDirection) {
    lines.push("3. Avoid the failed approaches listed under Do Not Repeat and run verification checks after each edit.");
  } else {
    lines.push("3. Run verification checks after each focused edit.");
  }

  return lines.join("\n");
}

/**
 * Builds a deterministic, fully redacted cross-session multi-day handoff packet for a work item.
 * Pure: performs no disk, git, or network I/O and makes no LLM calls.
 */
export function buildWorkHandoff(
  item: WorkHandoffItem,
  sessions: readonly Session[],
  eventsBySession: EventsBySession = new Map(),
  opts: WorkHandoffOptions = {},
): WorkHandoffPacket {
  const maxDeadEnds = opts.maxDeadEnds ?? DEFAULT_MAX_WORK_DEAD_ENDS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_WORK_SESSIONS;
  const redactor = opts.redact ?? createRedactor();
  const redact = (s: string) => redactor.string(s);

  const ordered = orderWorkSessions(item, sessions);
  const sortedById = new Map<string, AgentEvent[]>();
  const acc = createAccumulator();

  let totalCompactions = 0;
  for (const s of ordered) {
    const sorted = byTime([...eventsFor(eventsBySession, s.id)]);
    sortedById.set(s.id, sorted);
    const beforeCompactions = acc.compactionsSeen;
    foldSessionEvents(sorted, item.repo ?? s.repo?.root ?? item.cwd ?? s.cwd, redact, acc);
    const seenInSession = acc.compactionsSeen - beforeCompactions;
    totalCompactions += Math.max(s.stats.contextHygiene?.compactions ?? 0, seenInSession);
  }

  const timeline = buildWorkTimeline(item, ordered, sortedById, { maxSessions, shortId: opts.shortId, redact: redactor });
  const { goal, latestDirection } = extractWorkGoals(item, ordered, sortedById, redact);

  const filesChanged = [...new Set([...acc.filesSet].map(redact))].sort().slice(0, maxFiles);
  const passingChecks = finalizePassingChecks(acc.passingByKey);
  const progress: HandoffProgress = { filesChanged, passingChecks };
  const newest = ordered[ordered.length - 1];
  const tailEdits =
    acc.editsSinceCheck > 0
      ? acc.editsSinceCheck
      : sortedById.get(newest?.id ?? "")?.length
        ? undefined
        : newest?.stats.verification?.unverifiedTailEdits;
  if (tailEdits !== undefined && tailEdits > 0) progress.unverifiedTailEdits = tailEdits;

  const deadEnds = finalizeDeadEnds(acc.deadEndsByKey, maxDeadEnds);

  const sessionHandoffs = Math.max(0, ordered.length - 1);
  const contextResets: WorkContextResets = {
    compactions: totalCompactions,
    sessionHandoffs,
    total: totalCompactions + sessionHandoffs,
  };

  const agents = [...new Set([...(item.agents ?? []), ...ordered.map((s) => s.agent)])];
  const base: Omit<WorkHandoffPacket, "markdown"> = {
    workId: item.id,
    agents,
    spanDays: timeline.spanDays,
    totalSessions: timeline.totalSessions,
    timeline: timeline.entries,
    progress,
    deadEnds,
    contextResets,
  };

  if (timeline.firstStartedAt) base.firstStartedAt = timeline.firstStartedAt;
  if (timeline.lastEndedAt) base.lastEndedAt = timeline.lastEndedAt;
  if (timeline.omittedSessions !== undefined) base.omittedSessions = timeline.omittedSessions;

  const rawTitle = item.title?.trim() || ordered.find((s) => s.title?.trim())?.title?.trim();
  if (rawTitle) base.title = clip(redact(rawTitle), TITLE_MAX);

  const repoPath = item.repo ?? ordered.find((s) => s.repo?.root)?.repo?.root ?? item.cwd ?? ordered.find((s) => s.cwd)?.cwd;
  if (repoPath) base.repo = redact(repoPath);

  const branch = item.branch ?? [...ordered].reverse().find((s) => s.repo?.branch)?.repo?.branch;
  if (branch) base.branch = redact(branch);

  if (goal) base.goal = goal;
  if (latestDirection) base.latestDirection = latestDirection;

  const risk = buildWorkRiskRollup(item, ordered, contextResets);
  if (risk) base.risk = risk;

  const proof = buildWorkProofRollup(item, ordered, sortedById, redact);
  if (proof) base.proof = proof;

  const markdown = redact(formatWorkHandoffMarkdown(base));
  return { ...base, markdown };
}
