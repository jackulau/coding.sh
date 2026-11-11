// Redaction runs before anything is written (index, blobs, sinks). Rules are
// tuned for precision: they key on vendor prefixes or on an explicit secret
// name next to the value, so ordinary code, paths and sha hashes pass through.
import { statSync } from "node:fs";
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

/**
 * Adds to `t` what turned `before` into `after` (only called when they differ).
 * `placeholders` (kind → count) are vendor-shaped values that were plainly made up:
 * they count as `placeholder-key`, not as their vendor kind.
 */
function tallyChange(t: RedactionTally, before: string, after: string, placeholders?: Record<string, number>): void {
  const diff: Record<string, number> = {};
  if (countMarkers(before, diff, -1)) t.preexisting = true;
  countMarkers(after, diff);
  for (const [k, n] of Object.entries(diff)) {
    if (n <= 0) continue;
    const fake = Math.min(placeholders?.[k] ?? 0, n);
    if (n > fake) t.kinds[k] = (t.kinds[k] ?? 0) + n - fake;
    if (fake) t.kinds[PLACEHOLDER_KIND] = (t.kinds[PLACEHOLDER_KIND] ?? 0) + fake;
  }
}

/** The count kind of a vendor-shaped value that is plainly made up (isPlaceholderSecret). */
export const PLACEHOLDER_KIND = "placeholder-key";

/**
 * Published documentation keys: Stripe's and AWS's examples. They are joined at run time, not
 * written whole or with `+` (which the bundler folds back into one string), so neither the source
 * nor the published package holds a key-shaped literal for push protection or the release's
 * secret scan to stop on.
 */
const DOC_KEYS: ReadonlySet<string> = new Set(
  [["sk_test_", "4eC39HqLyjWDarjtT1zdp7dc"], ["AKIA", "IOSFODNN7EXAMPLE"]].map((parts) => parts.join("")),
);
/** A dash- or underscore-delimited word that marks a made-up value, after the vendor prefix. */
const PLACEHOLDER_WORD = /^(?:test|fake|dummy|example|stub|mock|placeholder|sample|x{3,})$/i;

const isAlnumCode = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 97 && c <= 122);

/** Longest run of consecutive characters, case-insensitive (`0123…`, `abcd…`, `AbCdEf…`). */
function ascendingRun(s: string): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const a = s.charCodeAt(i - 1) | 32;
    const b = s.charCodeAt(i) | 32;
    run = b === a + 1 && isAlnumCode(a) && isAlnumCode(b) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * True for a vendor-shaped token whose value is plainly made up, as in docs and
 * test fixtures: a published example key, the word EXAMPLE, eight of one
 * character, a chunk three times in a row (SECRETSECRETSECRET), eight
 * consecutive characters (abcdefgh, 01234567), or a word like test, fake or stub
 * after the vendor prefix (sk-ant-test-…). A live token is random: each shape
 * turns up in about one in a billion of them or fewer (a word after the prefix:
 * about one in a million). It is still redacted; it only does not count as a
 * vendor token, so it does not tag the session secret:exposed.
 */
export function isPlaceholderSecret(token: string): boolean {
  if (DOC_KEYS.has(token)) return true;
  if (token.length > 512) return false;
  if (/example/i.test(token) || /(.)\1{7}/.test(token) || /([A-Za-z0-9]{3,16})\1\1/.test(token) || ascendingRun(token) >= 8) return true;
  return token.split(/[-_]/).slice(2).some((w) => PLACEHOLDER_WORD.test(w));
}

/** A private key block too short to hold a key (the smallest real one, Ed25519 PKCS#8, has a 64-character body). */
const isPlaceholderPrivateKey = (block: string): boolean => block.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").length < 40;

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
/** Called with each match a high-confidence rule replaces, so the tally can tell a made-up value from a live one. */
type OnMatch = (kind: string, match: string) => void;

const fastApply = new WeakMap<RedactRule, (s: string, onMatch?: OnMatch) => string>();

