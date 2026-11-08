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

/**
 * What a redaction pass replaced, by rule kind: markers in the output minus
 * markers already in the input, so text that quotes a marker counts nothing.
 */
export interface RedactionTally {
  kinds: Record<string, number>;
  /** The input already held a marker (e.g. the agent read `coding.sh show` output). */
  preexisting?: boolean;
}

export const redactionTally = (): RedactionTally => ({ kinds: {} });

export interface Redactor {
  readonly rules: readonly RedactRule[];
  /** Redacts one string; with a tally, adds what it replaced. */
  string(s: string, tally?: RedactionTally): string;
  /** Deep-redacts strings in any JSON-like value; returns a new value. */
  value<T>(v: T, tally?: RedactionTally): T;
  event(e: AgentEvent, tally?: RedactionTally): AgentEvent;
}

export const marker = (kind: string): string => `[redacted:${kind}]`;

/**
 * Vendor token kinds: a match is almost surely a live credential, so a session
 * holding one is tagged `secret:exposed` (core/redaction-stats.ts). Name-based and
 * prose rules (password, secret-field, prose-secret, …) only count.
 */
export const HIGH_CONFIDENCE_KINDS: ReadonlySet<string> = new Set([
  "anthropic-key", "openai-key", "github-token", "gitlab-token", "slack-token", "slack-webhook", "aws-access-key",
  "google-api-key", "stripe-key", "npm-token", "coding-sh-key", "vercel-ai-gateway-key", "private-key",
]);

const MARKER_RE = /\[redacted:([a-z0-9-]+)\]/g;

/** Adds the markers in `s` to `into` (kind → count); returns how many it found. */
export function countMarkers(s: string, into: Record<string, number>, sign = 1): number {
  if (!s.includes("[redacted:")) return 0;
  let n = 0;
  for (const m of s.matchAll(MARKER_RE)) {
    into[m[1]!] = (into[m[1]!] ?? 0) + sign;
    n++;
  }
  return n;
}

/** Adds to `t` what turned `before` into `after` (only called when they differ). */
function tallyChange(t: RedactionTally, before: string, after: string): void {
  const diff: Record<string, number> = {};
  if (countMarkers(before, diff, -1)) t.preexisting = true;
  countMarkers(after, diff);
  for (const [k, n] of Object.entries(diff)) if (n > 0) t.kinds[k] = (t.kinds[k] ?? 0) + n;
}

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

/**
 * Linear-time appliers for rules whose regex backtracks quadratically on some
 * inputs. createRedactor uses these instead of rule.pattern; each produces
 * exactly what `s.replace(rule.pattern, …)` would (test/core/redact.test.ts
 * checks this against a frozen copy of the original patterns). Rules are keyed
 * by identity, so a copied rule object falls back to its (equivalent) regex.
 */
const fastApply = new WeakMap<RedactRule, (s: string) => string>();

function withFastApply(rule: RedactRule, apply: (s: string) => string): RedactRule {
  fastApply.set(rule, apply);
  return rule;
}

