// coding.sh CLI entry. Imports only the parser, output helpers and static
// command metadata; each command module is loaded after dispatch, so `--help`
// works offline and fast and touches no store, adapter or network.
//
// Conventions (https://vercel.com/design/cli):
//   stdout = the answer only; stderr = everything else.
//   --json = one JSON document on stdout; errors are one JSON line on stderr.
//   Exit codes: 0 ok, 1 failure, 2 usage error, 130 interrupted.
//
// `coding.sh` alone, in a terminal, sets up capture on first run (init) and
// opens the viewer after that (ui). Piped or in CI it prints help.
import { existsSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { parseArgs, suggest, UsageError, type FlagSpec } from "./args.ts";
import { Output } from "./output.ts";
import { version } from "./meta.ts";
import { COMMANDS, findCommand, GLOBAL_FLAGS, type ActionSpec, type CommandSpec } from "./registry.ts";

export const BIN = "coding.sh";

const SUMMARY = "Open-source, local-first observability and evals for coding agents.";
const GROUPS: CommandSpec["group"][] = ["Capture", "Explore", "Evaluate", "Harness", "Maintain"];

// ------------------------------------------------------------ help rendering

interface HelpStyle {
  heading(s: string): string;
  bold(s: string): string;
  faint(s: string): string;
}

function rows(items: [string, string][], indent = 2, min = 14): string[] {
  const w = Math.max(min, ...items.map(([k]) => k.length + 2));
  return items.map(([k, v]) => (k.length + 2 > 40 ? `${" ".repeat(indent)}${k}\n${" ".repeat(indent + 4)}${v}` : `${" ".repeat(indent)}${k.padEnd(w)}${v}`));
}

function flagSyntax(f: FlagSpec): string {
  const long = f.type === "boolean" ? `--${f.name}` : `--${f.name} ${f.value ?? "<VALUE>"}`;
  return f.short ? `-${f.short}, ${long}` : `    ${long}`;
}

function flagDesc(f: FlagSpec): string {
  return f.default !== undefined ? `${f.desc} (default: ${f.default})` : f.desc;
}

function argSyntax(args: ActionSpec["args"] = []): string {
  return args.map((a) => (a.required ? `<${a.name.toUpperCase()}>` : `[${a.name}]`) + (a.variadic ? "..." : "")).join(" ");
}

function section(title: string, body: string[], s: HelpStyle): string[] {
  return body.length ? ["", s.heading(title), ...body] : [];
}

export function rootHelp(s: HelpStyle): string {
  const out = [`${s.bold(BIN)} <command> [options]`, "", `  ${s.faint(SUMMARY)}`];
  for (const g of GROUPS) {
    const cmds = COMMANDS.filter((c) => c.group === g);
    out.push(...section(g, rows(cmds.map((c) => [c.name, c.summary])), s));
  }
  out.push(...section("Global Options", rows(GLOBAL_FLAGS.map((f): [string, string] => [flagSyntax(f), flagDesc(f)]).concat([["-v, --version", "Print the version"]])), s));
  out.push(...section("Examples", ["    coding.sh init", "    coding.sh sessions --since 7d", "    coding.sh show latest"], s));
  out.push(...section("Learn More", [`  Run ${s.bold(`${BIN} <command> --help`)} for a command's options.`], s));
  return out.join("\n") + "\n";
}

export function commandHelp(cmd: CommandSpec, action: ActionSpec | undefined, s: HelpStyle): string {
  const name = action ? `${cmd.name} ${action.name}` : cmd.name;
  const args = action ? action.args : cmd.args;
  const flags = action ? (action.flags ?? []) : (cmd.flags ?? []);
  const usage = [BIN, name];
  if (!action && cmd.actions) usage.push(cmd.actionOptional ? "[action]" : "<action>");
  const argText = argSyntax(args);
  if (cmd.passthrough) usage.push("[options] --", argText);
  else {
    if (argText) usage.push(argText);
    if (flags.length) usage.push("[options]");
  }
  const out = [s.bold(usage.join(" ")), "", `  ${s.faint(action ? action.summary : cmd.summary)}`];
  if (!action && cmd.actions) out.push(...section("Commands", rows(cmd.actions.map((a) => [a.name, a.summary])), s));
  if (args?.length) out.push(...section("Arguments", rows(args.map((a) => [a.name, a.desc])), s));
  if (flags.length) out.push(...section("Options", rows(flags.map((f) => [flagSyntax(f), flagDesc(f)])), s));
  out.push(...section("Global Options", rows(GLOBAL_FLAGS.map((f) => [flagSyntax(f), flagDesc(f)])), s));
  const examples = (action ? action.examples : cmd.examples) ?? [];
  out.push(...section("Examples", examples.slice(0, 3).map((e) => `    ${e}`), s));
  if (!action && cmd.notes?.length) out.push(...section("Notes", cmd.notes.map((n) => `  ${n}`), s));
  if (cmd.aliases?.length && !action) out.push(...section("Aliases", [`  ${cmd.aliases.join(", ")}`], s));
  return out.join("\n") + "\n";
}

/** `--help --json`: machine-readable metadata. */
export function helpMetadata(cmd?: CommandSpec, action?: ActionSpec): unknown {
  const flag = (f: FlagSpec) => ({ name: f.name, short: f.short ?? null, type: f.type, description: f.desc, default: f.default ?? null, choices: f.choices ?? null });
  const arg = (a: NonNullable<ActionSpec["args"]>[number]) => ({ name: a.name, description: a.desc, required: a.required === true, variadic: a.variadic === true });
  const describe = (c: CommandSpec) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    group: c.group,
    summary: c.summary,
    arguments: (c.args ?? []).map(arg),
    options: (c.flags ?? []).map(flag),
    commands: (c.actions ?? []).map((a) => ({ name: a.name, summary: a.summary, arguments: (a.args ?? []).map(arg), options: (a.flags ?? []).map(flag) })),
  });
  if (cmd && action) return { command: { name: `${cmd.name} ${action.name}`, summary: action.summary, arguments: (action.args ?? []).map(arg), options: (action.flags ?? []).map(flag) }, globalOptions: GLOBAL_FLAGS.map(flag) };
  if (cmd) return { command: describe(cmd), globalOptions: GLOBAL_FLAGS.map(flag) };
  return { name: BIN, version: version(), summary: SUMMARY, commands: COMMANDS.map(describe), globalOptions: GLOBAL_FLAGS.map(flag) };
}

