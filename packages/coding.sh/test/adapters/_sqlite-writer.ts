// A writer in another process, as an agent's app is, for tests that read a live SQLite database.
// It runs in WAL mode with busy_timeout 0, so any lock a reader takes that gets in its way is an
// SQLITE_BUSY it counts rather than waits out.
import { spawn } from "node:child_process";

export interface WriterOpts {
  /** SQL run once after `journal_mode = WAL`, before the first commit (CREATE TABLE ...). */
  setup?: string;
  /** One commit's statement. It binds $n, an integer that counts commits from 1. */
  step: string;
  /** Ms between commits. 0 commits once and then holds the database until stopped. */
  everyMs: number;
  /** Switch to exclusive locking mode before the first commit, which then takes the lock and keeps it. */
  exclusive?: boolean;
}

export interface WriterResult {
  commits: number;
  /** Commits that failed with SQLITE_BUSY or SQLITE_LOCKED: a reader got in the way. */
  busy: number;
  errors: string[];
}

export interface Writer {
  pid: number;
  /** Stop committing, close the database (the last connection's close checkpoints and removes -wal and -shm) and report. */
  stop(): Promise<WriterResult>;
  /** Stop the process if it still runs: for `finally`. */
  kill(): Promise<void>;
}

const WRITER = (path: string, o: WriterOpts) => `
const { DatabaseSync } = require("node:sqlite");
const o = ${JSON.stringify({ path, ...o })};
const db = new DatabaseSync(o.path);
db.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL");
if (o.setup) db.exec(o.setup);
if (o.exclusive) db.exec("PRAGMA locking_mode = EXCLUSIVE");
const step = db.prepare(o.step);
let commits = 0, busy = 0;
const errors = [];
function commit() {
  try {
    db.exec("BEGIN IMMEDIATE");
    step.run({ n: BigInt(commits + 1) });
    db.exec("COMMIT");
    commits++;
  } catch (e) {
    const code = e && typeof e.errcode === "number" ? e.errcode & 0xff : -1;
    if (code === 5 || code === 6) busy++;
    else if (errors.length < 5) errors.push(String(e && e.message));
    try { db.exec("ROLLBACK"); } catch {}
  }
}
commit();
const timer = o.everyMs > 0 ? setInterval(commit, o.everyMs) : undefined;
process.stdout.write("ready\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  if (timer) clearInterval(timer);
  db.close();
  process.stdout.write(JSON.stringify({ commits, busy, errors }) + "\\n");
});
`;

/** Start a writer on `path` and wait for its first commit, after which -wal and -shm exist. */
export async function startWriter(path: string, o: WriterOpts): Promise<Writer> {
  const child = spawn(process.execPath, ["--no-warnings", "-e", WRITER(path, o)], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  const running = () => child.exitCode === null && child.signalCode === null;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!out.includes("ready\n")) return;
        child.stdout.off("data", check);
        resolve();
      };
      child.stdout.on("data", check);
      void closed.then((code) => reject(new Error(`the writer exited (${code}) before its first commit: ${err}`)));
    });
  } catch (e) {
    if (running()) child.kill();
    await closed;
    throw e;
  }
  return {
    pid: child.pid!,
    async stop() {
      child.stdin.end();
      const code = await closed;
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (code !== 0 || !line) throw new Error(`the writer exited (${code}): ${err}`);
      return JSON.parse(line) as WriterResult;
    },
    async kill() {
      if (running()) child.kill();
      await closed;
    },
  };
}
