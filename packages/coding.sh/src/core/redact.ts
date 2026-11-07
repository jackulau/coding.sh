// Redaction runs before anything is written (index, blobs, sinks). Rules are
// tuned for precision: they key on vendor prefixes or on an explicit secret
// name next to the value, so ordinary code, paths and sha hashes pass through.
import type { AgentEvent, Session } from "../schema/index.ts";

export interface RedactRule {
  kind: string;
  pattern: RegExp; // must be global
  /** Replacement; default replaces the whole match with [redacted:<kind>]. */
  replace?: (match: string, ...groups: string[]) => string;
}

export interface Redactor {
  readonly rules: readonly RedactRule[];
  string(s: string): string;
  /** Deep-redacts strings in any JSON-like value; returns a new value. */
  value<T>(v: T): T;
  event(e: AgentEvent): AgentEvent;
}

export const marker = (kind: string): string => `[redacted:${kind}]`;

// Names that mark the adjacent value as a secret. Matched as a suffix of an
// identifier (OPENAI_API_KEY, db_password, x-api-key, …).
// ("pwd" is deliberately absent: as a key it usually means working directory.)
const SECRET_NAME = "(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|token|passw(?:or)?d|private[_-]?key|access[_-]?key(?:[_-]?id)?)";
// Upper-case env var names that END in a secret word (MAX_TOKENS does not).
const ENV_SECRET_NAME = "[A-Z0-9_]*(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|CREDENTIALS?)";

/** Object keys whose string values are always secrets, regardless of shape. */
const SECRET_KEY = new RegExp(`^(?:[a-z0-9]+[_-])*${SECRET_NAME}$|^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$`, "i");

/** Keeps capture group 1 (e.g. "Bearer ") and redacts the rest of the match. */
function keepPrefix(kind: string): (m: string, ...g: string[]) => string {
  return (_m, ...g) => `${g[0] ?? ""}${marker(kind)}`;
}