// ------------------------------------------------------------ dispatch

interface Globals {
  json: boolean;
  noColor: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
  /** `--store URL` / `--blobs URL`: point this run at another store (sets CODING_SH_STORE_URL / CODING_SH_BLOB_URL). */
  store?: string;
  blobs?: string;
}

/** Pulls global flags out of argv (up to `--`). */
export function extractGlobals(argv: readonly string[]): { globals: Globals; rest: string[] } {
  const g: Globals = { json: false, noColor: false, debug: false, help: false, version: false };
  const rest: string[] = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (passthrough || t === "--") {
      passthrough = true;
      rest.push(t);
      continue;
    }
    const storeFlag = /^--(store|blobs)(?:=(.*))?$/.exec(t);
    if (storeFlag) {
      const value = storeFlag[2] ?? argv[++i];
      if (value === undefined || value === "" || (storeFlag[2] === undefined && value.startsWith("-"))) {
        throw new UsageError(`--${storeFlag[1]} needs a URL, e.g. --${storeFlag[1]} ${storeFlag[1] === "store" ? "postgres://user:pass@host/db" : "s3://bucket/prefix"}`, { reason: "missing_argument" });
      }
      g[storeFlag[1] as "store" | "blobs"] = value;
      continue;
    }
    if (t === "--json") g.json = true;
    else if (t === "--no-color") g.noColor = true;
    else if (t === "--debug") g.debug = true;
    else if (t === "--help" || t === "-h") g.help = true;
    else if ((t === "--version" || t === "-v") && rest.length === 0) g.version = true;
    else rest.push(t);
  }
  return { globals: g, rest };
}

/**
 * What `coding.sh` with no command runs: "init" until capture is set up (the
 * hook bin exists), then "ui". Undefined (print help) when not interactive, so
 * scripts never block on a prompt or a server.
 */
export function defaultCommand(env: NodeJS.ProcessEnv, interactive: boolean): "init" | "ui" | undefined {
  if (!interactive) return undefined;
  return existsSync(paths(env).hook) ? "ui" : "init";
}

/** One dim stderr line when a newer release is out (cached; see update/index.ts for the opt-outs). */
async function updateNotice(env: NodeJS.ProcessEnv, out: Output, command: string): Promise<void> {
  // `mcp` talks to an agent over stdio; `update` reports on its own.
  if (out.json || process.stderr.isTTY !== true || command === "mcp" || command === "update") return;
  try {
    const { notice } = await import("../update/index.ts");
    notice(env, out, { command });
  } catch {
    // never let a notice fail a command
  }
}

/** Global `--name`s, for typo suggestions (extractGlobals pulls them out before parsing). */
const GLOBAL_OPTION_NAMES: readonly string[] = GLOBAL_FLAGS.map((f) => `--${f.name}`);
/** Before a command, `--version` is valid too. */
const ROOT_OPTION_NAMES: readonly string[] = [...GLOBAL_OPTION_NAMES, "--version"];

