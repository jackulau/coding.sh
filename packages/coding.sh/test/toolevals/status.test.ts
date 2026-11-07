// `toolevals validate` records a pass in the task file (status = "validated"),
// so `toolevals run` stops calling the task a draft.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadToolEvals, markTaskValidated } from "../../src/toolevals/config.ts";
import { cleanup, tmp } from "./helpers.ts";

after(cleanup);

function repo(files: Record<string, string>): string {
  const root = tmp("csh-te-status-");
  writeFileSync(join(root, "coding.sh.toml"), ["[toolevals.targets.fake]", 'kind = "cli"', 'bin = "fake-cli"', 'command = ["fake-cli"]', ""].join("\n"));
  const dir = join(root, "evals", "toolevals", "fake", "tasks");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return root;
}

const CHECK = ["", "[[checks]]", 'kind = "output"', 'contains = ["hello"]', ""];

describe("markTaskValidated", () => {
  it("adds status to a TOML task with none, and loading it again reads validated", async () => {
    const root = repo({ "a.toml": ['id = "a"', 'instruction = "Say hello."', ...CHECK].join("\n") });
    const [task] = (await loadToolEvals(root)).tasks;
    assert.equal(task!.status, "draft");
    assert.equal(await markTaskValidated(task!), true);
    const [again] = (await loadToolEvals(root)).tasks;
    assert.equal(again!.status, "validated");
    assert.deepEqual({ ...again, status: "draft" }, task, "nothing else changed");
    assert.equal(await markTaskValidated(again!), false, "already validated: no write");
  });

  it("replaces an explicit draft status in place and keeps comments and tables", async () => {
    const text = ["# greeting task", 'id = "a"', 'status = "draft"  # starter', 'instruction = "Say hello."', ...CHECK].join("\n");
    const root = repo({ "a.toml": text });
    const [task] = (await loadToolEvals(root)).tasks;
    assert.equal(await markTaskValidated(task!), true);
    assert.equal(readFileSync(task!.source, "utf8"), text.replace('status = "draft"  # starter', 'status = "validated"'));
  });

  it("refuses an edit that would land inside a multi-line string, leaving the file as is", async () => {
    const text = ['id = "a"', 'instruction = """', 'status = "draft"', 'Say hello."""', ...CHECK].join("\n");
    const root = repo({ "a.toml": text });
    const [task] = (await loadToolEvals(root)).tasks;
    await assert.rejects(markTaskValidated(task!), /couldn't place the status line safely/);
    assert.equal(readFileSync(task!.source, "utf8"), text);
  });

  it("sets status on the task's own JSONL line only", async () => {
    const row = (id: string) => JSON.stringify({ id, instruction: `Say ${id}.`, checks: [{ kind: "output", contains: [id] }] });
    const root = repo({ "t.jsonl": [row("a"), row("b"), ""].join("\n") });
    const tasks = (await loadToolEvals(root)).tasks;
    assert.equal(await markTaskValidated(tasks.find((t) => t.id === "b")!), true);
    const again = (await loadToolEvals(root)).tasks;
    assert.deepEqual(again.map((t) => [t.id, t.status]), [["a", "draft"], ["b", "validated"]]);
    assert.equal(readFileSync(join(root, "evals", "toolevals", "fake", "tasks", "t.jsonl"), "utf8").split("\n")[0], row("a"));
  });
});
