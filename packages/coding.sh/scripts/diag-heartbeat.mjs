// DIAGNOSTICS ONLY (throwaway branch). A process of its own, started by test-ci.mjs. Twice a
// second it logs how late its timer fired. Once a second it times: a trivial process start
// (cmd /c exit), a Node start (node -e ""), a new small file written and read back, one small
// read of chrome.dll at a random offset, and the machine's CPU split. With CSH_DIAG_CHROME_PROBE=1
// it also runs a whole headless Chrome to its own exit every 5 s.
import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { cpus, freemem, tmpdir } from "node:os";
import { join, dirname } from "node:path";

const dir = process.env.CSH_TRACE_DIR;
mkdirSync(dir, { recursive: true });
const fd = openSync(join(dir, "heartbeat.jsonl"), "a");
const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
const log = (ev, data) => writeSync(fd, JSON.stringify({ t: now(), ev, ...data }) + "\n");
const win = process.platform === "win32";
const chrome = process.env.CODING_SH_TEST_CHROME || (win ? join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : "/usr/bin/google-chrome");
let dll;
try {
  const app = dirname(chrome);
  for (const d of readdirSync(app)) {
    try {
      const p = join(app, d, "chrome.dll");
      statSync(p);
      dll = p;
    } catch {}
  }
} catch {}
const dllSize = dll ? statSync(dll).size : 0;
log("hb-start", { chrome, dll, dllSize, cpu: cpus()[0]?.model, ncpu: cpus().length });

const timed = (cmd, args, limit = 30_000) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    let spawned = -1;
    const c = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    c.once("spawn", () => (spawned = performance.now() - t0));
    const k = setTimeout(() => c.kill("SIGKILL"), limit);
    c.once("error", (e) => {
      clearTimeout(k);
      resolve({ ms: Math.round(performance.now() - t0), err: String(e.message).slice(0, 80) });
    });
    c.once("exit", (code) => {
      clearTimeout(k);
      resolve({ ms: Math.round((performance.now() - t0) * 10) / 10, spawnMs: Math.round(spawned * 10) / 10, code });
    });
  });

let lastTick = performance.now();
setInterval(() => {
  const t = performance.now();
  const late = t - lastTick - 500;
  if (late > 100) log("hb-late", { ms: Math.round(late) });
  lastTick = t;
}, 500);

let prev = cpuTotals();
function cpuTotals() {
  const s = { user: 0, sys: 0, idle: 0, irq: 0 };
  for (const c of cpus()) {
    s.user += c.times.user;
    s.sys += c.times.sys;
    s.idle += c.times.idle;
    s.irq += c.times.irq;
  }
  return s;
}

const probeDir = join(tmpdir(), "csh-diag-probe");
mkdirSync(probeDir, { recursive: true });
const src = readFileSync(new URL(import.meta.url));
let n = 0;
let busy = false;
setInterval(async () => {
  if (busy) return log("hb-skip", {});
  busy = true;
  n++;
  const cur = cpuTotals();
  const d = { user: cur.user - prev.user, sys: cur.sys - prev.sys, idle: cur.idle - prev.idle, irq: cur.irq - prev.irq };
  prev = cur;
  const tot = d.user + d.sys + d.idle + d.irq || 1;
  // A new file with script content, written, synced, closed and read back.
  let t0 = performance.now();
  const f = join(probeDir, `probe-${n % 50}.mjs`);
  let fileMs = -1;
  try {
    const wfd = openSync(f, "w");
    writeSync(wfd, src);
    fsyncSync(wfd);
    closeSync(wfd);
    readFileSync(f);
    fileMs = Math.round((performance.now() - t0) * 10) / 10;
  } catch {}
  // One 4 KB read of chrome.dll at a random offset: slow when the file is not in memory.
  let dllMs = -1;
  if (dll) {
    try {
      t0 = performance.now();
      const rfd = openSync(dll, "r");
      readSync(rfd, Buffer.alloc(4096), 0, 4096, Math.floor(Math.random() * (dllSize - 4096)));
      closeSync(rfd);
      dllMs = Math.round((performance.now() - t0) * 100) / 100;
    } catch {}
  }
  const cmd = win ? await timed("cmd.exe", ["/d", "/c", "exit"]) : await timed("/bin/true", []);
  const node = await timed(process.execPath, ["-e", ""]);
  log("hb", { user: Math.round((100 * d.user) / tot), sys: Math.round((100 * d.sys) / tot), idle: Math.round((100 * d.idle) / tot), freeMb: Math.round(freemem() / 1048576), fileMs, dllMs, cmdMs: cmd.ms, cmdSpawnMs: cmd.spawnMs, nodeMs: node.ms, nodeSpawnMs: node.spawnMs });
  if (process.env.CSH_DIAG_CHROME_PROBE === "1" && n % 5 === 0) {
    const pd = join(probeDir, `profile-${n}`);
    const r = await timed(chrome, ["--headless=new", `--user-data-dir=${pd}`, "--no-first-run", "--disable-gpu", "--disable-extensions", "--no-proxy-server", "--use-mock-keychain", "--password-store=basic", "--dump-dom", "about:blank"]);
    log("hb-chrome", r);
    try {
      rmSync(pd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
  busy = false;
}, 1000);
process.on("SIGTERM", () => process.exit(0));
