// Pass-to-pass (SWE-bench practice; PatchDiff, arxiv 2503.15223): run the
// repo's pre-existing test suite before and after the reference patch. Every
// test that passed before must still pass after, otherwise the reference (and
// so the verifier that accepts it) tolerates regressions.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type TestStatus = "pass" | "fail" | "skip";

/** Test name → status. A name seen several times keeps its worst status (fail > pass > skip). */
export type TestResults = Map<string, TestStatus>;

const RANK: Record<TestStatus, number> = { skip: 0, pass: 1, fail: 2 };

function put(m: TestResults, name: string, s: TestStatus): void {
  const n = name.trim();
  if (!n) return;
  const prev = m.get(n);
  if (!prev || RANK[s] > RANK[prev]) m.set(n, s);
}

const TAP_RE = /^\s*(not ok|ok)\s+\d+\b(?:\s*-)?\s*(.*?)\s*$/;
const PYTEST_V_RE = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)\b/;
const PYTEST_RA_RE = /^(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)\s+(\S+::\S+)/;
const GO_RE = /^\s*--- (PASS|FAIL|SKIP): (\S+)/;
const CARGO_RE = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/;
const SPEC_PASS_RE = /^\s*(?:✔|✓|√)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/;
const SPEC_FAIL_RE = /^\s*(?:✖|✕|×|✗)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/;

function pytestStatus(s: string): TestStatus {
  // xfail/xpass are expected-failure bookkeeping, not pass-to-pass evidence.
  return s === "PASSED" ? "pass" : s === "FAILED" || s === "ERROR" ? "fail" : "skip";
}

/**
 * Per-test outcomes from common runner outputs: TAP (node --test, prove),
 * pytest -v / -rA, go test -v, cargo test, and spec-style reporters
 * (node spec, mocha, jest --verbose, vitest).
 */
export function parseTestResults(output: string): TestResults {
  const m: TestResults = new Map();
  for (const line of output.split(/\r?\n/)) {
    let r: RegExpExecArray | null;
    if ((r = TAP_RE.exec(line))) {
      const directive = /\s#\s*(SKIP|TODO)\b/i.exec(r[2] ?? "");
      const name = (r[2] ?? "").replace(/\s#\s*(SKIP|TODO)\b.*$/i, "");
      put(m, name, directive ? "skip" : r[1] === "ok" ? "pass" : "fail");
    } else if ((r = PYTEST_V_RE.exec(line))) put(m, r[1] as string, pytestStatus(r[2] as string));
    else if ((r = PYTEST_RA_RE.exec(line))) put(m, r[2] as string, pytestStatus(r[1] as string));
    else if ((r = GO_RE.exec(line))) put(m, r[2] as string, r[1] === "PASS" ? "pass" : r[1] === "SKIP" ? "skip" : "fail");
    else if ((r = CARGO_RE.exec(line))) put(m, r[1] as string, r[2] === "ok" ? "pass" : r[2] === "ignored" ? "skip" : "fail");
    else if ((r = SPEC_PASS_RE.exec(line))) put(m, r[1] as string, "pass");
    else if ((r = SPEC_FAIL_RE.exec(line))) put(m, r[1] as string, "fail");
  }
  return m;
}

export interface SuiteRun {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface PassToPassResult {
  /** Tests that passed before the reference patch and still pass after. */
  passed: number;
  /** Tests that passed before the reference patch. */
  of: number;
  /** Tests that passed before and fail (or no longer run) after. */
  broken: string[];
  /** Of `broken`, the ones that no longer appear in the output at all. */
  missing: string[];
  /** "tests": per-test results were parsed; "exit": only the suite's exit status could be compared. */
  granularity: "tests" | "exit";
}

const suiteOk = (r: SuiteRun) => r.exitCode === 0 && !r.timedOut;

export function comparePassToPass(before: SuiteRun, after: SuiteRun): PassToPassResult {
  const b = parseTestResults(before.output);
  const passedBefore = [...b].filter(([, s]) => s === "pass").map(([n]) => n);
  if (passedBefore.length === 0) {
    // Nothing per-test to compare (unknown format, or no test passed): fall back to the exit status.
    const of = suiteOk(before) ? 1 : 0;
    const passed = of && suiteOk(after) ? 1 : 0;
    return { passed, of, broken: of && !passed ? ["(suite exit status)"] : [], missing: [], granularity: "exit" };
  }
  const a = parseTestResults(after.output);
  const broken = passedBefore.filter((n) => a.get(n) !== "pass");
  return { passed: passedBefore.length - broken.length, of: passedBefore.length, broken, missing: broken.filter((n) => !a.has(n)), granularity: "tests" };
}

async function readIf(dir: string, rel: string): Promise<string | undefined> {
  const p = join(dir, rel);
  return existsSync(p) ? readFile(p, "utf8").catch(() => undefined) : undefined;
}

/** Guess the repo's own test command from its start tree; undefined when there is no recognisable suite. */
export async function detectSuiteCommand(dir: string): Promise<string | undefined> {
  const pkg = await readIf(dir, "package.json");
  if (pkg) {
    try {
      const test = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts?.test;
      if (typeof test === "string" && test.trim() && !/no test specified/i.test(test)) {
        if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm test";
        if (existsSync(join(dir, "yarn.lock"))) return "yarn test";
        return "npm test";
      }
    } catch {
      // not JSON: ignore
    }
  }
  const pyproject = (await readIf(dir, "pyproject.toml")) ?? "";
  const setupCfg = (await readIf(dir, "setup.cfg")) ?? "";
  const tox = (await readIf(dir, "tox.ini")) ?? "";
  if (existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "conftest.py")) || pyproject.includes("[tool.pytest") || setupCfg.includes("[tool:pytest]") || tox.includes("[pytest]")) {
    return "python -m pytest -rA";
  }
  if (existsSync(join(dir, "go.mod"))) return "go test -v ./...";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  return undefined;
}
