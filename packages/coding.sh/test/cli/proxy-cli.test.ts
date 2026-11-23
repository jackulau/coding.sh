// `coding.sh proxy` through the CLI: a public bind is warned about and its env stays dialable,
// upstream URLs are validated, and the background log keeps one line per call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { stopProxy } from "../../src/cli/commands/proxy.ts";
import { DEFAULT_UPSTREAMS } from "../../src/proxy/server.ts";
import { pidAlive, probeProxy, readProxyState, requestStop, writeProxyState } from "../../src/proxy/state.ts";
import { anthropicStream, call, startUpstream, type Upstream } from "../proxy/_helpers.ts";
import { cleanup, runAsync, runLive, runSync, tmpHome } from "./_run-cli.ts";

const ups: Upstream[] = [];
const homes: ReturnType<typeof tmpHome>[] = [];
after(async () => {
  for (const h of homes) runSync(["proxy", "stop"], h.env, 10_000);
  for (const u of ups) await u.close();
  cleanup();
});
const home = (extra: NodeJS.ProcessEnv = {}) => {
  const h = tmpHome(extra);
  homes.push(h);
  return h;
};
// The CLI a printed command names with tmpHome's env, which sets no SHELL or MSYSTEM.
const BIN = process.platform === "win32" ? "codingsh" : "coding.sh";

/** A port nothing listens on: one the OS picks, closed again. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Ends a proxy a test started, by its pid, when `proxy stop` left it running. */
function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // it exited in between
  }
}

describe("coding.sh proxy status", () => {
  it("with no proxy running names the command that starts one, as the user's shell runs it", () => {
    const h = home();
    const r = runSync(["proxy", "status"], h.env);
    assert.equal(r.status, 1, r.stderr);
    assert.ok((r.stdout + r.stderr).includes(`${BIN} proxy --background`), r.stderr);
    const bash = runSync(["proxy", "status"], { ...h.env, MSYSTEM: "MINGW64" });
    assert.ok((bash.stdout + bash.stderr).includes("coding.sh proxy --background"), bash.stderr);
  });
});

