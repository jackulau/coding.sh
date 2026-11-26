// The hook's stdin cap (src/spool/hook-run.ts): the hook keeps the first 64 MB of a payload and logs
// a cut only when stdin holds more than that. Each call runs in-process on chosen bytes against a
// data dir of its own.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SpoolLine } from "../../src/core/types.ts";
import { MAX_STDIN_BYTES, runHook, type HookIO } from "../../src/spool/hook-run.ts";

const root = mkdtempSync(join(tmpdir(), "csh-hookrun-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** One Claude Code hook call on `stdin`, with a data dir of its own, which it returns. */
async function call(name: string, stdin: Buffer): Promise<string> {
  const home = join(root, name);
  let pos = 0;
  const io: HookIO = {
    env: { HOME: join(root, "home"), CODING_SH_HOME: home },
    read(buf) {
      const n = Math.min(buf.length, stdin.length - pos);
      stdin.copy(buf, 0, pos, pos + n);
      pos += n;
      return n;
    },
    isCharDevice: () => false,
    write: () => {},
    pid: 4242,
    ppid: 4241,
    cwd: () => "/work/demo",
  };
  await runHook(["claude-code", "PostToolUse"], io);
  assert.equal(pos, stdin.length, "the hook reads stdin to the end");
  return home;
}

/** `size` bytes of a JSON object with a cwd and one long string. */
function payload(size: number): Buffer {
  const out = Buffer.alloc(size, "x");
  out.write('{"cwd":"/big","pad":"');
  out.write('"}', size - 2);
  return out;
}

/** The one line the call wrote, the side file it names, and the error of each spool/errors.log entry. */
function stored(home: string): { line: SpoolLine; side: Buffer; errors: string[] } {
  const dir = join(home, "spool", "claude-code");
  const lines = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!) as SpoolLine;
  assert.ok(line.rawFile, "the line names a side file");
  const sides = readdirSync(join(dir, "raw"));
  assert.equal(sides.length, 1);
  const log = join(home, "spool", "errors.log");
  const errors = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => String((JSON.parse(l) as { error?: unknown }).error)) : [];
  return { line, side: readFileSync(join(dir, "raw", sides[0]!)), errors };
}

test("a stdin of exactly 64 MB is kept whole and logs no cut; one byte more is cut at 64 MB and logged", async () => {
  const whole = payload(MAX_STDIN_BYTES);
  const kept = stored(await call("exact", whole));
  assert.equal(kept.line.cwd, "/big");
  assert.ok(kept.side.equals(whole), "the side file holds the whole payload");
  assert.deepEqual(kept.errors, []);

  const over = payload(MAX_STDIN_BYTES + 1);
  const cut = stored(await call("over", over));
  assert.equal(cut.line.cwd, "/big");
  assert.ok(cut.side.equals(over.subarray(0, MAX_STDIN_BYTES)), "the side file holds the first 64 MB");
  assert.deepEqual(cut.errors, [`stdin truncated at ${MAX_STDIN_BYTES} bytes`]);
});
