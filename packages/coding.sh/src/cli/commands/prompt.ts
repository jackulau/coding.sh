// coding.sh prompt set|get|list|label|diff
import { resolve } from "node:path";
import { readTextFile, readTextFileSync } from "../../core/text-file.ts";
import {
  diffPrompts,
  FilePromptStore,
  normalizePromptVersion,
  PromptNotFoundError,
  PromptRenderError,
  PromptValidationError,
  renderPrompt,
  validatePromptConfig,
  validatePromptLabel,
  validatePromptMessages,
  validatePromptSlug,
} from "../../prompts/store.ts";
import type { PromptConfig, PromptLabels, PromptVersion } from "../../prompts/types.ts";
import { UsageError } from "../args.ts";
import { jsonArg, list, str } from "../common.ts";
import { ago, CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

function toCliError(e: unknown): never {
  if (e instanceof PromptValidationError || e instanceof PromptRenderError) {
    throw new UsageError(e.message, { reason: "invalid_argument" });
  }
  if (e instanceof PromptNotFoundError) {
    throw new CliError(e.message, {
      reason: "not_found",
      next: ["List prompts:", "coding.sh prompt list"],
    });
  }
  throw e;
}

function parseVarFlags(rawVars: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const item of rawVars) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(`Invalid --var ${JSON.stringify(item)}: expected KEY=VALUE`, { reason: "invalid_argument" });
    }
    const key = item.slice(0, eq).trim();
    const val = item.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new UsageError(`Invalid variable name ${JSON.stringify(key)} in --var`, { reason: "invalid_argument" });
    }
    vars[key] = val;
  }
  return vars;
}

