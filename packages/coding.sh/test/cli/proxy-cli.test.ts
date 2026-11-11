// `coding.sh proxy` from source: a public bind is warned about and its env stays dialable,
// upstream URLs are validated, and the background log keeps one line per call.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { anthropicStream, startUpstream, type Upstream } from "../proxy/_helpers.ts";
import { cleanup, runLive, runSync, tmpHome } from "./_run-source.ts";

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

describe("coding.sh proxy --host", () => {
  it("warns that a public bind has no auth and prints env a client can dial", async () => {
    const h = home();
    const p = runLive(["proxy", "--host", "0.0.0.0", "--port", "0"], h.env);
    try {
      await p.waitFor(/Press Ctrl-C/);
      const out = p.out.join("");
      const err = p.err.join("");
      assert.match(err, /no auth/i, err);
      assert.match(out, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
      assert.match(out, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1/);
      assert.doesNotMatch(out, /0\.0\.0\.0/);
    } finally {
      p.child.kill("SIGINT");
    }
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
    // Ctrl-C cannot reach a detached process; the log names the command that stops it.
    assert.match(text, /Stop with: coding\.sh proxy stop/, text);
    assert.doesNotMatch(text, /Ctrl-C/, text);
  });
});
