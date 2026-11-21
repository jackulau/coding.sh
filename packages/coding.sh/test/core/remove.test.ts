// src/core/remove.ts: removeSync waits between tries while another process still holds the path.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeSync } from "../../src/core/remove.ts";

const root = mkdtempSync(join(tmpdir(), "remove-"));
after(() => rmSync(root, { recursive: true, force: true }));

const fail = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("removeSync", () => {
  it("removes a folder with files in it, and a path that is not there is fine", () => {
    const dir = join(root, "nested");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "f.txt"), "x");
    removeSync(dir);
    assert.equal(existsSync(dir), false);
    removeSync(dir);
    removeSync(join(root, "never-made"));
  });

  it("waits retryDelay, then twice that, between tries while the path is held", () => {
    let calls = 0;
    const rm = () => {
      calls++;
      if (calls <= 2) throw fail("EBUSY");
    };
    const t0 = performance.now();
    removeSync("held", { maxRetries: 3, retryDelay: 40 }, rm);
    const ms = performance.now() - t0;
    assert.equal(calls, 3);
    // 40 ms, then 80 ms.
    assert.ok(ms >= 110, `waited ${ms} ms between tries, not 120`);
  });

  it("throws at once on a code that waiting cannot fix", () => {
    let calls = 0;
    const rm = () => {
      calls++;
      throw fail("EINVAL");
    };
    assert.throws(() => removeSync("bad", { maxRetries: 5, retryDelay: 1000 }, rm), { code: "EINVAL" });
    assert.equal(calls, 1);
  });

  it("throws the last error once the retries run out", () => {
    let calls = 0;
    const rm = () => {
      calls++;
      throw fail("EPERM", `try ${calls}`);
    };
    assert.throws(() => removeSync("held", { maxRetries: 2, retryDelay: 1 }, rm), { code: "EPERM", message: "try 3" });
    assert.equal(calls, 3);
  });

  // On Node 24 on Windows, rmSync with maxRetries gave up at once with EPERM here and left the
  // folder: its retries did not wait for the other process to let go.
  it("removes a folder once another process lets go of a file in it", { skip: process.platform !== "win32" && "a file held open blocks removal only on Windows", timeout: 30_000 }, async () => {
    const dir = join(root, "locked");
    mkdirSync(join(dir, "Default"), { recursive: true });
    const file = join(dir, "Default", "History");
    writeFileSync(file, "x");
    // No sharing: the way a Chrome helper that is still exiting holds its profile.
    const script = `$f = [System.IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Write-Output locked; Start-Sleep -Milliseconds 600; $f.Close()`;
    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let out = "";
        holder.stdout!.on("data", (d) => {
          out += d;
          if (out.includes("locked")) resolve();
        });
        holder.once("exit", (code) => reject(new Error(`the holder exited (${code}) before it held the file`)));
      });
      assert.throws(() => rmSync(file), /EBUSY|EPERM/, "the file is held");
      removeSync(dir, { maxRetries: 10, retryDelay: 50 });
      assert.equal(existsSync(dir), false);
    } finally {
      holder.kill();
      await exited;
    }
  });
});
