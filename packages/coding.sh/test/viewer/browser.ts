// Tiny headless-Chrome driver for viewer UI tests, over the DevTools protocol
// with Node's built-in WebSocket (no dependencies). Tests skip when no Chrome
// or Chromium is installed; set CODING_SH_TEST_CHROME to pick a binary (CI does,
// and then a missing binary fails the run instead of skipping the tests).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data));
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
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.ws.close();
  }
}

export interface Page {
  goto(url: string): Promise<void>;
  /** Evaluate an expression (awaited) and return its JSON value. */
  eval<T = any>(expr: string): Promise<T>;
  /** Poll an expression until it is truthy; returns its value. */
  waitFor<T = any>(expr: string, what?: string, timeoutMs?: number): Promise<T>;
  viewport(width: number, height: number, mobile?: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export async function launchBrowser(chrome: string): Promise<Browser> {
  const dir = mkdtempSync(join(tmpdir(), "csh-chrome-"));
  const child: ChildProcess = spawn(
    chrome,
    [
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
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start: " + buf.slice(-500))), 20_000);
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
      reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`));
    });
  });
  const cdp = await Cdp.connect(wsUrl);

  return {
    async newPage() {
      const { browserContextId } = await cdp.send("Target.createBrowserContext");
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (m: string, p?: Record<string, unknown>) => cdp.send(m, p, sessionId);
      await send("Page.enable");
      await send("Runtime.enable");
      const page: Page = {
        async goto(url) {
          await send("Page.navigate", { url });
          await page.waitFor("document.readyState === 'complete' && location.href !== 'about:blank'", "page load");
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
        async close() {
          await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
          await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        },
      };
      return page;
    },
    async close() {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      // On Windows, Chrome's helpers can hold the profile for a moment after it exits.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
    },
  };
}
