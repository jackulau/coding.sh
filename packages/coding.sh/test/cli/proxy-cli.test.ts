// `coding.sh proxy` through the CLI: a public bind is warned about and its env stays dialable,
// upstream URLs are validated, and the background log keeps one line per call.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { anthropicStream, startUpstream, type Upstream } from "../proxy/_helpers.ts";
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
