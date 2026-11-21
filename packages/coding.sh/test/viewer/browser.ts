// Tiny headless-Chrome driver for viewer UI tests, over the DevTools protocol
// with Node's built-in WebSocket (no dependencies). Tests skip when no Chrome
// or Chromium is installed; set CODING_SH_TEST_CHROME to pick a binary (CI does,
// and then a missing binary fails the run instead of skipping the tests).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where Chrome installs on Windows: machine-wide (64- and 32-bit) and per user. */
export function windowsChromePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
    .filter((d): d is string => !!d)
    .map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"));
}

export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pick = env.CODING_SH_TEST_CHROME;
  if (pick) {
    if (!existsSync(pick)) throw new Error(`CODING_SH_TEST_CHROME=${pick} does not exist`);
    return pick;
  }
  const known =
    platform === "win32"
      ? windowsChromePaths(env)
      : [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return known.find((p) => existsSync(p));
}

/** Longest a DevTools call may wait for its answer; a page eval that awaits a slow promise stays well under it. */
const SEND_TIMEOUT_MS = 30_000;

/** Keys Page.press knows beyond single characters: the DOM code, the virtual key code, and the text a key types (none for a navigation key). */
const NAMED_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  " ": { code: "Space", vk: 32, text: " " },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  End: { code: "End", vk: 35 },
  Home: { code: "Home", vk: 36 },
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  private ws: WebSocket;
  private closed = false;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    // Chrome can close the socket before it answers (Browser.close does on Windows). Fail the
    // calls still waiting, or a test waits on them until the CI job's time limit cancels it.
    const fail = () => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error("CDP connection closed before Chrome answered"));
      }
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.method) for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`CDP ${method}: the connection is closed`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method}: no answer from Chrome in ${SEND_TIMEOUT_MS / 1000} s`));
      }, SEND_TIMEOUT_MS);
      const done = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
        clearTimeout(timer);
        f(...a);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** Every protocol event, from any target; returns an unsubscribe. */
  on(fn: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close() {
    this.ws.close();
  }
}

export interface Page {
  /** Navigate and wait for the page to finish loading, for at most `timeoutMs` (5000). */
  goto(url: string, timeoutMs?: number): Promise<void>;
  /** Evaluate an expression (awaited) and return its JSON value. */
  eval<T = any>(expr: string): Promise<T>;
  /** Poll an expression until it is truthy; returns its value. */
  waitFor<T = any>(expr: string, what?: string, timeoutMs?: number): Promise<T>;
  viewport(width: number, height: number, mobile?: boolean): Promise<void>;
  /**
   * Press and release a key as a person would ("Enter", " ", "ArrowDown", "j"). Chrome runs the key's
   * default action (a button's click, a scroll), which a KeyboardEvent dispatched from the page never does.
   */
  press(key: string): Promise<void>;
  /** Uncaught exceptions and console.error calls on this page so far. */
  errors: string[];
  /** A raw DevTools call on this page (Input.dispatchMouseEvent, Network.emulateNetworkConditions, ...). */
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/** What Browser.close did, step by step, so a slow close names the step that took the time. */
export interface CloseSteps {
  /** The whole close. */
  ms: number;
  /** Browser.close until Chrome answered or dropped the socket. */
  askMs: number;
  /** The wait for chrome to exit after that; 3 s at most. */
  exitMs: number;
  /** Chrome was still running after the wait and was killed. */
  killed: boolean;
  /** Removing the profile directory, retries included. */
  profileMs: number;
  /** The profile directory could not be removed and was left behind. */
  profileLeft: boolean;
}

/** A close slower than this prints its steps. */
const SLOW_CLOSE_MS = 2000;

/**
 * Prints a slow close's steps on stderr. Not stdout: that is the result of a script that starts
 * a browser (scripts/warm-chrome.ts prints one line there). A test file's stderr is in the test
 * output all the same.
 */
export function noteClose(steps: CloseSteps): void {
  if (steps.ms > SLOW_CLOSE_MS) console.error(`# slow Chrome close, ${describeClose(steps)}`);
}

