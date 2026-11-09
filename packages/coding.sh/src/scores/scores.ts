// Typed scores: validation, configs and the one write path every surface uses
// (the viewer/serve API, `coding.sh score`, the MCP tools).
//
// A score is a number, a boolean, a category or a text on a session, an event,
// a dataset case or an eval run. A ScoreConfig fixes the type and the allowed
// values of one score name: a value outside its range or categories is refused.
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import type { IndexStore, Score, ScoreConfig, ScoreDataType, ScoreFilter, ScoreSource, ScoreTarget } from "../core/types.ts";

export const SCORE_TARGETS: readonly ScoreTarget[] = ["session", "event", "case", "run"];
export const SCORE_DATA_TYPES: readonly ScoreDataType[] = ["numeric", "boolean", "categorical", "text"];
export const SCORE_SOURCES: readonly ScoreSource[] = ["human", "judge", "code", "api", "monitor"];

/** Score and config names: what labels allow for a criterion, plus "/". */
export const NAME_RE = /^[\w.:/-]{1,100}$/;
const MAX_ID = 200;
const MAX_CATEGORY = 200;
const MAX_TEXT = 4000;
const MAX_CATEGORIES = 100;

/** A bad score or config (status 400), an unknown target (404), or a clash (409). Surfaces map it to their own errors. */
export class ScoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ScoreError";
    this.status = status;
  }
}

const bad = (message: string) => new ScoreError(400, message);
type Obj = Record<string, unknown>;

function obj(body: unknown, what: string): Obj {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad(`${what} must be a JSON object`);
  return body as Obj;
}

export function checkScoreId(v: unknown, what: string): string {
  if (typeof v !== "string" || !v || v.length > MAX_ID || /[\u0000-\u001f]/.test(v)) throw bad(`${what} must be 1-${MAX_ID} characters with no control characters`);
  return v;
}

function checkName(v: unknown, what = "name"): string {
  if (typeof v !== "string" || !NAME_RE.test(v)) throw bad(`${what} must be 1-100 chars of [A-Za-z0-9_.:/-]`);
  return v;
}

function optString(b: Obj, k: string, max: number): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > max) throw bad(`${k} must be a string of at most ${max} chars`);
  return v;
}

function oneOf<T extends string>(v: unknown, all: readonly T[], what: string): T {
  if (typeof v !== "string" || !(all as readonly string[]).includes(v)) throw bad(`${what} must be one of ${all.join(", ")}`);
  return v as T;
}

/** The data type a value has when none is given: number → numeric, boolean → boolean, string → categorical. */
function inferType(v: unknown): ScoreDataType {
  if (typeof v === "number") return "numeric";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "categorical";
  throw bad("value must be a number, a boolean or a string");
}

/** The value checked against its type and config (400 when it does not fit). Booleans may be given as 0 or 1. */
export function checkValue(dataType: ScoreDataType, v: unknown, config?: ScoreConfig): Score["value"] {
  switch (dataType) {
    case "numeric": {
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad("value must be a finite number for a numeric score");
      if (config?.min !== undefined && v < config.min) throw bad(`value ${v} is below ${config.name}'s minimum ${config.min}`);
      if (config?.max !== undefined && v > config.max) throw bad(`value ${v} is above ${config.name}'s maximum ${config.max}`);
      return v;
    }
    case "boolean": {
      if (v === 0 || v === 1) return v === 1;
      if (typeof v !== "boolean") throw bad("value must be true or false for a boolean score");
      return v;
    }
    case "categorical": {
      if (typeof v !== "string" || !v.trim() || v.length > MAX_CATEGORY) throw bad(`value must be a non-empty string of at most ${MAX_CATEGORY} chars for a categorical score`);
      if (config?.categories && !config.categories.includes(v)) throw bad(`value ${JSON.stringify(v)} is not one of ${config.name}'s categories: ${config.categories.join(", ")}`);
      return v;
    }
    case "text": {
      if (typeof v !== "string" || v.length > MAX_TEXT) throw bad(`value must be a string of at most ${MAX_TEXT} chars for a text score`);
      return v;
    }
  }
}

/**
 * The id a score gets when none is given: one current score per target, name,
 * source and person, so scoring again replaces it. A person's session score
 * shares the viewer label's id, so a label and a boolean score are the same row.
 */
export function defaultScoreId(s: Pick<Score, "target" | "targetId" | "name" | "source" | "by">): string {
  const key = s.source === "human" && s.target === "session" ? `label\0${s.targetId}\0${s.name}\0${s.by}` : `score\0${s.target}\0${s.targetId}\0${s.name}\0${s.source}\0${s.by}`;
  return createHash("sha256").update(key).digest("hex");
}

