// Writes docs/reference/cli.md from the command registry (src/cli/registry.ts),
// so the Markdown CLI reference cannot drift from the CLI it documents.
//
//   node packages/coding.sh/scripts/cli-reference.ts          # rewrite the file
//   node packages/coding.sh/scripts/cli-reference.ts --check  # exit 1 when it is stale
//
// test/docs/cli-reference.test.ts runs the same check in `npm test`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleFlags, type FlagSpec } from "../src/cli/args.ts";
import { BIN, commandHelp } from "../src/cli/main.ts";
import { COMMANDS, GLOBAL_FLAGS, type ActionSpec, type ArgSpec, type CommandSpec } from "../src/cli/registry.ts";

export const CLI_REFERENCE_PATH = fileURLToPath(new URL("../../../docs/reference/cli.md", import.meta.url));

const GROUPS: CommandSpec["group"][] = ["Capture", "Explore", "Evaluate", "Harness", "Maintain"];
const PLAIN = { heading: (s: string) => s, bold: (s: string) => s, faint: (s: string) => s };

/** Markdown text: escape pipes, and angle brackets and asterisks outside `code` spans. */
const cell = (s: string) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*/g, "\\*")))
    .join("")
    .replace(/\|/g, "\\|");
/** A sentence: ends with a period. */
const sentence = (s: string) => (/[.?!)]$/.test(s) ? s : `${s}.`);
const anchor = (name: string) => name.replace(/\s+/g, "-");

function flagSyntax(f: FlagSpec): string {
  const long = f.type === "boolean" ? `--${f.name}` : `--${f.name} ${f.value ?? "<VALUE>"}`;
  return f.short ? `-${f.short}, ${long}` : long;
}

function flagTable(all: FlagSpec[]): string[] {
  const flags = visibleFlags(all);
  if (!flags.length) return [];
  const rows = flags.map((f) => {
    const extra = [f.choices ? `One of: ${f.choices.map((c) => `\`${c}\``).join(", ")}.` : "", f.type === "list" && !/repeatable/i.test(f.desc) ? "Repeatable." : ""];
    return `| \`${flagSyntax(f)}\` | ${f.default !== undefined ? `\`${f.default}\`` : ""} | ${[sentence(cell(f.desc)), ...extra].filter(Boolean).join(" ")} |`;
  });
  return ["| Option | Default | Description |", "|---|---|---|", ...rows, ""];
}

function argTable(args: ArgSpec[] | undefined): string[] {
  if (!args?.length) return [];
  const rows = args.map((a) => `| \`${a.name}\` | ${a.required ? "yes" : "no"} | ${sentence(cell(a.desc))}${a.variadic ? " Takes the rest of the arguments." : ""} |`);
  return ["| Argument | Required | Description |", "|---|---|---|", ...rows, ""];
}

function examples(list: string[] | undefined): string[] {
  return list?.length ? ["```sh", ...list, "```", ""] : [];
}

function usage(cmd: CommandSpec, action?: ActionSpec): string {
  return commandHelp(cmd, action, PLAIN).split("\n")[0]!;
}

function renderAction(cmd: CommandSpec, a: ActionSpec): string[] {
  const name = `${cmd.name} ${a.name}`;
  return [
    `### \`${BIN} ${name}\``,
    "",
    `${a.summary}.`,
    "",
    "```text",
    usage(cmd, a),
    "```",
    "",
    ...argTable(a.args),
    ...flagTable(a.flags ?? []),
    ...examples(a.examples),
  ];
}

function renderCommand(cmd: CommandSpec): string[] {
  const out = [`## \`${BIN} ${cmd.name}\``, "", `${cmd.summary}.${cmd.aliases?.length ? ` Aliases: ${cmd.aliases.map((a) => `\`${a}\``).join(", ")}.` : ""}`, ""];
  out.push("```text", usage(cmd), "```", "");
  if (cmd.actions?.length) {
    out.push("| Action | What it does |", "|---|---|", ...cmd.actions.map((a) => `| [\`${a.name}\`](#${anchor(`${BIN} ${cmd.name} ${a.name}`).replace(/\./g, "")}) | ${cell(a.summary)} |`), "");
  }
  out.push(...argTable(cmd.args), ...flagTable(cmd.flags ?? []), ...examples(cmd.examples));
  if (cmd.notes?.length) out.push(...cmd.notes.map((n) => `- ${cell(n)}`), "");
  for (const a of cmd.actions ?? []) out.push(...renderAction(cmd, a));
  return out;
}

/** The whole reference as Markdown. Deterministic: no version, no date. */
export function renderCliReference(): string {
  const out = [
    "<!-- Generated from packages/coding.sh/src/cli/registry.ts by packages/coding.sh/scripts/cli-reference.ts. Do not edit by hand. -->",
    "",
    "# CLI reference",
    "",
    "Every `coding.sh` command, argument and option, generated from the CLI's command registry. Run",
    "`coding.sh <command> --help` for the same information in a terminal, or add `--json` to get it as JSON.",
    "",
    "## Global options",
    "",
    "Every command accepts these.",
    "",
    ...flagTable([...GLOBAL_FLAGS, { name: "version", short: "v", type: "boolean", desc: "Print the version" }]),
    "## Output and exit codes",
    "",
    "- stdout carries the answer only. Progress, warnings and errors go to stderr.",
    "- With `--json`, a command prints one JSON document on stdout. An error is one JSON line on stderr:",
    '  `{"status":"error","reason":"<reason>","message":"<text>","next":["<suggested command>"]}`.',
    "  The reasons are listed in [Troubleshooting](../troubleshooting.md).",
    "- Exit codes: `0` success, `1` error, `2` usage error (unknown option, bad value, missing `--yes`), `130` canceled.",
    "- Commands that change agent config ask first. In scripts and CI, pass `--yes`.",
    "",
    "## Commands",
    "",
    "| Command | Group | What it does |",
    "|---|---|---|",
    ...GROUPS.flatMap((g) => COMMANDS.filter((c) => c.group === g).map((c) => `| [\`${c.name}\`](#${anchor(`${BIN} ${c.name}`).replace(/\./g, "")}) | ${g} | ${cell(c.summary)} |`)),
    "",
  ];
  for (const g of GROUPS) for (const c of COMMANDS.filter((x) => x.group === g)) out.push(...renderCommand(c));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function isMain(): boolean {
  return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const want = renderCliReference();
  if (process.argv.includes("--check")) {
    let have = "";
    try {
      have = readFileSync(CLI_REFERENCE_PATH, "utf8");
    } catch {}
    if (have !== want) {
      process.stderr.write(`${CLI_REFERENCE_PATH} is stale. Regenerate it: node packages/coding.sh/scripts/cli-reference.ts\n`);
      process.exit(1);
    }
    process.stdout.write("docs/reference/cli.md is up to date\n");
  } else {
    writeFileSync(CLI_REFERENCE_PATH, want);
    process.stdout.write(`wrote ${CLI_REFERENCE_PATH}\n`);
  }
}
