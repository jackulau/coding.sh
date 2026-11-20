import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { dataHome, paths } from "../../src/core/paths.ts";

describe("paths", () => {
  // paths() adds names to the root with the separator instead of join(): every value must be
  // what join() returns, whatever form CODING_SH_HOME or HOME takes.
  const fsRoot = parse(process.cwd()).root;
  const envs: Record<string, NodeJS.ProcessEnv> = {
    absolute: { CODING_SH_HOME: join(fsRoot, "work", "demo", ".coding.sh") },
    "trailing separator": { CODING_SH_HOME: join(fsRoot, "work", "demo") + sep },
    "forward slashes": { CODING_SH_HOME: `${fsRoot}work/demo//data/`.replaceAll("\\", "/") },
    relative: { CODING_SH_HOME: join("data", "..", "home") },
    "the tilde": { CODING_SH_HOME: "~/data", HOME: join(fsRoot, "home", "user") },
    "the file system root": { CODING_SH_HOME: fsRoot },
    "no CODING_SH_HOME": { HOME: join(fsRoot, "home", "user") },
    "a relative HOME": { HOME: "." },
  };
  for (const [name, env] of Object.entries(envs)) {
    it(`gives join()'s values with ${name}`, () => {
      const p = paths(env);
      assert.equal(p.root, dataHome(env));
      const values = Object.entries(p).filter(([key]) => key !== "root");
      assert.ok(values.length >= 30, "every location is checked");
      for (const [key, value] of values) {
        const rel = relative(p.root, value);
        assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), `${key} is inside the root: ${value}`);
        assert.equal(value, join(p.root, ...rel.split(sep)), `${key} is what join() gives`);
      }
    });
  }

  it("keeps each location's name", () => {
    const root = resolve(fsRoot, "work", "demo");
    const p = paths({ CODING_SH_HOME: root });
    assert.equal(p.config, join(root, "config.toml"));
    assert.equal(p.hook, join(root, "bin", "hook.mjs"));
    assert.equal(p.spoolErrors, join(root, "spool", "errors.log"));
    assert.equal(p.ingestLock, join(root, "spool", ".ingest.lock"));
    assert.equal(p.index, join(root, "index.db"));
    assert.equal(paths({ CODING_SH_HOME: fsRoot }).config, join(fsRoot, "config.toml"));
  });
});
