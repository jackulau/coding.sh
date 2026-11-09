// `coding.sh workflows` command metadata (docs/design/workflows.md §10), ready for
// src/cli/registry.ts: `import { WORKFLOWS_COMMAND } from "../workflows/cli-spec.ts"`
// and add it to COMMANDS under "Evaluate". Type-only imports keep `--help`
// free of store and adapter code; the command module loads lazily.
import type { FlagSpec } from "../cli/args.ts";
import { durableFlags } from "../jobs/flags.ts";
import type { CommandSpec } from "../cli/registry.ts";

const YES: FlagSpec = { name: "yes", short: "y", type: "boolean", desc: "Run without asking when the estimated cost is above the confirm threshold" };
const CASES: FlagSpec = { name: "cases", type: "string", value: "<DIR>", desc: "Cases directory (default: evals/workflows/<workflow>/cases)" };
const BIN: FlagSpec = { name: "bin", type: "string", value: "<PATH>", desc: "claude binary for the claude-code-workflow driver (default: claude on PATH)" };

export const WORKFLOWS_COMMAND: CommandSpec = {
  name: "workflows",
  aliases: ["workflow", "wf"],
  group: "Evaluate",
  summary: "Capture, measure and A/B-test multi-agent workflow runs",
  actions: [
    {
      name: "list",
      summary: "Runs with status, wall time, cost and agent count",
      flags: [
        { name: "framework", type: "string", value: "<FRAMEWORK>", desc: "Only runs from this framework" },
        { name: "name", type: "string", value: "<NAME>", desc: "Only runs of this workflow" },
        { name: "since", type: "string", value: "<WHEN>", desc: "Only after this time: 7d, 12h, 30m or a date" },
        { name: "experiment", type: "string", value: "<ID>", desc: "Only runs of this experiment" },
        { name: "limit", short: "n", type: "number", value: "<N>", desc: "Maximum rows", default: "20" },
        { name: "import", type: "boolean", desc: "Import new or changed Claude Code workflow runs first (--no-import to skip)", default: "true" },
      ],
      examples: ["coding.sh workflows list --since 7d", "coding.sh workflows list --framework langgraph --json"],
    },
    {
      name: "import",
      summary: "Import Claude Code workflow runs from disk",
      args: [{ name: "path", desc: "Projects, project, session or run directory (default: Claude Code's projects dir)" }],
      flags: [{ name: "force", type: "boolean", desc: "Re-import run directories that did not change" }],
    },
    {
      name: "show",
      summary: "Run tree with per-node time, cost and status",
      args: [{ name: "run", desc: "Workflow run id", required: true }],
      flags: [
        { name: "tree", type: "boolean", desc: "Include subagent, tool and model-call nodes" },
        { name: "gantt", type: "boolean", desc: "Print the timeline as TSV instead" },
      ],
    },
    {
      name: "stats",
      summary: "Critical path, concurrency, barrier idle, failures, cache hits, cost",
      args: [{ name: "run", desc: "Workflow run id", required: true }],
    },
    {
      name: "score",
      summary: "Grade a run's output against a case's truth",
      args: [{ name: "run", desc: "Workflow run id", required: true }],
      flags: [
        { name: "case", type: "string", value: "<ID>", desc: "Case id (default: the run's case)" },
        CASES,
        { name: "slack", type: "number", value: "<LINES>", desc: "Line distance that still matches a seeded bug", default: "5" },
      ],
    },
    {
      name: "run",
      summary: "A/B workflow variants over cases; prints the experiment id",
      args: [{ name: "workflow", desc: "Workflow name (cases live under evals/workflows/<workflow>/cases)", required: true }],
      flags: [
        { name: "variant", type: "list", value: "<NAME=SCRIPT|JSON>", desc: "Variant: name=script path (claude), name=command (command), or JSON (repeatable)" },
        CASES,
        { name: "k", short: "k", type: "number", value: "<N>", desc: "Attempts per case and variant", default: "3" },
        { name: "split", type: "string", value: "<SPLIT>", choices: ["dev", "heldout"], desc: "Only cases in this split" },
        { name: "driver", type: "string", value: "<DRIVER>", choices: ["claude", "command"], desc: "How a variant runs", default: "claude" },
        { name: "concurrency", short: "j", type: "number", value: "<N>", desc: "Jobs at once (a workflow already fans out)", default: "1" },
        { name: "validate", type: "boolean", desc: "Check seeded bugs on each case's snapshot first: each bug's test fails, and passes with the bug reverted (--no-validate to skip)", default: "true" },
        ...durableFlags("workflow experiment"),
        BIN,
        YES,
      ],
      graceful: true,
      examples: ["coding.sh workflows run coding-sh-improve -v base=wf/improve.js -v cand=wf/improve-v2.js -k 3 --split dev", "coding.sh workflows run coding-sh-improve -v base=wf/improve.js -v cand=wf/improve-v2.js -k 3 --resume"],
    },
    {
      name: "compare",
      summary: "Paired comparison of two variants of an experiment",
      args: [{ name: "experiment", desc: "Experiment id", required: true }],
      flags: [
        { name: "baseline", type: "string", value: "<VARIANT>", desc: "Baseline variant (required)" },
        { name: "candidate", type: "string", value: "<VARIANT>", desc: "Candidate variant (required)" },
        { name: "threshold", type: "number", value: "<SCORE>", desc: "Score that counts as a pass (default: the case's, else 0.5)" },
        { name: "seed", type: "number", value: "<N>", desc: "Bootstrap seed for the intervals and P(front)" },
        { name: "select", type: "string", value: "<RULE>", choices: ["min-cost", "weighted", "pareto"], desc: "Pick a variant to deploy: cheapest above a quality floor, best quality − λ·cost, or the front's extremes" },
        { name: "q-min", type: "number", value: "<SCORE>", desc: "min-cost: quality lower bound to reach" },
        { name: "q-drop", type: "number", value: "<PP>", desc: "min-cost: quality points below the baseline's mean allowed (default 10)" },
        { name: "lambda", type: "number", value: "<λ>", desc: "weighted: quality given up per USD (per second when no run records cost)" },
      ],
      examples: ["coding.sh workflows compare wfx_01 --baseline base --candidate cand --select min-cost --q-drop 10", "coding.sh workflows compare wfx_01 --baseline base --candidate cand --select pareto --json"],
    },
    {
      name: "replay",
      summary: "Re-run an edited script from a run's journal (cached prefix)",
      args: [{ name: "run", desc: "Base workflow run id", required: true }],
      flags: [
        { name: "script", type: "string", value: "<PATH>", desc: "Edited workflow script (required)" },
        { name: "base-script", type: "string", value: "<PATH>", desc: "Script the base run used, when it was not captured" },
        { name: "args", type: "string", value: "<JSON>", desc: "Workflow args (JSON or a .json path)" },
        { name: "dry-run", type: "boolean", desc: "Print the predicted cache hits without running" },
        BIN,
        YES,
      ],
    },
  ],
  notes: ["Workflow runs are stored under ~/.coding.sh/workflows/ until the index stores them."],
  load: () => import("../cli/commands/workflows.ts"),
};
