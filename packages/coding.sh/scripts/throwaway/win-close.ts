// Throwaway, not for merging. On Windows: after a Chrome is killed, how long until every process
// it started is gone and its profile can be removed, when the kill ends Chrome's main process
// alone (what the test helper does today) and when it ends the whole tree (taskkill /T /F).
//
//   node --no-warnings scripts/throwaway/win-close.ts [rounds per arm]
//
// It also checks, with plain node processes standing in for Chrome, what the helper's new test
// stands on: a folder a process is working in cannot be removed, killing that process's parent
// alone does not change that, and killing the tree does.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromeArgs, findChrome } from "../../test/viewer/browser.ts";

const WIN = process.platform === "win32";
const ROUNDS = Number(process.argv[2] ?? 12);
const WATCH_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Proc {
  pid: number;
  ppid: number;
  name: string;
}

function processTable(): Proc[] {
  const r = WIN
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'], { encoding: "utf8" })
    : spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
  const rows: Proc[] = [];
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.trim().split(/[\\/]/).pop()! });
  }
  return rows;
}

/** Every process under `root`, the root left out. */
function descendants(root: number): Proc[] {
  const table = processTable();
  const out: Proc[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const row of table) {
      if (row.ppid === p && row.pid !== root && !out.some((o) => o.pid === row.pid)) {
        out.push(row);
        queue.push(row.pid);
      }
    }
  }
  return out;
}

interface Taskkill {
  status: number | null;
  ms: number;
  lines: number;
  text: string;
}

function taskkill(pid: number): Taskkill {
  const t = performance.now();
  const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { status: r.status, ms: performance.now() - t, lines: text ? text.split(/\r?\n/).length : 0, text: text.slice(0, 200) };
}

type Kill = "process" | "tree";
type When = "running" | "closing";

interface Watch {
  /** ms from the kill until every watched pid was gone; absent if some outlived the watch. */
  goneMs?: number;
  /** ms from the kill until the folder was removed; absent if it never was. */
  removedMs?: number;
  /** Removal attempts that failed. */
  fails: number;
  /** Of those, how many came when every watched pid was already gone. */
  failsAfterGone: number;
  codes: Record<string, number>;
  paths: Record<string, number>;
  survivors: string[];
}

