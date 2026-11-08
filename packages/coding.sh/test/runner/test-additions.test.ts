// The tamper check on edits that only add tests: real git diffs of real
// before/after files, so the hunks (and where git places a moved `});`) are
// what a run produces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { diffWorkdir } from "../../src/core/snapshot.ts";
import { detectTamper, type TamperOpts } from "../../src/runner/tamper.ts";
import { onlyAddsTests, patchHunks } from "../../src/runner/test-additions.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GIT = ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false"];

/** Commit `before`, write `after`, and run the tamper check on the work tree's real diff. */
async function check(before: Record<string, string>, afterFiles: Record<string, string | null>, opts: TamperOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "csh-addtests-"));
  dirs.push(dir);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(before)) put(rel, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", [...GIT, "add", "-A"], { cwd: dir });
  execFileSync("git", [...GIT, "commit", "-q", "-m", "start"], { cwd: dir });
  for (const [rel, text] of Object.entries(afterFiles)) {
    if (text === null) rmSync(join(dir, rel));
    else put(rel, text);
  }
  const diff = await diffWorkdir(dir);
  const readFile = (p: string) => {
    try {
      return readFileSync(join(dir, p), "utf8");
    } catch {
      return undefined;
    }
  };
  return detectTamper(diff, { readFile, ...opts });
}

/** One test file edited from `a` to `b`: the flags as [kind, path], and the paths only added to. */
async function one(path: string, a: string, b: string, opts: TamperOpts = {}) {
  const r = await check({ [path]: a }, { [path]: b }, opts);
  return { kinds: r.flags.map((f) => f.kind), added: r.addedTests ?? [] };
}

const additive = async (path: string, a: string, b: string, opts: TamperOpts = {}) => {
  const r = await one(path, a, b, opts);
  assert.deepEqual(r, { kinds: [], added: [path] }, `${path} should be a pure addition:\n${b}`);
};
const flagged = async (path: string, a: string, b: string, kinds: string[] = ["edit"]) => {
  const r = await one(path, a, b);
  assert.deepEqual(r.kinds, kinds, `${path} should be flagged ${kinds.join(",")}:\n${b}`);
  assert.deepEqual(r.added, []);
};

const JS = `import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.js";

describe("add", () => {
  it("adds", () => {
    assert.equal(add(2, 3), 5);
  });

  it("adds negatives", () => {
    assert.equal(add(-2, -3), -5);
  });
});
`;

const PY = `import pytest
from calc import add


def test_add():
    assert add(2, 3) == 5


class TestNeg:
    def test_neg(self):
        assert add(-2, -3) == -5
`;