function helpStyle(out: Output): HelpStyle {
  return {
    heading: (t) => out.style(out.style(t, "bold"), "magenta"),
    bold: (t) => out.style(t, "bold"),
    faint: (t) => out.style(t, "faint"),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let extracted: ReturnType<typeof extractGlobals>;
  try {
    extracted = extractGlobals(argv);
  } catch (e) {
    return new Output({ json: argv.includes("--json"), noColor: argv.includes("--no-color"), env }).error(e, argv.includes("--debug"));
  }
  const { globals, rest } = extracted;
  if (globals.store !== undefined || globals.blobs !== undefined) {
    env = { ...env, ...(globals.store !== undefined ? { CODING_SH_STORE_URL: globals.store } : {}), ...(globals.blobs !== undefined ? { CODING_SH_BLOB_URL: globals.blobs } : {}) };
  }
  const out = new Output({ json: globals.json, noColor: globals.noColor, env });
  try {
    if (globals.version && rest.length === 0) {
      if (out.json) out.data({ version: version() });
      else process.stdout.write(version() + "\n");
      return 0;
    }
    let [name, ...tail] = rest;
    if (name === "help") {
      globals.help = true;
      [name, ...tail] = tail;
    } else if (name === undefined && !globals.help) {
      name = defaultCommand(env, out.interactive);
    }
    if (name === undefined || name.startsWith("-")) {
      if (name !== undefined && !globals.help) {
        const hint = name.startsWith("--") ? suggest(name.split("=")[0]!, ROOT_OPTION_NAMES) : undefined;
        throw new UsageError(`Unknown option ${name}`, { suggestion: hint, reason: "unknown_option" });
      }
      if (out.json) out.data(helpMetadata());
      else process.stdout.write(rootHelp(helpStyle(out)));
      return 0;
    }
    const cmd = findCommand(name);
    if (!cmd) {
      const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
      const s = suggest(name, names);
      throw new UsageError(`Unknown command ${JSON.stringify(name)}`, { suggestion: s ? `${BIN} ${s}` : `${BIN} --help`, reason: "unknown_command" });
    }

    let action: ActionSpec | undefined;
    if (cmd.actions && !(cmd.actionOptional && (tail[0] === undefined || tail[0].startsWith("-")) && !globals.help)) {
      const a = tail[0];
      if (a === undefined || a.startsWith("-")) {
        if (globals.help) {
          if (out.json) out.data(helpMetadata(cmd));
          else process.stdout.write(commandHelp(cmd, undefined, helpStyle(out)));
          return 0;
        }
        throw new UsageError(`Missing command for ${BIN} ${cmd.name}. Choose one of: ${cmd.actions.map((x) => x.name).join(", ")}`, { reason: "missing_command" });
      }
      action = cmd.actions.find((x) => x.name === a);
      if (!action) {
        const s = suggest(a, cmd.actions.map((x) => x.name));
        throw new UsageError(`Unknown command ${JSON.stringify(`${cmd.name} ${a}`)}`, { suggestion: s ? `${BIN} ${cmd.name} ${s}` : `${BIN} ${cmd.name} --help`, reason: "unknown_command" });
      }
      tail = tail.slice(1);
    }

    if (globals.help) {
      if (out.json) out.data(helpMetadata(cmd, action));
      else process.stdout.write(commandHelp(cmd, action, helpStyle(out)));
      return 0;
    }

    const args = action ? (action.args ?? []) : (cmd.args ?? []);
    const flags = action ? (action.flags ?? []) : (cmd.flags ?? []);
    const variadic = args.some((a) => a.variadic) && !cmd.passthrough;
    const parsed = parseArgs(tail, flags, { maxPositionals: cmd.passthrough ? 0 : variadic ? undefined : args.length, suggestions: GLOBAL_OPTION_NAMES });
    if (cmd.passthrough) {
      if (parsed.rest.length === 0) throw new UsageError(`Missing command. Usage: ${BIN} ${cmd.name} -- <cmd> [args...]`, { reason: "missing_argument" });
    } else {
      if (parsed.sawDashDash) parsed.positionals.push(...parsed.rest);
      const required = args.filter((a) => a.required).length;
      if (parsed.positionals.length < required) {
        const missing = args.filter((a) => a.required)[parsed.positionals.length]!;
        throw new UsageError(`Missing argument <${missing.name.toUpperCase()}>. Usage: ${BIN} ${cmd.name}${action ? ` ${action.name}` : ""} ${argSyntax(args)}`, { reason: "missing_argument" });
      }
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = () => {
      interrupts++;
      if (interrupts > 1) process.exit(130);
      controller.abort();
    };
    const ownSignals = cmd.handlesSignals === true && !action;
    if (!cmd.passthrough && !ownSignals) process.on("SIGINT", onSigint);
    try {
      const mod = await cmd.load();
      const code = await mod.run({
        action: action?.name,
        flags: parsed.flags,
        positionals: parsed.positionals,
        rest: parsed.rest,
        out,
        env,
        cwd: process.cwd(),
        debug: globals.debug,
        signal: controller.signal,
      });
      if (controller.signal.aborted && !cmd.passthrough && !ownSignals) return 130;
      await updateNotice(env, out, cmd.name);
      return code ?? 0;
    } finally {
      process.off("SIGINT", onSigint);
    }
  } catch (e) {
    return out.error(e, globals.debug);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = new URL(import.meta.url).pathname;
    return entry === self || /(?:^|[\\/])(cli\.mjs|main\.ts|coding\.sh|codingsh)$/.test(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  // A closed stdout (`coding.sh sessions | head -1`) ends quietly with exit 0.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  main().then(
    (code) => {
      // Flush both streams before exiting (pipes are async on macOS).
      process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