function formatLabelsCell(labels: PromptLabels): string {
  const entries = Object.entries(labels)
    .filter(([k]) => k !== "latest")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return "-";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function labelsPointingAt(labels: PromptLabels, version: string): string[] {
  return Object.entries(labels)
    .filter(([, v]) => v === version)
    .map(([k]) => k)
    .sort();
}

async function handleSet(c: CommandContext, store: FilePromptStore): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  try {
    validatePromptSlug(name);
  } catch (e) {
    toCliError(e);
  }

  const textFlag = str(c.flags.text);
  const fileFlag = str(c.flags.file);
  const messagesFlag = str(c.flags.messages);
  const configFlag = str(c.flags.config);
  const noteFlag = str(c.flags.note);
  const labelFlags = list(c.flags.label);

  for (const lbl of labelFlags) {
    try {
      validatePromptLabel(lbl);
    } catch (e) {
      toCliError(e);
    }
  }

  const sources = [textFlag !== undefined, fileFlag !== undefined, messagesFlag !== undefined].filter(Boolean).length;
  if (sources > 1) {
    throw new UsageError("Pass only one of --text, --file or --messages", { reason: "invalid_argument" });
  }

  let config: PromptConfig | undefined;
  if (configFlag !== undefined) {
    const rawConfig = await jsonArg(configFlag, "--config");
    try {
      config = validatePromptConfig(rawConfig);
    } catch (e) {
      toCliError(e);
    }
  }

  let type: "text" | "chat" = "text";
  let template: string | undefined;
  let messages: ReturnType<typeof validatePromptMessages> | undefined;

  if (messagesFlag !== undefined) {
    type = "chat";
    const rawMessages = await jsonArg(messagesFlag, "--messages");
    try {
      messages = validatePromptMessages(rawMessages);
    } catch (e) {
      toCliError(e);
    }
  } else if (fileFlag !== undefined) {
    const abs = resolve(c.cwd, fileFlag);
    try {
      template = await readTextFile(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new CliError(`Can't read ${abs}: no such file`, { reason: "not_found" });
      throw new CliError(`Can't read ${abs}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
    }
  } else if (textFlag !== undefined) {
    template = textFlag;
  } else if (process.stdin.isTTY !== true) {
    try {
      template = readTextFileSync(0);
    } catch {
      template = "";
    }
    if (!template) {
      throw new UsageError("Missing prompt content. Pass --text <STR>, --file <PATH>, --messages <JSON|FILE>, or pipe text on stdin", {
        reason: "missing_argument",
      });
    }
  } else {
    throw new UsageError("Missing prompt content. Pass --text <STR>, --file <PATH>, --messages <JSON|FILE>, or pipe text on stdin", {
      reason: "missing_argument",
    });
  }

  let saved;
  try {
    const putInput: Parameters<FilePromptStore["putPrompt"]>[0] =
      type === "text"
        ? { name, type: "text", template }
        : { name, type: "chat", messages };
    if (config !== undefined) putInput.config = config;
    if (noteFlag !== undefined) putInput.note = noteFlag;
    if (labelFlags.length > 0) putInput.labels = labelFlags;
    saved = await store.putPrompt(putInput);
  } catch (e) {
    toCliError(e);
  }

  if (out.json) {
    out.data({
      outcome: saved.created ? "created" : "unchanged",
      prompt: saved.version,
      labels: saved.labels,
    });
    return 0;
  }

  out.ok(
    saved.created
      ? `${saved.version.slug}@${saved.version.version} saved (${saved.version.type})`
      : `${saved.version.slug}@${saved.version.version} is unchanged`,
  );
  out.print(`${saved.version.slug}@${saved.version.version}`);
  return 0;
}

async function handleGet(c: CommandContext, store: FilePromptStore): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  const versionFlag = str(c.flags.version);
  const labelFlag = str(c.flags.label);
  const varFlags = list(c.flags.var);
  const rawMode = c.flags.raw === true;

  if (versionFlag !== undefined && labelFlag !== undefined) {
    throw new UsageError("Pass either --version or --label, not both", { reason: "invalid_argument" });
  }

  let slug: string;
  try {
    slug = validatePromptSlug(name);
    if (versionFlag !== undefined) normalizePromptVersion(versionFlag);
    if (labelFlag !== undefined) validatePromptLabel(labelFlag);
  } catch (e) {
    toCliError(e);
  }

  const vars = parseVarFlags(varFlags);
  const hasVars = varFlags.length > 0;

  let prompt: PromptVersion | undefined;
  try {
    const getOpts: { version?: string; label?: string } = {};
    if (versionFlag !== undefined) getOpts.version = versionFlag;
    else if (labelFlag !== undefined) getOpts.label = labelFlag;
    prompt = await store.getPrompt(slug, getOpts);
  } catch (e) {
    toCliError(e);
  }

  if (!prompt) {
    const target = versionFlag !== undefined ? `@${versionFlag}` : ` (label ${labelFlag ?? "latest"})`;
    throw new CliError(`Can't find prompt ${JSON.stringify(slug)}${target}`, {
      reason: "not_found",
      next: ["List prompts:", "coding.sh prompt list"],
    });
  }

  let rendered: ReturnType<typeof renderPrompt> | undefined;
  if (hasVars) {
    try {
      rendered = renderPrompt(prompt, vars);
    } catch (e) {
      toCliError(e);
    }
  }

  const labels = await store.getLabels(slug);

  if (out.json) {
    const doc: Record<string, unknown> = { prompt, labels };
    if (rendered !== undefined) doc.rendered = rendered;
    out.data(doc);
    return 0;
  }

  if (rawMode) {
    if (prompt.type === "text") {
      const text = rendered?.type === "text" ? rendered.text : prompt.template;
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    } else {
      const msgs = rendered?.type === "chat" ? rendered.messages : prompt.messages;
      process.stdout.write(`${JSON.stringify(msgs)}\n`);
    }
    return 0;
  }

  const activeLabels = labelsPointingAt(labels, prompt.version);
  out.row("Prompt", `${prompt.slug}@${prompt.version} (${prompt.type})`, "none", true);
  out.row("Hash", prompt.hash.slice(0, 12), "none", true);
  if (activeLabels.length) out.row("Labels", activeLabels.join(", "), "none", true);
  if (prompt.variables.length) out.row("Variables", prompt.variables.join(", "), "none", true);
  if (prompt.config !== undefined) out.row("Config", JSON.stringify(prompt.config), "none", true);
  if (prompt.note !== undefined) out.row("Note", prompt.note, "none", true);
  out.print("");

  if (prompt.type === "text") {
    const text = rendered?.type === "text" ? rendered.text : prompt.template;
    out.print(text);
  } else {
    const msgs = rendered?.type === "chat" ? rendered.messages : prompt.messages;
    for (const m of msgs) {
      out.print(`[${m.role}]`);
      out.print(m.content);
    }
  }
  return 0;
}

async function handleList(c: CommandContext, store: FilePromptStore): Promise<number> {
  const { out } = c;
  const prompts = await store.listPrompts();
  if (out.json) {
    out.data({ prompts });
    return 0;
  }
  if (!prompts.length) {
    out.note("No prompts");
    out.next("Save a versioned prompt", 'coding.sh prompt set triage --text "Classify ticket: {{ticket}}" --label production');
    return 0;
  }
  out.table(
    ["PROMPT", "TYPE", "LATEST", "VERSIONS", "LABELS", "UPDATED"],
    prompts.map((p) => [p.slug, p.type, p.latest, String(p.versions), formatLabelsCell(p.labels), ago(p.updatedAt)]),
  );
  return 0;
}

async function handleLabel(c: CommandContext, store: FilePromptStore): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  const label = c.positionals[1]!;
  const versionArg = c.positionals[2];
  const del = c.flags.delete === true;

  if (del && versionArg !== undefined) {
    throw new UsageError("Cannot pass both <VERSION> and --delete", { reason: "invalid_argument" });
  }
  if (!del && versionArg === undefined) {
    throw new UsageError("Missing <VERSION> (or pass --delete to remove the label)", { reason: "missing_argument" });
  }

  let slug: string;
  let validLabel: string;
  try {
    slug = validatePromptSlug(name);
    validLabel = validatePromptLabel(label);
    if (versionArg !== undefined) normalizePromptVersion(versionArg);
  } catch (e) {
    toCliError(e);
  }

  if (del) {
    let result;
    try {
      result = await store.deleteLabel(slug, validLabel);
    } catch (e) {
      toCliError(e);
    }
    if (out.json) {
      out.data({ outcome: "deleted", slug, label: validLabel, version: null, labels: result.labels });
      return 0;
    }
    out.ok(`Removed label ${validLabel} from ${slug}`);
    out.print(slug);
    return 0;
  }

  let result;
  try {
    result = await store.setLabel(slug, validLabel, versionArg!);
  } catch (e) {
    toCliError(e);
  }
  if (out.json) {
    out.data({ outcome: "updated", slug, label: validLabel, version: result.version, labels: result.labels });
    return 0;
  }
  out.ok(`${slug}: ${validLabel} -> ${result.version}`);
  out.print(`${slug}@${result.version}`);
  return 0;
}

