// Fixture-repo builder for attribution tests: a real git repo, real shadow
// snapshots (core/snapshot.ts) under a temp CODING_SH_HOME, and stored
// sessions with file.change events, the way capture leaves them.
//
// The story (dates are fixed, so the matcher's time window is exercised):
//   base  human        README.md, src/math.ts
//   S1    claude-code  adds clamp() and a README section      → C1 "add clamp" (all of S1)
//   S2    codex        adds src/util.ts and lerp()            → C2 "add util": a person rewrote
//                      one of S2's lines and added one of their own before committing
//   S3    claude-code  on branch feature (from C2): smoothstep() and src/feature.ts → C3
//   H     human        on main: a header and clampToZero() at the top of src/math.ts,
//                      CONTRIBUTING.md; one line equals a line S1 wrote
//   feature is rebased onto main (C3 → C3', new sha, shifted line numbers) and
//   main fast-forwards to it: main = base, C1, C2, H, C3'.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "../../src/core/snapshot.ts";
import { SCHEMA_VERSION, type AgentEvent, type Session } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { gitc, tmp, write } from "../capture/_helpers.ts";

export const T0 = Date.parse("2026-10-01T09:00:00Z");
export const HOUR = 3600_000;

export function gitAt(cwd: string, at: number, ...args: string[]): string {
  const d = new Date(at).toISOString();
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }, stdio: ["pipe", "pipe", "pipe"] }).replace(/\n$/, "");
}

export function commitAll(cwd: string, at: number, msg: string): string {
  gitc(cwd, "add", "-A");
  gitAt(cwd, at, "commit", "-q", "-m", msg);
  return gitc(cwd, "rev-parse", "HEAD");
}

export function makeSession(id: string, agent: string, model: string, startedAt: number, repo: Session["repo"], endSnapshot?: string): Session {
  return {
    id,
    agent,
    model,
    startedAt,
    endedAt: startedAt + HOUR,
    repo,
    ...(endSnapshot ? { endSnapshot } : {}),
    stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 },
    flags: [],
  };
}

let seq = 0;
export function event(s: Session, kind: AgentEvent["kind"], payload: Record<string, unknown>, ts = s.startedAt + 60_000): AgentEvent {
  return { id: `e-${s.id}-${seq++}`, v: SCHEMA_VERSION, sessionId: s.id, ts, agent: s.agent, kind, payload, ...(s.repo?.root ? { cwd: s.repo.root } : {}) };
}

export interface Fixture {
  root: string;
  index: MemoryIndexStore;
  blobs: MemoryBlobStore;
  env: NodeJS.ProcessEnv;
  sessions: { s1: Session; s2: Session; s3: Session };
  commits: { base: string; c1: string; c2: string; h: string; c3: string; c3Rebased: string };
  /**
   * Who wrote each line of each file at HEAD (index = line - 1): a session id,
   * null for a person, undefined for a blank line (anyone may claim it).
   */
  expected: Record<string, (string | null | undefined)[]>;
}

const CLAMP = [
  "export function clamp(value: number, lo: number, hi: number): number {",
  "  if (value < lo) return lo;",
  "  if (value > hi) return hi;",
  "  return value;",
  "}",
];
const README_S1 = ["## Usage", "", "Call clamp(value, lo, hi) to bound a number."];
const UTIL_S2 = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (const v of values) total += v;",
  "  return total;",
  "}",
  "",
  "export function mean(values: number[]): number {",
  "  return values.length ? sum(values) / values.length : 0;",
  "}",
];
const LERP = ["", "export function lerp(a: number, b: number, t: number): number {", "  return a + (b - a) * t;", "}"];
const HUMAN_MEAN = "  return values.length === 0 ? 0 : sum(values) / values.length;";
const HUMAN_EPS = "export const EPSILON = 1e-9;";
const HUMAN_TOP = ["// Math helpers for the demo.", "export function clampToZero(value: number): number {", "  if (value < 0) return 0;", "  return value;", "}"];
const CONTRIB = ["# Contributing", "", "Run the tests before you send a change."];
const SMOOTH = [
  "",
  "export function smoothstep(edge0: number, edge1: number, x: number): number {",
  "  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);",
  "  return t * t * (3 - 2 * t);",
  "}",
];
const FEATURE = ['import { smoothstep } from "./math.ts";', "", "export function fade(x: number): number {", "  return smoothstep(0, 1, x);", "}"];

const text = (ls: string[]) => ls.join("\n") + "\n";