export function describeClose(s: CloseSteps): string {
  return (
    `${Math.round(s.ms)} ms: Browser.close ${Math.round(s.askMs)} ms, ` +
    `exit ${Math.round(s.exitMs)} ms${s.killed ? " (killed after the wait)" : ""}, ` +
    `profile removal ${Math.round(s.profileMs)} ms${s.profileLeft ? " (left behind)" : ""}`
  );
}

export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<CloseSteps>;
}

/** What a page load had done when its time ran out. */
export interface LoadWait {
  /** From the call of goto to the timeout. */
  waitedMs: number;
  /** How long Chrome took to answer Page.navigate. */
  navigateMs: number;
  /** How many times the page was asked for its state, and the longest it took to answer. */
  checks: number;
  slowestCheckMs: number;
  /** The last answer, or why there was none. */
  readyState?: string;
  href?: string;
  error?: string;
}

/**
 * The error of a page load that ran out of time. It says where the time went: in Page.navigate,
 * in a page that did not answer (its main thread was busy or blocked), or in a load that answered
 * and did not finish.
 */
export function loadTimeoutMessage(w: LoadWait): string {
  const span = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const last = w.error !== undefined ? `the last failed: ${w.error}` : `the last saw readyState ${JSON.stringify(w.readyState)} at ${w.href}`;
  return `timed out waiting for page load after ${span(w.waitedMs)}: Page.navigate took ${span(w.navigateMs)}, then ${w.checks} ${w.checks === 1 ? "check" : "checks"} of the page, the slowest took ${span(w.slowestCheckMs)}; ${last}`;
}

/** The flags launchBrowser starts Chrome with, for a profile in `dir`. */
export function chromeArgs(dir: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--no-pings",
    "--metrics-recording-only",
    "--mute-audio",
    // Keep Chrome out of the macOS keychain: under a test HOME it has none, and the lookup
    // pops a "keychain cannot be found" dialog on the desktop for every launch.
    "--use-mock-keychain",
    "--password-store=basic",
    // The viewer is on 127.0.0.1. Without this, a new Chrome on Windows asks the system for its
    // proxy settings before the first page load, and that took 0.6-1.7 s on CI runners.
    "--no-proxy-server",
    // Root (the desk, CI containers) cannot use Chrome's sandbox.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

/** Chrome prints this when it will not open DevTools, and then never says where they listen. */
const DEBUGGING_REFUSED = "requires a non-default data directory";

/**
 * The error of a start that failed, with the end of Chrome's stderr. On Windows, Chrome refuses
 * remote debugging, --user-data-dir or not, when USERPROFILE names a folder with no AppData\Local
 * in it, as a test home can; the error says so.
 */
export function startFailureMessage(what: string, stderr: string, platform: NodeJS.Platform = process.platform): string {
  const message = `${what}: ${stderr.slice(-500)}`;
  if (platform !== "win32" || !stderr.includes(DEBUGGING_REFUSED)) return message;
  return `${message}\nChrome says this when USERPROFILE names a folder with no AppData\\Local in it, as a test home can. Make that folder (scripts/gate.mjs does).`;
}

/** Where Chrome's DevTools listen, from its stderr. Fails on an exit, a refusal, or no answer in 20 s. */
function devToolsUrl(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
    };
    const fail = (what: string) => {
      if (settled) return;
      settle();
      reject(new Error(startFailureMessage(what, buf)));
    };
    const timer = setTimeout(() => fail("Chrome did not start in 20 s"), 20_000);
    child.stderr!.on("data", (d: Buffer) => {
      if (settled) return;
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        settle();
        resolve(m[1]!);
      } else if (buf.includes(DEBUGGING_REFUSED)) fail("Chrome refused remote debugging");
    });
    child.once("exit", (code, signal) => fail(`Chrome exited (${code ?? signal})`));
    // A binary that cannot be run. Unheard, the error event would end the test file.
    child.on("error", (e) => {
      settle();
      reject(e);
    });
  });
}

/** Stops a Chrome whose start failed, if it still runs, and removes its profile. */
async function abandonStart(child: ChildProcess | undefined, dir: string): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.kill("SIGKILL");
    await exited;
  }
  child?.stderr?.destroy();
  child?.unref();
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
}