/** From the kill at `t0`: try to remove `dir` every 25 ms with no retries, and watch `pids`. */
async function watch(dir: string, pids: Proc[], t0: number): Promise<Watch> {
  const w: Watch = { fails: 0, failsAfterGone: 0, codes: {}, paths: {}, survivors: [] };
  const deadline = t0 + WATCH_MS;
  for (;;) {
    const left = pids.filter((p) => alive(p.pid));
    if (w.goneMs === undefined && left.length === 0) w.goneMs = performance.now() - t0;
    if (w.removedMs === undefined) {
      try {
        rmSync(dir, { recursive: true });
        w.removedMs = performance.now() - t0;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        w.fails++;
        if (left.length === 0) w.failsAfterGone++;
        const code = err.code ?? "?";
        w.codes[code] = (w.codes[code] ?? 0) + 1;
        const path = err.path ? relative(dir, err.path).split(/[\\/]/).slice(0, 2).join("/") || "." : "?";
        w.paths[path] = (w.paths[path] ?? 0) + 1;
      }
    }
    if (w.goneMs !== undefined && w.removedMs !== undefined) break;
    if (performance.now() > deadline) break;
    await sleep(25);
  }
  for (const p of pids) {
    if (alive(p.pid)) {
      w.survivors.push(`${p.name}:${p.pid}`);
      try {
        process.kill(p.pid);
      } catch {}
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
  return w;
}

function devtools(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start: " + buf.slice(-300))), 180_000);
    child.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}): ${buf.slice(-300)}`));
    });
  });
}

async function chromeRound(chrome: string, kill: Kill, when: When) {
  const dir = mkdtempSync(join(tmpdir(), "csh-exp-"));
  const tStart = performance.now();
  const child = spawn(chrome, chromeArgs(dir), { stdio: ["ignore", "ignore", "pipe"] });
  const url = await devtools(child);
  const startMs = performance.now() - tStart;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("no DevTools socket")));
  });
  // A page with something in it, as a test's Chrome has.
  const made = new Promise<void>((resolve) => ws.addEventListener("message", () => resolve(), { once: true }));
  ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "data:text/html,<title>t</title><p>hello" } }));
  await made;
  await sleep(500);
  const tree = descendants(child.pid!);
  const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
  // "closing": Chrome has been asked to close and is on its way out when the kill lands, which is
  // nearer to the helper's kill (it comes 3 s after Browser.close went unanswered).
  if (when === "closing") ws.send(JSON.stringify({ id: 2, method: "Browser.close" }));
  const t0 = performance.now();
  let tk: Taskkill | undefined;
  if (kill === "tree" && WIN) {
    tk = taskkill(child.pid!);
    if (tk.status !== 0) child.kill("SIGKILL");
  } else {
    child.kill("SIGKILL");
  }
  const killMs = performance.now() - t0;
  await Promise.race([exited, sleep(WATCH_MS)]);
  const exitMs = performance.now() - t0;
  child.stderr?.destroy();
  child.unref();
  try {
    ws.close();
  } catch {}
  const w = await watch(dir, tree, t0);
  // What taskkill says of a process that has gone.
  const again = kill === "tree" && WIN ? taskkill(child.pid!) : undefined;
  return { kind: "chrome", kill, when, startMs, tree: tree.length, names: [...new Set(tree.map((p) => p.name))].join(","), killMs, exitMs, taskkill: tk, taskkillGone: again, ...w };
}

const IDLE = "setInterval(() => {}, 1000)";

/** A node process that starts one more, working in `dir`. Kill it one way or the other. */
async function standInRound(kill: Kill) {
  const dir = mkdtempSync(join(tmpdir(), "csh-exp-in-"));
  const outer = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" }); console.log(c.pid); ${IDLE};`;
  const parent = spawn(process.execPath, ["-e", outer], { stdio: ["ignore", "pipe", "ignore"] });
  const [line] = await once(parent.stdout!, "data");
  const inner = Number(String(line).trim());
  // Before any kill: can the folder be removed while the inner process works in it?
  let removableWhileHeld = false;
  let heldCode = "";
  try {
    rmSync(dir, { recursive: true });
    removableWhileHeld = true;
  } catch (e) {
    heldCode = (e as NodeJS.ErrnoException).code ?? "?";
  }
  const exited = once(parent, "exit");
  const t0 = performance.now();
  let tk: Taskkill | undefined;
  if (kill === "tree" && WIN) {
    tk = taskkill(parent.pid!);
    if (tk.status !== 0) parent.kill("SIGKILL");
  } else {
    parent.kill("SIGKILL");
  }
  await Promise.race([exited, sleep(WATCH_MS)]);
  const exitMs = performance.now() - t0;
  parent.stdout?.destroy();
  // A shorter watch: the inner process, left alone, never goes.
  const pids = [{ pid: inner, ppid: parent.pid!, name: "inner" }];
  const innerAliveAfterKill = alive(inner);
  const started = performance.now();
  let removedMs: number | undefined;
  let fails = 0;
  const codes: Record<string, number> = {};
  // Where the folder went while it was held (anywhere but Windows), there is nothing left to time.
  while (!removableWhileHeld && performance.now() - started < 3000) {
    try {
      rmSync(dir, { recursive: true });
      removedMs = performance.now() - t0;
      break;
    } catch (e) {
      fails++;
      const code = (e as NodeJS.ErrnoException).code ?? "?";
      codes[code] = (codes[code] ?? 0) + 1;
    }
    await sleep(25);
  }
  const innerAliveAtEnd = alive(inner);
  // Then end the inner process by its pid, and see how soon the folder goes.
  let removedAfterInnerKillMs: number | undefined;
  if (innerAliveAtEnd && !removableWhileHeld) {
    const t1 = performance.now();
    try {
      process.kill(inner);
    } catch {}
    while (performance.now() - t1 < 5000) {
      try {
        rmSync(dir, { recursive: true });
        removedAfterInnerKillMs = performance.now() - t1;
        break;
      } catch {}
      await sleep(5);
    }
  }
  for (const p of pids) {
    if (alive(p.pid)) {
      try {
        process.kill(p.pid);
      } catch {}
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
  return { kind: "stand-in", kill, removableWhileHeld, heldCode, exitMs, taskkill: tk, innerAliveAfterKill, innerAliveAtEnd, removedMs, fails, codes, removedAfterInnerKillMs };
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const span = (xs: (number | undefined)[]) => {
  const got = xs.filter((x): x is number => x !== undefined);
  if (!got.length) return `none of ${xs.length}`;
  return `median ${Math.round(med(got))}, min ${Math.round(Math.min(...got))}, max ${Math.round(Math.max(...got))} ms (${got.length} of ${xs.length})`;
};

async function main() {
  console.log(`# platform ${process.platform}, node ${process.version}, ${ROUNDS} rounds per arm`);
  const stand: Awaited<ReturnType<typeof standInRound>>[] = [];
  for (let i = 0; i < Math.min(ROUNDS, 10); i++) {
    for (const kill of ["process", "tree"] as const) {
      const r = await standInRound(kill);
      stand.push(r);
      console.log(`# round ${JSON.stringify(r)}`);
    }
  }
  for (const kill of ["process", "tree"] as const) {
    const rs = stand.filter((r) => r.kill === kill);
    console.log(
      `# stand-in, kill ${kill}: ${rs.length} rounds; folder removable while held ${rs.filter((r) => r.removableWhileHeld).length} (codes ${[...new Set(rs.map((r) => r.heldCode))].join(",")}); ` +
        `inner alive just after the kill ${rs.filter((r) => r.innerAliveAfterKill).length}, after 3 s ${rs.filter((r) => r.innerAliveAtEnd).length}; ` +
        `removed within 3 s ${rs.filter((r) => r.removedMs !== undefined).length}: ${span(rs.map((r) => r.removedMs))}; failed attempts ${rs.reduce((a, r) => a + r.fails, 0)}; ` +
        `after the inner was killed by pid, removed: ${span(rs.filter((r) => r.innerAliveAtEnd).map((r) => r.removedAfterInnerKillMs))}`,
    );
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log("# no Chrome found");
    process.exitCode = 1;
    return;
  }
  console.log(`# chrome ${chrome}`);
  const arms: [Kill, When][] = [
    ["process", "running"],
    ["tree", "running"],
    ["process", "closing"],
    ["tree", "closing"],
  ];
  const rounds: Awaited<ReturnType<typeof chromeRound>>[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    // Each round runs the four arms, starting one further along each time.
    for (let k = 0; k < arms.length; k++) {
      const [kill, when] = arms[(i + k) % arms.length]!;
      const r = await chromeRound(chrome, kill, when);
      rounds.push(r);
      console.log(`# round ${JSON.stringify(r)}`);
    }
  }
  const sum = (o: Record<string, number>[]) => {
    const t: Record<string, number> = {};
    for (const x of o) for (const [k, v] of Object.entries(x)) t[k] = (t[k] ?? 0) + v;
    return Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k} x${v}`)
      .join(", ");
  };
  for (const [kill, when] of arms) {
    const rs = rounds.filter((r) => r.kill === kill && r.when === when);
    console.log(
      `# chrome, kill ${kill}, ${when}: ${rs.length} rounds; processes under Chrome ${span(rs.map((r) => r.tree)).replace(/ ms/, "")}; ` +
        `start to DevTools ${span(rs.map((r) => r.startMs))}; the kill call ${span(rs.map((r) => r.killMs))}; exit ${span(rs.map((r) => r.exitMs))}; every process gone ${span(rs.map((r) => r.goneMs))}; ` +
        `profile removed ${span(rs.map((r) => r.removedMs))}; removed at the first try ${rs.filter((r) => r.removedMs !== undefined && r.fails === 0).length}; ` +
        `failed attempts ${rs.reduce((a, r) => a + r.fails, 0)}, of them with every process gone ${rs.reduce((a, r) => a + r.failsAfterGone, 0)}; ` +
        `codes: ${sum(rs.map((r) => r.codes)) || "none"}; paths: ${sum(rs.map((r) => r.paths)) || "none"}; survivors killed by pid: ${rs.reduce((a, r) => a + r.survivors.length, 0)}`,
    );
  }
  const tks = rounds.flatMap((r) => (r.taskkill ? [r.taskkill] : []));
  const gone = rounds.flatMap((r) => (r.taskkillGone ? [r.taskkillGone] : []));
  if (tks.length) {
    console.log(`# taskkill on a running Chrome: status ${[...new Set(tks.map((t) => t.status))].join(",")}, ${span(tks.map((t) => t.ms))}, lines ${span(tks.map((t) => t.lines)).replace(/ ms/, "")}`);
    console.log(`# taskkill on a Chrome that has gone: status ${[...new Set(gone.map((t) => t.status))].join(",")}, ${span(gone.map((t) => t.ms))}, says: ${gone[0]?.text ?? ""}`);
  }
}

await main();
