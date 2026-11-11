// Session → EvalTask drafting, plus on-disk import/export (coding.sh format and
// Harbor). A drafted task is always status "draft"; only validateTask() may
// promote it.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isPlumbing, shellParts } from "../core/failing-command.ts";
import { hashParts, sha256Hex } from "../core/ids.ts";
import { stringifyToml } from "../core/toml.ts";
import type { AgentEvent, BlobRef, BlobStore, EvalTask, IndexStore, Session } from "../core/types.ts";
import { safeJoin, safeWrite, toPosix } from "../runner/fsutil.ts";
import { rmrf, snapshotOps, type SnapshotOps } from "../runner/git.ts";
import { matchAny } from "../runner/glob.ts";
import type { ChatProvider } from "../judge/providers.ts";
import { filterPatch, patchPaths } from "./patch.ts";
import { deterministicLedger, draftStatement, renderStatement, requirementCandidates, type LedgerObligation } from "./statement.ts";
import { taskWitnesses, type Witness } from "./witness.ts";

export const TASK_FORMAT = "coding.sh/task@0";
export const DEFAULT_VERIFIER_TIMEOUT_MS = 10 * 60_000;

export interface TaskMeta {
  /** User prompts after the first one. Not part of the instruction: they often steer toward the answer. */
  followUps: string[];
  /** Human-readable notes about what was guessed or missing. */
  notes: string[];
  setupSource: "given" | "guessed" | "none";
  /** given: DraftTaskOpts.instruction; session: first user prompt; command: the prompt argument of a `coding.sh run -- <cmd>` session; ledger: rendered requirement ledger (src/eval/statement.ts). */
  instructionSource: "given" | "session" | "command" | "ledger";
  verifierSource: "given" | "session" | "manifest" | "none";
  /** The requirement ledger behind a `statement: "ledger"` instruction (superseded ones included). */
  obligations?: LedgerObligation[];
  /** Ledger ids the session discussed but did not build (left out of the instruction). */
  notImplemented?: string[];
}

/** EvalTask plus drafting metadata. Assignable to EvalTask (see report: request `meta` on the contract). */
export type DraftedTask = EvalTask & { meta: TaskMeta };

export interface DraftTaskOpts {
  index: IndexStore;
  blobs: BlobStore;
  sessionId: string;
  name?: string;
  /**
   * The task instruction. Overrides the session's first user prompt; needed
   * for sessions that recorded none (e.g. `coding.sh run -- ./script.sh`).
   */
  instruction?: string;
  verifierCommand?: string;
  setup?: string[];
  verifierTimeoutMs?: number;
  /**
   * Globs (repo-relative) of files the session changed that are tests: they
   * are removed from the reference patch and become hidden verifier files
   * (end-of-session content), copied in only at verify time.
   */
  hiddenTests?: string[];
  tags?: string[];
  /**
   * How to build the instruction when none is given. "first-prompt" (default): the first
   * user prompt. "ledger": every user turn as a requirement ledger (src/eval/statement.ts),
   * merged by `provider` when given, else one obligation per turn.
   */
  statement?: "first-prompt" | "ledger";
  /** Model for `statement: "ledger"`. */
  provider?: ChatProvider;
  /** Override for draftStatement (tests). */
  draft?: typeof draftStatement;
  signal?: AbortSignal;
  /** Override for src/core/snapshot.ts (tests, other backends). */
  git?: SnapshotOps;
  now?: number;
}

// ------------------------------------------------------------ session parsing

function textOf(e: AgentEvent): string | undefined {
  const t = e.payload.text;
  return typeof t === "string" && t.trim() !== "" ? t : undefined;
}

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "run_shell_command", "terminal", "run_terminal_cmd", "local_shell", "exec"]);

/** The shell command line from a tool.start event, when it is a shell tool. */
export function shellCommandOf(e: AgentEvent): string | undefined {
  if (e.kind !== "tool.start") return undefined;
  const tool = String(e.payload.tool ?? "").toLowerCase();
  if (!SHELL_TOOLS.has(tool)) return undefined;
  const input = e.payload.input as unknown;
  const raw =
    typeof input === "string"
      ? input
      : input && typeof input === "object"
        ? ((input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd)
        : undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    // Codex style: ["bash", "-lc", "npm test"]
    const a = raw as string[];
    if (a.length >= 3 && /(^|\/)(ba|z)?sh$/.test(a[0] as string) && /^-l?c$/.test(a[1] as string)) return a.slice(2).join(" ");
    return a.join(" ");
  }
  return undefined;
}

