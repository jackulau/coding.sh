// Doc lines about the proxy that state what the code does: the PowerShell form beside each sh
// line for `proxy env`, the budgets `--enforce-budget` ignores, and the header that stops SDKs
// retrying the budget 429.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { statusOf, type Budget } from "../../src/budget/index.ts";
import { budgetResponse, enforceable } from "../../src/proxy/budget.ts";
import type { Route } from "../../src/proxy/wire.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(repo, ...p), "utf8");
const budget = (b: Partial<Budget> = {}): Budget => ({ id: "day", period: "day", limitUsd: 1, createdAt: 0, ...b });
/** The paragraphs of a doc that name `needle`. */
const paragraphs = (doc: string, needle: string) => doc.split(/\r?\n\s*\r?\n/).filter((p) => p.includes(needle));

describe("proxy doc claims", () => {
  it("every doc that sets the proxy env with eval gives the PowerShell line too", () => {
    const docs = (readdirSync(join(repo, "docs"), { recursive: true, encoding: "utf8" }) as string[]).filter((f) => f.endsWith(".md"));
    // The CLI reference escapes the pipe inside its notes.
    const text = new Map(docs.map((f) => [f, read("docs", f).replaceAll("\\|", "|")]));
    const sh = docs.filter((f) => text.get(f)!.includes('eval "$(coding.sh proxy env)"'));
    assert.ok(sh.length >= 2, `docs with the sh line: ${sh.join(", ")}`);
    // `proxy env` prints PowerShell's $env: lines in PowerShell and cmd, which eval can't run.
    assert.deepEqual(sh.filter((f) => !text.get(f)!.includes("codingsh proxy env | Invoke-Expression")), []);
  });

  it("the guides name both kinds of budget --enforce-budget ignores: --repo and --where", () => {
    assert.equal(enforceable(budget()), true);
    assert.equal(enforceable(budget({ agent: "codex" })), true);
    assert.equal(enforceable(budget({ repo: "/work/demo" })), false);
    assert.equal(enforceable(budget({ where: "user:u1" })), false);
    const cost = paragraphs(read("docs", "how-to", "track-cost.md"), "--enforce-budget").filter((p) => /\bignores\b/.test(p));
    assert.equal(cost.length, 1, "the cost guide says which budgets --enforce-budget ignores");
    assert.match(cost[0]!, /`--repo`/);
    assert.match(cost[0]!, /`--where`/);
    const proxy = paragraphs(read("docs", "how-to", "capture-with-proxy.md"), "never blocks");
    assert.equal(proxy.length, 1, "the proxy guide says which budgets never block a call");
    assert.match(proxy[0]!, /`--repo` or `--where`/);
  });

  it("the proxy guide says the budget 429 carries x-should-retry: false, as both vendors' 429s do", () => {
    const now = Date.now();
    const block = { status: { ...statusOf(budget(), 1.5, 1, now), resetsAt: now + 3_600_000 }, retryAfter: 3600 };
    for (const route of [{ provider: "anthropic", api: "messages" }, { provider: "openai", api: "chat" }, { provider: "openai", api: "responses" }] as Route[]) {
      const r = budgetResponse(route, block);
      assert.equal(r.status, 429);
      assert.equal(r.headers["x-should-retry"], "false", `${route.provider} ${route.api}`);
    }
    const doc = read("docs", "how-to", "capture-with-proxy.md");
    assert.match(doc, /`x-should-retry: false`/);
    assert.match(paragraphs(doc, "x-should-retry")[0]!, /raise the 429 at once/);
  });
});
