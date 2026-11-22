// scripts/changelog/add.mjs on a temp copy of test/fixture: a fixture CHANGELOG.md and
// docs/, plus the repo's real apps/site/scripts/subset-fonts.py, which the script reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { add } from "../add.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const ADD = join(HERE, "..", "add.mjs");
const DOC = "https://github.com/jackulau/coding.sh/blob/main/docs/guides/explore.md";

// parseChangelog from the site's shape test, loaded without its tests.
let parseChangelog;
before(async () => {
  const src = readFileSync(join(REPO, "apps/site/test/changelog-shape.test.mjs"), "utf8");
  const sections = src.match(/^const SECTIONS = .*$/m)[0];
  const fn = src.match(/^export function parseChangelog[\s\S]*?^}$/m)[0];
  ({ parseChangelog } = await import(`data:text/javascript,${encodeURIComponent(`${sections}\n${fn}`)}`));
});

let dir;
let n = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "changelog-add-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fresh root: the fixture CHANGELOG.md and docs/, and the real subset-fonts.py. */
function root() {
  const r = join(dir, String(n++));
  cpSync(join(HERE, "fixture"), r, { recursive: true });
  mkdirSync(join(r, "apps/site/scripts"), { recursive: true });
  cpSync(join(REPO, "apps/site/scripts/subset-fonts.py"), join(r, "apps/site/scripts/subset-fonts.py"));
  return r;
}

const run = (r, ...args) => spawnSync(process.execPath, [ADD, "--root", r, ...args], { encoding: "utf8" });
const read = (r) => readFileSync(join(r, "CHANGELOG.md"), "utf8");
const words = (k) => Array.from({ length: k }, (_, i) => `w${i}`).join(" ");

test("a valid line lands at the end of Fixed and the shape test finds no problem", () => {
  const r = root();
  const res = run(r, "--section", "Fixed", "--area", "Work", "--text", "A stalled session shows in the queue.", "--link", "docs/guides/explore.md#open-the-viewer-1");
  assert.equal(res.status, 0, res.stderr);
  const md = read(r);
  const line = `- **Work.** A stalled session shows in the queue. ([docs](${DOC}#open-the-viewer-1))`;
  const lines = md.split("\n");
  assert.equal(lines[lines.indexOf("- **Viewer.** A folded turn opens on the first failure. ([docs](" + DOC + "))") + 1], line);
  assert.ok(lines.indexOf(line) < lines.indexOf("## [1.1.0] - 2026-11-01"));
  assert.deepEqual(parseChangelog(md).problems, []);
  assert.equal(run(r, "--check").status, 0);
});