const TEST_RE =
  /(^|[\s/(])(npm (run )?test\b|npm t\b|pnpm( run)? test\b|yarn( run)? test\b|bun( run)? test\b|npx (vitest|jest|mocha|playwright test)\b|vitest\b|jest\b|mocha\b|node (--[\w-]+ )*--test\b|deno test\b|pytest\b|python3? -m pytest\b|uv run pytest\b|tox\b|nox\b|go test\b|cargo (test|nextest)\b|make (test|check)\b|mvnw? (\S+ )*test\b|\.?\/?gradlew? (\S+ )*test\b|(bundle exec )?rspec\b|rake test\b|phpunit\b|dotnet test\b|swift test\b|mix test\b|ctest\b|(node|python3?|bun|deno run|tsx|ts-node) (\S+ )*\S*(test|spec)\S*\.(m?[jt]sx?|cjs|py)\b)/;

/**
 * Reduce a shell line the agent ran to the test-command part: drops
 * `cd <repoRoot> &&`, output plumbing (`2>&1 | tail -20`), and unrelated
 * `&&`/`;` segments. Returns undefined when nothing looks like a test run.
 */
export function extractTestCommand(cmd: string, repoRoot?: string): string | undefined {
  const segs = cmd.split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
  let cdPrefix: string | undefined;
  for (const raw of segs) {
    const seg = raw.trim();
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)$/.exec(seg);
    if (cd) {
      const target = (cd[1] as string).replace(/^["']|["']$/g, "");
      const rel = repoRoot && (target === repoRoot || target.startsWith(`${repoRoot}/`)) ? relative(repoRoot, target) : target;
      cdPrefix = rel === "" || rel === "." ? undefined : rel.startsWith("/") ? undefined : rel;
      continue;
    }
    if (!TEST_RE.test(seg)) continue;
    // `cat setup.cfg | grep pytest` and `echo "run pytest"` name a test runner without running it.
    if (isPlumbing(shellParts(seg)[0]?.prog)) continue;
    const cleaned = seg
      .replace(/\s*\|\s*(tail|head|grep|less|more|cat|tee)\b.*$/, "")
      .replace(/\s*[12]?>&[12]\s*/g, " ")
      .replace(/\s*2>\/dev\/null\s*/g, " ")
      .trim();
    if (!cleaned) continue;
    return cdPrefix ? `cd ${cdPrefix} && ${cleaned}` : cleaned;
  }
  return undefined;
}

/** The last test command the agent itself ran in the session, if any. */
export function guessVerifierFromEvents(events: readonly AgentEvent[], repoRoot?: string): string | undefined {
  let found: string | undefined;
  for (const e of events) {
    const c = shellCommandOf(e);
    if (!c) continue;
    const t = extractTestCommand(c, repoRoot);
    if (t) found = t;
  }
  return found;
}

// ------------------------------------------------------------ repo inspection

export interface RepoFacts {
  files: Set<string>;
  packageJson?: { scripts?: Record<string, string>; packageManager?: string };
}

export async function inspectRepo(dir: string): Promise<RepoFacts> {
  const files = new Set(await readdir(dir).catch(() => [] as string[]));
  let packageJson: RepoFacts["packageJson"];
  if (files.has("package.json")) {
    try {
      packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      packageJson = undefined;
    }
  }
  return { files, packageJson };
}

/** Install commands from lockfiles/manifests at the repo root. At most one per ecosystem. */
export function guessSetup(f: RepoFacts): string[] {
  return guessSetupFrom(f).map((g) => g.command);
}

/** {@link guessSetup}, with the file each command was guessed from. */
export function guessSetupFrom(f: RepoFacts): { command: string; from: string }[] {
  const has = (n: string) => f.files.has(n);
  const out: { command: string; from: string }[] = [];
  const add = (command: string, first: string, ...more: string[]) => out.push({ command, from: [first, ...more].find(has) ?? first });
  if (has("pnpm-lock.yaml")) add("pnpm i --frozen-lockfile", "pnpm-lock.yaml");
  else if (has("bun.lockb") || has("bun.lock")) add("bun install --frozen-lockfile", "bun.lockb", "bun.lock");
  else if (has("yarn.lock")) add(has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile", "yarn.lock");
  else if (has("package-lock.json") || has("npm-shrinkwrap.json")) add("npm ci", "package-lock.json", "npm-shrinkwrap.json");
  else if (has("package.json")) add("npm install", "package.json (no lockfile)");

  if (has("uv.lock")) add("uv sync --frozen", "uv.lock");
  else if (has("poetry.lock")) add("poetry install --no-interaction", "poetry.lock");
  else if (has("requirements.txt")) add("pip install -r requirements.txt", "requirements.txt");
  else if (has("pyproject.toml") || has("setup.py")) add("pip install -e .", "pyproject.toml", "setup.py");

  if (has("go.mod")) add("go mod download", "go.mod");
  if (has("Cargo.toml")) add("cargo fetch", "Cargo.toml");
  if (has("Gemfile.lock")) add("bundle install", "Gemfile.lock");
  return out;
}

const NPM_DEFAULT_TEST = /no test specified/;

/** Test command from manifests, when the session gave no hint. */
export function guessVerifierFromRepo(f: RepoFacts): string | undefined {
  const t = f.packageJson?.scripts?.test;
  if (t && !NPM_DEFAULT_TEST.test(t)) {
    if (f.files.has("pnpm-lock.yaml")) return "pnpm test";
    if (f.files.has("yarn.lock")) return "yarn test";
    if (f.files.has("bun.lockb") || f.files.has("bun.lock")) return "bun run test";
    return "npm test";
  }
  if (f.files.has("Cargo.toml")) return "cargo test";
  if (f.files.has("go.mod")) return "go test ./...";
  if (f.files.has("uv.lock")) return "uv run pytest";
  if (f.files.has("pyproject.toml") || f.files.has("pytest.ini") || f.files.has("setup.py") || f.files.has("requirements.txt")) return "python -m pytest";
  return undefined;
}

// ------------------------------------------------------------ instruction

/** Flags whose value is the prompt in common agent CLIs (`gemini -p "…"`, `aider --message "…"`). */
const PROMPT_FLAGS = new Set(["-p", "--prompt", "--print", "--message", "--instruction", "--task", "--query"]);
const PROMPT_FLAG_EQ = /^--(prompt|message|instruction|task|query)=([\s\S]+)$/;

const reads = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "" && !s.startsWith("-");

/**
 * The prompt in a wrapped command line, e.g. `claude -p "fix the tests"` or
 * `./agent.sh "make sum add"` (the wrapper adapter's own `run` passes the
 * instruction as the last argument). Positional arguments must contain
 * whitespace so file names and subcommands are never taken for a prompt.
 */
export function instructionFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const eq = PROMPT_FLAG_EQ.exec(a);
    if (eq && (eq[2] as string).trim()) return (eq[2] as string).trim();
    if (PROMPT_FLAGS.has(a) && reads(args[i + 1]) && /\s/.test((args[i + 1] as string).trim())) return (args[i + 1] as string).trim();
  }
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] as string;
    if (reads(a) && /\s/.test(a.trim())) return a.trim();
  }
  return undefined;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/**
 * Full argv of a wrapper session.start. The inline payload clips long args to a
 * preview, so prefer the event's blobs (the raw spool payload, or the clipped
 * args array), then the inline payload.
 */
