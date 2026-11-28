// Live telemetry steering advisor for a single session.
// Pure over (session, events): reads verification, formal proof loop, context hygiene,
// tamper and wait signals to produce prioritized steering directives and a paste-ready
// steer prompt with zero disk, process or network I/O. Every output string is redacted.
import type { AgentEvent, ProofLang, Session } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import { contextHygieneOf, contextHygieneState, foldContextHygiene } from "./context-hygiene.ts";
import { failureState, foldFailure } from "./failures.ts";
import { detectTestTamperTrace } from "./intent.ts";
import { buildProofReport } from "./proof-report.ts";
import {
  checkOutcome,
  isProofLang,
  isWholeProjectProofCheck,
  outText,
  proofCheck,
  proofOutputLang,
  type ProofCheck,
} from "./proof.ts";
import { createRedactor } from "./redact.ts";
import { commandOf, isVerifyCommand } from "./sessions.ts";
import { normalizeTracePath } from "./shell-diff.ts";
import { foldVerification, normalizeProofErrorSig, verificationOf, verificationState } from "./verification.ts";

export type SteerStatus = "continue" | "nudge" | "intervene";
export type SteerRisk = "low" | "medium" | "high";
export type SteerPriority = "high" | "medium" | "low";
export type SteerDirectiveKind =
  | "audit-tamper"
  | "answer-wait"
  | "break-oscillation"
  | "reset-context"
  | "target-single-file"
  | "verify-now"
  | "resolve-escapes"
  | "break-dead-end";

export interface SteerDirective {
  kind: SteerDirectiveKind;
  priority: SteerPriority;
  reason: string;
  steerText: string;
  evidence?: string;
}

export interface SteerTelemetry {
  checks: number;
  unverifiedTailEdits: number;
  maxUnverifiedEdits: number;
  compactions: number;
  deadEndStreak: number;
  proofLangs?: ProofLang[];
  oscillatingChecks?: number;
  escapeRemaining?: number;
}

export interface SteerAdvice {
  sessionId: string;
  status: SteerStatus;
  risk: SteerRisk;
  directives: SteerDirective[];
  suggestedSteer?: string;
  telemetry: SteerTelemetry;
}

