// Z-13: protected safety directives. A paired success gate can't see the harm
// of deleting or waiving a safety rule (Masked Erosion, arXiv 2610.38392), so
// harness edits are checked lexically: C6 protected-line, C7 relaxes-protected.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { refineProtectConfig } from "../../src/refine/config.ts";
import { checkProtected, hasRelaxingCue, isSafetyDirective, normLine, parseOverride, protectedLines, readOnlySection, safetyTopics, type HarnessText } from "../../src/refine/protect.ts";

const AGENTS = [
  "# Rules",
  "",
  "- Never run `git push --force`.",
  "- Ask the owner before deleting anything under `prod/`.",
  "- Prefer small commits.",
  "- Run `npm test`.",
  "- Use pnpm, not npm.",
  "",
  "<!-- coding.sh:protect -->",
  "Keep answers short.",
  "<!-- coding.sh:protect end -->",
  "",
  "```sh",
  "# never push --force from here",
  "git push --force",
  "```",
  "",
].join("\n");
const files = (text = AGENTS): HarnessText[] => [{ path: "AGENTS.md", text }];
const edit = (from: string, to: string): HarnessText[] => {
  assert.ok(AGENTS.includes(from), from);
  return files(AGENTS.replace(from, to));
};

describe("protectedLines", () => {
  it("auto-protects gate word + safety topic, a marker block and a config regex; nothing else", () => {
    const lines = protectedLines(files(), { protect: ["^Use pnpm"] });
    assert.deepEqual(
      lines.map((l) => [l.line, l.why, l.text]),
      [
        [3, "auto", "Never run `git push --force`."],
        [4, "auto", "Ask the owner before deleting anything under `prod/`."],
        [7, "config", "Use pnpm, not npm."],
        [10, "marker", "Keep answers short."],
      ],
    );
    assert.equal(lines[0]!.norm, "never run `git push --force`.");
  });

  it("autoProtect=false keeps only marker and config lines", () => {
    assert.deepEqual(
      protectedLines(files(), { protect: ["^Use pnpm"], autoProtect: false }).map((l) => l.why),
      ["config", "marker"],
    );
  });

  it("skips headings, table rows, fenced code and frontmatter", () => {
    const text = ["---", "description: never push to prod", "---", "## Never push to prod", "| never | push to prod |", "```", "never push to prod", "```", "Never push to prod."].join("\n");
    assert.deepEqual(
      protectedLines(files(text)).map((l) => l.line),
      [9],
    );
  });

  it("orders by path then line and rejects a bad regex", () => {
    const two = [
      { path: "b.md", text: "Never deploy on Fridays." },
      { path: "a.md", text: "x\nNever print a secret." },
    ];
    assert.deepEqual(
      protectedLines(two).map((l) => `${l.path}:${l.line}`),
      ["a.md:2", "b.md:1"],
    );
    assert.throws(() => protectedLines(two, { protect: ["(unclosed"] }), /refine\.protect: invalid regex/);
  });
});

describe("isSafetyDirective", () => {
  it("needs the gate word and the topic in the same sentence", () => {
    assert.equal(isSafetyDirective("Never commit secrets."), true);
    assert.equal(isSafetyDirective("Only deploy from main."), true);
    assert.equal(isSafetyDirective("Confirm with the user before you run `rm -rf`."), true);
    assert.equal(isSafetyDirective("Never guess. Secrets live in the vault."), false);
    assert.equal(isSafetyDirective("Prefer small commits."), false);
    assert.equal(isSafetyDirective("Run `npm test`."), false);
  });

  it("takes lead-only gate words only at a sentence start", () => {
    assert.equal(isSafetyDirective("The deploy job runs only on main."), false);
    assert.equal(isSafetyDirective("Check the dashboard after each deploy."), true);
  });

  it("keeps topics narrow: design tokens, push notifications and owner/ paths are not safety topics", () => {
    assert.deepEqual(safetyTopics("Never hardcode design tokens."), []);
    assert.deepEqual(safetyTopics("Never send push notifications at night."), []);
    assert.deepEqual(safetyTopics("Never edit owner/repo by hand."), []);
    assert.deepEqual(safetyTopics("Never log the GitHub token."), ["token"]);
    assert.ok(safetyTopics("Never force-push main.").includes("force"));
    assert.ok(safetyTopics("Never DROP TABLE users.").includes("drop"));
  });

  it("judges a hard-wrapped line by its own sentences", () => {
    // The first fragment ends the sentence above; the next sentence is a rule.
    assert.equal(isSafetyDirective("and the cache. Never push to prod on Friday."), true);
    // A lone continuation fragment is judged as written.
    assert.equal(isSafetyDirective("never touch the production database."), true);
  });

  it("calls a sentence over 240 characters a description, not a rule", () => {
    assert.equal(isSafetyDirective(`Never push to prod ${"and so on ".repeat(25)}.`), false);
  });
});