async function wrapperArgs(e: AgentEvent, blobs: BlobStore): Promise<string[] | undefined> {
  for (const ref of e.blobs ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await blobs.getText(ref)) ?? "");
    } catch {
      continue;
    }
    const args = stringArray(parsed) ?? (parsed && typeof parsed === "object" ? stringArray((parsed as Record<string, unknown>).args) : undefined);
    if (args) return args;
  }
  return stringArray(e.payload.args);
}

/**
 * Read an `--instruction` value: literal text, or `@path` for a file
 * (relative to `cwd`). Throws when the result is empty.
 */
export async function readInstructionArg(value: string, cwd: string): Promise<string> {
  let text = value;
  if (value.startsWith("@") && value.length > 1) {
    const path = resolve(cwd, value.slice(1));
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      throw new Error(`can't read instruction file ${path}: ${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e))}`);
    }
  }
  text = text.trim();
  if (!text) throw new Error(value.startsWith("@") ? `instruction file ${value.slice(1)} is empty` : "instruction is empty");
  return text;
}

// ------------------------------------------------------------ drafting

function startOf(session: Session, events: readonly AgentEvent[]): { repoRoot: string; snapshot: string; head: string; partial?: boolean } {
  // Only the session.start snapshot (or the session's own repo state, which
  // ingest sets from it) is pre-agent. turn.end / session.end snapshots are not.
  const startEvt = events.find((e) => e.kind === "session.start" && e.repo);
  const repo = startEvt?.repo ?? session.repo;
  if (!repo) throw new Error(`session ${session.id} has no repo state; cannot build a task`);
  const snap = repo.snapshot || repo.head;
  if (!snap) throw new Error(`session ${session.id} has neither a start snapshot nor a HEAD`);
  if (session.endSnapshot && snap === session.endSnapshot) {
    throw new Error(`session ${session.id}: start snapshot equals endSnapshot; refusing to start a task from the post-agent state`);
  }
  return { repoRoot: repo.root, snapshot: snap, head: repo.head, partial: repo.partial || !repo.snapshot };
}

