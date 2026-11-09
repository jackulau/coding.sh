// Hand-rolled argv parser (no deps). Supports `--name value`, `--name=value`,
// `-x value`, `--no-name` for booleans, repeated list flags (comma lists too where
// the flag says so), and `--` to end
// option parsing. Unknown options and extra positionals are usage errors raised
// before any work happens.

export type FlagType = "boolean" | "string" | "number" | "list";

export interface FlagSpec {
  name: string;
  short?: string;
  type: FlagType;
  desc: string;
  /** Placeholder shown in help, e.g. "<AGENT>". */
  value?: string;
  /** Shown as "(default: X)". */
  default?: string;
  choices?: readonly string[];
  /**
   * String flag whose value may be left out (the flag is then `true`). A
   * following token is taken as its value only when it is one of `choices`,
   * so `--gateway a b` keeps `a` and `b` as positionals.
   */
  optionalValue?: boolean;
  /** With optionalValue: a following token matching this is taken as the value too (`--resume exp_01H…`). */
  valuePattern?: RegExp;
  /** A following token that starts with a single `-` is its value, not a flag (`--where -flag:compaction`). */
  dashValue?: boolean;
  /** Accepted but left out of help, `--help --json` and the CLI reference (internal plumbing). */
  hidden?: boolean;
  /**
   * List flag whose values are ids or names: `--agent a,b` is `--agent a --agent b`. Left off
   * where a value may itself hold a comma (JSON, a command, a regex, a path or glob).
   */
  commas?: boolean;
}

/** The flags help shows: everything but the hidden ones. */
export function visibleFlags(flags: readonly FlagSpec[] | undefined): FlagSpec[] {
  return (flags ?? []).filter((f) => !f.hidden);
}

export type FlagValue = string | number | boolean | string[] | undefined;

export interface ParsedArgs {
  flags: Record<string, FlagValue>;
  positionals: string[];
  /** Everything after `--`. */
  rest: string[];
  /** True when `--` was present. */
  sawDashDash: boolean;
}

/** Wrong invocation: exit code 2. */
export class UsageError extends Error {
  readonly suggestion?: string;
  readonly reason: string;
  /** The suggestion is destructive, irreversible or paid: the user decides, not an agent (`askUser: true` in --json). */
  readonly askUser?: true;
  constructor(message: string, opts: { suggestion?: string; reason?: string; askUser?: boolean } = {}) {
    super(message);
    this.name = "UsageError";
    if (opts.suggestion) this.suggestion = opts.suggestion;
    this.reason = opts.reason ?? "invalid_usage";
    if (opts.askUser) this.askUser = true;
  }
}

