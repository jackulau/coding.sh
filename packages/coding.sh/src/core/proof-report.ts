// Formal-verification proof review report for a single session.
// Pure over (session, events) with an optional read-only disk scanner that
// checks touched proof files statically using core/proof.ts scanners.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { createRedactor } from "./redact.ts";
import {
  checkOutcome,
  isProofConfig,
  isProofLang,
  isProofOutput,
  isProofTestPath,
  isRocqOutput,
  isSpecNamed,
  isWholeProjectCheck,
  outText,
  proofChange,
  proofCheck,
  proofEnd,
  proofLang,
  proofLog,
  proofStart,
  proofWrite,
  readProofDiff,
  scanProofEscapes,
  type HasProof,
  type ProofCheck,
  type ProofLang,
} from "./proof.ts";
import { normalizeTracePath, shellCommand, shellDiffOrigin, shellWrites } from "./shell-diff.ts";
import { isShellCall } from "./shell-tools.ts";

export type ProofVerdict = "verified" | "incomplete" | "tampered" | "no-proof";

export interface ProofEscapes {
  added: number;
  removed: number;
  remaining: number;
  kinds: string[];
}

export interface ProofChecks {
  total: number;
  passed: number;
  failed: number;
  wholeProject: number;
  lastOk: boolean | null;
  medianMs?: number;
}

export interface ProofTamperFinding {
  kind: string;
  file?: string;
  detail: string;
}

export interface ProofDiskEscape {
  file: string;
  line: number;
  token: string;
}

export interface ProofDiskCheck {
  scanned: number;
  missing: number;
  remainingEscapes: ProofDiskEscape[];
}

export interface ProofReport {
  sessionId: string;
  langs: ProofLang[];
  proofFiles: string[];
  specFilesTouched: string[];
  specUntouched: boolean;
  escapes: ProofEscapes;
  checks: ProofChecks;
  tamperFindings: ProofTamperFinding[];
  verdict: ProofVerdict;
  verifyHints: string[];
  diskCheck?: ProofDiskCheck;
}

/** Escape tokens that disable kernel or verifier checking rather than leaving a proof hole. */
const KERNEL_BYPASS_HATCHES = new Set([
  "debug.skipKernelTC",
  "Unset Guard Checking",
  "Unset Universe Checking",
  "Unset Positivity Checking",
  "bypass_check",
  "{:verify false}",
  "quick_and_dirty",
  "skip_proofs",
  "-type-in-type",
  "no-verify",
]);

/** A `spec/` or `specs/` folder holding formal-verification files. */
const PROOF_SPEC_DIR = /(?:^|\/)specs?\//i;
/** Cap on single-file disk reads during read-only static verification. */
const MAX_DISK_FILE_BYTES = 5 * 1024 * 1024;
const TIMED_OUT_TEXT = /\b(?:exec )?command timed out\b/i;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function isSpecFile(path: string): boolean {
  return isProofConfig(path) || isSpecNamed(path) || PROOF_SPEC_DIR.test(path);
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(raw);
}

function firstFileFor(proofFiles: readonly string[], lang: ProofLang): string | undefined {
  const byExt: Record<ProofLang, RegExp> = {
    lean: /\.lean$/,
    rocq: /\.v$/,
    dafny: /\.dfy$/,
    verus: /\.rs$/,
    isabelle: /\.thy$/,
    tla: /\.tla$/,
    tlc: /\.cfg$/,
  };
  return proofFiles.find((p) => byExt[lang].test(p));
}