describe("pure additions to an existing test file are not tamper", () => {
  it("JS: a regression test at the end of the describe, a new describe, a test at the end of the file", async () => {
    await additive("test/add.test.js", JS, JS.replace(`    assert.equal(add(-2, -3), -5);\n  });\n`, `    assert.equal(add(-2, -3), -5);\n  });\n\n  it("adds zero (regression #12)", () => {\n    assert.equal(add(0, 0), 0);\n  });\n`));
    await additive("test/add.test.js", JS, `${JS}\ndescribe("add edge cases", () => {\n  it("adds floats", () => {\n    assert.equal(add(0.5, 0.25), 0.75);\n  });\n});\n`);
    await additive("test/add.test.js", JS, `${JS}\ntest("big numbers", () => {\n  assert.equal(add(1e9, 1e9), 2e9);\n});\n`);
  });

  it("JS: a test between two existing ones, where git may slide the closing `});`", async () => {
    // Git can show this insertion as "+  });\n+\n+  it(…\n+    …" above an unchanged "  });".
    await additive("test/add.test.js", JS, JS.replace(`  it("adds negatives"`, `  it("adds one", () => {\n    assert.equal(add(1, 0), 1);\n  });\n\n  it("adds negatives"`));
  });

  it("a block the diff shows with the closing `});` slid above it", () => {
    const post = JS.replace(`  it("adds negatives"`, `  it("adds one", () => {\n    assert.equal(add(1, 0), 1);\n  });\n\n  it("adds negatives"`);
    const patch = [
      "diff --git a/test/add.test.js b/test/add.test.js",
      "--- a/test/add.test.js",
      "+++ b/test/add.test.js",
      '@@ -6,6 +6,10 @@ describe("add", () => {',
      '   it("adds", () => {',
      "     assert.equal(add(2, 3), 5);",
      "+  });",
      "+",
      '+  it("adds one", () => {',
      "+    assert.equal(add(1, 0), 1);",
      "   });",
      " ",
      '   it("adds negatives", () => {',
      "",
    ].join("\n");
    assert.equal(onlyAddsTests("test/add.test.js", patchHunks(patch).get("test/add.test.js") ?? [], post), true);
    // Without the post-image there is nothing to check the placement against.
    assert.equal(onlyAddsTests("test/add.test.js", patchHunks(patch).get("test/add.test.js") ?? [], undefined), false);
  });

  it("JS: the new test's import added to an existing import line or list", async () => {
    await additive("test/add.test.js", JS, JS.replace(`import { add } from "../src/add.js";`, `import { add, sub } from "../src/add.js";`).replace(`  });\n});\n`, `  });\n\n  it("subtracts", () => {\n    assert.equal(sub(3, 2), 1);\n  });\n});\n`));
    const multi = JS.replace(`import { add } from "../src/add.js";`, `import {\n  add,\n} from "../src/add.js";`);
    await additive("test/add.test.js", multi, multi.replace(`  add,\n`, `  add,\n  sub,\n`).replace(`  });\n});\n`, `  });\n\n  it("subtracts", () => {\n    assert.equal(sub(3, 2), 1);\n  });\n});\n`));
    // A helper the new test needs, declared once.
    await additive("test/add.test.js", JS, `${JS}\nconst cases = [[1, 2, 3]];\nfunction sum3(a, b) {\n  return add(a, b);\n}\n\ntest("table", () => {\n  for (const [a, b, c] of cases) assert.equal(sum3(a, b), c);\n});\n`);
  });

  it("TypeScript and node:test subtests in a file the verifier names", async () => {
    const ts = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n\ntest("parse", async (t) => {\n  await t.test("empty", () => assert.equal(1, 1));\n});\n`;
    await additive("check/parse.spec.ts", ts, `${ts}\ntest("parse unicode", () => {\n  assert.equal("é".length, 1);\n});\n`, { verifierCommand: "node --test check/*.spec.ts" });
  });

  it("Python: a new test function, a method in an existing class, a new class, parametrized", async () => {
    await additive("tests/test_calc.py", PY, `${PY}\n\ndef test_add_zero():\n    assert add(0, 0) == 0\n`);
    await additive("tests/test_calc.py", PY, `${PY}\n    def test_neg_zero(self):\n        assert add(-0, 0) == 0\n`);
    await additive("tests/test_calc.py", PY, `${PY}\n\nclass TestBig:\n    def setup_method(self):\n        self.n = 10**9\n\n    def test_big(self):\n        assert add(self.n, self.n) == 2 * 10**9\n`);
    await additive("tests/test_calc.py", PY, PY.replace(`\n\nclass TestNeg:`, `\n\n@pytest.mark.parametrize("a,b,c", [(1, 1, 2), (2, 2, 4)])\ndef test_table(a, b, c):\n    assert add(a, b) == c\n\n\nclass TestNeg:`));
    await additive("tests/test_calc.py", PY, PY.replace("from calc import add", "from calc import add, sub").replace(/$/, `\n\ndef test_sub():\n    assert sub(3, 2) == 1\n`));
  });

  it("Go, Rust and Java", async () => {
    const go = `package calc\n\nimport (\n\t"testing"\n)\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("bad")\n\t}\n}\n`;
    await additive("calc_test.go", go, go.replace(`\t"testing"\n`, `\t"math"\n\t"testing"\n`).replace(/$/, `\nfunc TestAddInf(t *testing.T) {\n\tif Add(math.Inf(1), 1) != math.Inf(1) {\n\t\tt.Fatal("inf")\n\t}\n}\n`));
    const rs = `#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n`;
    await additive("tests/calc_test.rs", rs, rs.replace(`    }\n}\n`, `    }\n\n    #[test]\n    fn adds_zero<'a>() {\n        let s: &'a str = "x";\n        assert_eq!(add(0, 0), 0, "{}", s);\n    }\n}\n`));
    const java = `class CalcTest {\n    @Test\n    void adds() {\n        assertEquals(5, Calc.add(2, 3));\n    }\n}\n`;
    await additive("src/test/java/CalcTest.java", java, java.replace(`    }\n}\n`, `    }\n\n    @Test\n    void addsZero() {\n        assertEquals(0, Calc.add(0, 0));\n    }\n}\n`));
  });
});

