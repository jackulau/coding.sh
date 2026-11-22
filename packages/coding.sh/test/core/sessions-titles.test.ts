import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { buildSession, TITLE_SKIP } from "../../src/core/sessions.ts";
import { groupWorkItems, workItem } from "../../src/core/work.ts";

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "claude-code", kind, payload, ...o,
});
const title = (text: string): string | undefined => buildSession([ev("session.start"), ev("user.message", { text })]).title;

const FRAME = "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script.";

describe("session titles", () => {
  it("skip a workflow-harness frame line and title from the task", () => {
    assert.equal(title(`${FRAME}\n\nFix the flaky retry test in the parser`), "Fix the flaky retry test in the parser");
    // The harness indents every line of the task it wraps.
    assert.equal(title(`${FRAME}\n  Project: demo\n  Add a --json flag to sessions`), "Add a --json flag to sessions");
  });

  it("skip a Project: header line only inside a harness frame", () => {
    assert.equal(title(`${FRAME}\nProject: demo, a CLI for notes.\nRename the export command`), "Rename the export command");
    // With no frame, a task that starts with "Project:" is the task.
    assert.equal(title("Project: rename the API"), "Project: rename the API");
    assert.equal(title("Project: rewrite the importer so it streams\nKeep the CLI flags the same."), "Project: rewrite the importer so it streams Keep the CLI flags the same.");
  });

  it("a subagent's prompt skips the frame before it is cut to one line", () => {
    const s = buildSession([
      ev("session.start", { source: "subagent", parentSessionId: "p" }, { subagentId: "a1" }),
      ev("user.message", { text: `${FRAME}\n  Project: demo\n  Add a --json flag to sessions\n  Keep the old output too` }, { subagentId: "a1" }),
    ]);
    assert.equal(s.title, "Add a --json flag to sessions");
  });

  it("a workflow agent whose prompt is only a frame is titled by its phase and label", () => {
    const start = (extra: Record<string, unknown>) => ev("session.start", { source: "subagent", parentSessionId: "p", workflowId: "w1", ...extra });
    assert.equal(buildSession([start({ workflowPhase: "build", workflowLabel: "titles" }), ev("user.message", { text: FRAME })]).title, "build · titles");
    assert.equal(buildSession([start({ workflowPhase: "build" }), ev("user.message", { text: FRAME })]).title, "build");
    assert.equal(buildSession([start({ workflowLabel: "titles" })]).title, "titles");
    // A real task line still wins.
    assert.equal(buildSession([start({ workflowPhase: "build", workflowLabel: "titles" }), ev("user.message", { text: `${FRAME}\n  Fix the parser` })]).title, "Fix the parser");
    // Not a workflow agent: a frame-only prompt keeps today's title.
    assert.equal(buildSession([ev("session.start", { source: "subagent", parentSessionId: "p" }), ev("user.message", { text: FRAME })]).title, FRAME);
  });

  it("take the prompt outside a pasted block", () => {
    assert.equal(title("<pasted_content>\nstack trace line\n</pasted_content>\nwhy does this fail"), "why does this fail");
    assert.equal(title('<pasted_content id="1" lines="3">\nTypeError: x\n  at f\n</pasted_content>\n\nwhy does this fail'), "why does this fail");
  });

  it("a paste alone titles from its first non-empty line, with the tags dropped", () => {
    assert.equal(title("<pasted_content>\n\nstack trace line\nnext line\n</pasted_content>"), "stack trace line");
  });

  it("a prompt that is only skipped lines keeps today's title", () => {
    assert.equal(title("Project: demo"), "Project: demo");
    assert.equal(title(FRAME), FRAME.slice(0, 280));
  });

  it("an ordinary prompt is unchanged", () => {
    assert.equal(title("Fix the parser\nand add a test for it"), "Fix the parser and add a test for it");
    // Project: only counts at the start of a line.
    assert.equal(title("Rename the Project: header in the README"), "Rename the Project: header in the README");
    assert.equal(title("Explain [Workflow harness] notes"), "Explain [Workflow harness] notes");
  });

  it("a host's thread title still wins", () => {
    const s = buildSession([
      ev("session.start"),
      ev("notification", { type: "host-link", title: "Parser retries" }),
      ev("user.message", { text: `${FRAME}\nFix the flaky retry test` }),
    ]);
    assert.equal(s.title, "Parser retries");
  });

  it("a work item built from a framed session shows its task", () => {
    const s = buildSession([ev("session.start", { cwd: "/work/demo" }), ev("user.message", { text: `${FRAME}\n  Project: demo\n  Add a --json flag to sessions` })]);
    const [raw] = groupWorkItems([s]);
    assert.equal(workItem(raw!, s.startedAt + 1000).title, "Add a --json flag to sessions");
  });

  it("the skip list is short and every entry is anchored at a line start", () => {
    assert.ok(TITLE_SKIP.length <= 4);
    for (const re of TITLE_SKIP) assert.ok(re.source.startsWith("^"), re.source);
  });
});