describe("checkProtected", () => {
  it("passes an edit that leaves protected lines alone", () => {
    const r = checkProtected(files(), edit("- Run `npm test`.", "- Run `npm test`.\n- Run `npm run check` before finishing."));
    assert.equal(r.ok, true);
    assert.equal(r.protected.length, 3);
    assert.deepEqual(r.rejections, []);
  });

  it("C6: deleting, rewording or softening a protected line is rejected", () => {
    for (const to of ["", "- Avoid `git push --force` where possible.", "- never run  `git push --force`.  "]) {
      const r = checkProtected(files(), edit("- Never run `git push --force`.\n", to ? `${to}\n` : ""));
      if (to.startsWith("- never run")) {
        assert.equal(r.ok, true, "case and whitespace changes keep the line");
        continue;
      }
      assert.equal(r.ok, false, to);
      assert.equal(r.rejections[0]!.critic, "protected");
      assert.equal(r.rejections[0]!.reason, 'protected-line: AGENTS.md:3 "Never run `git push --force`." (auto)');
    }
  });

  it("C6: deleting the file or moving the line to another file is rejected", () => {
    assert.equal(checkProtected(files(), []).rejections.length, 3);
    const moved = [
      { path: "AGENTS.md", text: AGENTS.replace("- Never run `git push --force`.\n", "") },
      { path: "CLAUDE.md", text: "- Never run `git push --force`.\n" },
    ];
    assert.deepEqual(
      checkProtected(files(), moved).rejections.map((r) => r.protected.line),
      [3],
    );
  });

  it("C7: an added exception tied to a protected line is rejected, with the added line's location", () => {
    for (const added of ["- Skip the extra owner confirmation for obvious `prod/` cache paths.", "- Only ask the owner when the path is ambiguous."]) {
      const r = checkProtected(files(), edit("- Prefer small commits.", `- Prefer small commits.\n${added}`));
      assert.equal(r.ok, false, added);
      const [rej] = r.rejections;
      assert.equal(rej!.critic, "relaxes-protected");
      assert.equal(rej!.protected.line, 4);
      assert.deepEqual(rej!.added, { path: "AGENTS.md", line: 6, text: added.slice(2) });
      assert.match(rej!.reason, /^relaxes-protected: ".*" vs AGENTS\.md:4$/);
    }
  });

  it("C7: in an edited paragraph only the new sentences count", () => {
    // A skill paragraph on one line that already had a conditional tied to a protected line.
    const para = "Read the guide first. Use the CLI only if the owner declines the connector.";
    const base = files(AGENTS.replace("- Prefer small commits.", para));
    const edited = (to: string): HarnessText[] => files(AGENTS.replace("- Prefer small commits.", to));
    assert.equal(checkProtected(base, edited("Read the guide and the map first. Use the CLI only if the owner declines the connector.")).ok, true);
    const r = checkProtected(base, edited(`${para} Skip the owner for \`prod/\` cache paths.`));
    assert.equal(r.ok, false);
    assert.deepEqual(r.rejections[0]!.added, { path: "AGENTS.md", line: 5, text: "Skip the owner for `prod/` cache paths." });
  });

  it("C7: a relaxing cue with no tie to a protected line passes", () => {
    const r = checkProtected(files(), edit("- Prefer small commits.", "- Prefer small commits.\n- Skip the changelog for typo fixes."));
    assert.equal(r.ok, true);
  });

  it("an override waives that protected line and is reported; an unused one is listed", () => {
    const to = edit("- Never run `git push --force`.\n", "");
    const r = checkProtected(files(), to, { allow: ["AGENTS.md:3", "./AGENTS.md:99"] });
    assert.equal(r.ok, true);
    assert.equal(r.overridden.length, 1);
    assert.equal(r.overridden[0]!.protected.line, 3);
    assert.deepEqual(r.unusedOverrides, ["./AGENTS.md:99"]);
  });

  it("accepts a precomputed protected list", () => {
    const prot = protectedLines(files(), { autoProtect: false });
    const r = checkProtected(files(), edit("- Never run `git push --force`.\n", ""), { protected: prot });
    assert.equal(r.ok, true, "only the marker line is protected");
  });
});

