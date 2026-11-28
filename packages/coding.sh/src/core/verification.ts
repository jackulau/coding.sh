// Intermediate-step verification discipline, check latency and formal proof loop telemetry
// folded into Session.stats.verification. Pure: rules over events, no I/O.
import type { AgentEvent, ProofLang, ProofLoopStats, VerificationStats } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import type { ToolFailure } from "./failures.ts";
import {
  checkOutcome,
  hasRocqSentence,
  hasVerilogLine,
  isProofConfig,
  isProofLang,
  isProofTestPath,
  isWholeProjectProofCheck,
  KERNEL_BYPASS_HATCHES,
  outText,
  proofCheck,
  proofLang,
  proofOutputLang,
  readProofDiff,
  type ProofCheck,
} from "./proof.ts";
// sessions.ts imports this module; read commandOf and isVerifyCommand inside functions only.
import { commandOf, isVerifyCommand } from "./sessions.ts";
import { normalizeTracePath } from "./shell-diff.ts";

/** Additional mechanical verification commands beyond sessions.ts VERIFY_COMMAND. */
const EXTRA_VERIFY = /\b(?:go\s+(?:build|vet)|biome\s+(?:check|lint)|flake8|pylint|black\s+--check|prettier\s+--check|cargo\s+fmt\s+--check)\b/i;
/** ANSI CSI/OSC escape sequences stripped when normalizing proof checker errors. */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Proof error lines used to build a stable oscillation signature. */
const PROOF_ERROR_LINE = /\berror:|\bError:|\b[1-9]\d* errors?\b|^\*\*\* |\bis violated\b|Failed to finish proof|Unfinished session|unsolved goals|type mismatch|assertion might not hold|postcondition not satisfied|Unable to unify/i;
const ROCQ_FILE_LINE = /^File "([^"\n]+\.v)", line \d+/;
const RUST_LOC_LINE = /^\s*-->\s*(\S+\.rs):\d+:\d+/;
const RS_ARG = /(?:^|\s)([^\s"'`]+\.rs)(?=\s|$)/g;

const OPEN_MAX = 256;
const RECENT_IDS_MAX = 256;
const SAMPLES_MAX = 500;
const PROOF_FILES_MAX = 500;
const ESCAPE_KEYS_MAX = 1000;
const IDLESS_MAX = 64;
const QUEUES_MAX = 64;

interface OpenCheck {
  ts?: number;
  verify: boolean;
  proof?: ProofCheck;
  wholeProject: boolean;
}

/** Plain v8-serializable fold state for Session.stats.verification. */
export interface VerificationState {
  checks: number;
  passed: number;
  failed: number;
  totalEdits: number;
  editsSinceCheck: number;
  maxUnverifiedEdits: number;
  durations: number[];
  /** Open verification or proof checker tool calls by toolUseId. */
  openChecks: Map<string, OpenCheck>;
  /** Open file-edit tool calls by toolUseId. */
  openEdits: Map<string, true>;
  /** Idless shell calls queued per thread+tool until their tool.end. */
  idlessChecks: Map<string, (OpenCheck | null)[]>;
  /** toolUseIds already counted from file.change, so a matching edit tool.end does not double-count. */
  fileChangeIds: Set<string>;
  /** toolUseIds already counted from an edit tool.end, so its first file.change does not double-count. */
  toolEditIds: Set<string>;
  /** toolUseIds already counted as a verification check (dedupes tool.end and derived test.result). */
  countedCheckIds: Set<string>;
  /** toolUseIds whose tool.end already folded here (dedupes cross-path copies). */
  endedIds: Set<string>;
  /** Formal proof languages seen via files or checkers. */
  proofLangs: Set<ProofLang>;
  /** Learned proof language by normalized path (for .rs, .v, .cfg diffs). */
  proofFileLangs: Map<string, ProofLang>;
  /** Recent .tla files seen, to recognize sibling .cfg files as TLC models. */
  tlaFiles: Set<string>;
  proofChecks: number;
  proofPassed: number;
  proofFailed: number;
  escapeAdded: number;
  escapeRemoved: number;
  /** Net escape hatches added minus removed, keyed by `<path>\0<hatch>`. */
  escapeByFile: Map<string, number>;
  oscillatingChecks: number;
  wholeProjectChecks: number;
  /** Normalized signature of the most recent consecutive failing proof check. */
  lastProofFailSig?: string;
}

export function verificationState(): VerificationState {
  return {
    checks: 0,
    passed: 0,
    failed: 0,
    totalEdits: 0,
    editsSinceCheck: 0,
    maxUnverifiedEdits: 0,
    durations: [],
    openChecks: new Map(),
    openEdits: new Map(),
    idlessChecks: new Map(),
    fileChangeIds: new Set(),
    toolEditIds: new Set(),
    countedCheckIds: new Set(),
    endedIds: new Set(),
    proofLangs: new Set(),
    proofFileLangs: new Map(),
    tlaFiles: new Set(),
    proofChecks: 0,
    proofPassed: 0,
    proofFailed: 0,
    escapeAdded: 0,
    escapeRemoved: 0,
    escapeByFile: new Map(),
    oscillatingChecks: 0,
    wholeProjectChecks: 0,
  };
}

export interface VerificationFacts {
  cwd?: string;
  seen: ReadonlySet<string>;
  failure?: ToolFailure;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function addBoundedSet(set: Set<string>, value: string, max: number): void {
  set.delete(value);
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function setBoundedMap<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function recordEdit(s: VerificationState): void {
  s.totalEdits++;
  s.editsSinceCheck++;
  if (s.editsSinceCheck > s.maxUnverifiedEdits) s.maxUnverifiedEdits = s.editsSinceCheck;
}

function recordDuration(s: VerificationState, ms: number | undefined): void {
  if (ms !== undefined && ms >= 0 && s.durations.length < SAMPLES_MAX) s.durations.push(Math.round(ms));
}

function isVerifyCmd(cmd: string | undefined): boolean {
  return !!cmd && (isVerifyCommand(cmd) || EXTRA_VERIFY.test(cmd));
}

const queueKey = (e: AgentEvent): string => `${e.subagentId ?? ""}\u0000${typeof e.payload.tool === "string" ? e.payload.tool.toLowerCase() : ""}`;

function classifyCheckStart(e: AgentEvent, fromStart: boolean): OpenCheck | undefined {
  const p = e.payload;
  const tool = str(p.tool) ?? "";
  const input = p.input;
  const shell = isShellCall(tool, input);
  const cmd = shell ? commandOf(input) : typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).code === "string" ? commandOf(input) : undefined;
  const verify = p.verify === true || isVerifyCmd(cmd);
  const proof = shell && cmd ? proofCheck(cmd, input) : undefined;
  if (!verify && !proof) return undefined;
  const wholeProject = proof && cmd ? isWholeProjectProofCheck(cmd) : false;
  const open: OpenCheck = { verify, wholeProject };
  if (fromStart) open.ts = e.ts;
  if (proof) open.proof = proof;
  return open;
}

/**
 * Normalizes a failing proof checker's output into a stable file+error signature so edits to line
 * numbers do not hide consecutive repeated failures on the same stuck goal. Linear in text length.
 */
export function normalizeProofErrorSig(lang: string, check: ProofCheck, output: string): string {
  const snippet = output.slice(0, 8192).replace(ANSI_RE, "");
  const lines = snippet.split(/\r?\n/);
  let fileHint = "";
  let errLine = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    const rocq = ROCQ_FILE_LINE.exec(raw);
    if (rocq) {
      fileHint = (rocq[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
      continue;
    }
    const rust = RUST_LOC_LINE.exec(raw);
    if (rust && !fileHint) {
      fileHint = (rust[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
      if (errLine) break;
      continue;
    }
    if (!errLine && PROOF_ERROR_LINE.test(raw)) {
      errLine = raw;
      if (lang !== "verus" || fileHint) break;
    }
  }
  const cleanLine = errLine
    .replace(/\\/g, "/")
    .replace(/:\d+:\d+/g, ":")
    .replace(/\(\d+,\d+\)/g, "()")
    .replace(/\bline \d+(?:, characters \d+-\d+)?/gi, "line N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const scope = (fileHint || check.path || check.target || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const body = cleanLine || "failed";
  const prefix = scope && !body.includes(scope) ? `${lang}:${scope}:` : `${lang}:`;
  return `${prefix}${body}`.slice(0, 160);
}

/** Resolves whether a finished ProofCheck counts as a formal proof check and returns its ProofLang. */
function resolveProofLang(s: VerificationState, check: ProofCheck, out: string): ProofLang | undefined {
  if (isProofLang(check.lang)) return check.lang;
  const fromOut = proofOutputLang(out);
  if (fromOut) return fromOut;
  if (check.lang === "dune" && s.proofLangs.has("rocq")) return "rocq";
  if (check.lang === "make" && s.proofLangs.size > 0 && check.path && /\.(?:v|lean|dfy|thy|tla|cfg)$/.test(check.path)) {
    const first = s.proofLangs.values().next().value;
    if (first) return first;
  }
  return undefined;
}

function recordProofFile(s: VerificationState, path: string, diff: string, truncated: boolean): void {
  if (isProofConfig(path)) return;
  const known = s.proofFileLangs.get(path);
  let lang = proofLang(path, diff, known);
  if (lang === "rocq" && ((!known && !s.proofLangs.has("rocq")) || hasVerilogLine(diff)) && !hasRocqSentence(diff)) lang = undefined;
  if (lang === "tlc" && known !== "tlc" && !s.proofLangs.has("tlc") && !s.proofLangs.has("tla") && !s.tlaFiles.has(path.replace(/\.cfg$/, ".tla"))) lang = undefined;
  if (!lang) return;
  s.proofLangs.add(lang);
  setBoundedMap(s.proofFileLangs, path, lang, PROOF_FILES_MAX);
  if (lang === "tla") addBoundedSet(s.tlaFiles, path, 64);
  if (!diff || isProofTestPath(path)) return;
  const parsed = readProofDiff(path, lang, diff, truncated);
  for (const [hatch, delta] of parsed.hatches) {
    if (KERNEL_BYPASS_HATCHES.has(hatch)) continue;
    if (delta > 0) s.escapeAdded += delta;
    else if (delta < 0) s.escapeRemoved += -delta;
    const key = `${path}\u0000${hatch}`;
    const next = (s.escapeByFile.get(key) ?? 0) + delta;
    if (next === 0) s.escapeByFile.delete(key);
    else setBoundedMap(s.escapeByFile, key, next, ESCAPE_KEYS_MAX);
  }
}

function recordVerusCommandFiles(s: VerificationState, cmd: string, cwd: string | undefined): void {
  RS_ARG.lastIndex = 0;
  for (let m = RS_ARG.exec(cmd); m; m = RS_ARG.exec(cmd)) {
    const p = m[1];
    if (p) setBoundedMap(s.proofFileLangs, normalizeTracePath(p, cwd), "verus", PROOF_FILES_MAX);
  }
}

function applyCheckOutcome(s: VerificationState, open: OpenCheck, e: AgentEvent, id: string | undefined, failure: ToolFailure | undefined): void {
  const p = e.payload;
  const dur = num(e.durationMs) ?? num(p.durationMs) ?? (open.ts !== undefined && e.ts > open.ts ? e.ts - open.ts : undefined);
  const out = outText(p.output ?? p.error);
  const alreadyCounted = id !== undefined && s.countedCheckIds.has(id);
  const pLang = open.proof ? resolveProofLang(s, open.proof, out) : undefined;

  if (open.proof && pLang) {
    const outcome = checkOutcome(open.proof, p);
    if (!outcome) return;
    s.proofLangs.add(pLang);
    s.proofChecks++;
    if (open.wholeProject) s.wholeProjectChecks++;
    if (outcome === "green") {
      s.proofPassed++;
      delete s.lastProofFailSig;
    } else {
      s.proofFailed++;
      const sig = normalizeProofErrorSig(pLang, open.proof, out);
      if (s.lastProofFailSig !== undefined && s.lastProofFailSig === sig) s.oscillatingChecks++;
      s.lastProofFailSig = sig;
    }
    if (!alreadyCounted) {
      s.checks++;
      if (outcome === "green") s.passed++;
      else s.failed++;
      s.editsSinceCheck = 0;
      if (id !== undefined) addBoundedSet(s.countedCheckIds, id, RECENT_IDS_MAX);
    }
    recordDuration(s, dur);
    return;
  }

  if (!open.verify) return;
  if (p.interrupted === true || failure?.cls === "interrupted") return;
  if (!alreadyCounted) {
    s.checks++;
    if (p.ok === false) s.failed++;
    else s.passed++;
    s.editsSinceCheck = 0;
    if (id !== undefined) addBoundedSet(s.countedCheckIds, id, RECENT_IDS_MAX);
  }
  recordDuration(s, dur);
}

/** Folds the next event in time order into a VerificationState. */
export function foldVerification(s: VerificationState, e: AgentEvent, o: VerificationFacts): void {
  const p = e.payload;
  if (e.kind === "file.change") {
    const raw = str(p.path);
    if (!raw) return;
    const id = str(p.toolUseId);
    if (id && s.toolEditIds.has(id)) {
      s.toolEditIds.delete(id);
      addBoundedSet(s.fileChangeIds, id, RECENT_IDS_MAX);
    } else {
      recordEdit(s);
      if (id) addBoundedSet(s.fileChangeIds, id, RECENT_IDS_MAX);
    }
    const rel = normalizeTracePath(raw, o.cwd ?? e.cwd);
    const diff = typeof p.diff === "string" ? p.diff : "";
    recordProofFile(s, rel, diff, p.diffTruncated === true);
    return;
  }

  if (e.kind === "test.result") {
    const id = str(p.toolUseId);
    if (id && s.countedCheckIds.has(id)) return;
    if (id) addBoundedSet(s.countedCheckIds, id, RECENT_IDS_MAX);
    s.checks++;
    if ((num(p.failed) ?? 0) > 0) s.failed++;
    else s.passed++;
    s.editsSinceCheck = 0;
    const dur = num(e.durationMs) ?? num(p.durationMs);
    recordDuration(s, dur);
    return;
  }

  if ((e.kind !== "tool.start" && e.kind !== "tool.end") || p.wrapper === true) return;
  const id = str(p.toolUseId);
  const tool = str(p.tool) ?? "";

  if (e.kind === "tool.start") {
    if (id && o.seen.has(id)) return;
    if (tool && isFileEditTool(tool)) {
      if (id) setBoundedMap(s.openEdits, id, true, OPEN_MAX);
      return;
    }
    const open = classifyCheckStart(e, true);
    if (open?.proof) {
      if (isProofLang(open.proof.lang)) s.proofLangs.add(open.proof.lang);
      if (open.proof.lang === "verus") {
        const cmd = commandOf(p.input);
        if (cmd) recordVerusCommandFiles(s, cmd, o.cwd ?? e.cwd);
      }
    }
    if (id) {
      if (open) setBoundedMap(s.openChecks, id, open, OPEN_MAX);
      return;
    }
    if (isShellCall(tool, p.input) || open) {
      const k = queueKey(e);
      let q = s.idlessChecks.get(k);
      if (!q) {
        if (s.idlessChecks.size >= QUEUES_MAX) {
          const oldest = s.idlessChecks.keys().next().value;
          if (oldest !== undefined) s.idlessChecks.delete(oldest);
        }
        q = [];
        s.idlessChecks.set(k, q);
      }
      q.push(open ?? null);
      if (q.length > IDLESS_MAX) q.shift();
    }
    return;
  }

  // tool.end
  if (id) {
    if (s.endedIds.has(id)) return;
    addBoundedSet(s.endedIds, id, RECENT_IDS_MAX);
  }

  const wasEdit = id ? s.openEdits.delete(id) : tool !== "" && isFileEditTool(tool);
  if (wasEdit) {
    if (p.ok !== false && !(id && s.fileChangeIds.has(id))) {
      recordEdit(s);
      if (id) addBoundedSet(s.toolEditIds, id, RECENT_IDS_MAX);
    }
    return;
  }

  let open: OpenCheck | undefined;
  if (id) {
    open = s.openChecks.get(id);
    if (open) s.openChecks.delete(id);
  } else {
    const k = queueKey(e);
    const q = s.idlessChecks.get(k);
    if (q) {
      const head = q.shift();
      if (!q.length) s.idlessChecks.delete(k);
      if (head) open = head;
    }
  }
  if (!open && p.input !== undefined) open = classifyCheckStart(e, false);
  if (!open) return;
  applyCheckOutcome(s, open, e, id, o.failure);
}

function medianMs(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Derives Session.stats.verification from a folded VerificationState. Returns undefined when the
 * session had neither file edits nor verification checks nor formal proof activity.
 */
export function verificationOf(s: VerificationState): VerificationStats | undefined {
  const hasProof = s.proofLangs.size > 0 || s.proofChecks > 0;
  if (!s.totalEdits && !s.checks && !hasProof) return undefined;
  const out: VerificationStats = {
    checks: s.checks,
    passed: s.passed,
    failed: s.failed,
    maxUnverifiedEdits: s.maxUnverifiedEdits,
  };
  if (s.editsSinceCheck > 0) out.unverifiedTailEdits = s.editsSinceCheck;
  const med = medianMs(s.durations);
  if (med !== undefined) out.medianCheckMs = med;
  if (hasProof) {
    const proof: ProofLoopStats = {
      langs: [...s.proofLangs].sort(),
      checks: s.proofChecks,
      passed: s.proofPassed,
      failed: s.proofFailed,
    };
    if (s.escapeAdded > 0) proof.escapeAdded = s.escapeAdded;
    if (s.escapeRemoved > 0) proof.escapeRemoved = s.escapeRemoved;
    let remaining = 0;
    for (const v of s.escapeByFile.values()) if (v > 0) remaining += v;
    if (remaining > 0) proof.escapeRemaining = remaining;
    if (s.oscillatingChecks > 0) proof.oscillatingChecks = s.oscillatingChecks;
    if (s.wholeProjectChecks > 0) proof.wholeProjectChecks = s.wholeProjectChecks;
    out.proof = proof;
  }
  return out;
}