/** Trusted-kernel copy-paste audit hints per detected formal language. */
function buildVerifyHints(langs: readonly ProofLang[], proofFiles: readonly string[], redact: (s: string) => string): string[] {
  const hints: string[] = [];
  for (const lang of langs) {
    const file = firstFileFor(proofFiles, lang);
    switch (lang) {
      case "lean": {
        const target = file ?? "<File.lean>";
        hints.push(redact(`lake env lean ${target}  # check single file; add '#print axioms <theorem>' to audit trusted axioms`));
        break;
      }
      case "rocq": {
        const target = file ?? "<File.v>";
        hints.push(redact(`coqc ${target}  # check file; run 'Print Assumptions <theorem>.' to audit axioms`));
        break;
      }
      case "dafny": {
        const target = file ?? "<File.dfy>";
        hints.push(redact(`dafny verify ${target}  # verify file without --no-verify`));
        break;
      }
      case "verus": {
        const target = file ?? "<file.rs>";
        hints.push(redact(`verus ${target}  # verify file and audit for external_body or assume()`));
        break;
      }
      case "isabelle":
        hints.push("isabelle build -o quick_and_dirty=false -D .  # build session without quick_and_dirty");
        break;
      case "tla": {
        const target = file ?? "<Spec.tla>";
        hints.push(redact(`tlapm ${target}  # verify TLA+ proof obligations`));
        break;
      }
      case "tlc": {
        const cfg = file ?? "<Model.cfg>";
        const tla = firstFileFor(proofFiles, "tla") ?? "<Spec.tla>";
        hints.push(redact(`java -cp tla2tools.jar tlc2.TLC -config ${cfg} ${tla}  # run TLC with deadlock checking`));
        break;
      }
    }
  }
  return hints;
}

/**
 * Summarize a session's formal-verification integrity from its recorded events.
 * Pure: performs no disk or process I/O.
 */