test("a missing section is made in order: Changed between Added and Fixed", () => {
  const r = root();
  assert.equal(run(r, "--section", "Changed", "--area", "Cost.", "--text", "Prices come from the table.", "--link", "guides/explore.md").status, 0);
  assert.equal(run(r, "--section", "Performance", "--area", "Hook", "--text", "The hook starts faster.", "--link", DOC).status, 0);
  const md = read(r);
  const heads = md.split("\n").filter((l) => l.startsWith("#"));
  assert.deepEqual(heads, ["# Changelog", "## [1.2.0] - Unreleased", "### Added", "### Changed", "### Fixed", "### Performance", "## [1.1.0] - 2026-11-01", "### Fixed"]);
  assert.match(md, /### Changed\n\n- \*\*Cost\.\*\* Prices come from the table\. \(\[docs\]\([^)]+\)\)\n\n### Fixed/);
  assert.match(md, /### Performance\n\n- \*\*Hook\.\*\* The hook starts faster\. \(\[docs\]\([^)]+\)\)\n\n## \[1\.1\.0\]/);
  assert.deepEqual(parseChangelog(md).problems, []);
});

test("each rule refuses with exit 1, one reason, and leaves the file byte-identical", () => {
  const r = root();
  const before = read(r);
  const cases = [
    // 61 words in the written line, counted as the shape test counts: the "**Area.**" and "([docs](...))" count too.
    { args: ["--section", "Fixed", "--area", "Area", "--text", words(59), "--link", "guides/explore.md"], reason: /61 words, the limit is 60/ },
    { args: ["--section", "Fixed", "--area", "Area", "--text", "target ÷ reading", "--link", "guides/explore.md"], reason: /U\+00F7/ },
    { args: ["--section", "Fixed", "--area", "Area", "--text", "ok", "--link", "guides/missing.md"], reason: /docs\/guides\/missing\.md, which does not exist/ },
    { args: ["--section", "Fixed", "--area", "Area", "--text", "ok", "--link", "guides/explore.md#not-a-heading"], reason: /#not-a-heading/ },
    { args: ["--section", "Fixed", "--area", "Area", "--text", "ok", "--link", "guides/explore.md#%E0"], reason: /link fragment #%E0 is not valid percent-encoding/ },
    { args: ["--section", "Misc", "--area", "Area", "--text", "ok", "--link", "guides/explore.md"], reason: /section "Misc"/ },
    { args: ["--section", "Fixed", "--area", "Viewer", "--text", "A folded turn opens on the first failure.", "--link", DOC], reason: /already in CHANGELOG\.md/ },
  ];
  for (const c of cases) {
    const res = run(r, ...c.args);
    assert.equal(res.status, 1, `${c.args.join(" ")}: ${res.stdout}`);
    assert.match(res.stderr, c.reason);
    assert.equal(res.stderr.trim().split("\n").length, 1, res.stderr);
    assert.equal(read(r), before, c.args.join(" "));
  }
  // 60 words is allowed.
  assert.equal(run(r, "--section", "Fixed", "--area", "Area", "--text", words(58), "--link", "guides/explore.md").status, 0);
});

test("a fenced ## line is not a heading", () => {
  const r = root();
  assert.match(run(r, "--section", "Fixed", "--area", "A", "--text", "t", "--link", "guides/explore.md#not-a-heading").stderr, /no heading/);
  assert.equal(run(r, "--section", "Fixed", "--area", "A", "--text", "t", "--link", "guides/explore.md#codingsh-show").status, 0);
});

test("released sections are never touched, and an unreleased version is required", () => {
  const r = root();
  const md = read(r);
  const released = md.slice(md.indexOf("## [1.1.0]"));
  assert.equal(run(r, "--section", "Security", "--area", "A", "--text", "t", "--link", "guides/explore.md").status, 0);
  assert.ok(read(r).endsWith(released));
  writeFileSync(join(r, "CHANGELOG.md"), released);
  const res = run(r, "--section", "Fixed", "--area", "A", "--text", "t", "--link", "guides/explore.md");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /is released/);
  assert.equal(read(r), released);
});

test("two concurrent runs both land", async () => {
  const r = root();
  const go = (i) =>
    new Promise((ok) => {
      const p = spawn(process.execPath, [ADD, "--root", r, "--section", "Fixed", "--area", "Run", "--text", `Concurrent line ${i}.`, "--link", "guides/explore.md"]);
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => ok({ code, err }));
    });
  const results = await Promise.all([0, 1, 2, 3].map(go));
  for (const res of results) assert.equal(res.code, 0, res.err);
  const md = read(r);
  for (const i of [0, 1, 2, 3]) assert.ok(md.includes(`Concurrent line ${i}.`), `line ${i} is missing`);
  assert.deepEqual(parseChangelog(md).problems, []);
});

test("a CHANGELOG.md held by another program is tried again after 100, 200, 400 and 800 ms", () => {
  const busy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  const input = { section: "Fixed", area: "Work", text: "A held file is written on a later try.", link: "guides/explore.md" };
  // Held for two tries, then free: the line lands on the third.
  let r = root();
  let fails = 2;
  const waits = [];
  const held = (from, to) => {
    if (fails-- > 0) throw busy();
    renameSync(from, to);
  };
  assert.deepEqual(add({ ...input, root: r, file: join(r, "CHANGELOG.md"), rename: held, sleep: (ms) => waits.push(ms) }), []);
  assert.deepEqual(waits, [100, 200]);
  assert.ok(read(r).includes("A held file is written on a later try."));
  // Held on every try: the reason names it, and the file, with nothing left beside it, stays as it was.
  r = root();
  const before = read(r);
  waits.length = 0;
  const problems = add({ ...input, root: r, file: join(r, "CHANGELOG.md"), rename: () => { throw busy(); }, sleep: (ms) => waits.push(ms) });
  assert.deepEqual(problems, ["CHANGELOG.md is held by another program (EBUSY); tried 5 times"]);
  assert.deepEqual(waits, [100, 200, 400, 800]);
  assert.equal(read(r), before);
  assert.deepEqual(readdirSync(r).filter((f) => f.startsWith("CHANGELOG.md.")), []);
});

test("the wait before another try is real: a file held once is written at least 100 ms later", () => {
  const r = root();
  let fails = 1;
  const held = (from, to) => {
    if (fails-- > 0) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    renameSync(from, to);
  };
  const t = performance.now();
  assert.deepEqual(add({ section: "Fixed", area: "Work", text: "Written after a wait.", link: "guides/explore.md", root: r, file: join(r, "CHANGELOG.md"), rename: held }), []);
  assert.ok(performance.now() - t >= 95, "the second try came without a wait");
});

test("--check names each unreleased problem by line and skips released versions", () => {
  const r = root();
  const file = join(r, "CHANGELOG.md");
  const md = read(r).replace("### Fixed\n\n- **Viewer.**", `### Fixed\n\n- **Long.** ${words(60)} ([docs](${DOC}))\n- **Glyph.** a ÷ b ([docs](${DOC}#nope))\n- **Viewer.**`);
  writeFileSync(file, md);
  const res = run(r, "--check");
  assert.equal(res.status, 1);
  const out = res.stderr.trim().split("\n");
  assert.deepEqual(out.map((l) => l.replace(/: .*/, "")), ["CHANGELOG.md:13", "CHANGELOG.md:14", "CHANGELOG.md:14"]);
  assert.match(out[0], /62 words/);
  assert.match(out[1], /U\+00F7/);
  assert.match(out[2], /#nope/);
});

test("--check passes on the repo's CHANGELOG.md", () => {
  const res = spawnSync(process.execPath, [ADD, "--check"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});
