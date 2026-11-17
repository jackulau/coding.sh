// A repo's own .coding.sh/config.toml arrives with git clone, so its redactPatterns are literal
// text to redact. Regular expressions count only from the user's own config.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../src/core/config.ts";
import { createRedactor } from "../../src/core/redact.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(userToml: string, repoToml: string) {
  const root = mkdtempSync(join(tmpdir(), "csh-repo-patterns-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "data"), HOME: join(root, "user") };
  const repo = join(env.HOME, "code", "repo");
  mkdirSync(env.CODING_SH_HOME, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".coding.sh"), { recursive: true });
  writeFileSync(join(env.CODING_SH_HOME, "config.toml"), userToml);
  writeFileSync(join(repo, ".coding.sh", "config.toml"), repoToml);
  const c = loadConfig({ env, cwd: repo });
  return createRedactor({ redact: c.capture.redact, patterns: c.capture.redactPatterns });
}

describe("redactPatterns from a repo's config", { timeout: 20_000 }, () => {
  it("match as literal text", () => {
    const r = setup(`[capture]\nredact = ["none"]\n`, `[capture]\nredactPatterns = ["acme.internal", "ID-[0-9]+"]\n`);
    assert.equal(r.string("host acme.internal, not acmexinternal"), "host [redacted:pattern], not acmexinternal");
    assert.equal(r.string("ID-123 and ID-[0-9]+"), "ID-123 and [redacted:pattern]");
  });
  it("a pattern that would backtrack forever is plain text", () => {
    const r = setup(`[capture]\nredact = ["none"]\n`, `[capture]\nredactPatterns = ["(a+)+$", ".*"]\n`);
    const s = "a".repeat(40) + "!";
    const t = performance.now();
    assert.equal(r.string(s), s);
    assert.ok(performance.now() - t < 200, `${Math.round(performance.now() - t)} ms`);
  });
  it("a pattern that is not a valid regular expression, or is empty, still loads", () => {
    const r = setup(`[capture]\nredact = ["none"]\n`, `[capture]\nredactPatterns = ["f(x", "", "[a"]\n`);
    assert.equal(r.string("call f(x) or [a] here"), "call [redacted:pattern]) or [redacted:pattern]] here");
  });
  it("the user's own config still takes regular expressions", () => {
    const r = setup(`[capture]\nredact = ["none"]\nredactPatterns = ["ID-[0-9]+"]\n`, `[capture]\nredactPatterns = ["acme.internal"]\n`);
    assert.equal(r.string("ID-123 at acme.internal"), "[redacted:pattern] at [redacted:pattern]");
  });
});
