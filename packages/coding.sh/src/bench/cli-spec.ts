// `coding.sh bench` command metadata. Type-only imports keep `--help` free of
// store and runner code; the command module loads lazily.
import type { FlagSpec } from "../cli/args.ts";
import type { CommandSpec } from "../cli/registry.ts";

const NAME = { name: "name", desc: "Benchmark name, or a path to its .toml", required: true };
const RUN_REF: FlagSpec = { name: "run", type: "string", value: "<RUN>", desc: "A specific run: id or YYYY-MM-DD (default: latest)" };

export const BENCH_COMMAND: CommandSpec = {
  name: "bench",
  aliases: ["benchmark"],
  group: "Evaluate",
  summary: "Dynamic benchmarks: fresh cases every run, same set for every contender",
  actions: [
    {
      name: "new",
      summary: "Write a benchmark definition (bench/<name>.toml)",
      args: [{ name: "name", desc: "Benchmark name (lowercase, digits, . _ -)", required: true }],
      flags: [
        { name: "source", type: "string", value: "<KIND>", choices: ["command", "sessions", "github", "urls", "dataset"], desc: "Where fresh cases come from", default: "command" },
        { name: "command", type: "string", value: "<CMD>", desc: "command source: prints JSONL cases (gets CODING_SH_BENCH_SEED and _DATE)" },
        { name: "repo", type: "string", value: "<OWNER/NAME>", desc: "github source: repository" },
        { name: "sitemap", type: "list", value: "<URL>", desc: "urls source: sitemap URL (repeatable)" },
        { name: "dataset", type: "string", value: "<NAME>", desc: "dataset source: dataset to sample from" },
        { name: "contender", short: "c", type: "list", value: "<NAME=CMD|URL|agent:ID[:MODEL]>", desc: "A contender (repeatable, at least two)" },
        { name: "grader", short: "g", type: "list", value: "<JSON>", desc: 'Grader spec, e.g. {"kind":"exact"} (repeatable)' },
        { name: "cases", short: "n", type: "number", value: "<N>", desc: "Cases per run", default: "50" },
        { name: "global", type: "boolean", desc: "Write to ~/.coding.sh/benchmarks instead of ./bench" },
        { name: "force", type: "boolean", desc: "Overwrite an existing definition" },
      ],
      examples: [
        "coding.sh bench new answers --command 'node gen.mjs' -c fast='node fast.mjs' -c big='node big.mjs' -g '{\"kind\":\"exact\"}'",
        "coding.sh bench new triage --source github --repo owner/name -c claude=agent:claude-code -c codex=agent:codex",
        "coding.sh bench new fetchers --source urls --sitemap https://example.com/sitemap.xml -c a=https://a.example/v1 -c b=https://b.example/v1",
      ],
    },
    {
      name: "run",
      summary: "Sample fresh cases, freeze them, run every contender and grade",
      args: [NAME],
      flags: [
        { name: "date", type: "string", value: "<YYYY-MM-DD>", desc: "Sample as if on this UTC date (adhoc: kept out of history)" },
        { name: "seed", type: "string", value: "<SEED>", desc: "Fixed seed instead of the definition's (adhoc)" },
        { name: "cases", short: "n", type: "number", value: "<N>", desc: "Cases this run (adhoc; default: the definition's)" },
        { name: "adhoc", type: "boolean", desc: "Keep this run out of history and the freshness ledger" },
        { name: "concurrency", type: "number", value: "<N>", desc: "Parallel calls (default: the definition's)" },
        { name: "dry-run", type: "boolean", desc: "Sample and print the cases, the detectable gap and the cost estimate; run nothing" },
        { name: "resume", type: "boolean", desc: "Continue the latest incomplete run (budget stop or interrupt): same seed and cases, finished calls kept" },
        { name: "run", type: "string", value: "<RUN>", desc: "With --resume: which incomplete run, by id or YYYY-MM-DD (default: the latest)" },
      ],
      examples: ["coding.sh bench run answers", "coding.sh bench run answers --dry-run", "coding.sh bench run answers --seed try-1 --cases 10", "coding.sh bench run answers --resume"],
    },
    {
      name: "regrade",
      summary: "Re-score stored outputs with the current graders (no contender calls)",
      args: [NAME],
      flags: [RUN_REF, { name: "all", type: "boolean", desc: "Regrade every counted run" }],
      examples: ["coding.sh bench regrade answers", "coding.sh bench regrade answers --all"],
    },
    { name: "list", summary: "Benchmarks with their last run and leader" },
    {
      name: "show",
      summary: "Leaderboard, head-to-head and failures for one run (checks a secret seed's commitment)",
      args: [NAME],
      flags: [RUN_REF, { name: "cases", type: "boolean", desc: "Also list the frozen cases" }],
    },
    {
      name: "history",
      summary: "One metric per contender over time",
      args: [NAME],
      flags: [
        { name: "metric", short: "m", type: "string", value: "<METRIC>", choices: ["pass", "score", "latency", "p95", "cost", "tokens", "tokens-in", "tokens-out", "errors"], desc: "Metric", default: "pass" },
        { name: "limit", short: "n", type: "number", value: "<N>", desc: "Most recent runs", default: "30" },
        { name: "vs", type: "string", value: "<CONTENDER>", desc: "Show each contender's paired pass-rate gap to this one, plus the gap pooled over the window" },
        { name: "anchor", type: "boolean", desc: "Numbers from the anchor set only (the same cases every day)" },
      ],
      examples: ["coding.sh bench history answers", "coding.sh bench history answers --metric latency --json", "coding.sh bench history answers --vs baseline", "coding.sh bench history answers --anchor"],
    },
    {
      name: "report",
      summary: "Write a self-contained HTML report plus report.json",
      args: [NAME],
      flags: [
        { name: "out", short: "o", type: "string", value: "<DIR>", desc: "Output directory (default: ~/.coding.sh/benchmarks/<name>/report)" },
        { name: "days", type: "number", value: "<N>", desc: "Days of history to include", default: "90" },
        { name: "viewer-url", type: "string", value: "<URL>", desc: "Viewer base URL for session links", default: "http://127.0.0.1:4319" },
        { name: "reference", type: "string", value: "<CONTENDER>", desc: "Contender for the gap chart (default: the definition's reference)" },
        { name: "include-private", type: "boolean", desc: "Show case contents, outputs and session links of a private benchmark (local copies only)" },
      ],
      examples: ["coding.sh bench report answers --out ./public/bench"],
    },
    {
      name: "schedule",
      summary: "Print a daily cron line and a GitHub Actions workflow (installing needs budget_usd)",
      args: [NAME],
      flags: [
        { name: "at", type: "string", value: "<HH:MM>", desc: "Time of day (cron: local; Actions: UTC)", default: "06:15" },
        { name: "runner", type: "string", value: "<LABELS>", desc: "Actions runs-on label(s), comma-separated", default: "self-hosted" },
        { name: "report-dir", type: "string", value: "<DIR>", desc: "Also write the report here after each run" },
        { name: "install-cron", type: "boolean", desc: "Add the line to your crontab (replaces this benchmark's earlier line only)" },
        { name: "workflow-out", type: "string", value: "<FILE>", desc: "Write the workflow to this file, e.g. .github/workflows/bench-<name>.yml" },
        { name: "yes", short: "y", type: "boolean", desc: "Don't ask before editing the crontab" },
      ],
      examples: ["coding.sh bench schedule answers", "coding.sh bench schedule answers --install-cron --yes", "coding.sh bench schedule answers --workflow-out .github/workflows/bench-answers.yml"],
    },
  ],
  notes: [
    "Definitions live in ./bench/<name>.toml (searched upward from the current directory) or ~/.coding.sh/benchmarks/<name>.toml.",
    "Each run is stored in ~/.coding.sh/benchmarks/<name>/runs/, its sample as dataset bench-<name>, and one experiment per contender.",
    "History counts the first complete plain `bench run` per date. --seed, --cases, --date and same-day reruns are adhoc.",
    "Guide: docs/guides/benchmarks.md",
  ],
  load: () => import("../cli/commands/bench.ts"),
};
