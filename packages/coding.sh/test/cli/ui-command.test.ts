import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { run } from "../../src/cli/commands/ui.ts";
import { Output } from "../../src/cli/output.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

async function startUi(stdoutTTY: boolean): Promise<{ stdout: string; stderr: string; code: number }> {
  const root = mkdtempSync(join(tmpdir(), "csh-ui-"));
  roots.push(root);
  const env = { ...process.env, CODING_SH_HOME: join(root, "home"), HOME: join(root, "user"), NO_COLOR: "1", CI: "1" };
  let stdout = "";
  let stderr = "";
  const out = new Output({ env, stdout: { write: (s: string) => (stdout += s), isTTY: stdoutTTY }, stderr: { write: (s: string) => (stderr += s), isTTY: stdoutTTY }, stdin: { isTTY: false } });
  const ac = new AbortController();
  const done = run({ flags: { port: "0", open: false }, positionals: [], rest: [], out, env, cwd: root, debug: false, signal: ac.signal });
  for (let i = 0; i < 200 && !stderr.includes("Ctrl-C"); i++) await new Promise((r) => setTimeout(r, 25));
  ac.abort();
  return { code: await done, stdout, stderr };
}

describe("coding.sh ui", () => {
  test("prints the viewer URL once in a terminal", async () => {
    const r = await startUi(true);
    assert.equal(r.code, 130);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=/g)?.length, 1, r.stderr);
  });

  test("piped, the URL alone is on stdout", async () => {
    const r = await startUi(false);
    assert.match(r.stdout, /^http:\/\/127\.0\.0\.1:\d+\/\?t=\S+\n$/);
    assert.match(r.stderr, /Ready on http/);
  });
});