/** Levenshtein distance (small strings only). */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The one closest candidate within a small edit distance, or undefined. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const max = Math.max(1, Math.min(3, Math.floor(input.length / 2)));
  for (const c of candidates) {
    const d = distance(input.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= max ? best : undefined;
}

export interface ParseOptions {
  maxPositionals?: number;
  /** More `--name`s to suggest for a typo (e.g. global flags handled elsewhere). */
  suggestions?: readonly string[];
  /**
   * The command handles secrets (`purge`): no usage error repeats a token the
   * user typed, since a secret pasted as an argument would land on the
   * terminal, in CI logs and in an agent's transcript. Errors name the flag or
   * the position instead.
   */
  sensitive?: boolean;
}

/** What a usage error says in place of a value on a sensitive command. */
const HIDDEN = "(value not shown)";

export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[], opts: ParseOptions = {}): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let rest: string[] = [];
  let sawDashDash = false;

  const sensitive = opts.sensitive === true;
  /** A user token as an error may show it: quoted, or hidden on a sensitive command. */
  const shown = (raw: string): string => (sensitive ? HIDDEN : JSON.stringify(raw));

  const unknown = (token: string): never => {
    const names = [...visibleFlags(specs).map((s) => `--${s.name}`), ...(opts.suggestions ?? [])];
    const hint = token.startsWith("--") ? suggest(token.split("=")[0]!, names) : undefined;
    // The suggestion is always a known flag name, so it is safe to show.
    throw new UsageError(sensitive ? `Unknown option ${HIDDEN}` : `Unknown option ${token}`, { suggestion: hint, reason: "unknown_option" });
  };

  const assign = (spec: FlagSpec, raw: string | undefined, token: string) => {
    const label = `--${spec.name}`;
    if (spec.type === "boolean") {
      if (raw === undefined) flags[spec.name] = true;
      else if (raw === "true" || raw === "1") flags[spec.name] = true;
      else if (raw === "false" || raw === "0") flags[spec.name] = false;
      else throw new UsageError(`${label} takes no value, got ${shown(raw)}`);
      return;
    }
    if (raw === undefined && spec.optionalValue) {
      flags[spec.name] = true;
      return;
    }
    if (raw === undefined) throw new UsageError(`${token} needs a value${spec.value ? ` ${spec.value}` : ""}`, { reason: "missing_value" });
    const choice = (v: string) => {
      if (spec.choices && !spec.choices.includes(v)) {
        throw new UsageError(`${label} must be one of ${spec.choices.join(", ")}, got ${shown(v)}`, { suggestion: suggest(v, spec.choices) ? `${label} ${suggest(v, spec.choices)}` : undefined });
      }
    };
    if (!(spec.type === "list" && spec.commas)) choice(raw);
    if (spec.type === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`${label} must be a number, got ${shown(raw)}`);
      flags[spec.name] = n;
    } else if (spec.type === "list") {
      const prev = flags[spec.name];
      const parts = spec.commas ? raw.split(",").map((x) => x.trim()).filter(Boolean) : [raw];
      if (!parts.length) throw new UsageError(`${token} needs a value${spec.value ? ` ${spec.value}` : ""}`, { reason: "missing_value" });
      parts.forEach(choice);
      flags[spec.name] = [...(Array.isArray(prev) ? prev : []), ...parts];
    } else {
      flags[spec.name] = raw;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      sawDashDash = true;
      rest = argv.slice(i + 1);
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      let spec = byName.get(name);
      if (!spec && name.startsWith("no-")) {
        const neg = byName.get(name.slice(3));
        if (neg && neg.type === "boolean" && inline === undefined) {
          flags[neg.name] = false;
          continue;
        }
      }
      if (!spec) unknown(token);
      spec = spec!;
      if (spec.optionalValue && inline === undefined) {
        const next = argv[i + 1];
        const take = next !== undefined && (spec.choices?.includes(next) === true || spec.valuePattern?.test(next) === true);
        if (take) i++;
        assign(spec, take ? next : undefined, token);
      } else if (spec.type !== "boolean" && inline === undefined) {
        const next = argv[i + 1];
        const dashed = next !== undefined && next.startsWith("-") && next !== "-" && !/^-\d/.test(next) && !(spec.dashValue && !next.startsWith("--"));
        if (next === undefined || dashed) throw new UsageError(`${token} needs a value${spec.value ? ` ${spec.value}` : ""}`, { reason: "missing_value" });
        i++;
        assign(spec, next, token);
      } else {
        assign(spec, inline, token);
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && token !== "-" && !/^-\d/.test(token)) {
      // -x, -x=value, -xvalue is not supported (ambiguous with grouped booleans).
      const eq = token.indexOf("=");
      const short = eq === -1 ? token.slice(1) : token.slice(1, eq);
      const spec = byShort.get(short);
      if (!spec) unknown(token);
      if (spec!.type !== "boolean" && eq === -1) {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`${token} needs a value${spec!.value ? ` ${spec!.value}` : ""}`, { reason: "missing_value" });
        i++;
        assign(spec!, next, token);
      } else {
        assign(spec!, eq === -1 ? undefined : token.slice(eq + 1), token);
      }
      continue;
    }
    positionals.push(token);
  }

  if (opts.maxPositionals !== undefined && positionals.length > opts.maxPositionals) {
    const extra = positionals[opts.maxPositionals]!;
    if (sensitive) throw new UsageError(`Unexpected argument ${HIDDEN}: this command takes no values on the command line`, { reason: "extra_argument" });
    throw new UsageError(`Unexpected argument ${JSON.stringify(extra)}`, { reason: "extra_argument" });
  }
  return { flags, positionals, rest, sawDashDash };
}

/** Parses "7d", "12h", "30m", "90s", an ISO date, or epoch ms into an epoch-ms instant. */
export function parseSince(v: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(v.trim());
  if (m) {
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "s" | "m" | "h" | "d" | "w"];
    return now - Number(m[1]) * unit;
  }
  if (/^\d{12,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UsageError(`--since must be a duration (7d, 12h, 30m) or a date, got ${JSON.stringify(v)}`);
  return t;
}

/** A duration such as 30m, 12h, 7d or 2w, in ms (e.g. `--reuse-max-age`). */
export function parseAge(v: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(v.trim());
  if (!m || !(Number(m[1]) > 0)) throw new UsageError(`--${flag} needs a duration such as 12h, 7d or 2w, got ${JSON.stringify(v)}`, { reason: "invalid_argument" });
  return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "s" | "m" | "h" | "d" | "w"];
}

/** A positive integer flag value, or a usage error. */
export function positiveInt(v: FlagValue, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new UsageError(`--${name} must be an integer of at least 1, got ${JSON.stringify(v)}`);
  return v;
}