/**
 * Starts Chrome on a new profile and connects to it. A start that fails (an exit, a refusal, the
 * 20 s limit, a binary that cannot run, a socket that will not open) stops Chrome and removes the
 * profile before it throws, so a test run that cannot start Chrome leaves neither behind.
 */
async function startChrome(chrome: string): Promise<{ child: ChildProcess; cdp: Cdp; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "csh-chrome-"));
  let child: ChildProcess | undefined;
  try {
    child = spawn(chrome, chromeArgs(dir), { stdio: ["ignore", "ignore", "pipe"] });
    const cdp = await Cdp.connect(await devToolsUrl(child));
    return { child, cdp, dir };
  } catch (e) {
    await abandonStart(child, dir);
    throw e;
  }
}

export async function launchBrowser(chrome: string): Promise<Browser> {
  const { child, cdp, dir } = await startChrome(chrome);

  return {
    async newPage() {
      const { browserContextId } = await cdp.send("Target.createBrowserContext");
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (m: string, p?: Record<string, unknown>) => cdp.send(m, p, sessionId);
      const errors: string[] = [];
      const off = cdp.on((method, params, sid) => {
        if (sid !== sessionId) return;
        if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception");
        else if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push((params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" "));
      });
      await send("Page.enable");
      await send("Runtime.enable");
      const page: Page = {
        errors,
        send,
        async goto(url, timeoutMs = 5000) {
          const t0 = performance.now();
          await send("Page.navigate", { url });
          const navigateMs = performance.now() - t0;
          // The loop of waitFor, keeping what a timeout has to say.
          const deadline = Date.now() + timeoutMs;
          let checks = 0;
          let slowestCheckMs = 0;
          for (;;) {
            const t1 = performance.now();
            const seen: { readyState?: string; href?: string; error?: string } = await page
              .eval("({ readyState: document.readyState, href: location.href })")
              .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
            checks++;
            slowestCheckMs = Math.max(slowestCheckMs, performance.now() - t1);
            if (seen.readyState === "complete" && seen.href !== "about:blank") return;
            if (Date.now() > deadline) throw new Error(loadTimeoutMessage({ waitedMs: performance.now() - t0, navigateMs, checks, slowestCheckMs, ...seen }));
            await new Promise((r) => setTimeout(r, 40));
          }
        },
        async eval(expr) {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value;
        },
        async waitFor(expr, what, timeoutMs = 5000) {
          const deadline = Date.now() + timeoutMs;
          let last: unknown;
          for (;;) {
            last = await page.eval(`(() => { try { return (${expr}); } catch (e) { return null; } })()`).catch(() => null);
            if (last) return last as any;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what ?? expr}`);
            await new Promise((r) => setTimeout(r, 40));
          }
        },
        async viewport(width, height, mobile = false) {
          await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
          await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
        },
        async press(key) {
          const named = NAMED_KEYS[key];
          const code = named ? named.code : /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : "";
          const vk = named ? named.vk : key.toUpperCase().charCodeAt(0);
          const text = named ? named.text : key;
          const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
          // A headless page is not the focused window until told so, and an unfocused page gets no keys.
          await send("Emulation.setFocusEmulationEnabled", { enabled: true });
          await send("Input.dispatchKeyEvent", text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        },
        async close() {
          off();
          await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
          await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        },
      };
      return page;
    },
    async close() {
      const t0 = performance.now();
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
      const t1 = performance.now();
      const killed = await new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) return resolve(false);
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(true);
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve(false);
        });
      });
      const t2 = performance.now();
      // On Windows, Chrome's helper processes can outlive chrome.exe and keep its stderr pipe
      // open. Let go of the pipe and the child, or this test file's process never exits.
      child.stderr?.destroy();
      child.unref();
      // On Windows, Chrome's helpers can hold the profile for a moment after it exits. The async
      // rm waits between tries; on Node 24 on Windows, rmSync gave up at once with EPERM.
      let profileLeft = false;
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        profileLeft = true;
      }
      const t3 = performance.now();
      const steps: CloseSteps = { ms: t3 - t0, askMs: t1 - t0, exitMs: t2 - t1, killed, profileMs: t3 - t2, profileLeft };
      noteClose(steps);
      return steps;
    },
  };
}