describe("helpers", () => {
  it("normLine drops list marks, bold and case; hasRelaxingCue finds conditionals", () => {
    assert.equal(normLine("  - **Never**   push to `prod`.  "), "never push to `prod`.");
    assert.equal(hasRelaxingCue("Ask unless the owner is away."), true);
    assert.equal(hasRelaxingCue("Only ask the owner if unsure."), true);
    assert.equal(hasRelaxingCue("Ask the owner first."), false);
  });

  it("parseOverride wants PATH:LINE", () => {
    assert.deepEqual(parseOverride("./docs\\AGENTS.md:12"), { path: "docs/AGENTS.md", line: 12 });
    assert.throws(() => parseOverride("AGENTS.md"), /expected PATH:LINE/);
    assert.throws(() => parseOverride("AGENTS.md:0"), /expected PATH:LINE/);
  });

  it("readOnlySection lists every protected line for a proposer prompt", () => {
    const s = readOnlySection(protectedLines(files()));
    assert.match(s, /^READ-ONLY \(do not edit, reword, weaken or add exceptions to\):\n- AGENTS\.md:3: Never run `git push --force`\.\n/);
    assert.equal(readOnlySection([]), "");
  });
});

describe("refineProtectConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "csh-refine-cfg-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const setup = (name: string, user?: string, repo?: string) => {
    const home = join(root, name, "home", ".coding.sh");
    const cwd = join(root, name, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cwd, ".coding.sh"), { recursive: true });
    if (user !== undefined) writeFileSync(join(home, "config.toml"), user);
    if (repo !== undefined) writeFileSync(join(cwd, ".coding.sh", "config.toml"), repo);
    return { env: { CODING_SH_HOME: home, HOME: join(root, name, "home") } as NodeJS.ProcessEnv, cwd };
  };

  it("defaults to auto-protection and no patterns", () => {
    const { env, cwd } = setup("none");
    assert.deepEqual(refineProtectConfig(env, cwd), { protect: [], autoProtect: true, files: [] });
  });

  it("reads user patterns and autoProtect; the repo may add patterns but not turn auto off", () => {
    const { env, cwd } = setup("both", '[refine]\nprotect = ["^Use pnpm"]\nautoProtect = false\n', '[refine]\nprotect = ["staging", "^Use pnpm"]\nautoProtect = false\n');
    const c = refineProtectConfig(env, cwd);
    assert.deepEqual(c.protect, ["^Use pnpm", "staging"]);
    assert.equal(c.autoProtect, false, "the user turned it off");
    const repoOnly = setup("repo", undefined, "[refine]\nautoProtect = false\n");
    assert.equal(refineProtectConfig(repoOnly.env, repoOnly.cwd).autoProtect, true, "a repo config can't turn auto-protection off");
  });

  it("rejects a bad value or regex naming the file", () => {
    const bad = setup("bad", "[refine]\nprotect = \"^x\"\n");
    assert.throws(() => refineProtectConfig(bad.env, bad.cwd), /refine\.protect must be an array/);
    const re = setup("re", undefined, '[refine]\nprotect = ["(x"]\n');
    assert.throws(() => refineProtectConfig(re.env, re.cwd), /invalid regex/);
  });
});
