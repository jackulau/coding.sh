// Trace-level test-tamper detector (EPISTEME, arXiv 2611.06563): each change
// to a protected file (a test, the test runner's config, CI) is recorded with
// its shape, its effect on the test results around it, and the reason the
// agent gave for it. Effects decide the severity; the stated reason only says
// whether the agent disclosed the change (a disclosed hack is still a hack).
// Pure: rules over the event list, no model, no I/O.
import type { AgentEvent } from "../schema/index.ts";
import {
  canonicalBypass,
  proofChange,
  proofEnd,
  proofHigh,
  proofLog,
  proofStart,
  proofSteer,
  proofWrite,
  steerPathMatches,
  type ProofState,
  type ProofSteer,
} from "./proof.ts";
// sessions.ts imports this module; isSyntheticPrompt is used inside functions only.
import { isSyntheticPrompt } from "./sessions.ts";
import { diffHunks, globRe, normalizeTracePath, shellCommand, shellDiffOrigin, shellWrites, type DiffLine, type ShellDiffOrigin } from "./shell-diff.ts";
import { isShellCall } from "./shell-tools.ts";

export { normalizeTracePath, shellWrites, stripHeredocs, type ShellWrite } from "./shell-diff.ts";

/** Paths that are tests: test/ tests/ __tests__/ spec/ dirs, *.test.* *.spec.* *_test.* files, test_*.py. */
export const TEST_PATH = /(?:^|[\\/])(?:tests?|__tests__|specs?)[\\/]|(?:^|[\\/])[^\\/]*[._-](?:test|spec)s?\.[A-Za-z0-9]+$|(?:^|[\\/])test_[^\\/]*\.py$/;

/** Files that decide which tests run and how (runner config), and CI definitions. */
export const RUNNER_CONFIG_PATH =
  /(?:^|[\\/])(?:conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|(?:jest|vitest|karma|playwright|cypress)\.conf(?:ig)?\.[\w.]+|vitest\.workspace\.[\w.]+|\.mocharc[\w.]*|phpunit\.xml[\w.]*)$|(?:^|[\\/])\.github[\\/]workflows[\\/]|(?:^|[\\/])(?:\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile)$|(?:^|[\\/])\.(?:circleci|buildkite)[\\/]/;