export async function buildFixture(): Promise<Fixture> {
  const root = tmp("csh-attr-");
  const env = process.env;
  gitc(root, "init", "-q", "-b", "main");
  write(root, { "README.md": "# demo\n\nA small demo project.\n", "src/math.ts": "export const ZERO = 0;\n" });
  const base = commitAll(root, T0, "init");

  const index = new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  const events: AgentEvent[] = [];

  // S1: claude-code, everything it does is committed as C1.
  const s1Start = (await snapshot(root, { env }))!;
  appendFileSync(join(root, "src/math.ts"), "\n" + text(CLAMP));
  appendFileSync(join(root, "README.md"), "\n" + text(README_S1));
  const s1End = (await snapshot(root, { env }))!;
  const s1 = makeSession("s1-claude", "claude-code", "claude-sonnet-4-5", T0 + 1 * HOUR, s1Start, s1End.snapshot);
  events.push(event(s1, "file.change", { path: join(root, "src/math.ts"), op: "modify" }), event(s1, "file.change", { path: "README.md", op: "modify" }));
  const c1 = commitAll(root, T0 + 2 * HOUR, "add clamp");

  // S2: codex; a person edits its work before committing C2.
  const s2Start = (await snapshot(root, { env }))!;
  write(root, { "src/util.ts": text(UTIL_S2) });
  appendFileSync(join(root, "src/math.ts"), text(LERP));
  const s2End = (await snapshot(root, { env }))!;
  const s2 = makeSession("s2-codex", "codex", "gpt-5-codex", T0 + 3 * HOUR, s2Start, s2End.snapshot);
  events.push(event(s2, "file.change", { path: "src/util.ts", op: "add" }), event(s2, "file.change", { path: "src/math.ts", op: "modify" }));
  const util = readFileSync(join(root, "src/util.ts"), "utf8").replace(UTIL_S2[7]!, HUMAN_MEAN);
  writeFileSync(join(root, "src/util.ts"), util + "\n" + HUMAN_EPS + "\n");
  const c2 = commitAll(root, T0 + 4 * HOUR, "add util");

  // S3: claude-code on a feature branch.
  gitc(root, "checkout", "-q", "-b", "feature");
  const s3Start = (await snapshot(root, { env }))!;
  appendFileSync(join(root, "src/math.ts"), text(SMOOTH));
  write(root, { "src/feature.ts": text(FEATURE) });
  const s3End = (await snapshot(root, { env }))!;
  const s3 = makeSession("s3-claude", "claude-code", "claude-opus-4-1", T0 + 4.5 * HOUR, s3Start, s3End.snapshot);
  events.push(event(s3, "file.change", { path: "src/math.ts", op: "modify" }), event(s3, "file.change", { path: "src/feature.ts", op: "add" }));
  const c3 = commitAll(root, T0 + 6 * HOUR, "add smoothstep");

  // H: a person, on main.
  gitc(root, "checkout", "-q", "main");
  const math = readFileSync(join(root, "src/math.ts"), "utf8");
  writeFileSync(join(root, "src/math.ts"), text(HUMAN_TOP) + math);
  write(root, { "CONTRIBUTING.md": text(CONTRIB) });
  const h = commitAll(root, T0 + 5 * HOUR, "docs: contributing, clampToZero");

  // Rebase feature onto main, then fast-forward main.
  gitc(root, "checkout", "-q", "feature");
  gitAt(root, T0 + 7 * HOUR, "rebase", "-q", "main");
  const c3Rebased = gitc(root, "rev-parse", "HEAD");
  gitc(root, "checkout", "-q", "main");
  gitc(root, "merge", "-q", "--ff-only", "feature");

  for (const s of [s1, s2, s3]) await index.upsertSession(s);
  await index.putEvents(events);

  const who = (id: string | null, ls: string[]) => ls.map((l) => (l.trim() ? id : undefined));
  const human = (ls: string[]) => who(null, ls);
  return {
    root,
    index,
    blobs,
    env,
    sessions: { s1, s2, s3 },
    commits: { base, c1, c2, h, c3, c3Rebased },
    expected: {
      "src/math.ts": [...human(HUMAN_TOP), null, ...who(s1.id, ["", ...CLAMP]), ...who(s2.id, LERP), ...who(s3.id, SMOOTH)],
      "README.md": [...human(["# demo", "", "A small demo project.", ""]), ...who(s1.id, README_S1)],
      "src/util.ts": [...who(s2.id, UTIL_S2.slice(0, 7)), null, s2.id, undefined, null],
      "src/feature.ts": who(s3.id, FEATURE),
      "CONTRIBUTING.md": human(CONTRIB),
    },
  };
}