/** Built-in "secrets" rules. Order matters: specific vendor formats first. */
export function secretRules(): RedactRule[] {
  return [
    {
      kind: "private-key",
      pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    },
    { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
    // OpenAI-style: sk-, sk-proj-, sk-svcacct-… Require a digit so kebab-case words don't match.
    { kind: "openai-key", pattern: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
    { kind: "github-token", pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
    // GitLab PATs can carry dotted suffixes (glpat-<id>.<n>.<more>); redact the whole token.
    { kind: "gitlab-token", pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g },
    { kind: "slack-token", pattern: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
    { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
    { kind: "aws-access-key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}(?![A-Z0-9])/g },
    { kind: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
    { kind: "stripe-key", pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { kind: "npm-token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
    // coding.sh serve ingest/read keys (csh_ik_… / csh_rk_…).
    { kind: "coding-sh-key", pattern: /(?<![A-Za-z0-9_-])csh_(?:ik|rk)_[A-Za-z0-9_-]{32,}/g },
    { kind: "vercel-ai-gateway-key", pattern: /(?<![A-Za-z0-9_-])vck_[A-Za-z0-9_-]{20,}/g },
    { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
    // "Bearer <token>" / "Basic <b64>" in headers and curl commands; keep the scheme word.
    { kind: "bearer", pattern: /(\b[Bb]earer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, replace: keepPrefix("bearer") },
    { kind: "basic-auth", pattern: /(\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replace: keepPrefix("basic-auth") },
    // scheme://user:password@host — keep user and host.
    {
      kind: "password",
      pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
      replace: (_m, pre, _pw, at) => `${pre}${marker("password")}${at}`,
    },
    // ?password=…&token=… in URLs and form bodies.
    {
      kind: "url-secret",
      pattern: new RegExp(`([?&](?:[a-z0-9_-]*[_-])?${SECRET_NAME}=)[^&\\s#"'<>]+`, "gi"),
      replace: keepPrefix("url-secret"),
    },
    // FOO_API_KEY=value / export DB_PASSWORD="value" (shell, .env). No spaces
    // around "=" (that's code, not env), value isn't a $reference or a number.
    {
      kind: "secret-assignment",
      pattern: new RegExp(`(\\b${ENV_SECRET_NAME}=)(["']?)(?![$])(?!\\d+\\b)([^\\s"'\`;|&]{8,})\\2`, "g"),
      replace: (_m, name, q) => `${name}${q}${marker("secret-assignment")}${q}`,
    },
    // "api_key": "value" in JSON/YAML-ish text.
    {
      kind: "secret-field",
      pattern: new RegExp(`(["']?(?:[A-Za-z0-9]+[_-])*${SECRET_NAME}["']?\\s*:\\s*["'])([^"'\\s]{8,})(["'])`, "gi"),
      replace: (_m, pre, _v, post) => `${pre}${marker("secret-field")}${post}`,
    },
    // Secrets pasted in prose: "PAT here ya go: abcD3f-…", "the password is hunter22".
    // A secret word, a short gap, then ":", "=" or "is", then one token that mixes
    // letters and digits (so "password: string" and "token = getToken(user)" pass).
    {
      kind: "prose-secret",
      pattern: /(\b(?:PAT|personal access token|token|password|passwd|passcode|pass phrase|passphrase|api[ _-]?key|secret)\b[^\n[\]:=]{0,24}?(?::|=|\bis\b)\s*)(?![$[])(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`,;)]{8,}/gi,
      replace: keepPrefix("prose-secret"),
    },
  ];
}

/** Rules that replace literal values of secret-looking environment variables. */
export function envRules(env: NodeJS.ProcessEnv = process.env): RedactRule[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/KEY|TOKEN|SECRET|PASSW|PWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(name)) continue;
    values.push(value);
  }
  if (!values.length) return [];
  // Longest first so a value that contains another is replaced whole.
  values.sort((a, b) => b.length - a.length);
  const source = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return [{ kind: "env", pattern: new RegExp(source, "g") }];
}

/** Compiles user-configured regex sources; throws with the offending pattern on error. */
export function patternRules(patterns: readonly string[]): RedactRule[] {
  return patterns.map((src, i) => {
    let re: RegExp;
    try {
      re = new RegExp(src, "g");
    } catch (err) {
      throw new Error(`capture.redactPatterns[${i}] is not a valid regular expression (${JSON.stringify(src)}): ${(err as Error).message}`);
    }
    if (re.test("")) throw new Error(`capture.redactPatterns[${i}] matches the empty string: ${JSON.stringify(src)}`);
    return { kind: "pattern", pattern: re };
  });
}

export interface RedactOptions {
  /** Built-in redactors: "secrets", "env". Unknown names throw. */
  redact?: readonly string[];
  patterns?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function createRedactor(opts: RedactOptions = {}): Redactor {
  const rules: RedactRule[] = [];
  for (const name of opts.redact ?? ["secrets"]) {
    if (name === "secrets") rules.push(...secretRules());
    else if (name === "env") rules.push(...envRules(opts.env));
    else if (name === "none") continue;
    else throw new Error(`unknown redactor ${JSON.stringify(name)} in capture.redact (expected "secrets" or "env")`);
  }
  rules.push(...patternRules(opts.patterns ?? []));

  const string = (s: string): string => {
    let out = s;
    for (const r of rules) {
      r.pattern.lastIndex = 0;
      if (!r.pattern.test(out)) continue;
      r.pattern.lastIndex = 0;
      out = r.replace
        ? out.replace(r.pattern, r.replace as (m: string, ...g: unknown[]) => string)
        : out.replace(r.pattern, marker(r.kind));
    }
    return out;
  };

  const value = <T>(v: T): T => walk(v, string, 0) as T;

  return {
    rules,
    string,
    value,
    event: (e) => ({ ...e, payload: value(e.payload) }),
  };
}

function walk(v: unknown, redact: (s: string) => string, depth: number): unknown {
  if (typeof v === "string") return redact(v);
  if (depth > 64 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, redact, depth + 1));
  if (v instanceof Uint8Array) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const val = typeof x === "string" && x.length > 0 && SECRET_KEY.test(k) && !isAlreadyRedacted(x)
      ? marker("secret-field")
      : walk(x, redact, depth + 1);
    Object.defineProperty(out, k, { value: val, writable: true, enumerable: true, configurable: true });
  }
  return out;
}

function isAlreadyRedacted(s: string): boolean {
  return /^\[redacted:[a-z-]+\]$/.test(s);
}

/** True if a string contains any redaction marker. */
export function hasRedactions(s: string): boolean {
  return /\[redacted:[a-z-]+\]/.test(s);
}

// ---------------------------------------------------------------- metadata mode

/** Payload string fields that are structural (names/enums), never content. */
const METADATA_STRING_KEYS = new Set([
  "tool",
  "toolUseId",
  "op",
  "trigger",
  "reason",
  "runner",
  "status",
  "role",
  "kind",
  "model",
  "agentType",
  "subagentType",
  "stopReason",
  "level",
  "provider",
  "requestModel",
  "responseModel",
  "subagentId",
  "childSessionId",
  "server",
  "type",
]);

/**
 * Metadata-only view of an event, for remote sinks and capture.mode="metadata":
 * keeps kind, ids, timings, tool names, ok flags, counts and usage; drops text,
 * tool input/output, paths, cwd, repo root and blob refs.
 */
export function toMetadata(event: AgentEvent): AgentEvent {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.payload ?? {})) {
    if (typeof v === "number" || typeof v === "boolean") payload[k] = v;
    else if (typeof v === "string" && METADATA_STRING_KEYS.has(k) && v.length <= 200) payload[k] = v;
  }
  const out: AgentEvent = {
    id: event.id,
    v: event.v,
    sessionId: event.sessionId,
    ts: event.ts,
    agent: event.agent,
    kind: event.kind,
    payload,
  };
  for (const k of ["turnId", "durationMs", "traceId", "spanId", "parentSpanId", "subagentId"] as const) {
    if (event[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = event[k];
  }
  if (event.parentId !== undefined) out.parentId = event.parentId;
  if (event.agentVersion !== undefined) out.agentVersion = event.agentVersion;
  if (event.model !== undefined) out.model = event.model;
  if (event.usage !== undefined) out.usage = { ...event.usage };
  if (event.runId !== undefined) out.runId = event.runId;
  if (event.repo) {
    out.repo = { root: "", head: event.repo.head };
    if (event.repo.snapshot) out.repo.snapshot = event.repo.snapshot;
    if (event.repo.partial !== undefined) out.repo.partial = event.repo.partial;
  }
  return out;
}

/** Metadata-only view of a session: drops title, cwd and repo root. */
export function sessionToMetadata(s: Session): Session {
  const out: Session = { ...s, stats: { ...s.stats }, flags: [...s.flags] };
  delete out.title;
  delete out.cwd;
  if (s.repo) {
    out.repo = { root: "", head: s.repo.head };
    if (s.repo.snapshot) out.repo.snapshot = s.repo.snapshot;
  }
  return out;
}