export function buildProofReport(session: Pick<Session, "id" | "cwd" | "repo">, events: readonly AgentEvent[]): ProofReport {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0) || a.i - b.i).map((x) => x.e);
  const redactor = createRedactor();
  const redact = (s: string) => redactor.string(s);

  const proof: HasProof = {};
  const log = proofLog();
  const starts = new Map<string, AgentEvent>();
  const activeChecks = new Map<string, { check: ProofCheck; cmd: string; startTs: number }>();
  const seenBuildChecks = new Set<string>();

  const langs = new Set<ProofLang>();
  const proofFiles = new Set<string>();
  const specFiles = new Set<string>();
  const bypassCalls: { flag: string; lang: string }[] = [];
  const durations: number[] = [];

  let escapesAdded = 0;
  let escapesRemoved = 0;
  let checksTotal = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  let checksWholeProject = 0;
  let lastOk: boolean | null = null;

  const baseCwd = session.repo?.root ?? session.cwd;

  for (const e of sorted) {
    const p = e.payload ?? {};
    const cwd = baseCwd ?? e.cwd;
    if (e.kind === "tool.start") {
      const id = str(p.toolUseId);
      if (id) starts.set(id, e);
      const tool = str(p.tool);
      const cmd = shellCommand(tool, p.input);
      if (cmd === undefined) continue;
      if (isShellCall(tool ?? "", p.input)) {
        proofStart(proof, id, cmd, p.input);
        const check = proofCheck(cmd, p.input);
        if (check) {
          if (isProofLang(check.lang)) langs.add(check.lang);
          if (id) activeChecks.set(id, { check, cmd, startTs: e.ts });
        }
      }
      for (const w of shellWrites(cmd)) {
        const path = normalizeTracePath(w.path, cwd);
        const renamedTo = w.renamedTo === undefined ? undefined : normalizeTracePath(w.renamedTo, cwd);
        proofWrite(proof, e, w, path, renamedTo, id, false, log.note);
        const known = proof.proof?.files?.get(path)?.lang;
        const lang = isProofConfig(path) ? undefined : proofLang(path, "", known);
        if (lang) {
          langs.add(lang);
          proofFiles.add(path);
          if (isSpecFile(path)) specFiles.add(path);
        } else if (isProofConfig(path)) {
          specFiles.add(path);
        }
      }
    } else if (e.kind === "file.change") {
      const raw = str(p.path);
      if (!raw) continue;
      const path = normalizeTracePath(raw, cwd);
      const id = str(p.toolUseId);
      const start = id ? starts.get(id) : undefined;
      const origin = shellDiffOrigin(e, start, cwd);
      const moved = str(p.movedTo);
      const to = moved ? normalizeTracePath(moved, cwd) : undefined;
      const diff = str(p.diff) ?? "";
      const truncated = p.diffTruncated === true;
      const priorLang = proof.proof?.files?.get(path)?.lang;

      proofChange(proof, e, { path, to, origin, prot: isSpecFile(path), test: false }, log.note);

      const finalPath = to ?? path;
      const recordedLang = proof.proof?.files?.get(finalPath)?.lang ?? priorLang;
      const isConfig = isProofConfig(finalPath);
      const lang = isConfig ? undefined : proofLang(finalPath, diff, recordedLang);
      // Respect Rocq/TLC disambiguation: if proof.ts did not recognize a `.v` or `.cfg` file, skip it.
      const rocqOrTlcConfirmed =
        lang !== "rocq" && lang !== "tlc"
          ? true
          : proof.proof?.files?.has(finalPath) || (lang === "rocq" && proof.proof?.rocq === true) || (lang === "tlc" && proof.proof?.tlc === true);

      if (lang && rocqOrTlcConfirmed) {
        langs.add(lang);
        proofFiles.add(finalPath);
        if (isSpecFile(finalPath)) specFiles.add(finalPath);
        if (!isProofTestPath(finalPath) && diff) {
          const parsed = readProofDiff(finalPath, lang, diff, truncated);
          for (const [name, delta] of parsed.hatches) {
            if (KERNEL_BYPASS_HATCHES.has(name)) continue;
            if (delta > 0) escapesAdded += delta;
            else if (delta < 0) escapesRemoved += -delta;
          }
        }
      } else if (isConfig) {
        specFiles.add(finalPath);
      }
    } else if (e.kind === "tool.end") {
      proofEnd(proof, e, log.note);
      const id = str(p.toolUseId);
      const active = id ? activeChecks.get(id) : undefined;
      if (!active) continue;
      activeChecks.delete(id!);

      const { check, cmd, startTs } = active;
      const text = outText(p.output);
      if (isRocqOutput(text)) langs.add("rocq");
      if (check.lang === "make" || check.lang === "dune") {
        const key = `${check.lang}\u0000${check.target ?? ""}\u0000${check.path ?? ""}`;
        if (!seenBuildChecks.has(key) && !isProofOutput(text)) continue;
        seenBuildChecks.add(key);
      }

      const outcome = checkOutcome(check, p);
      const timedOut = p.timedOut === true || (p.ok === false && TIMED_OUT_TEXT.test(text));
      if (outcome === undefined && !timedOut) continue;

      checksTotal++;
      if (isWholeProjectCheck(check, cmd)) checksWholeProject++;

      if (typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
        durations.push(e.durationMs);
      } else if (e.ts > startTs) {
        durations.push(e.ts - startTs);
      }

      if (check.bypass) {
        bypassCalls.push({ flag: check.bypass, lang: check.lang });
        if (outcome === "red" || timedOut) {
          checksFailed++;
          lastOk = false;
        }
      } else if (outcome === "green") {
        checksPassed++;
        lastOk = true;
      } else {
        checksFailed++;
        lastOk = false;
      }
    }
  }

  let escapesRemaining = 0;
  const remainingKinds = new Set<string>();
  for (const [path, file] of proof.proof?.files ?? []) {
    if (isProofConfig(path)) continue;
    for (const [name, count] of file.sites ?? []) {
      if (count > 0 && !KERNEL_BYPASS_HATCHES.has(name)) {
        escapesRemaining += count;
        remainingKinds.add(name);
      }
    }
  }

  const tamperFindings: ProofTamperFinding[] = [];
  const seenBypass = new Set<string>();

  for (const f of log.findings(proof.proof)) {
    if (f.kind === "statement") {
      if (f.path) specFiles.add(f.path);
      const verb = f.shape === "weaken" ? "weakened" : f.shape === "delete" ? "deleted" : "changed";
      const target = f.theorem ? `statement ${f.theorem}` : "statement";
      const flip = f.flippedGreen ? " (turned failing check green)" : "";
      const item: ProofTamperFinding = { kind: "statement", detail: redact(`${target} ${verb}${flip}`) };
      if (f.path) item.file = redact(f.path);
      tamperFindings.push(item);
    } else if (f.kind === "spec") {
      if (f.path) specFiles.add(f.path);
      const label = isProofConfig(f.path) ? "proof config" : "spec";
      const verb = f.shape === "weaken" ? "weakened" : f.shape === "delete" ? "deleted" : "changed";
      const flip = f.flippedGreen ? " (turned failing check green)" : "";
      const item: ProofTamperFinding = { kind: "spec", detail: redact(`${label} ${verb}${flip}`) };
      if (f.path) item.file = redact(f.path);
      tamperFindings.push(item);
    } else if (f.kind === "escape") {
      if (f.path === "") {
        const flag = f.hatch ?? "bypass";
        seenBypass.add(flag);
        tamperFindings.push({ kind: "bypass", detail: redact(`checker bypass flag ${flag} passed after failure`) });
      } else if (isProofConfig(f.path) || (f.hatch !== undefined && KERNEL_BYPASS_HATCHES.has(f.hatch))) {
        if (isProofConfig(f.path)) specFiles.add(f.path);
        const item: ProofTamperFinding = { kind: "bypass", detail: redact(`verification bypass ${f.hatch ?? "unknown"} added`) };
        if (f.path) item.file = redact(f.path);
        tamperFindings.push(item);
      }
    }
  }

  for (const b of bypassCalls) {
    if (seenBypass.has(b.flag)) continue;
    seenBypass.add(b.flag);
    tamperFindings.push({ kind: "bypass", detail: redact(`checker bypass flag ${b.flag} used (${b.lang})`) });
  }

  const sortedLangs = [...langs].sort();
  const sortedProofFiles = [...proofFiles].map(redact).sort();
  const sortedSpecFiles = [...specFiles].map(redact).sort();

  const checks: ProofChecks = {
    total: checksTotal,
    passed: checksPassed,
    failed: checksFailed,
    wholeProject: checksWholeProject,
    lastOk,
  };
  const med = median(durations);
  if (med !== undefined) checks.medianMs = med;

  const escapes: ProofEscapes = {
    added: escapesAdded,
    removed: escapesRemoved,
    remaining: escapesRemaining,
    kinds: [...remainingKinds].sort(),
  };

  const hasProofActivity = sortedProofFiles.length > 0 || sortedSpecFiles.length > 0 || checks.total > 0 || sortedLangs.length > 0;
  let verdict: ProofVerdict;
  if (!hasProofActivity) {
    verdict = "no-proof";
  } else if (tamperFindings.length > 0) {
    verdict = "tampered";
  } else if (escapes.remaining > 0 || checks.passed === 0 || checks.lastOk !== true || sortedProofFiles.length === 0) {
    verdict = "incomplete";
  } else {
    verdict = "verified";
  }

  return {
    sessionId: session.id,
    langs: sortedLangs,
    proofFiles: sortedProofFiles,
    specFilesTouched: sortedSpecFiles,
    specUntouched: sortedSpecFiles.length === 0,
    escapes,
    checks,
    tamperFindings,
    verdict,
    verifyHints: buildVerifyHints(sortedLangs, sortedProofFiles, redact),
  };
}

