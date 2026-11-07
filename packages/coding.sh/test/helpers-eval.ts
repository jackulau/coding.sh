// Test doubles for eval/runner/stats tests: in-memory index + blobs, a
// git-backed stand-in for src/core/snapshot.ts, and a scriptable fake adapter.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { bundleId } from "../src/runner/bundle.ts";
import type {
  Adapter,
  AgentEvent,
  AgentRunOutput,
  BlobRef,
  BlobStore,
  EvalTask,
  HarnessBundle,
  IndexStore,
  Label,
  RepoState,
  RunResult,
  RunSpec,
  Session,
  SessionFilter,
} from "../src/core/types.ts";
import { GIT_IDENTITY, START_REF, git, type SnapshotOps, type WorkdirDiff } from "../src/runner/git.ts";

export class MemBlobs implements BlobStore {
  readonly kind = "mem";
  readonly data = new Map<string, Uint8Array>();
  async put(d: Uint8Array | string): Promise<BlobRef> {
    const bytes = typeof d === "string" ? new TextEncoder().encode(d) : d;
    const ref = createHash("sha256").update(bytes).digest("hex");
    this.data.set(ref, bytes);
    return ref;
  }
  async get(ref: BlobRef) {
    return this.data.get(ref);
  }
  async getText(ref: BlobRef) {
    const b = this.data.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }
  async has(refs: BlobRef[]) {
    return refs.map((r) => this.data.has(r));
  }
  async *list() {
    yield* this.data.keys();
  }
  async delete(ref: BlobRef) {
    this.data.delete(ref);
  }
}

export class MemIndex implements IndexStore {
  readonly kind = "mem";
  events: AgentEvent[] = [];
  sessions = new Map<string, Session>();
  tasks = new Map<string, EvalTask>();
  bundles = new Map<string, HarnessBundle>();
  runs: RunResult[] = [];
  labels: Label[] = [];
  cursors = new Map<string, number>();
  async migrate() {}
  async close() {}
  async putEvents(batch: AgentEvent[]) {
    const ids = new Set(this.events.map((e) => e.id));
    const fresh = batch.filter((e) => !ids.has(e.id));
    this.events.push(...fresh);
    return { inserted: fresh.length };
  }
  async upsertSession(s: Session) {
    this.sessions.set(s.id, s);
  }
  async getSession(id: string) {
    return this.sessions.get(id);
  }
  async listSessions(f: SessionFilter = {}) {
    return [...this.sessions.values()].filter((s) => (f.runId === undefined ? true : f.runId === null ? !s.runId : s.runId === f.runId));
  }
  async listEvents(sessionId: string, opts: { kinds?: string[] } = {}) {
    return this.events
      .filter((e) => e.sessionId === sessionId && (!opts.kinds || opts.kinds.includes(e.kind)))
      .sort((a, b) => a.ts - b.ts);
  }
  async search() {
    return [];
  }
  async getCursor(s: string) {
    return this.cursors.get(s) ?? 0;
  }
  async setCursor(s: string, o: number) {
    this.cursors.set(s, o);
  }
  async putTask(t: EvalTask) {
    this.tasks.set(t.id, t);
  }
  async getTask(id: string) {
    return this.tasks.get(id);
  }
  async listTasks() {
    return [...this.tasks.values()];
  }
  async putBundle(b: HarnessBundle) {
    this.bundles.set(b.id, b);
  }
  async getBundle(idOrName: string) {
    return this.bundles.get(idOrName) ?? [...this.bundles.values()].find((b) => b.name === idOrName);
  }
  async listBundles() {
    return [...this.bundles.values()];
  }
  async putRun(r: RunResult) {
    this.runs.push(r);
  }
  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}) {
    return this.runs.filter(
      (r) => (!f.taskId || r.taskId === f.taskId) && (!f.bundleId || r.bundleId === f.bundleId) && (!f.experimentId || r.experimentId === f.experimentId),
    );
  }
  async putLabel(l: Label) {
    this.labels.push(l);
  }
  async listLabels() {
    return this.labels;
  }
  async *referencedBlobs() {}
}

export type Tree = Record<string, string>;

/**
 * Stand-in for src/core/snapshot.ts: snapshots are named trees held in memory;
 * materialize writes the tree and commits it in a fresh repo (HEAD = start).
 * `extraCommits` simulates leaked future history reachable via --all.
 */