export async function draftTaskFromSession(opts: DraftTaskOpts): Promise<DraftedTask> {
  const { index, blobs, sessionId } = opts;
  const session = await index.getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const events = await index.listEvents(sessionId);
  const notes: string[] = [];

  const prompts = events.filter((e) => e.kind === "user.message").map(textOf).filter((t): t is string => !!t);
  let instruction = opts.instruction?.trim() || undefined;
  let instructionSource: TaskMeta["instructionSource"] = "given";
  // Ledger mode builds the instruction after the reference patch exists (the model uses it to drop unbuilt requirements).
  const ledgerCands = !instruction && opts.statement === "ledger" ? requirementCandidates(events) : [];
  if (ledgerCands.length) instructionSource = "ledger";
  if (!instruction && !ledgerCands.length && prompts[0]) {
    instruction = prompts[0];
    instructionSource = "session";
  }
  if (!instruction && !ledgerCands.length) {
    const wrapStart = events.find((e) => e.kind === "session.start" && e.payload.source === "wrapper");
    const args = wrapStart ? await wrapperArgs(wrapStart, blobs) : undefined;
    instruction = args ? instructionFromArgs(args) : undefined;
    if (instruction) {
      instructionSource = "command";
      notes.push("instruction taken from the wrapped command's prompt argument; review it");
    }
  }
  if (!instruction && !ledgerCands.length) {
    throw new Error(
      `session ${sessionId} has no user prompt to use as the instruction; pass one with --instruction "<what the agent was asked to do>" or --instruction @FILE`,
    );
  }
  const followUps = instructionSource === "ledger" ? [] : prompts.slice(instructionSource === "session" ? 1 : 0);
  if (followUps.length) notes.push(`${followUps.length} ${instructionSource === "session" ? "follow-up " : "session "}prompt(s) not included in the instruction; review whether the task needs them`);

  const start = startOf(session, events);
  if (start.partial) notes.push("start snapshot is partial or HEAD-only: uncommitted/untracked files at session start may be missing");
  const ops = await snapshotOps(opts.git);

  // Reference patch: start → end-of-session state.
  let referencePatch: BlobRef | undefined;
  const hiddenFiles: Record<string, BlobRef> = {};
  let refText: string | undefined;
  if (session.endSnapshot) {
    const d = await ops.diffSnapshots(start.repoRoot, start.snapshot, session.endSnapshot);
    refText = d.patch;
    const hidden = opts.hiddenTests ?? [];
    if (hidden.length && refText) {
      const testPaths = patchPaths(refText).filter((p) => matchAny(p, hidden));
      if (testPaths.length) {
        const endDir = await mkdtemp(join(tmpdir(), "csh-end-"));
        try {
          await ops.materialize({ root: start.repoRoot, head: start.head, snapshot: session.endSnapshot }, endDir);
          for (const p of testPaths) {
            const abs = safeJoin(endDir, p);
            if (!existsSync(abs)) continue; // deleted by the session; nothing to hide
            hiddenFiles[p] = await blobs.put(await readFile(abs));
          }
        } finally {
          await rmrf(endDir);
        }
        refText = filterPatch(refText, (p) => p in hiddenFiles);
        notes.push(`moved ${Object.keys(hiddenFiles).length} test file(s) from the reference patch into hidden verifier files`);
      }
    }
    if (refText && refText.trim() !== "") referencePatch = await blobs.put(refText, { contentType: "text/x-diff" });
    else notes.push("session made no net changes; no reference patch");
  } else {
    notes.push("session has no end snapshot; no reference patch (add one before validating)");
  }

  let ledgerMeta: Pick<TaskMeta, "obligations" | "notImplemented"> = {};
  if (instructionSource === "ledger") {
    if (opts.provider) {
      const assistantIds = new Set(events.filter((e) => e.kind === "assistant.message").map((e) => e.id));
      const d = await (opts.draft ?? draftStatement)({ candidates: ledgerCands, provider: opts.provider, assistantIds, ...(refText ? { referencePatchText: refText } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
      instruction = d.statement;
      ledgerMeta = { obligations: d.ledger.obligations, ...(d.ledger.notImplemented.length ? { notImplemented: d.ledger.notImplemented } : {}) };
      if (d.submissions > 1) notes.push(`ledger accepted on submission ${d.submissions} of ${opts.provider.name} ${opts.provider.model}`);
    } else {
      const obligations = deterministicLedger(ledgerCands);
      instruction = renderStatement(obligations);
      ledgerMeta = { obligations };
      notes.push("ledger is unmerged user turns; review superseded requirements");
    }
  }
  if (!instruction) throw new Error(`session ${sessionId}: the requirement ledger rendered no instruction`);

  // Setup / verifier guesses need a look at the start tree.
  let setup = opts.setup;
  let verifier = opts.verifierCommand;
  let setupSource: TaskMeta["setupSource"] = setup ? "given" : "none";
  let verifierSource: TaskMeta["verifierSource"] = verifier ? "given" : "none";
  let setupFrom: string[] = [];
  if (!verifier) {
    verifier = guessVerifierFromEvents(events, start.repoRoot);
    if (verifier) verifierSource = "session";
  }
  if (!setup || !verifier) {
    const dir = await mkdtemp(join(tmpdir(), "csh-start-"));
    try {
      await ops.materialize({ root: start.repoRoot, head: start.head, snapshot: start.snapshot }, dir);
      const facts = await inspectRepo(dir);
      if (!setup) {
        const guessed = guessSetupFrom(facts);
        setup = guessed.map((g) => g.command);
        setupFrom = guessed.map((g) => g.from);
        setupSource = setup.length ? "guessed" : "none";
      }
      if (!verifier) {
        verifier = guessVerifierFromRepo(facts);
        if (verifier) verifierSource = "manifest";
      }
    } finally {
      await rmrf(dir);
    }
  }
  if (!verifier) notes.push("no verifier command found; set one before validating");
  else if (verifierSource !== "given") notes.push(`verifier guessed from ${verifierSource}: ${verifier}`);
  if (setupSource === "guessed") notes.push(`setup guessed from ${setupFrom.join(", ")}: ${(setup ?? []).join(" && ")}`);

  const now = opts.now ?? Date.now();
  const tags = [...new Set(["from-session", `agent:${session.agent}`, ...(prompts.length > 1 ? ["multi-turn"] : []), ...(opts.tags ?? [])])];
  return {
    id: `task_${hashParts("task", sessionId, start.snapshot, instruction).slice(0, 16)}`,
    name: opts.name ?? defaultName(instruction),
    status: "draft",
    sourceSessionId: sessionId,
    start: { repoRoot: start.repoRoot, snapshot: start.snapshot, head: start.head },
    instruction,
    setup: setup ?? [],
    verifier: { command: verifier ?? "", hiddenFiles, timeoutMs: opts.verifierTimeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS },
    referencePatch,
    tags,
    createdAt: now,
    meta: { followUps, notes, instructionSource, setupSource, verifierSource, ...ledgerMeta },
  };
}

function defaultName(instruction: string): string {
  const slug = instruction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "task";
}

// ------------------------------------------------------------ coding.sh on-disk format
//
//   task.json        everything except instruction/blob contents; hidden files listed by path
//   instruction.md   the prompt given to the agent
//   tests/<path>     hidden verifier files (copied over the work tree at verify time)
//   reference.patch  reference solution (optional)
//   near-misses/NNN.patch
//   witnesses/witnesses.json   meta.witnesses (src/eval/witness.ts)
//   witnesses/files/<id12>/<path>   each witness's test file

interface TaskJson {
  format: typeof TASK_FORMAT;
  id: string;
  name: string;
  status: EvalTask["status"];
  sourceSessionId?: string;
  start: EvalTask["start"];
  setup: string[];
  verifier: { command: string; timeoutMs: number; hiddenFiles: string[] };
  tags: string[];
  createdAt: number;
  validation?: EvalTask["validation"];
  meta?: unknown;
}

async function blobBytes(blobs: BlobStore, ref: BlobRef, what: string): Promise<Uint8Array> {
  const b = await blobs.get(ref);
  if (!b) throw new Error(`${what}: blob ${ref} not found`);
  return b;
}

/**
 * A recorded agent run, for a verifier that grades what the agent said or did
 * (CODING_SH_AGENT_OUTPUT, CODING_SH_AGENT_STDOUT) and not only the tree. In a
 * task dir, `reference/` holds a run the verifier must pass (`output.md`, the
 * final answer; `stdout.jsonl`, the agent's stdout) next to `reference.patch`,
 * its diff. `near-misses/<label>/` holds a run it must fail, with its diff as
 * `diff.patch`. They live in task.meta (referenceRun, nearMissRuns), which
 * every store keeps.
 */
export interface RecordedRun {
  label: string;
  output?: BlobRef;
  stdout?: BlobRef;
  patch?: BlobRef;
}

const RUN_FILES = { output: "output.md", stdout: "stdout.jsonl", patch: "diff.patch" } as const;

function recordedRun(v: unknown, label: string): RecordedRun | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const run: RecordedRun = { label: typeof o.label === "string" && o.label ? o.label : label };
  for (const k of ["output", "stdout", "patch"] as const) if (typeof o[k] === "string" && o[k]) run[k] = o[k] as BlobRef;
  return run.output || run.stdout || run.patch ? run : undefined;
}

/** The task's reference run, when its task dir had a reference/ dir. */
export function referenceRun(task: Pick<EvalTask, "meta">): RecordedRun | undefined {
  return recordedRun(task.meta?.referenceRun, "reference");
}

/** The task's near-miss runs: near-misses/<label>/ dirs. */
export function nearMissRuns(task: Pick<EvalTask, "meta">): RecordedRun[] {
  const list = task.meta?.nearMissRuns;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v, i) => recordedRun(v, `near-miss run #${i + 1}`) ?? []);
}

