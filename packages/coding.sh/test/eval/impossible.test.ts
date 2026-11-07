import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { impossibleMutations, isTestPath, readTextFiles, verifierReferencedFiles } from "../../src/eval/impossible.ts";
import { HIDDEN_TEST, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const one = (path: string, text: string, max?: number) => impossibleMutations([{ path, text }], max);

describe("impossibleMutations", () => {
  it("flips the expected value of the first assertion and never touches imports", () => {
    const [m, ...rest] = one("test/add.test.js", HIDDEN_TEST, 1);
    assert.equal(rest.length, 0);
    assert.equal(m?.line, 4);
    assert.equal(m?.after, "assert.equal(add(2, 3), 6);");
    assert.equal(m?.label, "test/add.test.js:4 5→6");
    assert.equal(m?.text, HIDDEN_TEST.replace("assert.equal(add(2, 3), 5);", "assert.equal(add(2, 3), 6);"));
    assert.ok(m?.text.startsWith('import assert from "node:assert/strict";'), "import line unchanged");
  });

  it("yields one mutation per assertion line up to max", () => {
    const ms = one("t.js", HIDDEN_TEST, 5);
    assert.deepEqual(
      ms.map((m) => m.line),
      [4, 5],
    );
    assert.equal(ms[1]?.after, "assert.equal(mul(2, 3), 7);");
  });

  it("prefers the last non-string literal over a trailing failure message", () => {
    assert.equal(one("t.js", 'assert.equal(add(2, 3), 5, "add works");')[0]?.after, 'assert.equal(add(2, 3), 6, "add works");');
    assert.equal(one("t.py", 'assert greet("bob") == "hi bob", "greeting"')[0]?.after, 'assert greet("bob_impossible") == "hi bob", "greeting"');
  });

  it("handles pytest, jest, rust, booleans, floats and big integers", () => {
    assert.equal(one("test_x.py", "def test_add():\n    assert add(2, 3) == 5\n")[0]?.after, "    assert add(2, 3) == 6");
    assert.equal(one("x.test.ts", 'expect(name()).toBe("ada");')[0]?.after, 'expect(name()).toBe("ada_impossible");');
    assert.equal(one("x.rs", "    assert_eq!(add(2, 3), 5);")[0]?.after, "    assert_eq!(add(2, 3), 6);");
    assert.equal(one("x.py", "    assert is_even(4) is True")[0]?.after, "    assert is_even(4) is False");
    assert.equal(one("x.js", "assert.equal(isEven(x), false);")[0]?.after, "assert.equal(isEven(x), true);");
    assert.equal(one("x.js", "assert.equal(half(3), 1.5);")[0]?.after, "assert.equal(half(3), 2.5);");
    assert.equal(one("x.js", "assert.equal(big(), 9007199254740993);")[0]?.after, "assert.equal(big(), 9007199254740994);");
  });

  it("skips comments, imports, requires and assertions without literals", () => {
    const text = [
      'const assert = require("node:assert");',
      "// assert.equal(add(2, 3), 5);",
      "# assert add(2, 3) == 5",
      "from x import assert_close",
      "assert.ok(add(two, three) === five);",
    ].join("\n");
    assert.deepEqual(one("t.js", text), []);
  });

  it("does not flip numbers glued to identifiers", () => {
    assert.equal(one("t.js", "assert.equal(v2.add(x1), 5);")[0]?.after, "assert.equal(v2.add(x1), 6);");
  });
});

describe("verifierReferencedFiles", () => {
  it("finds files and test files under directories the verifier names, minus hidden ones", async () => {
    const dir = await tempDir("csh-imp-");
    dirs.push(dir);
    await mkdir(join(dir, "tests", "unit"), { recursive: true });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "tests", "unit", "test_a.py"), "assert 1 == 1\n");
    await writeFile(join(dir, "tests", "helpers.py"), "x = 1\n");
    await writeFile(join(dir, "check.sh"), "exit 0\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "add.js"), "x\n");
    await writeFile(join(dir, "verify_test.go"), "x\n");
    await writeFile(join(dir, "hidden.test.js"), "x\n");
    await writeFile(join(dir, "node_modules", "x", "a.test.js"), "x\n");
    const got = await verifierReferencedFiles(dir, "bash ./check.sh && grep -q 'a + b' src/add.js && python -m pytest tests/ -q && go test verify_test.go && node hidden.test.js --flag=1 missing.js", new Set(["hidden.test.js"]));
    assert.deepEqual(got, ["tests/unit/test_a.py", "verify_test.go"], "source files and plain scripts are not test files");
    assert.deepEqual(await verifierReferencedFiles(dir, "cat ../../etc/passwd /etc/passwd", new Set()), []);
    const texts = await readTextFiles(dir, [...got, "nope.txt"]);
    assert.deepEqual(
      texts.map((t) => t.path),
      got,
    );
  });
});

describe("isTestPath", () => {
  it("recognises test files by name or directory", () => {
    for (const p of ["test/add.js", "tests/x.py", "src/__tests__/a.ts", "a.test.ts", "a.spec.js", "test_a.py", "a_test.go", "spec/models/user_spec.rb"]) assert.ok(isTestPath(p), p);
    for (const p of ["src/add.js", "check.sh", "Makefile", "src/contest.js", "latest.txt"]) assert.ok(!isTestPath(p), p);
  });
});