export interface ScoreDefaults {
  /** Who is scoring (never read from the body). */
  by: string;
  /** Source when the body gives none. */
  source: ScoreSource;
  now: number;
}

/**
 * A score from a request body, checked: target, name, value against its type and
 * the config (by configId, else the config with the score's name), and the rest.
 * sessionId is taken as given; addScore resolves and checks it.
 */
export function parseScore(body: unknown, d: ScoreDefaults, configs: readonly ScoreConfig[]): Score {
  const b = obj(body, "body");
  const target = b.target === undefined ? "session" : oneOf(b.target, SCORE_TARGETS, "target");
  const targetId = checkScoreId(b.targetId ?? (target === "session" ? b.sessionId : undefined), "targetId");
  let config: ScoreConfig | undefined;
  if (b.configId !== undefined) {
    const id = checkScoreId(b.configId, "configId");
    config = configs.find((c) => c.id === id);
    if (!config) throw bad(`unknown configId ${JSON.stringify(id)} (list them: GET /api/score-configs)`);
  }
  const name = b.name === undefined && config ? config.name : checkName(b.name);
  if (config && config.name !== name) throw bad(`name ${JSON.stringify(name)} does not match config ${config.id}'s name ${JSON.stringify(config.name)}`);
  config ??= configs.find((c) => c.name === name);
  const dataType = b.dataType !== undefined ? oneOf(b.dataType, SCORE_DATA_TYPES, "dataType") : (config?.dataType ?? inferType(b.value));
  if (config && config.dataType !== dataType) throw bad(`dataType ${dataType} does not match ${config.name}'s config (${config.dataType})`);
  const value = checkValue(dataType, b.value, config);
  const source = b.source === undefined ? d.source : oneOf(b.source, SCORE_SOURCES, "source");
  let sessionId: string | undefined;
  if (target === "session") {
    if (b.sessionId !== undefined && b.sessionId !== targetId) throw bad("sessionId must equal targetId for a session score");
    sessionId = targetId;
  } else if (b.sessionId !== undefined && b.sessionId !== null) sessionId = checkScoreId(b.sessionId, "sessionId");
  let ts = d.now;
  if (b.ts !== undefined) {
    if (typeof b.ts !== "number" || !Number.isSafeInteger(b.ts) || b.ts < 0) throw bad("ts must be a non-negative integer (epoch ms)");
    ts = b.ts;
  }
  const score: Score = { id: "", target, targetId, ...(sessionId !== undefined ? { sessionId } : {}), name, dataType, value, source, by: d.by, ts };
  if (config) score.configId = config.id;
  const judgeVersion = optString(b, "judgeVersion", MAX_ID);
  if (judgeVersion) score.judgeVersion = judgeVersion;
  if (b.calibrated !== undefined && b.calibrated !== null) {
    if (typeof b.calibrated !== "boolean") throw bad("calibrated must be true or false");
    score.calibrated = b.calibrated;
  }
  const comment = optString(b, "comment", MAX_TEXT);
  if (comment) score.comment = comment;
  score.id = b.id === undefined ? defaultScoreId(score) : checkScoreId(b.id, "id");
  return score;
}

/** A config from a request body, checked. Its id defaults to its name. */
export function parseScoreConfig(body: unknown, now: number): ScoreConfig {
  const b = obj(body, "body");
  const name = checkName(b.name);
  const id = b.id === undefined ? name : checkScoreId(b.id, "id");
  const dataType = oneOf(b.dataType, SCORE_DATA_TYPES, "dataType");
  const c = { id, name, dataType } as ScoreConfig;
  const numberOr = (k: "min" | "max") => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`${k} must be a finite number`);
    return v;
  };
  const min = numberOr("min");
  const max = numberOr("max");
  if ((min !== undefined || max !== undefined) && dataType !== "numeric") throw bad("min and max apply to numeric configs only");
  if (min !== undefined && max !== undefined && min > max) throw bad("min must not be above max");
  if (min !== undefined) c.min = min;
  if (max !== undefined) c.max = max;
  if (b.categories !== undefined && b.categories !== null) {
    if (dataType !== "categorical") throw bad("categories apply to categorical configs only");
    const cats = b.categories;
    if (!Array.isArray(cats) || !cats.length || cats.length > MAX_CATEGORIES) throw bad(`categories must be a list of 1-${MAX_CATEGORIES} strings`);
    for (const x of cats) if (typeof x !== "string" || !x.trim() || x.length > MAX_CATEGORY) throw bad(`each category must be a non-empty string of at most ${MAX_CATEGORY} chars`);
    if (new Set(cats).size !== cats.length) throw bad("categories must be distinct");
    c.categories = [...(cats as string[])];
  } else if (dataType === "categorical") throw bad("a categorical config needs categories");
  const description = optString(b, "description", 1000);
  if (description) c.description = description;
  c.ts = now;
  return c;
}