async function readRunDir(dir: string, label: string, store: (data: Uint8Array) => Promise<BlobRef>, files: readonly (keyof typeof RUN_FILES)[]): Promise<RecordedRun | undefined> {
  const run: RecordedRun = { label };
  for (const k of files) {
    const f = join(dir, RUN_FILES[k]);
    if (existsSync(f)) run[k] = await store(await readFile(f));
  }
  return run.output || run.stdout || run.patch ? run : undefined;
}

async function writeRunDir(dir: string, run: RecordedRun, blobs: BlobStore): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const k of ["output", "stdout", "patch"] as const) {
    const ref = run[k];
    if (ref) await writeFile(join(dir, RUN_FILES[k]), await blobBytes(blobs, ref, `${run.label} ${RUN_FILES[k]}`));
  }
}

/** A near-miss dir name from its label. */
const runDirName = (label: string, i: number) => label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `run-${i + 1}`;

/** Where a witness's file lives in an exported task dir (its id keeps two witnesses at one path apart). */
const witnessFile = (w: Witness) => `${w.id.slice(0, 12)}/${w.path}`;

export async function exportTaskDir(task: EvalTask, dir: string, blobs: BlobStore): Promise<void> {
  await mkdir(dir, { recursive: true });
  const witnesses = taskWitnesses(task);
  let meta = (task as Partial<DraftedTask>).meta as Record<string, unknown> | undefined;
  if (meta && ("witnesses" in meta || "referenceRun" in meta || "nearMissRuns" in meta)) {
    const { witnesses: _w, referenceRun: _r, nearMissRuns: _n, ...rest } = meta;
    meta = Object.keys(rest).length ? rest : undefined;
  }
  const json: TaskJson = {
    format: TASK_FORMAT,
    id: task.id,
    name: task.name,
    status: task.status,
    sourceSessionId: task.sourceSessionId,
    start: task.start,
    setup: task.setup,
    verifier: { command: task.verifier.command, timeoutMs: task.verifier.timeoutMs, hiddenFiles: Object.keys(task.verifier.hiddenFiles).sort() },
    tags: task.tags,
    createdAt: task.createdAt,
    validation: task.validation,
    meta,
  };
  await writeFile(join(dir, "task.json"), `${JSON.stringify(json, null, 2)}\n`);
  await writeFile(join(dir, "instruction.md"), task.instruction.endsWith("\n") ? task.instruction : `${task.instruction}\n`);
  for (const [rel, ref] of Object.entries(task.verifier.hiddenFiles)) {
    await safeWrite(join(dir, "tests"), rel, await blobBytes(blobs, ref, `hidden file ${rel}`));
  }
  if (task.referencePatch) await writeFile(join(dir, "reference.patch"), await blobBytes(blobs, task.referencePatch, "reference patch"));
  const nm = task.nearMissPatches ?? [];
  if (nm.length) {
    await mkdir(join(dir, "near-misses"), { recursive: true });
    for (let i = 0; i < nm.length; i++) {
      await writeFile(join(dir, "near-misses", `${String(i + 1).padStart(3, "0")}.patch`), await blobBytes(blobs, nm[i] as BlobRef, "near-miss patch"));
    }
  }
  const ref = referenceRun(task);
  if (ref) await writeRunDir(join(dir, "reference"), ref, blobs);
  for (const [i, run] of nearMissRuns(task).entries()) await writeRunDir(join(dir, "near-misses", runDirName(run.label, i)), run, blobs);
  if (witnesses.length) {
    await mkdir(join(dir, "witnesses"), { recursive: true });
    await writeFile(join(dir, "witnesses", "witnesses.json"), `${JSON.stringify(witnesses, null, 2)}\n`);
    for (const w of witnesses) await safeWrite(join(dir, "witnesses", "files"), witnessFile(w), await blobBytes(blobs, w.blob, `witness ${w.path}`));
  }
}

