// Workflow cases: evals/workflows/<workflow>/cases/*.toml (docs/design/workflows.md §5).
//
//   id = "seeded-1"
//   split = "dev"                    # or "heldout"
//   args = '{"seeded":"seeded-1"}'   # JSON string or a table
//   threshold = 0.5                  # optional: score ≥ threshold is a pass
//   [truth]
//   kind = "seeded-bugs"
//   file = "hidden/seeded-1.json"    # bugs JSON kept outside the workflow's tree
//   # or inline:
//   [[truth.bugs]]
//   id = "b1"  file = "src/a.ts"  lines = [10, 12]  category = "logic"  severity = "P1"
//   patch = "bugs/b1.patch"          # path relative to the case file
//
//   [start]                          # optional: the tree the workflow works on
//   repoRoot = "../../../.."  snapshot = "/tmp/seeded-1"   # truth.file may not sit inside either
//
// verifier (Fix workflows): kind = "verifier", command = "npm test", or named tests:
//   [[truth.tests]]
//   id = "orders"  command = "node --test test/orders.test.ts"  before = "pass"   # failing now = regression
// judge (synthesis / research): kind = "judge", rubric = "…", judge = "anthropic" | "<provider>:<model>" | '{json}'.
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BlobStore } from "../core/types.ts";
import { parseToml, type TomlTable } from "../core/toml.ts";
import type { SeededBug, VerifierTest, WorkflowCase, WorkflowTruth } from "./types.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SEVERITIES = new Set(["P0", "P1", "P2"]);

async function parseBugs(list: unknown, baseDir: string, blobs: Pick<BlobStore, "put">, where: string): Promise<SeededBug[]> {
  if (!Array.isArray(list)) throw new Error(`${where}: truth.bugs must be an array`);
  const out: SeededBug[] = [];
  for (const [i, b] of list.entries()) {
    if (!isObj(b)) throw new Error(`${where}: bug ${i} is not a table`);
    const id = typeof b.id === "string" ? b.id : `bug-${i + 1}`;
    if (typeof b.file !== "string") throw new Error(`${where}: bug ${id} needs a file`);
    const lines = Array.isArray(b.lines) ? b.lines : typeof b.line === "number" ? [b.line, b.line] : undefined;
    if (!lines || typeof lines[0] !== "number") throw new Error(`${where}: bug ${id} needs lines = [a, b]`);
    const severity = typeof b.severity === "string" && SEVERITIES.has(b.severity) ? (b.severity as SeededBug["severity"]) : "P1";
    let patch = "";
    if (typeof b.patch === "string" && /^[0-9a-f]{64}$/.test(b.patch)) {
      patch = b.patch; // already a blob ref (e.g. truth written by buildSeededTree)
    } else if (typeof b.patch === "string" && b.patch) {
      const p = isAbsolute(b.patch) ? b.patch : resolve(baseDir, b.patch);
      let text: string;
      try {
        text = await readFile(p, "utf8");
      } catch {
        throw new Error(`${where}: can't read patch ${JSON.stringify(b.patch)} for bug ${id}`);
      }
      patch = await blobs.put(text);
    }
    const bug: SeededBug = {
      id,
      file: b.file,
      lines: [lines[0] as number, (typeof lines[1] === "number" ? lines[1] : lines[0]) as number],
      category: typeof b.category === "string" ? b.category : "bug",
      severity,
      patch,
    };
    if (typeof b.test === "string") bug.test = b.test;
    out.push(bug);
  }
  return out;
}

/** [[truth.tests]]: {id, command, before?}; undefined when absent. */
function parseTests(list: unknown, where: string): VerifierTest[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || !list.length) throw new Error(`${where}: truth.tests must be a non-empty array of tables`);
  const seen = new Set<string>();
  return list.map((x, i) => {
    if (!isObj(x) || typeof x.command !== "string" || !x.command.trim()) throw new Error(`${where}: test ${i + 1} needs a command`);
    const id = typeof x.id === "string" && x.id ? x.id : `test-${i + 1}`;
    if (seen.has(id)) throw new Error(`${where}: test id ${JSON.stringify(id)} is used twice`);
    seen.add(id);
    if (x.before !== undefined && x.before !== "pass" && x.before !== "fail") throw new Error(`${where}: test ${id}: before must be "pass" or "fail"`);
    const t: VerifierTest = { id, command: x.command };
    if (x.before === "pass" || x.before === "fail") t.before = x.before;
    return t;
  });
}