describe("real disabling in an existing test file is still tamper", () => {
  it("weakened, changed or deleted assertions and deleted tests", async () => {
    await flagged("test/add.test.js", JS, JS.replace("assert.equal(add(2, 3), 5);", "assert.ok(true);"));
    await flagged("test/add.test.js", JS, JS.replace("    assert.equal(add(2, 3), 5);\n", ""));
    await flagged("test/add.test.js", JS, JS.replace(`  it("adds negatives", () => {\n    assert.equal(add(-2, -3), -5);\n  });\n`, ""));
    await flagged("tests/test_calc.py", PY, PY.replace("assert add(2, 3) == 5", "assert add(2, 3) == add(2, 3)"));
  });

  it("skip and focus markers, even inside a new test", async () => {
    await flagged("test/add.test.js", JS, JS.replace(`  it("adds", () => {`, `  it.skip("adds", () => {`), ["edit", "skip"]);
    await flagged("test/add.test.js", JS, `${JS}\ntest.only("mine", () => {});\n`, ["edit", "skip"]);
    await flagged("tests/test_calc.py", PY, PY.replace("def test_add():", "@pytest.mark.skip\ndef test_add():"), ["edit", "skip"]);
    await flagged("tests/test_calc.py", PY, `${PY}\n\ndef test_new():\n    pytest.skip("later")\n`, ["edit", "skip"]);
  });

  it("early returns and exits added inside an existing test or at the top of the file", async () => {
    await flagged("test/add.test.js", JS, JS.replace(`  it("adds", () => {\n`, `  it("adds", () => {\n    return;\n`));
    await flagged("test/add.test.js", JS, JS.replace(`  it("adds", () => {\n`, `  it("adds", () => {\n    if (true) return;\n`));
    await flagged("test/add.test.js", JS, `process.exit(0);\n${JS}`);
    await flagged("test/add.test.js", JS, `${JS}\ntest("bye", () => {\n  process.exit(0);\n});\n`);
    await flagged("tests/test_calc.py", PY, PY.replace("def test_add():\n", "def test_add():\n    return\n"));
    await flagged("tests/test_calc.py", PY, `import sys\nsys.exit(0)\n${PY}`);
  });

  it("a new test inserted inside an existing one, or one that takes over the rest of its body", async () => {
    await flagged("test/add.test.js", JS, JS.replace(`    assert.equal(add(2, 3), 5);\n`, `    it("inner", () => {});\n    assert.equal(add(2, 3), 5);\n`));
    // At column 0 in the middle of test_add, the new def takes the assertion away from it.
    const two = PY.replace("    assert add(2, 3) == 5\n", "    x = add(2, 3)\n    assert x == 5\n");
    await flagged("tests/test_calc.py", two, two.replace("    x = add(2, 3)\n", "    x = add(2, 3)\n\n\ndef test_x():\n    x = 5\n"));
  });

  it("a definition that shadows an existing test or helper", async () => {
    // Python keeps the last def: the original test_add never runs.
    await flagged("tests/test_calc.py", PY, `${PY}\n\ndef test_add():\n    assert True\n`);
    await flagged("tests/test_calc.py", PY, `${PY}\n\nclass TestNeg:\n    def test_ok(self):\n        assert True\n`);
    const cjs = `const assert = require("node:assert");\nfunction expected() {\n  return 5;\n}\ntest("adds", () => assert.equal(2 + 3, expected()));\n`;
    await flagged("test/add.test.js", cjs, `${cjs}\nfunction expected() {\n  return 2 + 3;\n}\ntest("again", () => {});\n`);
  });

  it("hooks, fixtures, mocks and patched test machinery that reach the existing tests", async () => {
    await flagged("test/add.test.js", JS, JS.replace(`describe("add", () => {\n`, `describe("add", () => {\n  beforeEach(() => {\n    globalThis.add = () => 5;\n  });\n\n`));
    await flagged("test/add.test.js", JS, `${JS}\njest.mock("../src/add.js", () => ({ add: () => 5 }));\ntest("x", () => {});\n`);
    await flagged("test/add.test.js", JS, `${JS}\ntest("x", () => {\n  assert.equal = () => {};\n});\n`);
    await flagged("test/add.test.js", JS, `${JS}\nglobalThis.fetch = async () => ({ ok: true });\ntest("x", () => {});\n`);
    await flagged("tests/test_calc.py", PY, `${PY}\n\n@pytest.fixture(autouse=True)\ndef fake(monkeypatch):\n    monkeypatch.setattr("calc.add", lambda a, b: 5)\n\n\ndef test_x():\n    assert True\n`);
    await flagged("tests/test_calc.py", PY, `${PY}\n\npytestmark = pytest.mark.xfail\n\n\ndef test_x():\n    assert True\n`);
    await flagged("tests/test_calc.py", PY, `${PY}\n\ndef pytest_collection_modifyitems(items):\n    items.clear()\n\n\ndef test_x():\n    assert True\n`);
    await flagged("tests/test_calc.py", PY, PY.replace("class TestNeg:\n", "class TestNeg:\n    def setUp(self):\n        pass\n\n"));
  });

  it("file-level disables: Go build constraints and TestMain", async () => {
    const go = `package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("bad")\n\t}\n}\n`;
    await flagged("calc_test.go", go, `//go:build ignore\n\n${go}\nfunc TestMore(t *testing.T) {}\n`);
    await flagged("calc_test.go", go, `${go}\nfunc TestMain(m *testing.M) {}\n\nfunc TestMore(t *testing.T) {}\n`);
  });

  it("additions with no new test, in a language it doesn't parse, or without the file are edits", async () => {
    await flagged("test/add.test.js", JS, `${JS}\nconst unused = 1;\n`);
    const rb = `describe Calc do\n  it "adds" do\n    expect(Calc.add(2, 3)).to eq(5)\n  end\nend\n`;
    await flagged("spec/calc_spec.rb", rb, rb.replace(/end\n$/, `  it "adds zero" do\n    expect(Calc.add(0, 0)).to eq(0)\n  end\nend\n`));
    // No post-image reader: the old behavior, every edit is a flag.
    const r = await check({ "test/add.test.js": JS }, { "test/add.test.js": `${JS}\ntest("x", () => {});\n` }, { readFile: undefined });
    assert.deepEqual(r.flags.map((f) => f.kind), ["edit"]);
  });

  it("runner config and CI files flag even when only added to", async () => {
    const r = await check({ "jest.config.js": "module.exports = {\n};\n" }, { "jest.config.js": "module.exports = {\n  testPathIgnorePatterns: ['add'],\n};\n" });
    assert.deepEqual(r.flags.map((f) => [f.kind, f.why]), [["edit", "runner-config"]]);
  });

  it("a mixed diff flags the edited file and lists the added-to one", async () => {
    const r = await check(
      { "test/add.test.js": JS, "tests/test_calc.py": PY },
      { "test/add.test.js": `${JS}\ntest("zero", () => {\n  assert.equal(add(0, 0), 0);\n});\n`, "tests/test_calc.py": PY.replace("== 5", "!= 5") },
    );
    assert.deepEqual(r.flags.map((f) => [f.kind, f.path]), [["edit", "tests/test_calc.py"]]);
    assert.deepEqual(r.addedTests, ["test/add.test.js"]);
  });
});

describe("real fixtures", () => {
  // Diffs from real work: commits in this repo that added tests to existing test files, and
  // ones that changed existing tests (test/fixtures/tamper/README.md says where each came from).
  const root = join(import.meta.dirname, "../fixtures/tamper");
  for (const name of readdirSync(root).filter((n) => !n.includes("."))) {
    it(name, () => {
      const dir = join(root, name);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { path: string; additive: boolean };
      const patch = readFileSync(join(dir, "diff.patch"), "utf8");
      const post = readFileSync(join(dir, "post"), "utf8");
      assert.equal(onlyAddsTests(meta.path, patchHunks(patch).get(meta.path) ?? [], post), meta.additive);
    });
  }
});