/** Built-in "secrets" rules. Order matters: specific vendor formats first. */
export function secretRules(): RedactRule[] {
  const privateKey: RedactRule = {
    kind: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  };
  // Secrets pasted in prose: "PAT here ya go: abcD3f-…", "the password is hunter22".
  // A secret word, a short gap, then ":", "=" or "is", then one token that mixes
  // letters and digits (so "password: string" and "token = getToken(user)" pass).
  const proseSecret: RedactRule = {
    kind: "prose-secret",
    pattern: /(\b(?:PAT|personal access token|token|password|passwd|passcode|pass phrase|passphrase|api[ _-]?key|secret)\b[^\n[\]:=]{0,24}?(?::|=|\bis\b)\s*)(?![$[])(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`,;)]{8,}/gi,
    replace: keepPrefix("prose-secret"),
  };
  return [
    withFastApply(privateKey, (s) => redactPrivateKeys(s, privateKey.pattern)),
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
    // scheme://user:password@host — keep user and host. The scheme is checked by
    // a lookbehind once "://" is found: scanning forward from every word start in
    // a long dotted/dashed run is quadratic. The scheme stays in the output either
    // way, so only where the match starts changes.
    {
      kind: "password",
      pattern: /(:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:)([^\s@/]+)(@)/gi,
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
    // "api_key": "value" in JSON/YAML-ish text. The match starts at the secret
    // word: the name it suffixes ("client_api_key", "x-api-key") is left as is, so
    // there is no need for a `(?:[A-Za-z0-9]+[_-])*` prefix loop, which rescans the
    // whole identifier from every start position (quadratic on long words).
    {
      kind: "secret-field",
      pattern: new RegExp(`(${SECRET_NAME}["']?\\s*:\\s*["'])([^"'\\s]{8,})(["'])`, "gi"),
      replace: (_m, pre, _v, post) => `${pre}${marker("secret-field")}${post}`,
    },
    withFastApply(proseSecret, redactProseSecrets),
  ];
}

// The private-key regex lazily scans to the next END line from every BEGIN line,
// so many unterminated BEGIN lines cost O(n²). Every match ends with an END line,
// so only the text up to the end of the last END line can change; inside that
// prefix each BEGIN line finds its END and the scan consumes it.
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/y;
function redactPrivateKeys(s: string, re: RegExp): string {
  let cut = -1;
  for (let q = s.lastIndexOf("-----END "); q >= 0; q = q > 0 ? s.lastIndexOf("-----END ", q - 1) : -1) {
    PRIVATE_KEY_END.lastIndex = q;
    if (PRIVATE_KEY_END.test(s)) {
      cut = PRIVATE_KEY_END.lastIndex; // END lines can't nest, so the last one ends last
      break;
    }
  }
  if (cut < 0 || !s.includes("-----BEGIN ")) return s;
  re.lastIndex = 0;
  return s.slice(0, cut).replace(re, marker("private-key")) + s.slice(cut);
}

// prose-secret, evaluated by hand. The regex checks "the rest of the token has a
// digit and a letter" with lookaheads that scan to the end of the token from every
// candidate start, which is O(n²) on input like "token:token:token:…". This walks
// the same alternatives in the same order (secret word, lazy 0–24 char gap, then
// ":" / "=" / "is", greedy whitespace, value) and answers the lookaheads from a
// table built in one right-to-left pass.
const PROSE_WORD = /\b(?:PAT|personal access token|token|password|passwd|passcode|pass phrase|passphrase|api[ _-]?key|secret)\b/gi;
const NON_ASCII_SPACE = /\s/;
const isWordCode = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpaceAt = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c < 128 ? c === 32 || (c >= 9 && c <= 13) : NON_ASCII_SPACE.test(s[i]!);
};
/** `[^\s"'\`]` — the class the original lookaheads scan. */
const isTokenAt = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c !== 34 && c !== 39 && c !== 96 && !isSpaceAt(s, i);
};
/** `[^\s"'\`,;)]` — the class of the redacted value. */
const isValueAt = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c !== 44 && c !== 59 && c !== 41 && isTokenAt(s, i);
};

/** flags[i]: bit 1 = a digit, bit 2 = an ASCII letter occurs in the `[^\s"'\`]` run starting at i. */
function tokenFlags(s: string): Uint8Array {
  const flags = new Uint8Array(s.length + 1);
  for (let i = s.length - 1; i >= 0; i--) {
    if (!isTokenAt(s, i)) continue;
    const c = s.charCodeAt(i);
    flags[i] = flags[i + 1]! | (c >= 48 && c <= 57 ? 1 : 0) | ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 2 : 0);
  }
  return flags;
}