/** `p` is `dir` or below it (after resolving both). */
function isInside(p: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(p));
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

export async function parseCase(text: string, file: string, workflow: string, blobs: Pick<BlobStore, "put">): Promise<WorkflowCase> {
  const t: TomlTable = parseToml(text, file);
  const baseDir = dirname(file);
  const id = typeof t.id === "string" ? t.id : file.replace(/^.*[\\/]/, "").replace(/\.toml$/, "");
  let args: unknown = t.args ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // a plain string arg
    }
  }
  const tr = isObj(t.truth) ? t.truth : {};
  let truth: WorkflowTruth;
  let truthFile: string | undefined;
  const kind = typeof tr.kind === "string" ? tr.kind : "seeded-bugs";
  if (kind === "verifier") {
    const tests = parseTests(tr.tests, file);
    if (typeof tr.command !== "string" && !tests) throw new Error(`${file}: truth.command or [[truth.tests]] is required for kind = "verifier"`);
    if (typeof tr.command === "string" && tests) throw new Error(`${file}: use truth.command or [[truth.tests]], not both`);
    truth = { kind: "verifier", ...(typeof tr.command === "string" ? { command: tr.command } : {}), ...(tests ? { tests } : {}) };
  } else if (kind === "judge") {
    if (typeof tr.rubric !== "string" || !tr.rubric.trim()) throw new Error(`${file}: truth.rubric is required for kind = "judge"`);
    const judge = typeof tr.judge === "string" ? tr.judge : isObj(tr.judge) ? JSON.stringify(tr.judge) : "anthropic";
    truth = { kind: "judge", rubric: tr.rubric, judge };
  } else if (kind === "seeded-bugs") {
    let list: unknown = tr.bugs;
    let listBase = baseDir;
    if (typeof tr.file === "string") {
      const p = isAbsolute(tr.file) ? tr.file : resolve(baseDir, tr.file);
      truthFile = p;
      const v = JSON.parse(await readFile(p, "utf8")) as unknown;
      list = Array.isArray(v) ? v : isObj(v) ? v.bugs : undefined;
      listBase = dirname(p);
    }
    truth = { kind: "seeded-bugs", bugs: await parseBugs(list ?? [], listBase, blobs, file) };
  } else {
    throw new Error(`${file}: unknown truth.kind ${JSON.stringify(kind)}`);
  }
  const c: WorkflowCase = { id, workflow, split: t.split === "heldout" ? "heldout" : "dev", args, truth };
  if (isObj(t.start) && typeof t.start.repoRoot === "string") {
    const at = (p: unknown) => (typeof p === "string" && p ? (isAbsolute(p) ? p : resolve(baseDir, p)) : "");
    c.start = { repoRoot: at(t.start.repoRoot), snapshot: at(t.start.snapshot), head: typeof t.start.head === "string" ? t.start.head : "" };
    // The truth is hidden from the workflow: a truth file inside the tree it works on could be read by its agents.
    for (const tree of [c.start.repoRoot, c.start.snapshot]) {
      if (truthFile && tree && isInside(truthFile, tree)) throw new Error(`${file}: truth.file ${JSON.stringify(t.truth && isObj(t.truth) ? t.truth.file : "")} is inside the workflow's tree ${tree}; keep it outside, e.g. in hidden/ next to cases/`);
    }
  }
  if (typeof t.threshold === "number") c.threshold = t.threshold;
  return c;
}

/** All cases in a dir (sorted by file name), optionally one split only. */
export async function loadCases(dir: string, workflow: string, blobs: Pick<BlobStore, "put">, split?: WorkflowCase["split"]): Promise<WorkflowCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".toml")).sort();
  const out: WorkflowCase[] = [];
  for (const f of files) {
    const p = join(dir, f);
    const c = await parseCase(await readFile(p, "utf8"), p, workflow, blobs);
    if (!split || c.split === split) out.push(c);
  }
  return out;
}