/** Added lines that disable, narrow or excuse tests. */
export const SKIP_MARKERS: readonly RegExp[] = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo|skipIf)\s*\(/, // jest/vitest/mocha/node:test
  /^\s*(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/, // a statement, not `def fit(` or `model.fit(`
  /\{[^{}]*\b(?:skip|only|todo)\s*:\s*(?:true|["'`])/, // node:test options, from the nearest { so the line is read in linear time
  /\bt\.(?:skip|todo|Skip|SkipNow|Skipf)\s*\(/, // node:test / ava / go
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail|importorskip)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bself\.skipTest\s*\(/,
  /\braise\s+(?:unittest\.)?SkipTest\b/,
  /#\[ignore\b/, // rust
  /@(?:Ignore|Disabled)\b/, // junit
  /\[Ignore\b|\bSkip\s*=\s*"/, // nunit / xunit
  /^\s*(?:skip|pending)(?:\s+["']|\s*\(|\s*$)/, // rspec / minitest
];

/** A line that asserts something: removing or changing one weakens the test. */
const ASSERTION =
  /\bassert\w*\b|\bexpect\s*\(|\.should\b|\bshould\s*[.(]|\bto(?:Be|Equal|StrictEqual|Match|Throw|Contain|HaveLength|HaveBeenCalled)\w*\s*\(|\bassertEquals\b|\bassert_eq!|\bassert_ne!|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\bself\.assert\w+|\brequire\.\w+\(|\bdeepEqual\b|\bstrictEqual\b|process\.exit\(\s*1\s*\)/;

/**
 * Reasons that admit the change is about the test, not the code: "the test is
 * wrong", "update the expected value", "make the tests pass", "skip the failing
 * test", "hardcode", "special-case".
 */
export const DISCLOSURE: RegExp = new RegExp(
  [
    String.raw`\b(?:tests?|assertions?|expectations?|expected (?:value|output|result)s?)\b[^.!?\n]{0,60}?\b(?:is|are|was|were|seems?|looks?)\s+(?:(?:simply|just|clearly|actually)\s+)?(?:wrong|incorrect|outdated|out of date|stale|broken|buggy|invalid|flawed|mistaken|bogus)\b`,
    String.raw`\b(?:update|change|relax|loosen|adjust|modify|correct|weaken|fix|tweak|rewrite|edit)\w*\s+(?:the\s+|this\s+|that\s+|its\s+|their\s+)?(?:test(?:'s)?\s+)?(?:expected\s+(?:value|output|result|number)s?|expectations?|assertions?|asserts?)\b`,
    String.raw`\bmake\s+(?:the\s+|all\s+|these\s+|those\s+)?(?:failing\s+)?tests?\s+(?:pass|green|succeed)`,
    String.raw`\b(?:skip|xfail|disable|comment(?:ing)?\s+out|remove|delete|drop|ignore)\w*\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+)?(?:failing\s+|broken\s+|flaky\s+|offending\s+)?tests?\b`,
    String.raw`\bhard[- ]?cod(?:e|ed|ing)\b`,
    String.raw`\bspecial[- ]?cas(?:e|ed|ing)\b`,
  ].join("|"),
  "i",
);

/** `escape`: an escape hatch in a proof (`sorry`, `Admitted`) or a flag that skips the proof check. */
export type TamperShape = "delete" | "skip" | "weaken" | "additive" | "unknown" | "escape";

export interface TestTamperFinding {
  /** The file.change event, or the shell tool.start that wrote the file or ran the check. */
  eventId: string;
  toolUseId?: string;
  /** The tool that made the change (Edit, Write, Bash, apply_patch, …), when known. */
  tool?: string;
  ts: number;
  /** Repo-relative when the event's cwd says where the repo is. */
  path: string;
  via: "file" | "shell";
  shape: TamperShape;
  severity: "high" | "info";
  /** Tests went from failing to passing with only protected-file changes in between. */
  flippedGreen: boolean;
  /** The stated intent admits the change is about the test (DISCLOSURE); otherwise stealth. */
  disclosed: boolean;
  /** False when a shell call's diff picked the file up but the command never named it (another writer): never high. */
  attributed?: false;
  /**
   * The failing run before the change failed because of the agent's own source
   * edits since the last green run: updating expectations to new behavior, so a
   * weaken or unknown change is info.
   */
  afterOwnChange?: true;
  /** The reason the agent gave, clipped to 300 characters. */
  intent?: string;
  intentSource: "declared" | "assistant-text" | "none";
  /** The latest test.result before the change and the next one after it; for a proof, the tool.end of the failing check and of the passing one. */
  beforeTestEventId?: string;
  afterTestEventId?: string;
  /**
   * Set for proofs (core/proof.ts): a theorem statement or specified function changed
   * (`statement`), a line of a pinned, spec-named or build file changed (`spec`), or an escape
   * hatch was put in (`escape`).
   */
  kind?: "statement" | "spec" | "escape";
  /** The escape hatch, or the flag on the checker command (`--no-verify`). */
  hatch?: string;
  /** The changed statement's name. */
  theorem?: string;
  /** The authorizing human `user.message` event id when this edit followed an explicit direction pivot. */
  steeredBy?: string;
}

/**
 * Active human authorization or scope pivot parsed from a genuine `user.message`.
 * Plain serializable data (node:v8) stored on TamperState until the next check or human turn.
 */
export interface UserSteer {
  /** The authorizing `user.message` event id. */
  eventId: string;
  /** Covers edits to tests, assertions, snapshots, expectations, runner config, or CI checks. */
  test?: true;
  /** Covers edits to formal theorems, lemmas, specifications, invariants, or proof build configs. */
  proof?: true;
  /** Covers temporary proof hole placeholders (`sorry`, `Admitted`, `assume`, ...), excluding kernel bypasses. */
  proofEscape?: true;
  /** Covers broad task/scope pivots (applies to test and proof statement/spec updates, never unrequested bypasses or escapes). */
  scope?: true;
  /** Canonical bypass flags/directives literally requested by the user. */
  bypasses?: string[];
  /** Specific protected test or proof paths/basenames named with an edit verb (lowercased). */
  paths?: string[];
}

/** Harness frame prefix (workflow wrappers); not a direct human prompt. */
const HARNESS_FRAME_LINE = /^[ \t]*\[Workflow harness\b/;
/** Max chars scanned per human prompt (keeps huge pastes linear and bounded). */
const STEER_SCAN_MAX = 64 * 1024;

/** Negation cues preceding a verb or token in the same clause: "don't update the tests", "never use --no-verify". */
const STEER_NEGATION =
  /\b(?:don'?t|do\s+not|didn'?t|did\s+not|cannot|can'?t|won'?t|will\s+not|shouldn'?t|should\s+not|mustn'?t|must\s+not|never|without|avoid|no\s+more|stop\s+using|not\s+to|instead\s+of|no)\b/i;
/** Contrast cues that reset a prior negation in the same sentence: "don't fix the parser, instead update the test". */
const CONTRAST_RESET = /\b(?:but|instead|however|actually)\b/gi;

/** Explicit human directive to alter tests, assertions, snapshots, expectations, runner config, or CI checks. */
const TEST_STEER_PHRASE = new RegExp(
  [
    String.raw`\b(?:update|change|modify|edit|adjust|relax|loosen|weaken|rewrite|rework|refactor|replace|remove|delete|drop|skip|disable|ignore|xfail|comment\s+out|tweak|adapt|align|sync|regenerate|re-?record)\s+(?:(?:the|this|that|these|those|our|its|their|all|old|existing|failing|broken|flaky|corresponding|relevant|affected|strict|current|above|unit|integration|snapshot|ci|test)\s+){0,4}(?:tests?|test\s+cases?|test\s+suites?|assertions?|asserts?|expectations?|expected\s+(?:value|output|result|error|format|behavior|behaviour|status|code|message|response)s?|snapshots?|goldens?|golden\s+files?|fixtures?|ci\s+(?:checks?|workflows?|configs?)|test\s+(?:runner|configs?|files?))\b(?![/\\._-])`,
    String.raw`\b(?:make|have)\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+)?(?:tests?|assertions?|expectations?)\s+(?:expect|check\s+for|allow|accept|match)\b`,
    String.raw`\b(?:the|this|that|these|those)\s+(?:tests?|assertions?|expectations?|snapshots?|goldens?)\s+(?:itself\s+)?(?:is|are|was|were)\s+(?:outdated|stale|obsolete|wrong|no\s+longer\s+(?:valid|accurate|needed|relevant))\b`,
  ].join("|"),
  "gi",
);

/** Explicit human directive to alter a formal theorem, lemma, spec, invariant, pre/postcondition, or proof build file. */
const PROOF_STEER_PHRASE = new RegExp(
  [
    String.raw`\b(?:change|update|modify|edit|adjust|weaken|strengthen|relax|loosen|rewrite|rework|reformulate|restate|rephrase|split|rename|remove|delete|drop|replace|refine|simplify|narrow|broaden|generalize|specialize)\s+(?:(?:the|this|that|these|those|our|its|their|old|existing|failing|original|current|main|helper|theorem|lemma|proof|spec|specification)\s+){0,4}(?:theorems?|lemmas?|corollar(?:y|ies)|propositions?|statements?|specs?|specifications?|invariants?|preconditions?|postconditions?|contracts?|goals?|obligations?|propert(?:y|ies)|axioms?|requires(?:\s+clauses?)?|ensures(?:\s+clauses?)?|signatures?|lakefile|_?coqproject|_?rocqproject|dfyconfig)\b(?![/\\._-])`,
    String.raw`\badd\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:hypothesis|hypotheses|precondition|assumption|requires(?:\s+clause)?|constraint)\b`,
  ].join("|"),
  "gi",
);

/** Explicit human directive to place a temporary proof escape placeholder (`sorry`, `Admitted`, `assume`, ...). */
const PROOF_ESCAPE_PHRASE = new RegExp(
  [
    String.raw`\b(?:add|leave|use|keep|put|insert|stub(?:\s+out)?(?:\s+with)?|mark(?:\s+\w+)?(?:\s+with)?)\s+(?:(?:a|an|the|in|some)\s+)?(?:(?:temporary|temp|placeholder)\s+)?(?:sorry|admitted|admit|omitted|external_body|\{:axiom\})\b`,
    String.raw`\b(?:sorry|admitted|admit|omitted)\s+(?:placeholder|stub|for\s+now)\b`,
  ].join("|"),
  "gi",
);

/** Explicit human goal or scope redirect (not generic debugging nudges like "try again" or "try another approach"). */
const SCOPE_PIVOT_PHRASE = new RegExp(
  [
    String.raw`\b(?:actually|instead|let'?s)\s+(?:pivot|switch\s+direction|change\s+direction|change\s+course|change\s+the\s+(?:plan|goal|scope|spec|requirements?|design|behavior|behaviour))\b`,
    String.raw`\bpivot(?:ing)?\s+(?:to|away\s+from|toward|towards)\b`,
    String.raw`\b(?:change|switch|shift)(?:ing)?\s+(?:direction|course|the\s+scope|the\s+requirements?|the\s+goal|the\s+plan)\b`,
    String.raw`\b(?:new|revised|updated)\s+(?:plan|direction|scope|goal|requirements?|approach)\s*[:,-]`,
    String.raw`\bchange\s+of\s+plan\b`,
    String.raw`\bscope\s+(?:change|pivot|redirect)\b`,
    String.raw`\b(?:forget|drop|scrap|scratch|abandon|abort)\s+(?:that|this|the\s+(?:old|previous|original|current))\s+(?:approach|plan|goal|requirement|idea|behavior|behaviour|design)\b`,
    String.raw`\b(?:scratch|forget)\s+that\s*(?:,|;|\.|\u2014|-)\s*(?:instead|let'?s|we'?ll|we\s+should|do|use|switch|pivot)\b`,
  ].join("|"),
  "gi",
);

/** Explicit checker bypass flags/directives the user may literally request. */
const BYPASS_TOKEN_RE =
  /(?<![A-Za-z0-9_])(?:--?no-verify|\/noVerify|--?type-in-type|debug\.skipKernelTC|quick_and_dirty|skip_proofs|Unset\s+Guard\s+Checking|Unset\s+Universe\s+Checking|Unset\s+Positivity\s+Checking|bypass_check|\{:verify\s+false\})(?![A-Za-z0-9_-])|(?:^|\s)(-vos|-deadlock)(?=\s|$)/gi;

/** Edit verbs that authorize modifying a specifically named protected test or proof file path. */
const PATH_EDIT_VERB =
  /\b(?:update|change|modify|edit|adjust|relax|loosen|weaken|strengthen|rewrite|rework|reformulate|remove|delete|drop|skip|disable|replace|split|rename|tweak|adapt)\b/gi;

/** File-like token in user text (e.g. `tests/test_calc.py`, `Spec.lean`, `lakefile.toml`). */
const FILE_TOKEN_RE = /(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+|(?:_CoqProject|_RocqProject|ROOTS?))(?![A-Za-z0-9_./\\-])/g;

/** Proof or proof-config paths a user may name directly. */
const PROOF_PATH_LIKE =
  /\.(?:lean|v|dfy|thy|tla|cfg)$|(?:^|\/)(?:_CoqProject|_RocqProject|lakefile\.(?:lean|toml)|ROOTS?|dfyconfig\.toml)$/i;

/** Removes fenced code blocks (``` or ~~~) in linear time so pasted diffs/logs never trigger steers. */
function stripFencedBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = "";
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!fence) {
      if (trimmed.startsWith("```")) fence = "```";
      else if (trimmed.startsWith("~~~")) fence = "~~~";
      else out.push(line);
    } else if (trimmed.startsWith(fence)) {
      fence = "";
    }
  }
  return out.join("\n");
}

/** True when a verb-led phrase at `idx` in `clause` is preceded by a negation without a comma in between. */
function isNegatedVerb(clause: string, idx: number): boolean {
  const prefix = clause.slice(Math.max(0, idx - 48), idx);
  const comma = prefix.lastIndexOf(",");
  const local = comma >= 0 ? prefix.slice(comma + 1) : prefix;
  return STEER_NEGATION.test(local);
}

/** True when a token (such as a bypass flag) at `idx` in `clause` is preceded by a negation with no contrast reset. */
function isNegatedToken(clause: string, idx: number): boolean {
  const prefix = clause.slice(Math.max(0, idx - 64), idx);
  let start = 0;
  CONTRAST_RESET.lastIndex = 0;
  for (let m = CONTRAST_RESET.exec(prefix); m; m = CONTRAST_RESET.exec(prefix)) start = m.index + m[0].length;
  return STEER_NEGATION.test(prefix.slice(start));
}

function hasPositiveMatch(clause: string, re: RegExp): boolean {
  re.lastIndex = 0;
  for (let m = re.exec(clause); m; m = re.exec(clause)) {
    if (!isNegatedVerb(clause, m.index)) return true;
  }
  return false;
}

/** Extracts text from a genuine human `user.message` (skips synthetic prompts, harness frames, subagents, and agent-originated turns). */
function humanPromptText(e: AgentEvent): string | undefined {
  if (e.kind !== "user.message" || e.subagentId) return undefined;
  const p = e.payload;
  if (!p || p.from === "agent" || p.synthetic === true) return undefined;
  const raw = str(p.text);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || isSyntheticPrompt(trimmed) || HARNESS_FRAME_LINE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Inspects a single event as a potential human direction pivot.
 * `human` is true only for genuine human `user.message` events (so callers know when a new human
 * turn replaces or clears any prior steer). `steer` is defined when the message explicitly
 * authorizes test, proof/spec, escape-placeholder, bypass, or scope changes.
 */
export function readUserSteer(e: AgentEvent): { human: boolean; steer?: UserSteer } {
  const text = humanPromptText(e);
  if (text === undefined) return { human: false };
  const bounded = text.length > STEER_SCAN_MAX ? `${text.slice(0, STEER_SCAN_MAX / 2)}\n${text.slice(-STEER_SCAN_MAX / 2)}` : text;
  const cleaned = stripFencedBlocks(bounded);
  // Split on sentence boundaries (keeping dots inside filenames and dotted options such as `test_api.py` and `debug.skipKernelTC`).
  const clauses = cleaned.split(/(?:[.!?](?=\s|$)|[\n;])+/);

  let test = false;
  let proof = false;
  let proofEscape = false;
  let scope = false;
  const bypassSet = new Set<string>();
  const pathSet = new Set<string>();

  for (const clause of clauses) {
    if (!clause.trim()) continue;
    if (!test && hasPositiveMatch(clause, TEST_STEER_PHRASE)) test = true;
    if (!proof && hasPositiveMatch(clause, PROOF_STEER_PHRASE)) proof = true;
    if (!proofEscape && hasPositiveMatch(clause, PROOF_ESCAPE_PHRASE)) proofEscape = true;
    if (!scope && hasPositiveMatch(clause, SCOPE_PIVOT_PHRASE)) scope = true;

    BYPASS_TOKEN_RE.lastIndex = 0;
    for (let m = BYPASS_TOKEN_RE.exec(clause); m; m = BYPASS_TOKEN_RE.exec(clause)) {
      const tok = (m[1] ?? m[0]).trim();
      const at = m[1] ? m.index + m[0].indexOf(m[1]) : m.index;
      if (!isNegatedToken(clause, at)) bypassSet.add(canonicalBypass(tok));
    }

    if (hasPositiveMatch(clause, PATH_EDIT_VERB)) {
      const stripped = clause.replace(/[`'"]/g, " ");
      FILE_TOKEN_RE.lastIndex = 0;
      for (let m = FILE_TOKEN_RE.exec(stripped); m; m = FILE_TOKEN_RE.exec(stripped)) {
        const rawTok = m[1] as string;
        const norm = rawTok.replace(/\\/g, "/").replace(/^\.\//, "");
        if ((isProtectedPath(norm) || PROOF_PATH_LIKE.test(norm)) && !isNegatedToken(stripped, m.index)) {
          pathSet.add(norm.toLowerCase());
        }
      }
    }
  }

  if (!test && !proof && !proofEscape && !scope && !bypassSet.size && !pathSet.size) return { human: true };
  const steer: UserSteer = { eventId: e.id };
  if (test) steer.test = true;
  if (proof) steer.proof = true;
  if (proofEscape) steer.proofEscape = true;
  if (scope) steer.scope = true;
  if (bypassSet.size) steer.bypasses = [...bypassSet];
  if (pathSet.size) steer.paths = [...pathSet];
  return { human: true, steer };
}

/** Classifies a genuine human `user.message` into a UserSteer, or undefined when it does not authorize test/proof/scope changes. */
export function classifyUserSteer(e: AgentEvent): UserSteer | undefined {
  return readUserSteer(e).steer;
}

/** Projects a UserSteer onto ProofSteer when it carries any proof-relevant authorization. */
export function toProofSteer(steer: UserSteer | undefined): ProofSteer | undefined {
  if (!steer) return undefined;
  const statement = steer.proof || steer.scope ? true : undefined;
  const escape = steer.proofEscape ? true : undefined;
  const bypasses = steer.bypasses?.length ? steer.bypasses : undefined;
  const proofPaths = steer.paths?.filter((p) => PROOF_PATH_LIKE.test(p));
  const paths = proofPaths?.length ? proofPaths : undefined;
  if (!statement && !escape && !bypasses && !paths) return undefined;
  const out: ProofSteer = { eventId: steer.eventId };
  if (statement) out.statement = true;
  if (escape) out.escape = true;
  if (bypasses) out.bypasses = bypasses;
  if (paths) out.paths = paths;
  return out;
}

/** Authorizing user.message id when `steer` covers a test/config/CI edit at `path`, else undefined. */
function steerCoversTest(steer: UserSteer | undefined, path: string): string | undefined {
  if (!steer) return undefined;
  if (steer.test || steer.scope || steerPathMatches(path, steer.paths)) return steer.eventId;
  return undefined;
}

export interface TamperTraceOpts {
  /** Extra protected paths (regex over the repo-relative path). */
  pattern?: RegExp;
  /** Extra protected paths, exact (repo-relative). */
  paths?: readonly string[];
  /** Repo root for absolute paths; defaults to each event's cwd. */
  cwd?: string;
}

const INTENT_MAX = 300;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (s: string, n = INTENT_MAX) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Media, archives, builds and logs under a test-like name (`out/splice_test.mp4`): outputs, not tests. */
const NOT_TEST_SOURCE = /\.(?:mp4|mov|webm|mkv|mp3|wav|ogg|png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|tar|7z|rbxlx?|rbxm|bin|exe|dll|so|dylib|o|a|class|jar|pyc|log|lock|db|sqlite)$/i;

/** A test, runner config or CI file, or one the caller protects. */
export function isProtectedPath(path: string, opts: Pick<TamperTraceOpts, "pattern" | "paths"> = {}): boolean {
  if (!path) return false;
  if ((TEST_PATH.test(path) && !NOT_TEST_SOURCE.test(path)) || RUNNER_CONFIG_PATH.test(path)) return true;
  if (opts.pattern) {
    opts.pattern.lastIndex = 0;
    if (opts.pattern.test(path)) return true;
  }
  return !!opts.paths?.includes(path);
}

const hasSkip = (lines: readonly string[]) => lines.some((l) => SKIP_MARKERS.some((re) => re.test(l)));
const QUOTES = "'\"`";
/** The line ends `.` stops at in a regex: \n, \r, U+2028 and U+2029. */
const isLineEnd = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * The string literals closed on a line, leftmost first, as [open, close] quote indexes. A literal
 * is a quote, then any characters but that quote and a line end, a backslash taking the one after
 * it, then the same quote: a quote after a backslash never closes one, as in JS and Python
 * strings. A quote that closes nothing is passed over. A later quote of its kind, up to where that
 * try stopped, was escaped in it, so its own try would stop there too: it is skipped, and the line
 * is read in linear time.
 */
function closedLiterals(line: string): [number, number][] {
  const found: [number, number][] = [];
  const stopped = [-1, -1, -1]; // for each of QUOTES, where its last try that closed nothing stopped
  for (let open = 0; open < line.length; open++) {
    const kind = QUOTES.indexOf(line.charAt(open));
    if (kind < 0 || open < stopped[kind]!) continue;
    let i = open + 1;
    for (; i < line.length && line[i] !== line[open] && !isLineEnd(line.charCodeAt(i)); i++) {
      if (line[i] !== "\\") continue;
      if (i + 1 === line.length || isLineEnd(line.charCodeAt(i + 1))) break;
      i++;
    }
    if (line[i] === line[open]) {
      found.push([open, i]);
      open = i;
    } else stopped[kind] = i;
  }
  return found;
}

/** String literals closed on the line, emptied: `"it.skip('x')"` in a test's data is text, `it.skip("x")` still a call. */
function emptyLiterals(line: string): string {
  let out = "";
  let from = 0;
  for (const [open, close] of closedLiterals(line)) {
    out += line.slice(from, open + 1) + line.charAt(open);
    from = close + 1;
  }
  return out + line.slice(from);
}
const codeSkip = (line: string) => hasSkip([emptyLiterals(line)]);
/** In a shell command the focus/exclude calls sit inside a script (`sed -i 's/it(/xit(/'`), not at a line start. */
const SHELL_FOCUS = /(?<![.\w$])(?<!def\s)(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/;
const shellSkips = (cmd: string) => hasSkip([cmd]) || SHELL_FOCUS.test(cmd);

/** The line that opens a test: `it(`, `test.skip(`, `describe(`, `def test_x`, `func TestX`, `fn test_x`, rspec `it '…'`. */
const TEST_OPENER = /^\s*(?:(?:it|test|describe|context|suite|specify|xit|xtest|xdescribe|fit|fdescribe)(?:\.(?:skip|only|todo|skipIf|each)\b[^(]*)?\s*\(|it\s+['"]|(?:async\s+)?def\s+test\w*|func\s+Test\w*|(?:pub\s+)?(?:async\s+)?fn\s+test\w*)/;
/** A marker that annotates the test below it: `@pytest.mark.skip`, `#[ignore]`, `@Disabled`, `[Ignore]`. */
const ANNOTATION = /^\s*(?:@|#\[|\[)/;
/** The test a declaration names: its first string literal, else its function name. */
const testKey = (line: string): string | undefined => {
  const [first] = closedLiterals(line);
  return first ? line.slice(first[0] + 1, first[1]) : /(?:def|func|fn)\s+(\w+)/.exec(line)?.[1];
};

/**
 * True when a skip marker added in the hunk disables a test that existed
 * before: the nearest test opener (above the marker, or below an annotation)
 * is a context line, or an added line that redeclares a removed one
 * (`-it('adds'` / `+it.skip('adds'`). A guard inside a test the hunk adds
 * (`if (!git) return t.skip("needs git")`) hides no failure. No opener in
 * view (a truncated diff): the skip counts.
 */
function skipsExistingTest(hunk: readonly DiffLine[]): boolean {
  const removedKeys = new Set(hunk.filter((l) => l.t === "-" && TEST_OPENER.test(l.s)).map((l) => testKey(l.s)));
  return hunk.some((l, k) => {
    if (l.t !== "+" || !codeSkip(l.s)) return false;
    let opener: DiffLine | undefined;
    if (ANNOTATION.test(l.s)) {
      for (let j = k + 1; j < hunk.length && !opener; j++) if (hunk[j]!.t !== "-" && TEST_OPENER.test(hunk[j]!.s)) opener = hunk[j];
    } else {
      for (let j = k; j >= 0 && !opener; j--) if (hunk[j]!.t !== "-" && TEST_OPENER.test(hunk[j]!.s)) opener = hunk[j];
    }
    return !opener || opener.t === " " || removedKeys.has(testKey(opener.s));
  });
}

/** A removed line that takes nothing away: blank, a comment, closing punctuation or an import (re-added lines are matched separately). */
const TRIVIAL_LINE = /^\s*(?:$|\/\/|#(?!\[)|\/?\*|--\s|[)\]};,]+;?\s*$|import\b|from\s+\S+\s+import\b|use\s|require\(|const\s+\{[^}]*\}\s*=\s*require\()/;

/**
 * The shape of a change to a protected file from its diff: skip (a marker that
 * disables an existing test), weaken (an assertion removed and not put back
 * as is), additive (only lines added; what was removed is blank, comments,
 * closing punctuation, imports or re-added unchanged), else unknown.
 */
function changeShape(op: string | undefined, diff: string | undefined, additions: number | undefined, deletions: number | undefined): TamperShape {
  if (op === "delete") return "delete";
  if (op === "add") return "additive";
  if (!diff) return deletions === 0 && (additions ?? 0) > 0 ? "additive" : "unknown";
  const hunks = diffHunks(diff);
  if (hunks.some(skipsExistingTest)) return "skip";
  const taken = takenLines(hunks);
  if (taken.some((l) => ASSERTION.test(l))) return "weaken";
  return taken.every((l) => TRIVIAL_LINE.test(l)) ? "additive" : "unknown";
}

/** The lines a diff removes and does not put back unchanged. */
function takenLines(hunks: readonly DiffLine[][]): string[] {
  const lines = hunks.flat();
  const readded = new Map<string, number>();
  for (const l of lines) if (l.t === "+") readded.set(l.s.trim(), (readded.get(l.s.trim()) ?? 0) + 1);
  const taken: string[] = [];
  for (const l of lines) {
    if (l.t !== "-") continue;
    const n = readded.get(l.s.trim()) ?? 0;
    if (n > 0) readded.set(l.s.trim(), n - 1);
    else taken.push(l.s);
  }
  return taken;
}

/** Lines of one file remembered as the agent's own (OwnLines): enough for the tests it writes, bounded for the fold's state. */
const OWN_LINES_MAX = 2000;
/** Per protected file, the lines the agent's own edits added this session (trimmed, trivial lines left out). */
type OwnLines = Map<string, Set<string>>;

/** Records the lines an attributed diff adds to `path`. */
function addOwnLines(own: OwnLines, path: string, diff: string | undefined): void {
  if (!diff) return;
  let set = own.get(path);
  for (const l of diffHunks(diff).flat()) {
    if (l.t !== "+" || TRIVIAL_LINE.test(l.s)) continue;
    if (!set) own.set(path, (set = new Set()));
    if (set.size >= OWN_LINES_MAX) return;
    set.add(l.s.trim());
  }
}

/** The diff only rewrites lines the agent itself added earlier this session (a test it is still writing). */
function reworksOwnLines(own: OwnLines | undefined, path: string, diff: string | undefined): boolean {
  const set = own?.get(path);
  if (!set || !diff) return false;
  const taken = takenLines(diffHunks(diff)).filter((l) => !TRIVIAL_LINE.test(l));
  return taken.length > 0 && taken.every((l) => set.has(l.trim()));
}

/** Tests a run counted, when it says (passed + failed). */
const ranOf = (p: Record<string, unknown> | undefined): number | undefined => {
  const passed = num(p?.passed);
  const failed = num(p?.failed);
  return passed === undefined && failed === undefined ? undefined : (passed ?? 0) + (failed ?? 0);
};
/**
 * A green run shows the failures are gone only if it ran at least as many
 * tests as passed in the red one: one file of a failing suite going green
 * says nothing about the test that failed.
 */
const coversRun = (passedBefore: number | undefined, after: Record<string, unknown> | undefined): boolean => {
  const a = ranOf(after);
  return passedBefore === undefined || a === undefined || a >= passedBefore;
};

interface Candidate {
  i: number;
  e: AgentEvent;
  path: string;
  via: "file" | "shell";
  shape: TamperShape;
  /** The agent created the file earlier in this session: its own work, not a protected test. */
  own: boolean;
  /** A file a shell call's diff picked up that the command never named: reported, never high. */
  unattributed?: boolean;
  /** Authorizing human `user.message` event id when this change occurred under a matching steer. */
  steeredBy?: string;
  toolUseId?: string;
  tool?: string;
  start?: AgentEvent;
}

/**
 * Every change to a protected path in a session's events, oldest first: shape,
 * severity, whether it turned the tests green, and the agent's stated intent.
 * High: a skip, a delete of a pre-existing file, or a weaken/unknown change that
 * alone turned failing tests green. Everything else is info.
 */
export function detectTestTamperTrace(events: readonly AgentEvent[], opts: TamperTraceOpts = {}): TestTamperFinding[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0) || a.i - b.i);
  const ev = sorted.map((x) => x.e);
  /** Each event's first index in `ev`. */
  const pos = new Map<AgentEvent, number>();
  ev.forEach((e, i) => {
    if (!pos.has(e)) pos.set(e, i);
  });
  const protect = { pattern: opts.pattern, paths: opts.paths?.map((p) => normalizeTracePath(p, opts.cwd)) };
  const starts = new Map<string, AgentEvent>();
  const created = new Set<string>();
  /** A file the agent created and then removed with a shell command: path → that call (its diff reports the delete). */
  const ownDeleted = new Map<string, string | undefined>();
  const ownLines: OwnLines = new Map();
  const cands: Candidate[] = [];
  /** Every write in order for flippedGreen; attributed: the agent made it (an edit tool, or a shell command that names the file). */
  const writes: { i: number; protected: boolean; toolUseId?: string; attributed: boolean }[] = [];
  const tests: number[] = [];
  const proof: { proof?: ProofState } = {};
  const log = proofLog();
  let activeSteer: UserSteer | undefined;
  /** An earlier tool call named the file (read, ran or edited it), so it existed before this write. */
  const mentionedBefore = (path: string, i: number) => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    for (let j = 0; j < i; j++) {
      const e = ev[j] as AgentEvent;
      if (e.kind === "tool.start" && JSON.stringify(e.payload?.input ?? "").includes(base)) return true;
    }
    return false;
  };
  ev.forEach((e, i) => {
    const p = e.payload ?? {};
    const cwd = opts.cwd ?? e.cwd;
    /** Still absolute (or above the root) after normalizing against a known repo root: a scratch file, not the repo's test. */
    const outsideRepo = (path: string) => !!cwd && /^(?:\/|[A-Za-z]:\/|~|\.\.\/)/.test(path);
    if (e.kind === "user.message") {
      const u = readUserSteer(e);
      if (u.human) {
        activeSteer = u.steer;
        proofSteer(proof, toProofSteer(activeSteer));
      }
    } else if (e.kind === "tool.start") {
      const id = str(p.toolUseId);
      if (id) starts.set(id, e);
      const cmd = shellCommand(str(p.tool), p.input);
      if (cmd === undefined) return;
      if (isShellCall(str(p.tool) ?? "", p.input)) proofStart(proof, id, cmd, p.input);
      const skips = shellSkips(cmd);
      for (const w of shellWrites(cmd)) {
        const path = normalizeTracePath(w.path, cwd);
        // A test file gets the generic reading, whatever its language; the fold has no caller pattern, so neither does this.
        proofWrite(proof, e, w, path, w.renamedTo === undefined ? undefined : normalizeTracePath(w.renamedTo, cwd), id, isProtectedPath(path), log.note);
        const prot = isProtectedPath(path, protect);
        writes.push({ i, protected: prot, toolUseId: id, attributed: true });
        const own = created.has(path) || (/[*?]/.test(path) && [...created].some((c) => globRe(path).test(c)));
        if (w.op === "create") created.add(path);
        else if (w.op === "delete" && created.delete(path)) ownDeleted.set(path, id);
        if (!prot || outsideRepo(path)) continue;
        // A rename that keeps the file a test is not a delete; its target is recorded as a write.
        if (w.renamedTo !== undefined && isProtectedPath(normalizeTracePath(w.renamedTo, cwd), protect)) continue;
        // Skip markers count only when the command edits the file in place (sed -i 's/def test/…skip…/').
        const shape: TamperShape = w.op === "delete" ? "delete" : w.op === "append" ? "additive" : skips && w.op === "modify" ? "skip" : "unknown";
        // A whole-file write to a path no earlier call named is a new file, not an overwritten test.
        const fresh = w.op === "create" && !mentionedBefore(path, i);
        const cand: Candidate = { i, e, path, via: "shell", shape, own: own || fresh, toolUseId: id, tool: str(p.tool), start: e };
        if (!cand.own && shape !== "additive") {
          const sb = steerCoversTest(activeSteer, path);
          if (sb) cand.steeredBy = sb;
        }
        cands.push(cand);
      }
    } else if (e.kind === "file.change") {
      const raw = str(p.path);
      if (!raw) return;
      const path = normalizeTracePath(raw, cwd);
      let prot = isProtectedPath(path, protect);
      const id = str(p.toolUseId);
      const op = str(p.op);
      const start = id ? starts.get(id) : undefined;
      // A shell call's diff reports every file that changed while it ran. Files a git command
      // brought in are not the agent's edits: no candidate, and not a protected write either, so
      // a rebase that changes source between a red and a green run breaks flippedGreen.
      const origin = shellDiffOrigin(e, start, cwd);
      const moved = str(p.movedTo);
      const proofFile = proofChange(proof, e, { path, to: moved ? normalizeTracePath(moved, cwd) : undefined, origin, prot, test: isProtectedPath(path) }, log.note);
      if (origin === "vcs") prot = false;
      writes.push({ i, protected: prot && origin !== "unattributed", toolUseId: id, attributed: origin === "edit" || origin === "named" });
      if (prot && !outsideRepo(path) && !proofFile) {
        const shape = changeShape(op, str(p.diff), num(p.additions), num(p.deletions));
        const own = created.has(path) || (op === "delete" && ownDeleted.has(path) && ownDeleted.get(path) === id) || reworksOwnLines(ownLines, path, str(p.diff));
        const unattributed = origin === "unattributed" || undefined;
        const cand: Candidate = { i, e, path, via: "file", shape, own, unattributed, toolUseId: id, tool: str(p.tool) ?? str(start?.payload?.tool), start };
        if (!own && !unattributed && shape !== "additive") {
          const sb = steerCoversTest(activeSteer, path);
          if (sb) cand.steeredBy = sb;
        }
        cands.push(cand);
      }
      if (prot && (origin === "edit" || origin === "named")) addOwnLines(ownLines, path, str(p.diff));
      if (op === "add") created.add(path);
      if (op === "delete") created.delete(path);
    } else if (e.kind === "tool.end") proofEnd(proof, e, log.note);
    else if (e.kind === "test.result") {
      tests.push(i);
      activeSteer = undefined;
    }
  });
  const proofFound = log.findings(proof.proof);
  if (!cands.length && !proofFound.length) return [];

  const failed = (i: number) => num(ev[i]?.payload?.failed) ?? 0;
  /** The failing run at `before` followed a green run and the agent's own source edits since it. */
  const ownRegression = (before: number) => {
    const green = [...tests].reverse().find((t) => t < before && failed(t) === 0);
    return green !== undefined && writes.some((w) => w.i > green && w.i < before && !w.protected && w.attributed);
  };
  const found = cands.map((c): [number, TestTamperFinding] => {
    const before = [...tests].reverse().find((t) => t < c.i);
    const after = tests.find((t) => t > c.i);
    let flippedGreen = false;
    if (before !== undefined && after !== undefined && failed(before) > 0 && failed(after) === 0 && coversRun(num(ev[before]?.payload?.passed), ev[after]?.payload)) {
      // The run that produced `after` may write its own output (pytest > log); that's not a fix.
      const afterTool = str(ev[after]?.payload?.toolUseId);
      flippedGreen = writes.filter((w) => w.i > before && w.i < after && !(afterTool && w.toolUseId === afterTool)).every((w) => w.protected);
    }
    const { intent, intentSource } = intentOf(ev, pos, c);
    // A file the agent created this session is its own work: changing it never counts as high.
    // Deleting a pre-existing test counts while tests are failing (making the failure go away), not as cleanup on green.
    const red = before !== undefined && failed(before) > 0;
    // Tests the agent's own source change broke: editing their expectations is info.
    const afterOwnChange = red && ownRegression(before);
    const severity = !c.own && !c.unattributed && !c.steeredBy && (c.shape === "skip" || (c.shape === "delete" && (red || flippedGreen)) || ((c.shape === "weaken" || c.shape === "unknown") && flippedGreen && !afterOwnChange)) ? "high" : "info";
    const f: TestTamperFinding = {
      eventId: c.e.id,
      ts: c.e.ts,
      path: c.path,
      via: c.via,
      shape: c.shape,
      severity,
      flippedGreen,
      disclosed: intent !== undefined && DISCLOSURE.test(intent),
      intentSource,
    };
    if (c.unattributed) f.attributed = false;
    if (afterOwnChange && (c.shape === "weaken" || c.shape === "unknown")) f.afterOwnChange = true;
    if (c.steeredBy) f.steeredBy = c.steeredBy;
    if (c.toolUseId) f.toolUseId = c.toolUseId;
    if (c.tool) f.tool = c.tool;
    if (intent !== undefined) f.intent = intent;
    if (before !== undefined) f.beforeTestEventId = (ev[before] as AgentEvent).id;
    if (after !== undefined) f.afterTestEventId = (ev[after] as AgentEvent).id;
    return [c.i, f];
  });
  // Proof findings: a bypass is told at its check's tool.end and reported at its tool.start.
  // Findings at one event (the statements one diff changed) share its intent.
  const intents = new Map<AgentEvent, Pick<TestTamperFinding, "intent" | "intentSource">>();
  for (const x of proofFound) {
    const id = str(x.e.payload?.toolUseId);
    const call = x.e.kind === "tool.start" ? x.e : id ? starts.get(id) : undefined;
    const at = x.e.kind === "tool.end" && call ? call : x.e;
    const i = pos.get(at) ?? -1;
    let said = intents.get(at);
    if (!said) intents.set(at, (said = intentOf(ev, pos, { i, e: at, toolUseId: id, start: call })));
    const { intent, intentSource } = said;
    const tool = str(x.e.payload?.tool) ?? str(call?.payload?.tool);
    const f: TestTamperFinding = {
      eventId: at.id,
      ts: at.ts,
      path: x.path,
      via: at.kind === "file.change" ? "file" : "shell",
      shape: x.shape,
      severity: x.high ? "high" : "info",
      flippedGreen: x.flippedGreen,
      disclosed: intent !== undefined && DISCLOSURE.test(intent),
      intentSource,
      kind: x.kind,
    };
    if (x.hatch !== undefined) f.hatch = x.hatch;
    if (x.theorem !== undefined) f.theorem = x.theorem;
    if (x.steeredBy !== undefined) f.steeredBy = x.steeredBy;
    if (id) f.toolUseId = id;
    if (tool) f.tool = tool;
    if (intent !== undefined) f.intent = intent;
    if (x.before !== undefined) f.beforeTestEventId = x.before;
    if (x.after !== undefined) f.afterTestEventId = x.after;
    found.push([i, f]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}

/**
 * The reason given for a change: the call's own description/reason/explanation,
 * else the last assistant text in the same subagent after the previous tool
 * result and no later than the call.
 */
function intentOf(ev: readonly AgentEvent[], pos: ReadonlyMap<AgentEvent, number>, c: Pick<Candidate, "i" | "e" | "toolUseId" | "start">): Pick<TestTamperFinding, "intent" | "intentSource"> {
  const input = c.start?.payload?.input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["description", "reason", "explanation", "justification"]) {
      const v = str(o[k]);
      if (v?.trim()) return { intent: clip(v), intentSource: "declared" };
    }
  }
  const call = c.start ?? c.e;
  const at = pos.get(call) ?? -1;
  const sub = call.subagentId;
  const ts = call.ts;
  let from = -1;
  for (let j = (at < 0 ? c.i : at) - 1; j >= 0; j--) {
    const e = ev[j] as AgentEvent;
    if (e.kind === "tool.end" && e.subagentId === sub && e.payload?.toolUseId !== c.toolUseId) {
      from = j;
      break;
    }
  }
  let text: string | undefined;
  for (let j = from + 1; j < ev.length; j++) {
    const e = ev[j] as AgentEvent;
    if (e.ts > ts) break;
    if (e.kind !== "assistant.message" || e.subagentId !== sub) continue;
    const t = str(e.payload?.text);
    if (t?.trim()) text = t;
  }
  return text ? { intent: clip(text), intentSource: "assistant-text" } : { intentSource: "none" };
}

/** True when any finding is high severity (the `test-tamper` session flag). */
export function detectTestTamper(sorted: readonly AgentEvent[]): boolean {
  return detectTestTamperTrace(sorted).some((f) => f.severity === "high");
}

/**
 * What foldTamper carries from one event to the next: enough to tell whether
 * any change is high severity without the event list, so live ingest updates
 * the `test-tamper` flag from new events only. Serializable (node:v8).
 */
export interface TamperState {
  /** Files the agent created so far (detectTestTamperTrace's `created`). */
  created: Set<string>;
  /** Created files a shell call then removed: path → that call (detectTestTamperTrace's `ownDeleted`). */
  ownDeleted?: Map<string, string | undefined>;
  /** Lines the agent's own edits added to protected files (detectTestTamperTrace's `ownLines`). */
  ownLines?: Map<string, Set<string>>;
  /** The last few shell calls (tool use id, command): the call a shell diff's file.change came from. */
  shells?: [string, string][];
  high: boolean;
  /**
   * A shell command created a test file, and the next run went green: whether
   * the file existed before (so the change counts) depends on every earlier
   * call, so detectTestTamper decides from the events.
   */
  needsEvents: boolean;
  /** `failed` and `passed` of the last test.result, if there was one. */
  lastFailed?: number;
  lastPassed?: number;
  /** A green run happened; the agent edited source since the last one; the last failing run followed both. */
  sawGreen?: boolean;
  sourceSinceGreen?: boolean;
  redOwn?: boolean;
  /** Since the last test.result: a change that is high if the next run goes green, or one that might be. */
  flipCand: boolean;
  flipMaybe: boolean;
  /** Writes to unprotected paths since the last test.result: none, all from one tool call (its id), or several (true). */
  unprotected: string | true | null;
  /** Active human direction pivot, cleared on the next test.result or human user.message. */
  steer?: UserSteer;
  /** Proofs and their checks (core/proof.ts), made at the first one. */
  proof?: ProofState;
}

export const tamperState = (): TamperState => ({ created: new Set(), high: false, needsEvents: false, flipCand: false, flipMaybe: false, unprotected: null });

/** The `test-tamper` flag from the fold: a high test change, or a proof change that is high while it stands (core/proof.ts). */
export const tamperHigh = (s: TamperState): boolean => s.high || proofHigh(s.proof);

/** Shell calls foldTamper remembers: a shell diff's file.change follows its own call closely. */
const RECENT_SHELLS = 8;

/** Folds the next event, in time order, into a TamperState: the rules of detectTestTamperTrace with no options. */
export function foldTamper(s: TamperState, e: AgentEvent): void {
  if (s.high) return;
  const p = e.payload ?? {};
  const cwd = e.cwd;
  const outsideRepo = (path: string) => !!cwd && /^(?:\/|[A-Za-z]:\/|~|\.\.\/)/.test(path);
  const red = (s.lastFailed ?? 0) > 0;
  const write = (prot: boolean, id: string | undefined, attributed: boolean) => {
    if (prot) return;
    s.unprotected = s.unprotected === null && id !== undefined ? id : s.unprotected === id ? id : true;
    if (attributed) s.sourceSinceGreen = true;
  };
  // Only a change the agent didn't make itself: a skip is high at once, a delete while tests
  // fail too, a weaken or unknown change only when the next run turns the failing tests green.
  const candidate = (shape: TamperShape) => {
    if (shape === "skip" || (shape === "delete" && red)) s.high = true;
    else if ((shape === "weaken" || shape === "unknown") && red && !s.redOwn) s.flipCand = true;
  };
  if (e.kind === "user.message") {
    const u = readUserSteer(e);
    if (u.human) {
      if (u.steer) s.steer = u.steer;
      else delete s.steer;
      proofSteer(s, toProofSteer(u.steer));
    }
  } else if (e.kind === "tool.start") {
    const id = str(p.toolUseId);
    const cmd = shellCommand(str(p.tool), p.input);
    if (cmd === undefined) return;
    // shellDiffOrigin reads only a shell call's command: a file change by a Codex code-mode cell (exec with JavaScript) is an edit.
    const shell = isShellCall(str(p.tool) ?? "", p.input);
    if (id !== undefined && shell && (s.shells ??= []).push([id, cmd]) > RECENT_SHELLS) s.shells.shift();
    if (shell) proofStart(s, id, cmd, p.input);
    const skips = shellSkips(cmd);
    for (const w of shellWrites(cmd)) {
      const path = normalizeTracePath(w.path, cwd);
      const prot = isProtectedPath(path);
      proofWrite(s, e, w, path, w.renamedTo === undefined ? undefined : normalizeTracePath(w.renamedTo, cwd), id, prot);
      write(prot, id, true);
      const own = s.created.has(path) || (/[*?]/.test(path) && [...s.created].some((c) => globRe(path).test(c)));
      if (w.op === "create") s.created.add(path);
      else if (w.op === "delete" && s.created.delete(path)) (s.ownDeleted ??= new Map()).set(path, id);
      if (!prot || outsideRepo(path) || own) continue;
      if (w.renamedTo !== undefined && isProtectedPath(normalizeTracePath(w.renamedTo, cwd))) continue;
      if (w.op === "create") {
        // New (the agent's own) unless an earlier call named it: left to the events, if it matters.
        if (red && !s.redOwn && !steerCoversTest(s.steer, path)) s.flipMaybe = true;
      } else if (!steerCoversTest(s.steer, path)) candidate(w.op === "delete" ? "delete" : w.op === "append" ? "additive" : skips && w.op === "modify" ? "skip" : "unknown");
    }
  } else if (e.kind === "file.change") {
    const raw = str(p.path);
    if (!raw) return;
    const path = normalizeTracePath(raw, cwd);
    const id = str(p.toolUseId);
    const op = str(p.op);
    let prot = isProtectedPath(path);
    const cmd = s.shells?.find(([k]) => k === id)?.[1];
    const start = cmd === undefined ? undefined : ({ ...e, kind: "tool.start", payload: { tool: "Bash", input: { command: cmd } } } as AgentEvent);
    const origin: ShellDiffOrigin = shellDiffOrigin(e, start, cwd);
    const moved = str(p.movedTo);
    const proofFile = proofChange(s, e, { path, to: moved ? normalizeTracePath(moved, cwd) : undefined, origin, prot, test: prot });
    if (origin === "vcs") prot = false;
    write(prot && origin !== "unattributed", id, origin === "edit" || origin === "named");
    const own = s.created.has(path) || (op === "delete" && !!s.ownDeleted?.has(path) && s.ownDeleted.get(path) === id) || reworksOwnLines(s.ownLines, path, str(p.diff));
    if (prot && !outsideRepo(path) && !own && origin !== "unattributed" && !proofFile && !steerCoversTest(s.steer, path)) candidate(changeShape(op, str(p.diff), num(p.additions), num(p.deletions)));
    if (prot && (origin === "edit" || origin === "named")) addOwnLines((s.ownLines ??= new Map()), path, str(p.diff));
    if (op === "add") s.created.add(path);
    if (op === "delete") s.created.delete(path);
  } else if (e.kind === "tool.end") proofEnd(s, e);
  else if (e.kind === "test.result") {
    const failed = num(p.failed) ?? 0;
    if (red && failed === 0 && (s.flipCand || s.flipMaybe) && coversRun(s.lastPassed, p)) {
      // The run that went green may write its own output (pytest > log); that's not a fix.
      const tool = str(p.toolUseId);
      if (s.unprotected === null || (tool !== undefined && s.unprotected === tool)) {
        if (s.flipCand) s.high = true;
        else s.needsEvents = true;
      }
    }
    if (failed === 0) {
      s.sawGreen = true;
      s.sourceSinceGreen = s.redOwn = false;
    } else s.redOwn = !!(s.sawGreen && s.sourceSinceGreen);
    s.lastFailed = failed;
    s.lastPassed = num(p.passed);
    s.flipCand = s.flipMaybe = false;
    s.unprotected = null;
    delete s.steer;
  }
}