function redactProseSecrets(s: string): string {
  const n = s.length;
  let flags: Uint8Array | undefined;
  let wsFrom = -1;
  let wsTo = -1;
  // Value end for a value that would start at a (after "\s*"), or -1.
  const valueAt = (a: number): number => {
    if (a !== wsFrom) {
      let v = a;
      while (v < n && isSpaceAt(s, v)) v++;
      wsFrom = a;
      wsTo = v;
    }
    // Giving whitespace back to \s* can't help: the lookaheads then fail on it.
    const v = wsTo;
    if (v < n) {
      const c = s.charCodeAt(v);
      if (c === 36 || c === 91) return -1; // (?![$[])
    }
    flags ??= tokenFlags(s);
    if (flags[v] !== 3) return -1;
    let e = v;
    while (e < n && isValueAt(s, e)) e++;
    return e - v >= 8 ? e : -1;
  };

  let out = "";
  let copied = 0;
  let pos = 0;
  while (pos < n) {
    PROSE_WORD.lastIndex = pos;
    const m = PROSE_WORD.exec(s);
    if (!m) break;
    const p = m.index;
    const k = p + m[0].length; // at most one alternative can match at p
    let value = -1;
    let end = -1;
    for (let g = 0; g <= 24; g++) {
      const j = k + g;
      if (j >= n) break;
      if (g > 0) {
        const c = s.charCodeAt(j - 1); // gap char: [^\n[\]:=]
        if (c === 10 || c === 91 || c === 93 || c === 58 || c === 61) break;
      }
      const c = s.charCodeAt(j);
      let a = -1;
      if (c === 58 || c === 61) a = j + 1;
      else if ((c === 105 || c === 73) && j + 1 < n && (s.charCodeAt(j + 1) | 32) === 115 && !isWordCode(s.charCodeAt(j - 1)) && (j + 2 >= n || !isWordCode(s.charCodeAt(j + 2)))) a = j + 2;
      if (a < 0) continue;
      const e = valueAt(a);
      if (e >= 0) {
        value = wsTo;
        end = e;
        break;
      }
    }
    if (end < 0) {
      pos = p + 1;
      continue;
    }
    out += s.slice(copied, value) + marker("prose-secret");
    copied = pos = end;
  }
  return copied === 0 ? s : out + s.slice(copied);
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

  const string = (s: string, tally?: RedactionTally): string => {
    const out = apply(s);
    if (tally) {
      if (out !== s) tallyChange(tally, s, out);
      else if (!tally.preexisting && s.includes("[redacted:")) tally.preexisting = true;
    }
    return out;
  };

  const apply = (s: string): string => {
    let out = s;
    for (const r of rules) {
      const fast = fastApply.get(r);
      if (fast) {
        out = fast(out);
        continue;
      }
      r.pattern.lastIndex = 0;
      if (!r.pattern.test(out)) continue;
      r.pattern.lastIndex = 0;
      out = r.replace
        ? out.replace(r.pattern, r.replace as (m: string, ...g: unknown[]) => string)
        : out.replace(r.pattern, marker(r.kind));
    }
    return out;
  };

  const value = <T>(v: T, tally?: RedactionTally): T => walk(v, tally ? (x) => string(x, tally) : apply, 0, tally) as T;

  return {
    rules,
    string,
    value,
    event: (e, tally) => ({ ...e, payload: value(e.payload, tally) }),
  };
}

// Redaction hits found in blob content, by blob ref (the content hash): the event
// that points at an offloaded tool output counts what was redacted inside it.
// Only refs with hits are kept, and only the most recent few thousand.
const blobHits = new Map<string, Record<string, number>>();
const BLOB_HITS_MAX = 4096;

/** Remembers what redaction replaced in the blob stored under `ref`. */
export function noteBlobHits(ref: string, kinds: Record<string, number>): void {
  if (!Object.keys(kinds).length) return;
  blobHits.delete(ref);
  blobHits.set(ref, { ...kinds });
  if (blobHits.size > BLOB_HITS_MAX) blobHits.delete(blobHits.keys().next().value!);
}

/**
 * Redacts an event and records what was replaced in `payload.redactions`
 * (kind → count, never values): the inline payload's hits, or the hits in the
 * blobs it points at when those are more (an offloaded output's inline part is a
 * prefix of the blob, so the two are not added). An event whose input already
 * held markers gets `redactions: {}`, so readers don't count those markers as
 * hits. Nothing found: the payload has no `redactions`.
 */
export function redactEventCounted(r: Redactor, e: AgentEvent): AgentEvent {
  const tally = redactionTally();
  const ev = r.event(e, tally);
  const kinds = { ...tally.kinds };
  if (e.blobs?.length) {
    const inBlobs: Record<string, number> = {};
    for (const ref of e.blobs) for (const [k, n] of Object.entries(blobHits.get(ref) ?? {})) inBlobs[k] = (inBlobs[k] ?? 0) + n;
    for (const [k, n] of Object.entries(inBlobs)) kinds[k] = Math.max(kinds[k] ?? 0, n);
  }
  const earlier = redactionCounts(e.payload?.redactions);
  if (Object.keys(kinds).length) ev.payload = { ...ev.payload, redactions: kinds };
  // Re-finishing a stored event (its markers are now "preexisting"): keep what the first pass counted.
  else if (earlier) ev.payload = { ...ev.payload, redactions: earlier };
  else if (tally.preexisting) ev.payload = { ...ev.payload, redactions: {} };
  return ev;
}