describe("coding.sh proxy --host", () => {
  it("warns that a public bind has no auth and prints env a client can dial", async () => {
    const h = home();
    const p = runLive(["proxy", "--host", "0.0.0.0", "--port", "0"], h.env);
    try {
      await p.waitFor(/Press Ctrl-C/);
      const out = p.out.join("");
      const err = p.err.join("");
      assert.match(err, /no auth/i, err);
      // `export NAME=url` in sh, `$env:NAME = 'url'` in PowerShell or cmd.
      assert.match(out, /ANTHROPIC_BASE_URL(=| = ')http:\/\/127\.0\.0\.1:\d+/);
      assert.match(out, /OPENAI_BASE_URL(=| = ')http:\/\/127\.0\.0\.1:\d+\/v1/);
      assert.doesNotMatch(out, /0\.0\.0\.0/);
    } finally {
      p.child.kill("SIGINT");
    }
  });
});

describe("coding.sh proxy env", () => {
  it("prints export lines in sh, and in PowerShell or cmd the $env: lines `| Invoke-Expression` runs", () => {
    // No proxy runs in this home: the lines name the default port.
    const h = home();
    const lines = (env: NodeJS.ProcessEnv) => {
      const r = runSync(["proxy", "env"], env);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim().split(/\r?\n/);
    };
    const sh = ["export ANTHROPIC_BASE_URL=http://127.0.0.1:4320", "export OPENAI_BASE_URL=http://127.0.0.1:4320/v1"];
    assert.deepEqual(lines({ ...h.env, SHELL: "/bin/bash" }), sh);
    assert.deepEqual(lines({ ...h.env, MSYSTEM: "MINGW64" }), sh);
    // No MSYSTEM or SHELL: PowerShell or cmd on Windows, where an export line does not run.
    const ps = ["$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4320'", "$env:OPENAI_BASE_URL = 'http://127.0.0.1:4320/v1'"];
    assert.deepEqual(lines(h.env), process.platform === "win32" ? ps : sh);
  });

  it("says on stderr when no proxy answers and names the command that starts one; stdout stays the same", async () => {
    // The configured port, where proxy env, proxy --background and proxy status all read it.
    const port = await freePort();
    const h = home();
    mkdirSync(h.env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(h.env.CODING_SH_HOME!, "config.toml"), `[proxy]\nport = ${port}\n`);
    const url = `http://127.0.0.1:${port}`;
    const sh = { ...h.env, SHELL: "/bin/bash" };
    const stdout = `export ANTHROPIC_BASE_URL=${url}\nexport OPENAI_BASE_URL=${url}/v1\n`;
    const note = `! No proxy answers on ${url}. Start it: coding.sh proxy --background\n`;

    let r = runSync(["proxy", "env"], sh);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, stdout);
    assert.equal(r.stderr, note);
    // The command as the user's shell runs it: no SHELL or MSYSTEM is PowerShell or cmd on Windows.
    r = runSync(["proxy", "env"], h.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, `! No proxy answers on ${url}. Start it: ${BIN} proxy --background\n`);
    // --json is the one document, with nothing on stderr.
    r = runSync(["proxy", "env", "--json"], h.env);
    assert.deepEqual(JSON.parse(r.stdout), { url, env: { ANTHROPIC_BASE_URL: url, OPENAI_BASE_URL: `${url}/v1` } });
    assert.equal(r.stderr, "");

    // A proxy started on that port: the same stdout, and no note.
    const started = runSync(["proxy", "--background", "--json"], h.env);
    assert.equal(started.status, 0, started.stderr);
    const { pid, url: running } = JSON.parse(started.stdout) as { pid: number; url: string };
    assert.equal(running, url);
    try {
      r = runSync(["proxy", "env"], sh);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, stdout);
      assert.equal(r.stderr, "");
    } finally {
      const stop = runSync(["proxy", "stop"], h.env, 30_000);
      killIfAlive(pid);
      assert.equal(stop.status, 0, stop.stderr);
    }
    // Stopped: the note is back.
    r = runSync(["proxy", "env"], sh);
    assert.equal(r.stdout, stdout);
    assert.equal(r.stderr, note);
  });
});

describe("coding.sh proxy upstream URLs", () => {
  it("--anthropic-upstream that is not http(s) exits 2 and names the flag", () => {
    const r = runSync(["proxy", "--anthropic-upstream", "api.anthropic.com", "--port", "0"], home().env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--anthropic-upstream/);
  });

  it("[proxy] openai_upstream in config.toml that is not http(s) exits 2 and names the key", () => {
    const h = home();
    mkdirSync(h.env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(h.env.CODING_SH_HOME!, "config.toml"), `[proxy]\nopenai_upstream = "ftp://x"\n`);
    const r = runSync(["proxy", "--port", "0"], h.env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /proxy\.openai_upstream/);
  });
});

describe("coding.sh proxy --background", () => {
  it("keeps one line per call in proxy.log", async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const s of anthropicStream({ text: "ok" })) res.write(s);
      res.end();
    });
    ups.push(up);
    const h = home();
    const r = runSync(["proxy", "--background", "--port", "0", "--anthropic-upstream", up.url, "--json"], h.env);
    assert.equal(r.status, 0, r.stderr);
    const url = JSON.parse(r.stdout).url as string;
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-x" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    const log = join(h.env.CODING_SH_HOME!, "proxy.log");
    let text = "";
    for (let i = 0; i < 40 && !/claude-sonnet-4-5/.test(text); i++) {
      await sleep(100);
      try {
        text = readFileSync(log, "utf8");
      } catch {
        // not written yet
      }
    }
    assert.match(text, /claude-sonnet-4-5\S* 200/, text);
    // Ctrl-C cannot reach a detached process; the log names the command that stops it, as the
    // user's shell runs it (tmpHome sets no SHELL: PowerShell or cmd on Windows).
    assert.ok(text.includes(`Stop with: ${BIN} proxy stop`), text);
    assert.doesNotMatch(text, /Ctrl-C/, text);
  });

  it("on a port in use, says so and names the same background command on a free port", async () => {
    // Another listener holds the port, so the detached proxy can't bind it and exits.
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
    const port = (held.address() as AddressInfo).port;
    try {
      // FORCE_COLOR: the child's error in the log is colored, and is still read.
      const r = await runAsync(["proxy", "--background", "--enforce-budget", "--port", String(port)], { ...home().env, NO_COLOR: undefined, FORCE_COLOR: "1" });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`port ${port} is in use`), r.stderr);
      // --background and --enforce-budget kept, as the user's shell runs it.
      assert.ok(r.stderr.includes(`${BIN} proxy --background --enforce-budget --port 0`), r.stderr);
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
  });

  it("with a budgets.json it can't read, says that rather than only that it did not start", () => {
    const h = home();
    mkdirSync(h.env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(h.env.CODING_SH_HOME!, "budgets.json"), "{not json");
    const r = runSync(["proxy", "--background", "--enforce-budget", "--port", "0"], h.env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Can't read the budgets/, r.stderr);
  });
});

/** Resolves once `check` holds, or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(50);
  }
}

/** `proxy --background` on a free port in `h`: its pid, URL and state file. */
function startBackground(h: ReturnType<typeof tmpHome>, args: string[] = []): { pid: number; url: string; statePath: string } {
  const r = runSync(["proxy", "--background", "--port", "0", ...args, "--json"], h.env);
  assert.equal(r.status, 0, r.stderr);
  const { pid, url } = JSON.parse(r.stdout) as { pid: number; url: string };
  return { pid, url, statePath: join(h.env.CODING_SH_HOME!, "proxy.json") };
}

const messagesBody = JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 5, messages: [{ role: "user", content: "hi" }] });