const EXTRA_VERIFY = /\b(?:go\s+(?:build|vet)|biome\s+(?:check|lint)|flake8|pylint|black\s+--check|prettier\s+--check|cargo\s+fmt\s+--check)\b/i;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const PROOF_ERROR_LINE = /\berror:|\bError:|\b[1-9]\d* errors?\b|^\*\*\* |\bis violated\b|Failed to finish proof|Unfinished session|unsolved goals|type mismatch|assertion might not hold|postcondition not satisfied|Unable to unify/i;
const LEAN_FILE_LINE = /^([^\s:]+\.lean):\d+:\d+:/;
const ROCQ_FILE_LINE = /^File "([^"\n]+\.v)", line \d+/;
const DAFNY_FILE_LINE = /^([^\s(]+\.dfy)\(\d+,\d+\):/;
const RUST_LOC_LINE = /^\s*-->\s*(\S+\.rs):\d+:\d+/;
const SLOW_WHOLE_PROJECT_MS = 15_000;

const PRIORITY_RANK: Record<SteerPriority, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<SteerDirectiveKind, number> = {
  "audit-tamper": 0,
  "answer-wait": 1,
  "reset-context": 2,
  "break-oscillation": 3,
  "break-dead-end": 4,
  "verify-now": 5,
  "target-single-file": 6,
  "resolve-escapes": 7,
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function clip(text: string, max: number): string {
  const flat = text.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function editPathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  return str(o.file_path) ?? str(o.path) ?? str(o.filePath) ?? str(o.target_file) ?? str(o.filename);
}

function normalizeCmd(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

function isVerifyCmd(cmd: string | undefined): boolean {
  return !!cmd && (isVerifyCommand(cmd) || EXTRA_VERIFY.test(cmd));
}

function extractProofFailureDetail(output: string): { file?: string; errorLine?: string } {
  const lines = output.slice(0, 8192).replace(ANSI_RE, "").split(/\r?\n/);
  let file: string | undefined;
  let errorLine: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!file) {
      const lean = LEAN_FILE_LINE.exec(line);
      if (lean?.[1]) file = lean[1].replace(/\\/g, "/").replace(/^\.\//, "");
      const rocq = ROCQ_FILE_LINE.exec(line);
      if (!file && rocq?.[1]) file = rocq[1].replace(/\\/g, "/").replace(/^\.\//, "");
      const dafny = DAFNY_FILE_LINE.exec(line);
      if (!file && dafny?.[1]) file = dafny[1].replace(/\\/g, "/").replace(/^\.\//, "");
      const rust = RUST_LOC_LINE.exec(line);
      if (!file && rust?.[1]) file = rust[1].replace(/\\/g, "/").replace(/^\.\//, "");
    }
    if (!errorLine && PROOF_ERROR_LINE.test(line)) {
      errorLine = clip(line, 140);
      if (file) break;
    }
  }
  const out: { file?: string; errorLine?: string } = {};
  if (file) out.file = file;
  if (errorLine) out.errorLine = errorLine;
  return out;
}

function firstFileFor(files: readonly string[], lang: ProofLang): string | undefined {
  const byExt: Record<ProofLang, RegExp> = {
    lean: /\.lean$/,
    rocq: /\.v$/,
    dafny: /\.dfy$/,
    verus: /\.rs$/,
    isabelle: /\.thy$/,
    tla: /\.tla$/,
    tlc: /\.cfg$/,
  };
  return files.find((p) => byExt[lang].test(p));
}

function targetedCheckCommand(langs: readonly ProofLang[], proofFiles: readonly string[]): string {
  const lang = langs[0];
  if (!lang) return "a targeted single-file check";
  const file = firstFileFor(proofFiles, lang);
  switch (lang) {
    case "lean":
      return `lake env lean ${file ?? "<File.lean>"}`;
    case "rocq":
      return `coqc ${file ?? "<File.v>"}`;
    case "dafny":
      return `dafny verify ${file ?? "<File.dfy>"}`;
    case "verus":
      return file ? `verus ${file}` : "cargo verus -- --verify-module <module>";
    case "isabelle":
      return "isabelle build -d . <Session>";
    case "tla":
      return `tlapm ${file ?? "<Spec.tla>"}`;
    case "tlc": {
      const cfg = file ?? "<Model.cfg>";
      const tla = firstFileFor(proofFiles, "tla") ?? "<Spec.tla>";
      return `java -cp tla2tools.jar tlc2.TLC -config ${cfg} ${tla}`;
    }
  }
}

function formatList(items: readonly string[], max = 3): string {
  if (!items.length) return "";
  const head = items.slice(0, max).join(", ");
  return items.length > max ? `${head} +${items.length - max} more` : head;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface OscillationDetail {
  lang: ProofLang;
  file?: string;
  errorLine?: string;
  count: number;
}

interface OpenShell {
  cmd: string;
  ts: number;
  verify: boolean;
  proof?: ProofCheck;
  wholeProject: boolean;
}

interface StreakTracker {
  count: number;
  commands: Map<string, number>;
  lastCmd?: string;
}

function topEntry(map: ReadonlyMap<string, number>): string | undefined {
  let bestKey: string | undefined;
  let bestCount = 0;
  for (const [k, n] of map) {
    if (n > bestCount) {
      bestCount = n;
      bestKey = k;
    }
  }
  return bestKey;
}

function addUniqueTail(list: string[], value: string): void {
  const idx = list.indexOf(value);
  if (idx >= 0) list.splice(idx, 1);
  list.push(value);
  if (list.length > 32) list.shift();
}

/**
 * Compute live steering advice for a session from its stored stats and events.
 * Pure: reads no files, runs no subprocesses, and redacts every returned string.
 */
export function buildSteerAdvice(
  session: Pick<Session, "id" | "cwd" | "repo" | "flags" | "stats">,
  events: readonly AgentEvent[],
): SteerAdvice {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0) || a.i - b.i)
    .map((x) => x.e);

  const redactor = createRedactor();
  const redact = (s: string) => redactor.string(s);

  const baseCwd = session.repo?.root ?? session.cwd;
  const fState = failureState();
  const vState = verificationState();
  const hState = contextHygieneState();
  const seenStarts = new Set<string>();

  const openShells = new Map<string, OpenShell>();
  const openEditPaths = new Map<string, string>();
  const unverifiedTailFiles: string[] = [];
  const wholeProjectCmds = new Map<string, number>();
  let wholeProjectMaxMs = 0;
  let lastFastVerifyCmd: string | undefined;

  let lastProofSig: string | undefined;
  let curOscCount = 0;
  let worstOsc: OscillationDetail | undefined;

  const streaks = new Map<string, StreakTracker>();
  let bestDeadEndCount = 0;
  let bestDeadEndCmd: string | undefined;
  let bestDeadEndError: string | undefined;
  const curFailedCmds = new Map<string, Map<string, string>>();
  const preCompactCmds = new Map<string, Map<string, string>>();
  let postCompactRepeatCmd: string | undefined;

  for (const e of sorted) {
    const failure = foldFailure(fState, e);
    foldVerification(vState, e, { cwd: baseCwd, seen: seenStarts, failure });
    foldContextHygiene(hState, e, { seen: seenStarts, failure });

    const p = e.payload ?? {};
    const scope = e.subagentId ?? "";
    const cwd = baseCwd ?? e.cwd;

    if (e.kind === "context.compact") {
      const cur = curFailedCmds.get(scope);
      if (cur?.size) {
        let pre = preCompactCmds.get(scope);
        if (!pre) {
          pre = new Map();
          preCompactCmds.set(scope, pre);
        }
        for (const [k, v] of cur) pre.set(k, v);
        cur.clear();
      }
      continue;
    }

    if (e.kind === "file.change") {
      const raw = str(p.path);
      if (raw) addUniqueTail(unverifiedTailFiles, normalizeTracePath(raw, cwd));
      continue;
    }

    if (e.kind === "test.result") {
      unverifiedTailFiles.length = 0;
      continue;
    }

    if ((e.kind !== "tool.start" && e.kind !== "tool.end") || p.wrapper === true) continue;
    const id = str(p.toolUseId);
    const tool = str(p.tool) ?? "";

    if (e.kind === "tool.start") {
      if (id) {
        if (seenStarts.has(id)) continue;
        seenStarts.add(id);
      }
      if (tool && isFileEditTool(tool)) {
        const ep = editPathOf(p.input);
        if (id && ep) openEditPaths.set(id, normalizeTracePath(ep, cwd));
        continue;
      }
      if (isShellCall(tool, p.input)) {
        const cmd = commandOf(p.input);
        if (cmd) {
          const proof = proofCheck(cmd, p.input);
          const verify = p.verify === true || isVerifyCmd(cmd);
          const wholeProject = !!proof && isWholeProjectProofCheck(cmd);
          if (id) openShells.set(id, { cmd, ts: e.ts, verify, proof, wholeProject });
        }
      }
      continue;
    }

    // tool.end
    const editedPath = id ? openEditPaths.get(id) : undefined;
    if (id && editedPath !== undefined) openEditPaths.delete(id);
    if (tool && isFileEditTool(tool)) {
      if (p.ok !== false) {
        const ep = editedPath ?? (editPathOf(p.input) ? normalizeTracePath(editPathOf(p.input)!, cwd) : undefined);
        if (ep) addUniqueTail(unverifiedTailFiles, ep);
      }
    }

    let open = id ? openShells.get(id) : undefined;
    if (id && open) openShells.delete(id);
    if (!open && isShellCall(tool, p.input)) {
      const cmd = commandOf(p.input);
      if (cmd) {
        const proof = proofCheck(cmd, p.input);
        const verify = p.verify === true || isVerifyCmd(cmd);
        const wholeProject = !!proof && isWholeProjectProofCheck(cmd);
        open = { cmd, ts: e.ts, verify, proof, wholeProject };
      }
    }

    const out = outText(p.output ?? p.error);
    if (open) {
      const dur = num(e.durationMs) ?? num(p.durationMs) ?? (e.ts > open.ts ? e.ts - open.ts : undefined);
      const normCmd = normalizeCmd(open.cmd);
      if (open.proof) {
        const pLang = isProofLang(open.proof.lang) ? open.proof.lang : proofOutputLang(out);
        if (pLang) {
          const outcome = checkOutcome(open.proof, p);
          if (outcome) {
            unverifiedTailFiles.length = 0;
            if (open.wholeProject) {
              wholeProjectCmds.set(normCmd, (wholeProjectCmds.get(normCmd) ?? 0) + 1);
              if (dur !== undefined && dur > wholeProjectMaxMs) wholeProjectMaxMs = dur;
            } else {
              lastFastVerifyCmd = normCmd;
            }
            if (outcome === "green") {
              lastProofSig = undefined;
              curOscCount = 0;
            } else {
              const sig = normalizeProofErrorSig(pLang, open.proof, out);
              if (lastProofSig !== undefined && lastProofSig === sig) {
                curOscCount++;
                const detail = extractProofFailureDetail(out);
                const oscFile = detail.file ?? open.proof.path;
                if (!worstOsc || curOscCount >= worstOsc.count) {
                  const nextOsc: OscillationDetail = { lang: pLang, count: curOscCount };
                  if (oscFile) nextOsc.file = oscFile;
                  if (detail.errorLine) nextOsc.errorLine = detail.errorLine;
                  worstOsc = nextOsc;
                }
              } else {
                curOscCount = 0;
              }
              lastProofSig = sig;
            }
          }
        }
      } else if (open.verify && p.interrupted !== true && failure?.cls !== "interrupted") {
        unverifiedTailFiles.length = 0;
        lastFastVerifyCmd = normCmd;
      }
    }

    // Dead-end streak and post-compaction failed repeat tracking for grounded command evidence.
    const cmdLabel = open ? clip(normalizeCmd(open.cmd), 120) : tool || undefined;
    const cmdKey = open ? `cmd:${normalizeCmd(open.cmd)}` : undefined;
    if (p.ok !== false) {
      streaks.delete(scope);
      if (cmdKey) {
        curFailedCmds.get(scope)?.delete(cmdKey);
        preCompactCmds.get(scope)?.delete(cmdKey);
      }
    } else if (!failure || failure.cls === "real") {
      let tr = streaks.get(scope);
      if (!tr) {
        tr = { count: 0, commands: new Map() };
        streaks.set(scope, tr);
      }
      tr.count++;
      if (cmdLabel) {
        tr.commands.set(cmdLabel, (tr.commands.get(cmdLabel) ?? 0) + 1);
        tr.lastCmd = cmdLabel;
      }
      if (tr.count >= bestDeadEndCount) {
        bestDeadEndCount = tr.count;
        bestDeadEndCmd = topEntry(tr.commands) ?? tr.lastCmd;
        const firstErrLine = out.replace(ANSI_RE, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (firstErrLine) bestDeadEndError = clip(firstErrLine, 120);
      }
      if (cmdKey && open) {
        const pre = preCompactCmds.get(scope);
        if (pre?.has(cmdKey)) {
          postCompactRepeatCmd = clip(normalizeCmd(open.cmd), 120);
          pre.delete(cmdKey);
        }
        let cur = curFailedCmds.get(scope);
        if (!cur) {
          cur = new Map();
          curFailedCmds.set(scope, cur);
        }
        cur.set(cmdKey, clip(normalizeCmd(open.cmd), 120));
      }
    }
  }

  const foldedVerification = sorted.length > 0 ? verificationOf(vState) : undefined;
  const verification = session.stats.verification ?? foldedVerification;
  const foldedHygiene =
    sorted.length > 0
      ? contextHygieneOf(hState, { verification, compactionRefetches: session.stats.compactionRefetches })
      : undefined;
  const hygiene = session.stats.contextHygiene ?? foldedHygiene;
  const proofReport = buildProofReport(session, sorted);

  const checks = verification?.checks ?? 0;
  const unverifiedTailEdits = verification?.unverifiedTailEdits ?? 0;
  const maxUnverifiedEdits = verification?.maxUnverifiedEdits ?? 0;
  const compactions = hygiene?.compactions ?? 0;
  const deadEndStreak = hygiene?.deadEndStreak ?? (bestDeadEndCount >= 2 ? bestDeadEndCount : 0);
  const postCompactRepeats = hygiene?.postCompactionFailedRepeats ?? 0;
  const riskReasons = new Set(hygiene?.riskReasons ?? []);

  const proofLangsSet = new Set<ProofLang>([
    ...(verification?.proof?.langs ?? []),
    ...proofReport.langs,
  ]);
  const proofLangs = [...proofLangsSet].sort();
  const oscillatingChecks = Math.max(verification?.proof?.oscillatingChecks ?? 0, worstOsc?.count ?? 0);
  const wholeProjectChecks = Math.max(verification?.proof?.wholeProjectChecks ?? 0, proofReport.checks.wholeProject);
  const escapeRemaining = Math.max(verification?.proof?.escapeRemaining ?? 0, proofReport.escapes.remaining);

  const directives: SteerDirective[] = [];
  const pushDirective = (d: SteerDirective) => {
    const cleanDir: SteerDirective = {
      kind: d.kind,
      priority: d.priority,
      reason: redact(d.reason),
      steerText: redact(d.steerText),
    };
    if (d.evidence) cleanDir.evidence = redact(d.evidence);
    directives.push(cleanDir);
  };

  // 1. audit-tamper
  const hasTestTamperFlag = session.flags.includes("test-tamper");
  const hasProofTamper = proofReport.verdict === "tampered" || proofReport.tamperFindings.length > 0;
  let standingEscapeTamper = false;
  if (hasTestTamperFlag || hasProofTamper) {
    if (hasProofTamper) {
      const top = proofReport.tamperFindings.slice(0, 2);
      const summary = top.map((f) => (f.file ? `${f.file}: ${f.detail}` : f.detail)).join("; ");
      const files = [...new Set(proofReport.tamperFindings.map((f) => f.file).filter((x): x is string => !!x))];
      const where = files.length ? ` in ${formatList(files)}` : "";
      pushDirective({
        kind: "audit-tamper",
        priority: "high",
        reason: `Proof or spec tamper detected (${proofReport.tamperFindings.length} finding${proofReport.tamperFindings.length === 1 ? "" : "s"}).`,
        steerText: `Stop and revert any unauthorized spec, theorem statement, or verifier bypass changes${where}, then prove the original specification cleanly.`,
        evidence: summary,
      });
    } else {
      const hasNonProofTestTamper =
        sorted.length === 0 ||
        escapeRemaining === 0 ||
        detectTestTamperTrace(sorted, baseCwd ? { cwd: baseCwd } : {}).some(
          (f) => f.severity === "high" && f.kind === undefined,
        );
      if (hasNonProofTestTamper) {
        pushDirective({
          kind: "audit-tamper",
          priority: "high",
          reason: "The test-tamper flag is active on this session.",
          steerText: "Stop modifying or weakening tests and assertions to make checks pass. Revert test edits and fix the implementation against the original test suite.",
          evidence: "session flag: test-tamper",
        });
      } else {
        standingEscapeTamper = true;
      }
    }
  }

  // 2. answer-wait (blocking waits only: permission, question, plan)
  const waiting = session.stats.waiting;
  if (waiting && waiting.kind !== "turn") {
    const label = waiting.kind === "permission" ? "permission approval" : waiting.kind === "plan" ? "plan approval" : "a user question";
    const snippet = waiting.text ? clip(waiting.text, 160) : undefined;
    pushDirective({
      kind: "answer-wait",
      priority: "high",
      reason: `Agent is blocked waiting on ${label}.`,
      steerText: snippet
        ? `Respond to the pending ${label} ("${snippet}") so the agent can resume.`
        : `Respond to the pending ${label} so the agent can resume.`,
      evidence: snippet ? `waiting (${waiting.kind}): ${snippet}` : `waiting (${waiting.kind})`,
    });
  }

  // 3. break-oscillation
  if (oscillatingChecks >= 2) {
    const oscFile = worstOsc?.file ?? (proofLangs.length ? firstFileFor(proofReport.proofFiles, proofLangs[0]!) : undefined) ?? proofReport.proofFiles[0];
    const oscErr = worstOsc?.errorLine;
    const targetName = oscFile ?? "the failing proof file";
    const errSuffix = oscErr ? ` (${oscErr})` : "";
    pushDirective({
      kind: "break-oscillation",
      priority: "high",
      reason: `Proof checker repeated the same failure ${oscillatingChecks} times in a row.`,
      steerText: `Stop retrying the same tactic on ${targetName}${errSuffix}. Inspect the current goal state, split the goal into a smaller helper lemma, or switch proof strategy before re-running the checker.`,
      evidence: `${oscillatingChecks} consecutive identical proof failures${oscFile ? ` on ${oscFile}` : ""}${oscErr ? `: ${oscErr}` : ""}`,
    });
  }

  // 4. reset-context
  const shouldResetContext =
    hygiene?.supervisionRisk === "high" &&
    (riskReasons.has("post-compaction-repeats") ||
      postCompactRepeats >= 1 ||
      (riskReasons.has("compaction-churn") && riskReasons.has("dead-end-loop")));
  if (shouldResetContext) {
    const parts: string[] = [];
    if (compactions > 0) parts.push(`${compactions} compaction${compactions === 1 ? "" : "s"}`);
    if (postCompactRepeats > 0) parts.push(`${postCompactRepeats} post-compaction failed repeat${postCompactRepeats === 1 ? "" : "s"}`);
    if (deadEndStreak >= 3) parts.push(`dead-end streak ${deadEndStreak}`);
    if (postCompactRepeatCmd) parts.push(`repeated: ${postCompactRepeatCmd}`);
    const repeatNote = postCompactRepeatCmd ? ` (repeating failed command \`${postCompactRepeatCmd}\`)` : "";
    pushDirective({
      kind: "reset-context",
      priority: "high",
      reason: "High supervision risk from post-compaction repeats or compaction churn with a dead-end loop.",
      steerText: `Context has degraded across compaction${repeatNote}. Pause this thread and run \`coding.sh handoff ${session.id}\` or fork a fresh session carrying only verified files and known-failing approaches to avoid.`,
      evidence: parts.join(", "),
    });
  }

  // 5. target-single-file
  const slowWholeProject =
    wholeProjectChecks >= 1 &&
    (wholeProjectMaxMs >= SLOW_WHOLE_PROJECT_MS || (verification?.medianCheckMs ?? 0) >= SLOW_WHOLE_PROJECT_MS);
  if (wholeProjectChecks >= 2 || slowWholeProject) {
    const bareCmd = topEntry(wholeProjectCmds) ?? (proofLangs[0] === "rocq" ? "dune build" : "lake build");
    const targeted = targetedCheckCommand(proofLangs, proofReport.proofFiles);
    const durNote =
      wholeProjectMaxMs >= SLOW_WHOLE_PROJECT_MS
        ? `, max ${formatDurationMs(wholeProjectMaxMs)}`
        : verification?.medianCheckMs !== undefined
          ? `, median ${formatDurationMs(verification.medianCheckMs)}`
          : "";
    pushDirective({
      kind: "target-single-file",
      priority: "medium",
      reason: `${wholeProjectChecks} bare whole-project proof build${wholeProjectChecks === 1 ? "" : "s"} slowed iteration.`,
      steerText: `Switch from bare \`${bareCmd}\` to targeted single-file checks (\`${targeted}\`) while iterating, and save the full project build for final verification.`,
      evidence: `${wholeProjectChecks} whole-project build${wholeProjectChecks === 1 ? "" : "s"} (\`${bareCmd}\`${durNote})`,
    });
  }

  // 6. verify-now
  if (unverifiedTailEdits >= 3 || (maxUnverifiedEdits >= 5 && unverifiedTailEdits > 0)) {
    const highVerify = unverifiedTailEdits >= 6 || maxUnverifiedEdits >= 10;
    const filesText = formatList(unverifiedTailFiles, 3);
    const suggestedCmd =
      proofLangs.length > 0
        ? targetedCheckCommand(proofLangs, proofReport.proofFiles)
        : lastFastVerifyCmd ?? "your fast test or typecheck command";
    const fileClause = filesText ? ` (${filesText})` : "";
    const cmdClause =
      suggestedCmd === "your fast test or typecheck command" ? suggestedCmd : `\`${suggestedCmd}\``;
    pushDirective({
      kind: "verify-now",
      priority: highVerify ? "high" : "medium",
      reason: `${unverifiedTailEdits} unverified file edit${unverifiedTailEdits === 1 ? "" : "s"} since the last check (max streak ${maxUnverifiedEdits}).`,
      steerText: `Pause editing after ${unverifiedTailEdits} unverified file edit${unverifiedTailEdits === 1 ? "" : "s"}${fileClause}. Run ${cmdClause} now to validate the current diff before making more changes.`,
      evidence: filesText
        ? `${unverifiedTailEdits} unverified tail edits (max ${maxUnverifiedEdits}): ${filesText}`
        : `${unverifiedTailEdits} unverified tail edits (max ${maxUnverifiedEdits})`,
    });
  }

  // 7. resolve-escapes
  if (escapeRemaining > 0) {
    const kinds = proofReport.escapes.kinds.length ? proofReport.escapes.kinds.join(", ") : "escape hatch";
    const filesText = formatList(proofReport.proofFiles, 3);
    const where = filesText ? ` in ${filesText}` : "";
    pushDirective({
      kind: "resolve-escapes",
      priority: standingEscapeTamper ? "high" : "medium",
      reason: `${escapeRemaining} proof escape hatch${escapeRemaining === 1 ? "" : "es"} (${kinds}) remain unresolved.`,
      steerText: `Replace the ${escapeRemaining} remaining proof escape${escapeRemaining === 1 ? "" : "s"} (${kinds})${where} with complete proofs before concluding.`,
      evidence: `${escapeRemaining} remaining (${kinds})${filesText ? ` across ${filesText}` : ""}`,
    });
  }

  // 8. break-dead-end
  if (deadEndStreak >= 3) {
    const highDeadEnd = deadEndStreak >= 5;
    const cmdPart = bestDeadEndCmd ? ` (repeating \`${bestDeadEndCmd}\`)` : "";
    const evParts = [`${deadEndStreak} consecutive failed tool calls`];
    if (bestDeadEndCmd) evParts.push(`command: ${bestDeadEndCmd}`);
    if (bestDeadEndError) evParts.push(`error: ${bestDeadEndError}`);
    pushDirective({
      kind: "break-dead-end",
      priority: highDeadEnd ? "high" : "medium",
      reason: `${deadEndStreak} consecutive failed tool calls without recovery.`,
      steerText: `Stop repeating the failing step${cmdPart}. Inspect the underlying error output and change approach instead of retrying unchanged.`,
      evidence: evParts.join("; "),
    });
  }

  directives.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  const hasHigh = directives.some((d) => d.priority === "high");
  const status: SteerStatus =
    directives.length === 0
      ? "continue"
      : hasHigh || hygiene?.supervisionRisk === "high" || directives.length >= 3
        ? "intervene"
        : "nudge";

  const risk: SteerRisk =
    status === "intervene"
      ? "high"
      : status === "nudge" || hygiene?.supervisionRisk === "medium"
        ? "medium"
        : "low";

  const telemetry: SteerTelemetry = {
    checks,
    unverifiedTailEdits,
    maxUnverifiedEdits,
    compactions,
    deadEndStreak,
  };
  if (proofLangs.length > 0) telemetry.proofLangs = proofLangs;
  if (oscillatingChecks > 0) telemetry.oscillatingChecks = oscillatingChecks;
  if (escapeRemaining > 0) telemetry.escapeRemaining = escapeRemaining;

  const advice: SteerAdvice = {
    sessionId: session.id,
    status,
    risk,
    directives,
    telemetry,
  };
  if (status !== "continue" && directives.length > 0) {
    const top = directives.slice(0, 2).map((d) => d.steerText);
    advice.suggestedSteer = redact(top.join(" "));
  }
  return advice;
}