function withFastApply(rule: RedactRule, apply: (s: string, onMatch?: OnMatch) => string): RedactRule {
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
    withFastApply(privateKey, (s, onMatch) => redactPrivateKeys(s, privateKey.pattern, onMatch)),
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
function redactPrivateKeys(s: string, re: RegExp, onMatch?: OnMatch): string {
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
  const head = s.slice(0, cut);
  return (
    (onMatch
      ? head.replace(re, (m) => {
          onMatch("private-key", m);
          return marker("private-key");
        })
      : head.replace(re, marker("private-key"))) + s.slice(cut)
  );
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

/**
 * Email addresses: a personal detail, not a secret, so it is not among the
 * built-in "secrets" rules. Capture redacts emails when capture.redact lists
 * "email"; what coding.sh shows as a summary (improve) always does.
 * The local part only starts a match at the start of its run (the lookbehind), so a
 * long run of address characters without an "@" is scanned once, not once per
 * start. The last domain label is letters (`pkg@1.2.3` is a version), and an
 * `@2x.png` image name is not an address.
 */
export function emailRules(): RedactRule[] {
  return [{ kind: "email", pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?!\d+x\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?<=\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g }];
}

// ---------------------------------------------------------------- PII pack
//
// Opt-in personal data rules (capture.redact: "pii", or one of PII_KINDS). Each
// candidate is checked before it is replaced, so ids, versions and timestamps
// that look like numbers pass through: a card number needs a known issuer prefix,
// a grouping a card uses and a valid Luhn check digit; an IBAN a known country,
// its length and the mod-97 check; a phone number a leading + with 8 to 15
// digits, or the North American (555) 123-4567 / 555-123-4567 shape.

/** The PII rule sets, by the name capture.redact takes. "pii" turns on all of them. */
export const PII_KINDS = ["email", "phone", "card", "iban", "national-id"] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Issuer prefixes and lengths: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro. */
const CARD_ISSUER = /^(?:4\d{12}(?:\d{3}){0,2}|5[1-5]\d{14}|2(?:2[2-9]|[3-6]\d|7[01])\d{13}|2720\d{12}|3[47]\d{13}|6(?:011|5\d\d|4[4-9]\d)\d{12,15}|35(?:2[89]|[3-8]\d)\d{12,15}|3(?:0[0-5]|[689]\d)\d{11,16}|62\d{14,17}|(?:5018|5020|5038|6304|6759|676[1-3])\d{8,15})$/;

/** A card number's digits as people write them: unbroken, or in groups of 4 (Amex 4-6-5, Diners 4-6-4), one separator. */
function isCardNumber(m: string): boolean {
  const digits = m.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19 || !CARD_ISSUER.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const seps = m.match(/[ -]/g);
  if (seps) {
    if (new Set(seps).size > 1) return false;
    const groups = m.split(/[ -]/).map((g) => g.length).join(",");
    if (!/^(?:4,)+[1-4]$/.test(groups) && groups !== "4,6,5" && groups !== "4,6,4") return false;
  }
  return luhnValid(digits);
}

/** IBAN lengths by country (ISO 13616 registry). */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
  RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** An IBAN: a known country, that country's length, and the mod-97 check. */
export function ibanValid(m: string): boolean {
  const iban = m.replace(/ /g, "");
  if (IBAN_LENGTH[iban.slice(0, 2)] !== iban.length) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** A + phone number's digit count (E.164 allows at most 15). */
const phoneDigits = (m: string): number => m.replace(/\D/g, "").length;

/** The rules of one PII kind. */
export function piiRules(kinds: readonly string[] = PII_KINDS): RedactRule[] {
  const want = new Set(kinds);
  const rules: RedactRule[] = [];
  const checked = (kind: string, pattern: RegExp, ok: (m: string) => boolean): RedactRule => ({ kind, pattern, replace: (m) => (ok(m) ? marker(kind) : m) });
  if (want.has("email")) rules.push(...emailRules());
  // Unbroken, 4-4-4-4(-3), or Amex/Diners 4-6-5/4-6-4: a looser shape would swallow a number before the card.
  if (want.has("card")) rules.push(checked("card", /(?<![\w.+-])(?:\d{13,19}|\d{4}([ -])(?:\d{6}\1\d{4,5}|\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?))(?![\w-]|\.\d)/g, isCardNumber));
  if (want.has("iban")) rules.push(checked("iban", /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g, ibanValid));
  if (want.has("national-id")) {
    // US SSN, dashed (an undashed nine-digit number is anything): no 000, 666 or 9xx area, no 00 group, no 0000 serial.
    rules.push({ kind: "national-id", pattern: /(?<![\w.-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-]|\.\d)/g });
    // UK National Insurance number: two prefix letters (not BG, GB, KN, NK, NT, TN, ZZ), six digits, a suffix A-D.
    rules.push({ kind: "national-id", pattern: /(?<![A-Za-z0-9])(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g });
    // Canadian SIN, grouped 3-3-3 with a valid Luhn digit.
    rules.push(checked("national-id", /(?<![\w.-])[1-9]\d{2}([ -])\d{3}\1\d{3}(?![\w-]|\.\d)/g, (m) => luhnValid(m.replace(/\D/g, ""))));
  }
  if (want.has("phone")) {
    // +<country> then 7-14 more digits in groups; a "+05:30" offset or "+1.2.3" has too few digits.
    rules.push(checked("phone", /(?<![\w+])\+\d{1,3}(?:[ .-]?\(\d{1,4}\))?(?:[ .-]?\d{1,5}){2,5}(?![\w-]|\.\d)/g, (m) => phoneDigits(m) >= 8 && phoneDigits(m) <= 15));
    // North American: (555) 123-4567, 555-123-4567, 555.123.4567 (one separator throughout).
    rules.push({ kind: "phone", pattern: /(?<![\w.+-])(?:\(\d{3}\) ?\d{3}-\d{4}|\d{3}([-.])\d{3}\1\d{4})(?![\w-]|\.\d)/g });
  }
  return rules;
}

/** Redacts what coding.sh prints or returns as a summary: the secret rules, then emails. */
let shown: Redactor | undefined;
export function redactShown(s: string): string {
  shown ??= createRedactor({ redact: ["secrets", "email"] });
  return shown.string(s);
}

/**
 * Env names that match the secret words but hold a place, not a secret: the
 * working directory (PWD, OLDPWD), the X session manager's socket, and
 * *_PATH, *_DIR, *_FILE, *_SOCK locations (SSH_AUTH_SOCK, AUTH_CONFIG_DIR).
 */
const ENV_PLACE_NAME = /^(?:OLD)?PWD$|^SESSION_MANAGER$|_(?:PATH|DIR|FILE|SOCK)$/i;

/** True when `value` names a file or directory that exists: a location, which redacting would cut out of every path. */
function isExistingPath(value: string): boolean {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.includes("\n")) return false;
  try {
    return statSync(value, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Rules that replace literal values of secret-looking environment variables.
 * Names that hold a place (ENV_PLACE_NAME) and values that are an existing file
 * or directory are left out: the cwd in PWD would otherwise turn every path
 * under it into `[redacted:env]/src/a.ts`.
 */
export function envRules(env: NodeJS.ProcessEnv = process.env): RedactRule[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/KEY|TOKEN|SECRET|PASSW|PWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(name)) continue;
    if (ENV_PLACE_NAME.test(name) || isExistingPath(value)) continue;
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

/** Names capture.redact takes. */
export const REDACTORS = ["secrets", "env", "pii", ...PII_KINDS.filter((k) => k !== "email"), "email", "none"] as const;

export interface RedactOptions {
  /** Built-in redactors (REDACTORS): "secrets", "env", "email", "pii" (every PII rule) or one PII kind. Unknown names throw. */
  redact?: readonly string[];
  patterns?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function createRedactor(opts: RedactOptions = {}): Redactor {
  const rules: RedactRule[] = [];
  const pii = new Set<string>();
  for (const name of opts.redact ?? ["secrets"]) {
    if (name === "secrets") rules.push(...secretRules());
    else if (name === "env") rules.push(...envRules(opts.env));
    else if (name === "pii") for (const k of PII_KINDS) pii.add(k);
    else if ((PII_KINDS as readonly string[]).includes(name)) pii.add(name);
    else if (name === "none") continue;
    else throw new Error(`unknown redactor ${JSON.stringify(name)} in capture.redact (expected ${REDACTORS.map((r) => JSON.stringify(r)).join(", ")})`);
  }
  // In PII_KINDS order (cards before phone numbers), after the secret rules.
  if (pii.size) rules.push(...piiRules(PII_KINDS.filter((k) => pii.has(k))));
  rules.push(...patternRules(opts.patterns ?? []));

  const string = (s: string, tally?: RedactionTally): string => {
    if (!tally) return apply(s);
    let placeholders: Record<string, number> | undefined;
    const out = apply(s, (kind, m) => {
      if (kind === "private-key" ? !isPlaceholderPrivateKey(m) : !isPlaceholderSecret(m)) return;
      placeholders ??= {};
      placeholders[kind] = (placeholders[kind] ?? 0) + 1;
    });
    if (out !== s) tallyChange(tally, s, out, placeholders);
    else if (!tally.preexisting && s.includes("[redacted:")) tally.preexisting = true;
    return out;
  };

  const apply = (s: string, onMatch?: OnMatch): string => {
    let out = s;
    for (const r of rules) {
      const fast = fastApply.get(r);
      if (fast) {
        out = fast(out, onMatch);
        continue;
      }
      r.pattern.lastIndex = 0;
      if (!r.pattern.test(out)) continue;
      r.pattern.lastIndex = 0;
      if (r.replace) out = out.replace(r.pattern, r.replace as (m: string, ...g: unknown[]) => string);
      else if (onMatch && HIGH_CONFIDENCE_KINDS.has(r.kind)) {
        out = out.replace(r.pattern, (m) => {
          onMatch(r.kind, m);
          return marker(r.kind);
        });
      } else out = out.replace(r.pattern, marker(r.kind));
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
  "rateLimitType",
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
  // Which gateway a call went through (a gateway id such as "cliproxyapi"): the session's gateway tag.
  "gateway",
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

/** Metadata-only view of a session: drops title, cwd, repo root and the paths of the memory files it used. */
export function sessionToMetadata(s: Session): Session {
  const out: Session = { ...s, stats: { ...s.stats }, flags: [...s.flags] };
  delete out.title;
  delete out.cwd;
  delete out.stats.memoryUse;
  // A model error message can quote the prompt; keep the count and status code.
  if (out.stats.llmErrors?.error !== undefined) {
    const { error: _error, ...rest } = out.stats.llmErrors;
    out.stats.llmErrors = rest;
  }
  if (s.repo) {
    out.repo = { root: "", head: s.repo.head };
    if (s.repo.snapshot) out.repo.snapshot = s.repo.snapshot;
  }
  return out;
}