/** Whether the store keeps scores (sqlite and memory do). */
export function hasScores(index: IndexStore): index is IndexStore & Required<Pick<IndexStore, "putScore" | "listScores" | "putScoreConfig" | "listScoreConfigs">> {
  return !!(index.putScore && index.listScores && index.putScoreConfig && index.listScoreConfigs);
}

function requireScores(index: IndexStore) {
  if (!hasScores(index)) throw new ScoreError(501, `the ${index.kind} store does not keep scores yet (use the default SQLite store)`);
  return index;
}

/** Two scores equal in everything but ts. */
function sameButTs(a: Score, b: Score): boolean {
  const strip = ({ ts: _ts, ...rest }: Score) => rest;
  const x = strip(a);
  const y = strip(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if ((x as Obj)[k] !== (y as Obj)[k]) return false;
  return true;
}

export interface AddScoreOptions extends ScoreDefaults {
  /**
   * The session a score must belong to be visible to the caller: called with the
   * resolved sessionId (or undefined when there is none); throws (404) when it is
   * not visible. Default: a session target must exist.
   */
  checkSession?: (sessionId: string | undefined) => Promise<void>;
}

/**
 * Checks and stores one score. A session target must exist; an event target's
 * session is looked up when the store can find events by id. Posting the same
 * id with the same content again changes nothing (`created: false`, the stored
 * score back, its ts kept); with other content it replaces the score.
 */
export async function addScore(index: IndexStore, body: unknown, o: AddScoreOptions): Promise<{ score: Score; created: boolean; changed: boolean }> {
  const store = requireScores(index);
  const score = parseScore(body, o, await store.listScoreConfigs());
  if (score.target === "event" && score.sessionId === undefined && index.eventsByIdPrefix) {
    const [e] = (await index.eventsByIdPrefix(score.targetId, 2)).filter((x) => x.id === score.targetId);
    if (!e) throw new ScoreError(404, `event not found: ${score.targetId}`);
    score.sessionId = e.sessionId;
  }
  if (o.checkSession) await o.checkSession(score.sessionId);
  else if (score.target === "session" && !(await index.getSession(score.targetId))) throw new ScoreError(404, `session not found: ${score.targetId}`);
  const [prev] = await store.listScores({ id: score.id });
  const givenTs = !!body && typeof body === "object" && (body as Obj).ts !== undefined;
  if (prev && sameButTs(prev, score) && (!givenTs || prev.ts === score.ts)) return { score: prev, created: false, changed: false };
  await store.putScore(score);
  return { score, created: !prev, changed: true };
}

/** Stores a config. Another config with the same name is a clash (409): one config per score name. */
export async function addScoreConfig(index: IndexStore, body: unknown, now: number): Promise<{ config: ScoreConfig; created: boolean }> {
  const store = requireScores(index);
  const config = parseScoreConfig(body, now);
  const all = await store.listScoreConfigs();
  const clash = all.find((c) => c.name === config.name && c.id !== config.id);
  if (clash) throw new ScoreError(409, `config ${clash.id} already covers the name ${JSON.stringify(config.name)}`);
  const prev = all.find((c) => c.id === config.id);
  if (prev) {
    const { ts: _a, ...x } = prev;
    const { ts: _b, ...y } = config;
    if (JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y))) return { config: prev, created: false };
  }
  await store.putScoreConfig(config);
  return { config, created: !prev };
}

function sortKeys(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function listScores(index: IndexStore, filter: ScoreFilter = {}): Promise<Score[]> {
  return requireScores(index).listScores(filter);
}

export async function listScoreConfigs(index: IndexStore): Promise<ScoreConfig[]> {
  return requireScores(index).listScoreConfigs();
}

/** A ScoreFilter from query parameters (the API and MCP share the names). */
export function scoreFilter(get: (k: string) => string | undefined): ScoreFilter {
  const f: ScoreFilter = {};
  const target = get("target");
  if (target !== undefined) f.target = oneOf(target, SCORE_TARGETS, "target");
  const source = get("source");
  if (source !== undefined) f.source = oneOf(source, SCORE_SOURCES, "source");
  for (const k of ["id", "targetId", "sessionId"] as const) {
    const v = get(k);
    if (v !== undefined) f[k] = checkScoreId(v, k);
  }
  const name = get("name");
  if (name !== undefined) f.name = checkName(name);
  for (const k of ["since", "until"] as const) {
    const v = get(k);
    if (v === undefined) continue;
    if (!/^\d{1,15}$/.test(v)) throw bad(`${k} must be epoch milliseconds`);
    f[k] = Number(v);
  }
  return f;
}

/** Who is scoring from the CLI or MCP: the OS user, as the viewer records labels. */
export function whoami(): string {
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}