describe("coding.sh proxy stop", () => {
  it("asks the proxy to stop: a call in flight finishes, then the proxy exits and its state file is gone", async () => {
    const parts = anthropicStream({ text: "finished" });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const up = await startUpstream(async (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(parts[0]);
      await held;
      for (const s of parts.slice(1)) res.write(s);
      res.end();
    });
    ups.push(up);
    const h = home();
    const { pid, url, statePath } = startBackground(h, ["--anthropic-upstream", up.url]);
    try {
      let first: () => void = () => {};
      const started = new Promise<void>((r) => (first = r));
      const inFlight = call(url, { path: "/v1/messages", body: messagesBody, headers: { "content-type": "application/json" }, onChunk: () => first() });
      await started;
      const stopping = runAsync(["proxy", "stop"], h.env, 30_000);
      // The proxy stops listening while the call is still open; then the upstream finishes it.
      await until(async () => !(await probeProxy(url, 500)), 10_000, "the proxy stops listening");
      release();
      const r = await inFlight;
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), parts.join(""));
      const stop = await stopping;
      assert.equal(stop.status, 0, stop.stderr);
      assert.ok(stop.stderr.includes(`Stopped the proxy on ${url}`), stop.stderr);
      assert.doesNotMatch(stop.stderr, /ended/, stop.stderr);
      assert.equal(pidAlive(pid), false);
      assert.equal(existsSync(statePath), false);
      // It was asked, not signalled: its log says so.
      assert.match(readFileSync(join(h.env.CODING_SH_HOME!, "proxy.log"), "utf8"), /Stopping: proxy stop asked/);
    } finally {
      release();
      killIfAlive(pid);
    }
  });

  it("the secret in the state file stops the proxy, which removes that file itself; a wrong one changes nothing", async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    ups.push(up);
    const h = home();
    const { pid, url, statePath } = startBackground(h, ["--anthropic-upstream", up.url]);
    try {
      const { secret } = JSON.parse(readFileSync(statePath, "utf8")) as { secret?: string };
      assert.match(secret ?? "", /^[0-9a-f]{64}$/);
      // Only this user can read it, where the OS has file modes.
      if (process.platform !== "win32") assert.equal(statSync(statePath).mode & 0o777, 0o600);
      // Without it: refused by the proxy, never sent upstream, and the proxy keeps running.
      for (const wrong of ["", "0".repeat(64), secret!.slice(1)]) assert.equal(await requestStop(url, wrong), 403, wrong);
      assert.equal(up.seen.length, 0);
      assert.ok(await probeProxy(url));
      assert.ok(pidAlive(pid));
      assert.ok(existsSync(statePath));
      // With it, and no `proxy stop` to clean up after it.
      assert.equal(await requestStop(url, secret!), 200);
      await until(() => !pidAlive(pid), 10_000, "the proxy exits");
      assert.equal(existsSync(statePath), false);
    } finally {
      killIfAlive(pid);
    }
  });

  it("stops a proxy whose state file has no secret, as an older version wrote it, as before", async () => {
    const h = home();
    const { pid, statePath } = startBackground(h);
    try {
      const old = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      delete old.secret;
      writeFileSync(statePath, JSON.stringify(old));
      const stop = runSync(["proxy", "stop"], h.env, 30_000);
      assert.equal(stop.status, 0, stop.stderr);
      assert.match(stop.stderr, /Stopped the proxy/, stop.stderr);
      assert.equal(pidAlive(pid), false);
      assert.equal(existsSync(statePath), false);
      // Signalled, not asked.
      assert.doesNotMatch(readFileSync(join(h.env.CODING_SH_HOME!, "proxy.log"), "utf8"), /proxy stop asked/);
    } finally {
      killIfAlive(pid);
    }
  });

  it("ends a proxy that was asked to stop and is still running after the wait", async () => {
    const h = home();
    // A process that says yes to the stop request and keeps running, as a proxy whose call does not end.
    const fake = spawn(process.execPath, ["-e", `const s = require("node:http").createServer((q, r) => { q.resume(); r.writeHead(q.url === "/__codingsh/stop" ? 200 : 404).end(); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`], { stdio: ["ignore", "pipe", "ignore"] });
    const exit = once(fake, "exit");
    try {
      const [line] = (await once(fake.stdout!.setEncoding("utf8"), "data")) as [string];
      const port = Number(line.trim());
      const st = { pid: fake.pid!, url: `http://127.0.0.1:${port}`, host: "127.0.0.1", port, startedAt: Date.now(), upstreams: { ...DEFAULT_UPSTREAMS }, secret: "s" };
      await writeProxyState(st, h.env);
      assert.deepEqual(await stopProxy(st, h.env, 300), { cut: true });
      const [, signal] = (await exit) as [number | null, NodeJS.Signals | null];
      // Windows reports no signal for a process it ended.
      if (process.platform !== "win32") assert.equal(signal, "SIGKILL");
      assert.equal(readProxyState(h.env), undefined);
    } finally {
      killIfAlive(fake.pid!);
    }
  });
});
