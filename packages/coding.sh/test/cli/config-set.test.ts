// `coding.sh config set` edits one key of ~/.coding.sh/config.toml in place.
// INS-1: a key missing from [capture] was written into the [[sinks]] table that
// followed it, silently flipping a metadata-only remote sink to full capture.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { onlyKeyChanged, run, setTomlKey } from "../../src/cli/commands/config.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { loadConfig } from "../../src/core/config.ts";
import { parseToml } from "../../src/core/toml.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WITH_SINK = '[capture]\nredact = ["secrets"]\n\n[[sinks]]\nkind = "otlp"\nendpoint = "http://collector.example:4318"\nmode = "metadata"\n';

function env(): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-config-")));
  roots.push(root);
  return { HOME: root, CODING_SH_HOME: join(root, ".coding.sh"), PATH: process.env.PATH };
}

async function set(e: NodeJS.ProcessEnv, key: string, value: string): Promise<{ code: number | void; stderr: string }> {
  let stderr = "";
  const sink = { write: (s: string) => ((stderr += s), true), isTTY: false };
  const out = new Output({ json: false, env: e, stdout: { write: () => true, isTTY: false }, stderr: sink, stdin: { isTTY: false } });
  const c: CommandContext = { action: "set", flags: {}, positionals: [key, value], rest: [], out, env: e, cwd: e.HOME!, debug: false, signal: new AbortController().signal };
  return { code: await run(c), stderr };
}

describe("config set never writes into a following [[array]] table", () => {
  test("setTomlKey inserts into [capture], not into [[sinks]]", () => {
    const after = setTomlKey(WITH_SINK, "capture", "mode", '"full"');
    const t = parseToml(after) as { capture: Record<string, unknown>; sinks: Record<string, unknown>[] };
    assert.equal(t.capture.mode, "full");
    assert.equal(t.sinks[0]!.mode, "metadata");
  });

  test("setTomlKey inserts a missing [retention] key into [retention] when [[sinks]] follows it", () => {
    const text = "[retention]\nkeepSpoolDays = 7\n\n[[sinks]]\nkind = \"otlp\"\nendpoint = \"http://x\"\n";
    const t = parseToml(setTomlKey(text, "retention", "toolOutputDays", "30")) as { retention: Record<string, unknown>; sinks: Record<string, unknown>[] };
    assert.equal(t.retention.toolOutputDays, 30);
    assert.equal(t.sinks[0]!.toolOutputDays, undefined);
  });

  test("`config set capture.mode full` leaves sinks[0].mode alone", async () => {
    const e = env();
    mkdirSync(e.CODING_SH_HOME!, { recursive: true });
    const file = join(e.CODING_SH_HOME!, "config.toml");
    writeFileSync(file, WITH_SINK);
    await set(e, "capture.mode", "full");
    const c = loadConfig({ env: e });
    assert.equal(c.capture.mode, "full");
    assert.equal(c.sinks[0]!.mode, "metadata");
    assert.match(readFileSync(file, "utf8"), /\[\[sinks\]\]\nkind = "otlp"\nendpoint = "http:\/\/collector\.example:4318"\nmode = "metadata"\n/);
  });

  test("onlyKeyChanged flags an edit that changed another setting", () => {
    const a = { capture: { mode: "metadata" }, sinks: [{ mode: "metadata" }] };
    assert.equal(onlyKeyChanged(a, { capture: { mode: "full" }, sinks: [{ mode: "metadata" }] }, "capture.mode"), true);
    assert.equal(onlyKeyChanged(a, { capture: { mode: "metadata" }, sinks: [{ mode: "full" }] }, "capture.mode"), false);
  });
});
