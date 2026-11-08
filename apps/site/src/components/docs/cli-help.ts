// Builds the CLI reference from the CLI itself. At build time it runs the
// bundled packages/coding.sh/dist/cli.mjs: `--help --json` names the commands,
// groups and sub-actions, and each command's plain `--help` is the text shown.
// Nothing is hand-written, so the page cannot drift from the binary it
// documents. When dist/cli.mjs has not been built, the page says so instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface HelpCommand {
  /** "init", or "eval new" for a sub-action. */
  name: string;
  summary: string;
  aliases: string[];
  /** Plain --help text with the shared Global Options block removed. */
  help: string;
  actions: HelpCommand[];
}

export interface HelpGroup {
  label: string;
  commands: HelpCommand[];
}

export interface CliReference {
  version: string;
  summary: string;
  /** Global options block from the top-level help, verbatim. */
  globalOptions: string;
  groups: HelpGroup[];
}

interface MetaCommand {
  name: string;
  group: string;
  summary: string;
  aliases?: string[];
  commands?: { name: string; summary: string }[];
}
interface Meta {
  version: string;
  summary: string;
  commands: MetaCommand[];
}

/** Walks up from the build's cwd to the repo's packages/coding.sh/dist/cli.mjs. */
function findCli(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "packages", "coding.sh", "dist", "cli.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The indented lines under a block title such as "Global Options". */
function block(text: string, title: string): string {
  const m = new RegExp(`(?:^|\\n)${title}\\n((?: .*(?:\\n|$))*)`).exec(text);
  return m ? m[1]!.trimEnd() : "";
}

/** Removes the "Global Options" block, which every command repeats. */
function stripGlobal(text: string): string {
  return text
    .replace(/(^|\n)Global Options\n(?: .*(?:\n|$))*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Re-indents each titled block ("Options", "Arguments", ...) to two spaces.
 * The CLI pads flag rows to leave room for a short flag ("-h, "), so a block
 * with no short flags starts six columns in; on a phone that is wasted width.
 * Columns inside a block keep their alignment.
 */
export function dedentBlocks(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split("\n");
      const body = lines.slice(/^\S/.test(lines[0] ?? "") ? 1 : 0).filter((l) => l.trim());
      if (!body.length) return para;
      const min = Math.min(...body.map((l) => l.match(/^ */)![0].length));
      if (min <= 2) return para;
      const cut = min - 2;
      return lines.map((l) => (/^ /.test(l) ? l.slice(Math.min(cut, l.match(/^ */)![0].length)) : l)).join("\n");
    })
    .join("\n\n");
}

/** Heading id for a command or sub-action: "eval new" -> "cmd-eval-new". */
export const cliAnchor = (name: string) => `cmd-${name.replace(/\s+/g, "-")}`;

/**
 * Each top-level command has its own page, /docs/cli/<command>, with its
 * sub-actions on it. All of them on one page came to over 40KB of HTML.
 */
export const cliPath = (name: string) => `/docs/cli/${name.split(/\s+/)[0]}`;

let cached: CliReference | null | undefined;

export function cliReference(): CliReference | null {
  if (cached !== undefined) return cached;
  const cliPath = findCli();
  if (!cliPath) return (cached = null);

  // --help never touches user data, but run it against a throwaway home anyway:
  // a docs build must not read or write anyone's real ~/.coding.sh.
  const home = mkdtempSync(join(tmpdir(), "codingsh-docs-"));
  const env = { ...process.env, HOME: home, CODING_SH_HOME: join(home, ".coding.sh"), NO_COLOR: "1", FORCE_COLOR: "0" };
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

  try {
    const meta = JSON.parse(run("--help", "--json")) as Meta;
    const groups: HelpGroup[] = [];
    for (const c of meta.commands) {
      let group = groups.find((g) => g.label === c.group);
      if (!group) groups.push((group = { label: c.group, commands: [] }));
      group.commands.push({
        name: c.name,
        summary: c.summary,
        aliases: c.aliases ?? [],
        help: dedentBlocks(stripGlobal(run(c.name, "--help"))),
        actions: (c.commands ?? []).map((a) => ({
          name: `${c.name} ${a.name}`,
          summary: a.summary,
          aliases: [],
          help: dedentBlocks(stripGlobal(run(c.name, a.name, "--help"))),
          actions: [],
        })),
      });
    }
    return (cached = { version: meta.version, summary: meta.summary, globalOptions: dedentBlocks(block(run("--help"), "Global Options")), groups });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