/**
 * Statically scan touched proof files on disk for remaining escape hatches.
 * Read-only: reads files under `repoRoot` and executes no external commands.
 */
export function verifyProofFilesOnDisk(repoRoot: string, proofFiles: readonly string[]): ProofDiskCheck {
  const redactor = createRedactor();
  const rootAbs = resolve(repoRoot);
  if (!existsSync(rootAbs)) {
    return { scanned: 0, missing: proofFiles.length, remainingEscapes: [] };
  }
  let scanned = 0;
  let missing = 0;
  const remainingEscapes: ProofDiskEscape[] = [];

  for (const file of proofFiles) {
    const abs = resolve(rootAbs, file);
    const rel = relative(rootAbs, abs);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) {
      missing++;
      continue;
    }
    let text: string;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_DISK_FILE_BYTES) {
        missing++;
        continue;
      }
      text = readFileSync(abs, "utf8");
    } catch {
      missing++;
      continue;
    }
    scanned++;
    const isConfig = isProofConfig(file);
    const lang = isConfig ? undefined : proofLang(file, text);
    if (!lang && !isConfig) continue;
    for (const hit of scanProofEscapes(file, lang, text)) {
      remainingEscapes.push({ file: redactor.string(file), line: hit.line, token: hit.token });
    }
  }

  return { scanned, missing, remainingEscapes };
}

/** Attach a read-only disk scan result to a report, downgrading `verified` to `incomplete` if escapes remain on disk. */
export function attachDiskCheck(report: ProofReport, repoRoot: string | undefined): ProofReport {
  const diskCheck = repoRoot ? verifyProofFilesOnDisk(repoRoot, report.proofFiles) : { scanned: 0, missing: report.proofFiles.length, remainingEscapes: [] };
  const verdict: ProofVerdict = report.verdict === "verified" && diskCheck.remainingEscapes.length > 0 ? "incomplete" : report.verdict;
  return { ...report, verdict, diskCheck };
}