export class FakeSnapshots implements SnapshotOps {
  readonly trees = new Map<string, Tree>();
  readonly extraCommits = new Map<string, Tree>();
  materialized = 0;
  add(id: string, tree: Tree): this {
    this.trees.set(id, tree);
    return this;
  }
  async materialize(state: RepoState, dest: string): Promise<void> {
    const id = state.snapshot ?? state.head;
    const tree = this.trees.get(id);
    if (!tree) throw new Error(`unknown snapshot ${id}`);
    this.materialized++;
    await mkdir(dest, { recursive: true });
    await writeTree(dest, tree);
    await mustGit(["init", "-q"], dest);
    await mustGit(["add", "-A"], dest);
    await mustGit([...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", `snapshot ${id}`], dest);
    await mustGit(["update-ref", START_REF, "HEAD"], dest);
    const leak = this.extraCommits.get(id);
    if (leak) {
      await mustGit(["checkout", "-q", "-b", "future"], dest);
      await writeTree(dest, leak);
      await mustGit(["add", "-A"], dest);
      await mustGit([...GIT_IDENTITY, "commit", "-q", "-m", "future fix"], dest);
      await mustGit(["checkout", "-q", "-"], dest);
    }
  }
  async diffWorkdir(dir: string): Promise<WorkdirDiff> {
    await mustGit(["add", "-A"], dir);
    const patch = (await git(["diff", "--cached", "--binary", START_REF], dir)).stdoutTail;
    const num = (await git(["diff", "--cached", "--numstat", START_REF], dir)).stdoutTail;
    const names = (await git(["diff", "--cached", "--name-status", START_REF], dir)).stdoutTail;
    await mustGit(["reset", "-q"], dir);
    const status = new Map<string, string>();
    for (const l of names.split("\n").filter(Boolean)) {
      const [s, p] = l.split("\t");
      if (s && p) status.set(p, s);
    }
    const files = num
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [a, d, p] = l.split("\t");
        return { path: p ?? "", status: status.get(p ?? "") ?? "M", additions: Number(a) || 0, deletions: Number(d) || 0 };
      });
    return { patch, files };
  }
  async diffSnapshots(repoRoot: string, a: string, b: string): Promise<WorkdirDiff> {
    const dir = await mkdtemp(join(tmpdir(), "csh-fake-diff-"));
    try {
      await this.materialize({ root: repoRoot, head: a, snapshot: a }, dir);
      for (const e of await readdir(dir)) if (e !== ".git") await rm(join(dir, e), { recursive: true, force: true });
      const tree = this.trees.get(b);
      if (!tree) throw new Error(`unknown snapshot ${b}`);
      await writeTree(dir, tree);
      return await this.diffWorkdir(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function writeTree(dir: string, tree: Tree): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

async function mustGit(args: string[], cwd: string): Promise<void> {
  const r = await git(args, cwd);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderrTail}`);
}

// ------------------------------------------------------------ toy project

/** Two independent bugs in two files, so the reference patch has 2 hunks. */
export const BUGGY: Tree = {
  "package.json": JSON.stringify({ name: "toy", version: "1.0.0", scripts: { test: "node --test" } }, null, 2) + "\n",
  "package-lock.json": "{}\n",
  "src/add.js": "export function add(a, b) {\n  return a - b;\n}\n",
  "src/mul.js": "export function mul(a, b) {\n  return a + b;\n}\n",
  "README.md": "# toy\n",
};

export const FIXED: Tree = {
  ...BUGGY,
  "src/add.js": "export function add(a, b) {\n  return a + b;\n}\n",
  "src/mul.js": "export function mul(a, b) {\n  return a * b;\n}\n",
};

export const HIDDEN_TEST =
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.js";\n' +
  'import { mul } from "../src/mul.js";\n' +
  "assert.equal(add(2, 3), 5);\n" +
  "assert.equal(mul(2, 3), 6);\n";

export async function tempDir(prefix = "csh-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ------------------------------------------------------------ fake adapter

export interface FakeAdapterOpts {
  /** Decide what the "agent" does in spec.cwd; return files to write. */
  act?: (spec: RunSpec) => Promise<Tree | void> | Tree | void;
  usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  throws?: boolean;
  overlayEnv?: Record<string, string>;
}

export function fakeAdapter(opts: FakeAdapterOpts = {}): Adapter & { specs: RunSpec[] } {
  const specs: RunSpec[] = [];
  return {
    id: "fake",
    displayName: "Fake",
    tier: "C",
    specs,
    async detect() {
      return { installed: true, hooked: false };
    },
    async install() {
      return [];
    },
    async uninstall() {
      return [];
    },
    async normalize() {
      return [];
    },
    async overlay() {
      return { env: opts.overlayEnv ?? {}, flags: ["--fake-overlay"] };
    },
    async run(spec: RunSpec): Promise<AgentRunOutput> {
      specs.push(spec);
      if (opts.throws) throw new Error("agent exploded");
      const t0 = Date.now();
      const files = await opts.act?.(spec);
      if (files) await writeTree(spec.cwd, files);
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - t0,
        sessionId: `sess-${spec.runId}`,
        usage: opts.usage,
        stdoutTail: "done",
        stderrTail: "",
      };
    },
  };
}

// ------------------------------------------------------------ toy world for runner tests

const worldDirs: string[] = [];
export async function cleanupWorlds(): Promise<void> {
  for (const d of worldDirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
}

export async function toyWorld() {
  const blobs = new MemBlobs();
  const index = new MemIndex();
  const git = new FakeSnapshots().add("start", BUGGY);
  const runsDir = await tempDir("csh-runs-");
  worldDirs.push(runsDir);
  const task: EvalTask = {
    id: "t1",
    name: "toy",
    status: "validated",
    start: { repoRoot: "/r", snapshot: "start", head: "h" },
    instruction: "fix add and mul",
    setup: ["echo built > build.log"],
    verifier: { command: "node test/add.test.js", hiddenFiles: { "test/add.test.js": await blobs.put(HIDDEN_TEST) }, timeoutMs: 30_000 },
    tags: [],
    createdAt: 0,
  };
  const mkBundle = async (name: string, claude: string, extra: Partial<HarnessBundle> = {}): Promise<HarnessBundle> => {
    const body = { name, agent: "fake", flags: ["--b"], env: { FROM_BUNDLE: "1" }, files: { "CLAUDE.md": await blobs.put(claude) }, remove: ["README.md"], ...extra };
    return { id: bundleId(body), createdAt: 0, ...body };
  };
  return { blobs, index, git, runsDir, task, mkBundle };
}

/** The "agent": reads CLAUDE.md in its cwd and does what it says. */
export const obedientAgent = () =>
  fakeAdapter({
    usage: { costUsd: 0.5, inputTokens: 100, outputTokens: 50 },
    act: async (spec: RunSpec): Promise<Tree | undefined> => {
      const rules = await readFile(join(spec.cwd, "CLAUDE.md"), "utf8");
      if (rules.includes("fix")) return { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
      if (rules.includes("half")) return { "src/add.js": FIXED["src/add.js"] as string };
      return undefined;
    },
  });

