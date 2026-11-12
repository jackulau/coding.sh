// coding.sh score add|list|config|configs: typed scores from the command line.
//
//   coding.sh score add latest helpfulness 4 --comment "fixed it first try"
//   coding.sh score add event:evt_123 correct false --source code
//   coding.sh score list --name helpfulness --json
//   coding.sh score config helpfulness --type numeric --min 0 --max 5
import { parseSince, positiveInt, UsageError } from "../cli/args.ts";
import { autoIngest, list, num, readIngest, resolveSession, str, withContext } from "../cli/common.ts";
import { ago, CliError, plural } from "../cli/output.ts";
import type { CommandContext } from "../cli/types.ts";
import type { Context } from "../core/context.ts";
import { FileEvalStore } from "../datasets/store.ts";
import type { Score, ScoreConfig, ScoreDataType, ScoreFilter, ScoreTarget } from "../core/types.ts";
import { addScore, addScoreConfig, listScoreConfigs, listScores, SCORE_DATA_TYPES, SCORE_TARGETS, ScoreError, whoami } from "./scores.ts";

/** ScoreError → the CLI's errors: bad input exits 2, the rest 1. */
function cliError(e: unknown): unknown {
  if (!(e instanceof ScoreError)) return e;
  if (e.status === 400) return new UsageError(e.message, { reason: "invalid_score" });
  if (e.status === 404) return new CliError(e.message, { reason: "not_found", next: ["List sessions:", "coding.sh sessions"] });
  if (e.status === 409) return new CliError(e.message, { reason: "conflict", next: ["List configs:", "coding.sh score configs"] });
  if (e.status === 501) return new CliError(e.message, { reason: "unsupported_store", next: ["coding.sh config get store.index shows which store is in use"] });
  return new CliError(e.message, { reason: "error" });
}

const TARGET_HELP = "session:<id>, event:<id>, case:<id> or run:<id> (an eval run, run_…)";

/** Whether any version of any dataset has a case with this id. */
async function caseExists(ctx: Context, id: string): Promise<boolean> {
  const store = new FileEvalStore({ env: ctx.env, index: ctx.index });
  for (const d of await store.listDatasets()) {
    for (const v of await store.listDatasetVersions(d.id)) {
      if ((await store.getDataset(d.id, v.version))?.cases.some((c) => c.id === id)) return true;
    }
  }
  return false;
}

/** `kind:id`, or a session id (prefix or "latest"). `exists`: a run target must be a stored run (score add). */
async function resolveTarget(ctx: Context, raw: string, exists = false): Promise<{ target: ScoreTarget; targetId: string }> {
  const colon = raw.indexOf(":");
  const kind = colon > 0 ? raw.slice(0, colon) : "";
  if ((SCORE_TARGETS as readonly string[]).includes(kind)) {
    const id = raw.slice(colon + 1);
    if (!id) throw new UsageError(`${kind}: needs an id, e.g. ${kind}:abc123`, { reason: "bad_arg" });
    if (kind === "run" && exists && !(await ctx.index.listRuns()).some((r) => r.id === id)) {
      throw new CliError(`run not found: ${id}`, { reason: "not_found", next: ["A run id is an eval run's run_… id. Score a session instead:", "coding.sh score add latest outcome true"] });
    }
    if (kind === "case" && exists && !(await caseExists(ctx, id))) {
      throw new CliError(`case not found: ${id}`, { reason: "not_found", next: ["A case id is the id of a case in a dataset. List the datasets:", "coding.sh dataset list"] });
    }
    if (kind !== "session") return { target: kind as ScoreTarget, targetId: id };
    return { target: "session", targetId: (await resolveSession(ctx, id)).id };
  }
  if (kind === "exp" || kind === "experiment") {
    throw new UsageError(`an experiment is not a score target: score its runs or cases instead (${TARGET_HELP})`, { reason: "bad_arg" });
  }
  const s = await resolveSession(ctx, raw).catch((e: unknown) => {
    // `foo:bar` that is not a session either: name the targets, not "can't find session".
    if (/^[a-z]+$/.test(kind) && e instanceof CliError && e.reason === "not_found") throw new UsageError(`unknown score target ${kind}: use ${TARGET_HELP}, or a session id`, { reason: "bad_arg" });
    throw e;
  });
  return { target: "session", targetId: s.id };
}

/** The value as typed, read as its data type (or as the type it looks like). */
export function readValue(raw: string, type: ScoreDataType | undefined): unknown {
  const t = type ?? (/^(true|false)$/i.test(raw) ? "boolean" : raw.trim() !== "" && Number.isFinite(Number(raw)) ? "numeric" : "categorical");
  if (t === "numeric") return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (t === "boolean") {
    const v = raw.toLowerCase();
    if (["true", "1", "pass", "yes"].includes(v)) return true;
    if (["false", "0", "fail", "no"].includes(v)) return false;
    return raw;
  }
  return raw;
}

function shown(s: Score): string {
  return typeof s.value === "string" ? s.value : String(s.value);
}