async function walkFiles(root: string, sub = ""): Promise<string[]> {
  const out: string[] = [];
  const here = join(root, sub);
  for (const e of await readdir(here, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(root, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export interface ImportTaskOpts {
  /** The start tree, when task.json has none (a hand-written task's repo/ dir, snapshotted by the caller). */
  start?: EvalTask["start"];
}

/**
 * Paths a verifier command names under tests/ that will not be there at verify time. A task
 * dir's tests/<path> is copied over the work tree at <path>, so `node tests/check.js` finds no
 * file and `node --test tests/*.test.js` runs zero tests and passes. One message per path.
 */
export function verifierPathWarnings(task: Pick<EvalTask, "verifier">): string[] {
  const hidden = Object.keys(task.verifier.hiddenFiles);
  if (!hidden.length) return [];
  const out = new Set<string>();
  for (const raw of task.verifier.command.split(/[\s;&|()<>]+/)) {
    const path = raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    if (!path.startsWith("tests/")) continue;
    const inside = path.slice("tests/".length);
    // A hidden file really is at tests/… (the task dir has tests/tests/…).
    if (!inside || hidden.some((h) => matchAny(h, [path]))) continue;
    const lands = hidden.filter((h) => matchAny(h, [inside]));
    if (!lands.length) continue;
    const shown = lands.slice(0, 3).map((h) => `tests/${h} → ${h}`);
    if (lands.length > 3) shown.push("…");
    out.add(`the verifier names ${path}, but hidden files land at their path inside tests/ (${shown.join(", ")}): name ${inside}, or move the files to tests/tests/`);
  }
  return [...out];
}

/** The id a task.json is stored under: its own `id`, else `task_<hash of name>`. Undefined with neither. */
export function taskJsonId(json: { id?: unknown; name?: unknown }): string | undefined {
  if (typeof json.id === "string" && json.id) return json.id;
  return typeof json.name === "string" && json.name ? `task_${sha256Hex(json.name).slice(0, 16)}` : undefined;
}

/**
 * Read a task dir. Blob refs are sha256 of content (the BlobStore contract),
 * so they are correct with or without `blobs`; pass `blobs` to also store them.
 *
 * A hand-written task.json may leave out `format`, `id` and `start`: the id is
 * then `task_<hash of name>`, and the start comes from `opts.start`.
 */
export async function importTaskDir(dir: string, blobs?: BlobStore, opts: ImportTaskOpts = {}): Promise<EvalTask> {
  const json = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as Partial<TaskJson>;
  if (json.format !== undefined && json.format !== TASK_FORMAT) throw new Error(`${dir}/task.json: unsupported format ${JSON.stringify(json.format)} (want ${TASK_FORMAT})`);
  if (opts.start) json.start = opts.start;
  if (!json.id && json.name) json.id = taskJsonId(json);
  if (!json.id || !json.start?.snapshot || !json.verifier) throw new Error(`${dir}/task.json: missing ${!json.id ? "name" : !json.verifier ? "verifier" : "start.snapshot (add a repo/ dir)"}`);
  const store = async (data: Uint8Array): Promise<BlobRef> => (blobs ? blobs.put(data) : sha256Hex(data));
  const instruction = (await readFile(join(dir, "instruction.md"), "utf8")).replace(/\n$/, "");
  const hiddenFiles: Record<string, BlobRef> = {};
  const testsDir = join(dir, "tests");
  const testFiles = existsSync(testsDir) ? await walkFiles(testsDir) : [];
  const listed = new Set(json.verifier.hiddenFiles ?? testFiles);
  for (const rel of testFiles) {
    if (!listed.has(rel)) continue;
    safeJoin(dir, rel); // validates the path shape
    hiddenFiles[toPosix(rel)] = await store(await readFile(join(testsDir, rel)));
  }
  for (const rel of listed) if (!(rel in hiddenFiles)) throw new Error(`${dir}: task.json lists hidden file ${rel} but tests/${rel} is missing`);
  const refPath = join(dir, "reference.patch");
  const referencePatch = existsSync(refPath) ? await store(await readFile(refPath)) : undefined;
  const nmDir = join(dir, "near-misses");
  const nearMissPatches: BlobRef[] = [];
  const runs: RecordedRun[] = [];
  if (existsSync(nmDir) && (await stat(nmDir)).isDirectory()) {
    for (const e of (await readdir(nmDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && e.name.endsWith(".patch")) nearMissPatches.push(await store(await readFile(join(nmDir, e.name))));
      else if (e.isDirectory()) {
        const run = await readRunDir(join(nmDir, e.name), e.name, store, ["output", "stdout", "patch"]);
        if (run) runs.push(run);
      }
    }
  }
  const reference = existsSync(join(dir, "reference")) ? await readRunDir(join(dir, "reference"), "reference", store, ["output", "stdout"]) : undefined;
  const task: EvalTask = {
    id: json.id,
    name: json.name ?? json.id,
    status: json.status ?? "draft",
    sourceSessionId: json.sourceSessionId,
    start: json.start,
    instruction,
    setup: json.setup ?? [],
    verifier: { command: json.verifier.command ?? "", timeoutMs: json.verifier.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS, hiddenFiles },
    referencePatch,
    nearMissPatches: nearMissPatches.length ? nearMissPatches : undefined,
    validation: json.validation,
    tags: json.tags ?? [],
    createdAt: json.createdAt ?? Date.now(),
  };
  if (json.meta && typeof json.meta === "object" && !Array.isArray(json.meta)) task.meta = json.meta as Record<string, unknown>;
  if (reference || runs.length) {
    const { referenceRun: _r, nearMissRuns: _n, ...rest } = task.meta ?? {};
    task.meta = { ...rest, ...(reference ? { referenceRun: reference } : {}), ...(runs.length ? { nearMissRuns: runs } : {}) };
  }
  const wJson = join(dir, "witnesses", "witnesses.json");
  if (existsSync(wJson)) {
    const listed = JSON.parse(await readFile(wJson, "utf8")) as unknown;
    if (!Array.isArray(listed)) throw new Error(`${wJson}: expected an array of witnesses`);
    const witnesses: Witness[] = [];
    for (const w of taskWitnesses({ ...task, meta: { witnesses: listed } })) {
      const file = join(dir, "witnesses", "files");
      const data = await readFile(safeJoin(file, witnessFile(w))).catch(() => {
        throw new Error(`${dir}: witness ${w.path} is listed but witnesses/files/${witnessFile(w)} is missing`);
      });
      const blob = await store(data);
      if (blob !== w.blob) throw new Error(`${dir}: witnesses/files/${witnessFile(w)} does not match its witness (blob ${w.blob})`);
      witnesses.push(w);
    }
    if (witnesses.length) task.meta = { ...(task.meta ?? {}), witnesses };
  }
  return task;
}

// ------------------------------------------------------------ Harbor export
//
// The Harbor task layout (harbor-framework/harbor v0.25, task.toml schema 1.4,
// src/harbor/models/task/config.py TaskConfig):
//   - task.toml: schema_version, [task] name ("org/name"), [metadata], [verifier]
//     timeout_sec and environment_mode, [agent].timeout_sec, [environment].
//   - environment/Dockerfile builds the image; the agent works in WORKDIR /app.
//   - tests/ is copied to /tests only at verify time; tests/test.sh must write
//     1 (pass) or 0 (fail) to /logs/verifier/reward.txt. The verifier runs in the
//     agent's container (environment_mode "shared"), so it sees the agent's /app.
//   - solution/ is copied to /solution for the oracle; solution/solve.sh is run.
//     solution/trajectory.json (optional) is the source session as ATIF-v1.8
//     (eval/atif.ts): next to the solution, never beside instruction.md, where
//     Harbor would seed the agent with it.
// Hidden files go to tests/files/<path> and are copied over /app by test.sh.
// The start tree is exported (with its single-commit .git) to environment/repo/.

export const HARBOR_SCHEMA_VERSION = "1.4";

/** A Harbor package name ("org/name": letters, digits, dot, dash, underscore). */
export function harborTaskName(task: Pick<EvalTask, "name" | "id">): string {
  const slug = task.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").replace(/\.\.+/g, ".").slice(0, 80);
  return `coding-sh/${slug || task.id}`;
}

export interface HarborOpts {
  /** Export the start tree into environment/repo (default true). Needs the snapshot to be materializable. */
  includeRepo?: boolean;
  git?: SnapshotOps;
  agentTimeoutSec?: number;
  /** The source session as an ATIF trajectory (eval/atif.ts), written to solution/trajectory.json. */
  trajectory?: unknown;
}

function baseImage(setup: readonly string[]): string {
  const s = setup.join("\n");
  if (/\bbun\b/.test(s)) return "oven/bun:1";
  if (/\b(npm|pnpm|yarn)\b/.test(s)) return "node:22-bookworm";
  if (/\b(pip|uv|poetry)\b/.test(s)) return "python:3.12-bookworm";
  if (/\bgo mod\b/.test(s)) return "golang:1.23-bookworm";
  if (/\bcargo\b/.test(s)) return "rust:1-bookworm";
  if (/\bbundle\b/.test(s)) return "ruby:3.3-bookworm";
  return "ubuntu:24.04";
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function exportHarbor(task: EvalTask, dir: string, blobs: BlobStore, opts: HarborOpts = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const toml = stringifyToml({
    schema_version: HARBOR_SCHEMA_VERSION,
    task: { name: harborTaskName(task), ...(task.instruction ? { description: task.instruction.split("\n")[0]!.slice(0, 200) } : {}), keywords: task.tags },
    metadata: {
      name: task.name,
      source: "coding.sh",
      coding_sh_task_id: task.id,
      ...(task.sourceSessionId ? { source_session: task.sourceSessionId } : {}),
      tags: task.tags,
    },
    verifier: { timeout_sec: Math.ceil(task.verifier.timeoutMs / 1000), environment_mode: "shared" },
    agent: { timeout_sec: opts.agentTimeoutSec ?? 1800 },
    environment: { build_timeout_sec: 1800 },
  });
  await writeFile(join(dir, "task.toml"), toml);
  await writeFile(join(dir, "instruction.md"), task.instruction.endsWith("\n") ? task.instruction : `${task.instruction}\n`);

  const env = join(dir, "environment");
  await mkdir(env, { recursive: true });
  const image = baseImage(task.setup);
  const docker = [
    `FROM ${image}`,
    "RUN command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*)",
    ...(image.startsWith("node:") && task.setup.some((c) => /\b(pnpm|yarn)\b/.test(c)) ? ["RUN corepack enable"] : []),
    "WORKDIR /app",
    "COPY repo/ /app/",
    ...task.setup.map((c) => `RUN ${c}`),
    "",
  ].join("\n");
  await writeFile(join(env, "Dockerfile"), docker);
  if (opts.includeRepo ?? true) {
    const repoDir = join(env, "repo");
    await rmrf(repoDir);
    const ops = await snapshotOps(opts.git);
    await ops.materialize({ root: task.start.repoRoot, head: task.start.head, snapshot: task.start.snapshot }, repoDir);
  }

  const tests = join(dir, "tests");
  await mkdir(tests, { recursive: true });
  for (const [rel, ref] of Object.entries(task.verifier.hiddenFiles)) {
    await safeWrite(join(tests, "files"), rel, await blobBytes(blobs, ref, `hidden file ${rel}`));
  }
  const testSh = [
    "#!/usr/bin/env bash",
    "# Generated by coding.sh. Copies hidden verifier files over the work tree, runs the verifier,",
    "# and writes the reward Harbor reads.",
    "mkdir -p /logs/verifier",
    "if [ -d /tests/files ]; then cp -R /tests/files/. /app/; fi",
    "cd /app",
    `if bash -c ${shQuote(task.verifier.command || "false")}; then`,
    "  echo 1 > /logs/verifier/reward.txt",
    "else",
    "  echo 0 > /logs/verifier/reward.txt",
    "fi",
    "",
  ].join("\n");
  await writeFile(join(tests, "test.sh"), testSh);
  await chmod(join(tests, "test.sh"), 0o755);

  if (opts.trajectory !== undefined) {
    await mkdir(join(dir, "solution"), { recursive: true });
    await writeFile(join(dir, "solution", "trajectory.json"), `${JSON.stringify(opts.trajectory, null, 2)}\n`);
  }
  if (task.referencePatch) {
    const sol = join(dir, "solution");
    await mkdir(sol, { recursive: true });
    await writeFile(join(sol, "reference.patch"), await blobBytes(blobs, task.referencePatch, "reference patch"));
    const solve = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cd /app",
      "git apply --whitespace=nowarn /solution/reference.patch || patch -p1 < /solution/reference.patch",
      "",
    ].join("\n");
    await writeFile(join(sol, "solve.sh"), solve);
    await chmod(join(sol, "solve.sh"), 0o755);
  }
}