async function handleDiff(c: CommandContext, store: FilePromptStore): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  const refA = c.positionals[1]!;
  const refB = c.positionals[2]!;

  let slug: string;
  let verA: PromptVersion | undefined;
  let verB: PromptVersion | undefined;
  try {
    slug = validatePromptSlug(name);
    verA = await store.resolveRef(slug, refA);
    verB = await store.resolveRef(slug, refB);
  } catch (e) {
    toCliError(e);
  }

  if (!verA) {
    throw new CliError(`Can't find ${JSON.stringify(refA)} on prompt ${JSON.stringify(slug)}`, {
      reason: "not_found",
      next: ["List prompts:", "coding.sh prompt list"],
    });
  }
  if (!verB) {
    throw new CliError(`Can't find ${JSON.stringify(refB)} on prompt ${JSON.stringify(slug)}`, {
      reason: "not_found",
      next: ["List prompts:", "coding.sh prompt list"],
    });
  }

  const diff = diffPrompts(verA, verB, { fromRef: refA, toRef: refB });
  if (out.json) {
    out.data(diff);
    return 0;
  }
  if (diff.identical) {
    out.note(`${slug}: ${refA} (${verA.version}) and ${refB} (${verB.version}) are identical`);
    return 0;
  }

  for (const line of diff.unified.trimEnd().split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) out.print(out.style(line, "bold"));
    else if (line.startsWith("@@ ")) out.print(out.style(line, "cyan"));
    else if (line.startsWith("+")) out.print(out.style(line, "green"));
    else if (line.startsWith("-")) out.print(out.style(line, "red"));
    else out.print(line);
  }
  return 0;
}

export async function run(c: CommandContext): Promise<number> {
  const store = new FilePromptStore({ env: c.env });
  switch (c.action) {
    case "set":
      return handleSet(c, store);
    case "get":
      return handleGet(c, store);
    case "list":
      return handleList(c, store);
    case "label":
      return handleLabel(c, store);
    case "diff":
      return handleDiff(c, store);
    default:
      throw new UsageError(`Unknown prompt command ${c.action}`, { reason: "unknown_command" });
  }
}