async function add(c: CommandContext, ctx: Context): Promise<number> {
  const [rawTarget, name, rawValue] = c.positionals;
  if (!rawTarget || !name || rawValue === undefined) throw new UsageError("score add needs <target> <name> <value>, e.g. coding.sh score add latest outcome true", { reason: "missing_arg" });
  const { target, targetId } = await resolveTarget(ctx, rawTarget, true);
  const type = str(c.flags.type) as ScoreDataType | undefined;
  const configs = await listScoreConfigs(ctx.index).catch((e) => Promise.reject(cliError(e)));
  const configId = str(c.flags.config);
  const config = configId !== undefined ? configs.find((x) => x.id === configId) : configs.find((x) => x.name === name);
  if (configId !== undefined && !config) throw new CliError(`unknown score config ${JSON.stringify(configId)}`, { reason: "not_found", exitCode: 2, next: ["List configs:", "coding.sh score configs"] });
  const body: Record<string, unknown> = { target, targetId, name, value: readValue(rawValue, type ?? config?.dataType) };
  if (type) body.dataType = type;
  if (configId !== undefined) body.configId = configId;
  for (const [flag, key] of [["comment", "comment"], ["id", "id"], ["judge-version", "judgeVersion"], ["source", "source"]] as const) {
    const v = str(c.flags[flag]);
    if (v !== undefined) body[key] = v;
  }
  const session = str(c.flags.session);
  if (session !== undefined && target !== "session") body.sessionId = (await resolveSession(ctx, session)).id;
  const r = await addScore(ctx.index, body, { by: whoami(), source: "human", now: Date.now() }).catch((e) => Promise.reject(cliError(e)));
  if (c.out.json) {
    c.out.data({ score: r.score, created: r.created, changed: r.changed });
    return 0;
  }
  c.out.print(r.score.id);
  c.out.ok(`${r.changed ? (r.created ? "Scored" : "Updated") : "Unchanged:"} ${r.score.name} = ${shown(r.score)} (${r.score.dataType}) on ${r.score.target} ${r.score.targetId}`);
  return 0;
}

async function listCmd(c: CommandContext, ctx: Context): Promise<number> {
  const f: ScoreFilter = { limit: positiveInt(c.flags.limit, "limit") ?? 50 };
  const rawTarget = str(c.flags.target);
  if (rawTarget !== undefined) Object.assign(f, await resolveTarget(ctx, rawTarget));
  const name = str(c.flags.name);
  if (name) f.name = name;
  const source = str(c.flags.source) as ScoreFilter["source"];
  if (source) f.source = source;
  const session = str(c.flags.session);
  if (session !== undefined) f.sessionId = (await resolveSession(ctx, session)).id;
  const since = str(c.flags.since);
  if (since !== undefined) f.since = parseSince(since);
  const items = await listScores(ctx.index, f).catch((e) => Promise.reject(cliError(e)));
  if (c.out.json) {
    c.out.data({ items });
    return 0;
  }
  if (!items.length) {
    const filtered = Object.keys(f).some((k) => k !== "limit");
    c.out.note(filtered ? "No scores match these filters." : "No scores yet.");
    if (filtered) c.out.next("List every score", "coding.sh score list");
    else c.out.next("Score the latest session", "coding.sh score add latest outcome true");
    return 0;
  }
  c.out.table(
    ["WHEN", "TARGET", "NAME", "VALUE", "SOURCE", "BY"],
    items.map((s) => [ago(s.ts), `${s.target}:${s.targetId}`, s.name, shown(s), s.source, s.by]),
  );
  c.out.note(plural(items.length, "score"));
  return 0;
}

async function config(c: CommandContext, ctx: Context): Promise<number> {
  const [name] = c.positionals;
  if (!name) throw new UsageError("score config needs <name>, e.g. coding.sh score config helpfulness --type numeric --min 0 --max 5", { reason: "missing_arg" });
  const type = str(c.flags.type);
  if (!type) throw new UsageError(`score config needs --type (${SCORE_DATA_TYPES.join(", ")})`, { reason: "missing_flag" });
  const body: Record<string, unknown> = { name, dataType: type };
  const id = str(c.flags.id);
  if (id !== undefined) body.id = id;
  const min = num(c.flags.min);
  if (min !== undefined) body.min = min;
  const max = num(c.flags.max);
  if (max !== undefined) body.max = max;
  const cats = list(c.flags.categories).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  if (cats.length) body.categories = cats;
  const description = str(c.flags.description);
  if (description !== undefined) body.description = description;
  const r = await addScoreConfig(ctx.index, body, Date.now()).catch((e) => Promise.reject(cliError(e)));
  if (c.out.json) {
    c.out.data({ config: r.config, created: r.created });
    return 0;
  }
  c.out.print(r.config.id);
  c.out.ok(`${r.created ? "Created" : "Saved"} config ${r.config.name} (${describe(r.config)})`);
  return 0;
}

function describe(x: ScoreConfig): string {
  if (x.dataType === "numeric") return x.min === undefined && x.max === undefined ? "numeric" : `numeric ${x.min ?? "-∞"}..${x.max ?? "∞"}`;
  if (x.dataType === "categorical") return `categorical: ${x.categories?.join(", ")}`;
  return x.dataType;
}

async function configs(c: CommandContext, ctx: Context): Promise<number> {
  const items = await listScoreConfigs(ctx.index).catch((e) => Promise.reject(cliError(e)));
  if (c.out.json) {
    c.out.data({ items });
    return 0;
  }
  if (!items.length) {
    c.out.note("No score configs yet. A config fixes a score name's type and allowed values.");
    c.out.next("Add one", "coding.sh score config helpfulness --type numeric --min 0 --max 5");
    return 0;
  }
  c.out.table(["ID", "NAME", "TYPE", "DESCRIPTION"], items.map((x) => [x.id, x.name, describe(x), x.description ?? ""]));
  return 0;
}

export async function run(c: CommandContext): Promise<number> {
  return withContext(c, async (ctx) => {
    switch (c.action) {
      case "add":
        await autoIngest(ctx, readIngest(c));
        return add(c, ctx);
      case "list":
        await autoIngest(ctx, readIngest(c));
        return listCmd(c, ctx);
      case "config":
        return config(c, ctx);
      case "configs":
        return configs(c, ctx);
      default:
        throw new UsageError(`Unknown score command ${c.action}`);
    }
  }, { create: c.action !== "list" && c.action !== "configs" });
}