/** A command-line flag whose value is a secret: --api-key, --openai-api-key, --db-password, -token. */
const SECRET_FLAG = new RegExp(`^(--?(?:[a-z0-9]+[_-])*${SECRET_NAME})(=.*)?$`, "i");

/**
 * Redacts the values of secret-named flags in an argv array: `--openai-api-key X`
 * and `--api-key=X`, whatever X looks like. Other elements are left as is.
 */
export function redactArgv<T>(args: readonly T[]): T[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (typeof a !== "string") continue;
    const m = SECRET_FLAG.exec(a);
    if (!m) continue;
    if (m[2] !== undefined) {
      if (m[2].length > 1 && !isAlreadyRedacted(m[2].slice(1))) out[i] = `${m[1]}=${marker("secret-flag")}` as T;
      continue;
    }
    const next = out[i + 1];
    if (typeof next === "string" && next !== "" && !next.startsWith("-") && !isAlreadyRedacted(next)) out[++i] = marker("secret-flag") as T;
  }
  return out;
}

function walk(v: unknown, redact: (s: string) => string, depth: number, tally?: RedactionTally): unknown {
  if (typeof v === "string") return redact(v);
  if (depth > 64 || v === null || typeof v !== "object") return v;
  // Arrays may be argv (wrapper session.start args, tool command vectors).
  if (Array.isArray(v)) {
    const argv = redactArgv(v);
    if (tally) for (let i = 0; i < argv.length; i++) if (argv[i] !== v[i] && typeof v[i] === "string") tallyChange(tally, v[i] as string, argv[i] as string);
    return argv.map((x) => walk(x, redact, depth + 1, tally));
  }
  if (v instanceof Uint8Array) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const secretKey = typeof x === "string" && x.length > 0 && SECRET_KEY.test(k) && !isAlreadyRedacted(x);
    if (secretKey && tally) tally.kinds["secret-field"] = (tally.kinds["secret-field"] ?? 0) + 1;
    const val = secretKey
      ? marker("secret-field")
      : walk(x, redact, depth + 1, tally);
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
  // Model calls (the proxy): which API, which client, how it failed, and ids/short hashes, never content.
  "api",
  "client",
  "clientVersion",
  "linkedBy",
  "errorClass",
  "errorType",
  "systemHash",
  "toolsHash",
  "messageId",
  "responseId",
  "requestId",
  "agentId",
  "parentAgentId",
  "parentSessionId",
  "forkedFromSessionId",
  "subagentKind",
  "accountHash",
  "upstreamAuth",
  // Hook context: which hook event and whose hook (plugin:<name>, settings), never the text or command.
  "hookEvent",
  "hookSource",
  // How the agent was launched (session.start): Claude Code's entrypoint, Codex's originator and launch source.
  "entrypoint",
  "originator",
  "launch",
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
    // The tools a model call offered, by name (the proxy), like `tool` on tool events.
    else if (k === "toolNames" && Array.isArray(v)) payload[k] = v.filter((n): n is string => typeof n === "string" && n.length <= 200).slice(0, 128);
  }
  // Redaction counts (kind → number, never values): the secret-exposure signal survives metadata mode.
  const counts = redactionCounts(event.payload?.redactions);
  if (counts) payload.redactions = counts;
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
  // The capture path ("hook", "transcript", …): live-vs-backfill dedupe and session end rules read it.
  if (event.source !== undefined) out.source = event.source;
  if (event.repo) {
    out.repo = { root: "", head: event.repo.head };
    if (event.repo.snapshot) out.repo.snapshot = event.repo.snapshot;
    if (event.repo.partial !== undefined) out.repo.partial = event.repo.partial;
  }
  return out;
}

/** `payload.redactions` as kind → positive count, or undefined when it is not one. */
export function redactionCounts(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (/^[a-z0-9-]{1,64}$/.test(k) && typeof n === "number" && Number.isInteger(n) && n >= 0) out[k] = n;
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
