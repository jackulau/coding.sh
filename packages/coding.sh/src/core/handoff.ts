// Deterministic $0 context-reset handoff packet for a single session.
// Summarizes original goal, verified progress, unresolved dead ends, supervision
// risk and formal-verification status with full secret redaction and no LLM call.
import type { AgentEvent, ProofLang, Session } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import { isoMs } from "./dates.ts";
import { failureState, foldFailure } from "./failures.ts";
import { checkOutcome, outText, proofCheck, type ProofCheck } from "./proof.ts";
import { buildProofReport, type ProofTamperFinding, type ProofVerdict } from "./proof-report.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import { byTime, commandOf, isRealPrompt, isVerifyCommand } from "./sessions.ts";
import { normalizeTracePath, shellCommand, shellWrites } from "./shell-diff.ts";

export const DEFAULT_MAX_DEAD_ENDS = 8;
export const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_CHECKS = 12;
const GOAL_MAX = 1500;
const CMD_MAX = 200;
const ERROR_MAX = 180;

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
  return isoMs(ts) ?? new Date(ts).toISOString();
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

  const filesSet = new Set<string>();
  const passingByKey = new Map<string, PassingAcc>();
  const deadEndsByKey = new Map<string, DeadEndAcc>();

  const fState = failureState();
  const openCalls = new Map<string, OpenCall>();
  const seenStartIds = new Set<string>();
  const endedIds = new Set<string>();
  const fileChangeIds = new Set<string>();
  const countedTestIds = new Set<string>();
  const currentFailed = new Map<string, Set<string>>();
  const preCompactFailed = new Map<string, Set<string>>();

  let editsSinceCheck = 0;

  const markResolved = (scope: string, key: string | undefined): void => {
    if (!key) return;
    currentFailed.get(scope)?.delete(key);
    preCompactFailed.get(scope)?.delete(key);
    const existing = deadEndsByKey.get(key);
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
    const existing = deadEndsByKey.get(key);
    if (existing) {
      existing.count++;
      existing.lastTs = e.ts;
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
      deadEndsByKey.set(key, entry);
    }
  };

  for (const e of sorted) {
    const p = e.payload ?? {};
    const scope = e.subagentId ?? "";
    const cwd = baseCwd ?? e.cwd;

    if (e.kind === "context.compact") {
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
      if (rel) filesSet.add(rel);
      const moved = str(p.movedTo);
      if (moved) {
        const movedRel = normalizeTracePath(moved, cwd);
        if (movedRel) filesSet.add(movedRel);
      }
      const id = str(p.toolUseId);
      if (id) fileChangeIds.add(id);
      editsSinceCheck++;
      continue;
    }

    if (e.kind === "test.result") {
      const id = str(p.toolUseId);
      if (id && countedTestIds.has(id)) continue;
      if (id) countedTestIds.add(id);
      editsSinceCheck = 0;
      const failed = num(p.failed) ?? 0;
      if (failed === 0) {
        const runner = str(p.runner);
        const passed = num(p.passed);
        const label = runner
          ? passed !== undefined ? `${runner} (${passed} passed)` : runner
          : passed !== undefined ? `tests (${passed} passed)` : "tests";
        const key = `test:${(runner ?? "tests").toLowerCase()}`;
        passingByKey.set(key, {
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
          if (target) filesSet.add(target);
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
          if (rel) filesSet.add(rel);
        }
        if (!(id && fileChangeIds.has(id))) editsSinceCheck++;
        markResolved(scope, call.actionKey);
      } else if (!failure || failure.cls === "real") {
        recordDeadEnd(scope, call, e);
      }
      continue;
    }

    if (call.proof) {
      const outcome = checkOutcome(call.proof, p);
      if (outcome === "green" && !call.proof.bypass) {
        editsSinceCheck = 0;
        if (id) countedTestIds.add(id);
        if (call.actionKey) {
          passingByKey.set(call.actionKey, {
            command: clip(redact(call.display), CMD_MAX),
            at: formatTs(e.ts),
            outcome: "passed",
            kind: "proof",
            ts: e.ts,
          });
          markResolved(scope, call.actionKey);
        }
      } else if (outcome === "red" || p.ok === false) {
        editsSinceCheck = 0;
        if (call.actionKey) passingByKey.delete(call.actionKey);
        if (!failure || failure.cls === "real") recordDeadEnd(scope, call, e);
      }
      continue;
    }

    if (call.verify) {
      if (p.interrupted === true || failure?.cls === "interrupted") continue;
      editsSinceCheck = 0;
      if (p.ok !== false) {
        if (id) countedTestIds.add(id);
        if (call.actionKey) {
          passingByKey.set(call.actionKey, {
            command: clip(redact(call.display), CMD_MAX),
            at: formatTs(e.ts),
            outcome: "passed",
            kind: "verify",
            ts: e.ts,
          });
          markResolved(scope, call.actionKey);
        }
      } else if (!failure || failure.cls === "real") {
        if (call.actionKey) passingByKey.delete(call.actionKey);
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

  const filesChanged = [...new Set([...filesSet].map(redact))].sort().slice(0, maxFiles);
  const passingChecks: HandoffCheck[] = [...passingByKey.values()]
    .sort((a, b) => a.ts - b.ts)
    .slice(-DEFAULT_MAX_CHECKS)
    .map(({ command, at, outcome, kind }) => ({ command, at, outcome, kind }));

  const progress: HandoffProgress = { filesChanged, passingChecks };
  const tailEdits = session.stats.verification !== undefined
    ? session.stats.verification.unverifiedTailEdits
    : editsSinceCheck > 0 ? editsSinceCheck : undefined;
  if (tailEdits !== undefined && tailEdits > 0) progress.unverifiedTailEdits = tailEdits;

  const deadEnds: HandoffDeadEnd[] = [...deadEndsByKey.values()]
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
