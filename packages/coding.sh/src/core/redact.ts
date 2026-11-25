// Redaction runs before anything is written (index, blobs, sinks). Rules are
// tuned for precision: they key on vendor prefixes or on an explicit secret
// name next to the value, so ordinary code, paths and sha hashes pass through.
//
// The hook's redaction rules (spool/redact.ts, bundled to hook-redact.mjs) include this file,
// so it loads node:fs and node:util from process.getBuiltinModule, as spool/hook.ts says.
import type { AgentEvent, Session } from "../schema/index.ts";
import { weightsCheckpointOf } from "./weights.ts";

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
  "huggingface-token", "groq-key", "replicate-token", "xai-key", "perplexity-key", "google-oauth-token",
  "google-oauth-secret", "sendgrid-key", "digitalocean-token", "shopify-token", "pypi-token", "docker-token",
  "linear-key", "vault-token", "stripe-webhook-secret", "atlassian-token", "databricks-token", "age-secret-key",
  "postman-key", "sentry-token", "pinecone-key", "langsmith-key", "tavily-key", "nvidia-key", "grafana-token",
  "figma-token",
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
/** Lower-case text that every SECRET_NAME holds. */
const SECRET_NAME_NEEDLES: readonly string[] = ["key", "secret", "token", "passw"];
/** Lower-case text that every key SECRET_KEY matches holds. */
const SECRET_KEY_NEEDLES: readonly string[] = [...SECRET_NAME_NEEDLES, "authorization", "cookie"];

/** GitLab token prefixes after "gl" (glpat-, gldt-, glrt-, ...); a longer one before its own prefix. */
const GITLAB_PREFIXES: readonly string[] = ["pat", "oas", "dt", "rtr", "rt", "cbt", "ptt", "ft", "imt", "agent", "soat", "ffct"];
/** "-----BEGIN " in base64, as an encoded key block starts (kubeconfig's client-key-data). */
const ENCODED_BEGIN = "LS0tLS1CRUdJTi";

/** True when base64 text decodes to the BEGIN line of a private key. */
function isEncodedPrivateKey(b64: string): boolean {
  const head = b64.slice(0, Math.min(64, b64.length - (b64.length % 4)));
  return /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/.test(Buffer.from(head, "base64").toString("latin1"));
}

/** A value written by hand, not a reference: a digit and a letter, and no `$x`, `{...}`, `<...>`, index, call or dotted name. */
function isLiteralSecret(v: string): boolean {
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v) || /^[${(<]/.test(v) || /[[(]/.test(v)) return false;
  return !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v);
}

function holdsAny(s: string, needles: readonly string[]): boolean {
  for (const n of needles) if (s.includes(n)) return true;
  return false;
}

/**
 * True for a dotted attribute key that names a secret: `db.password`, `app.api.key` (the dots
 * as separators) and `http.request.header.authorization` (its last part on its own).
 */
export function isSecretAttrKey(key: string): boolean {
  if (!holdsAny(key.toLowerCase(), SECRET_KEY_NEEDLES)) return false;
  return SECRET_KEY.test(key.replace(/\./g, "_")) || SECRET_KEY.test(key.slice(key.lastIndexOf(".") + 1));
}

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

/** Text that every match of a rule's regex holds. */
export interface RuleNeedles {
  /** The regex can only match a string that holds one of these. */
  any: readonly string[];
  /** The regex has the `i` flag: `any` is lower-case, and is looked for in the lower-cased string. */
  fold?: boolean;
}

/**
 * The text each built-in secret rule needs, by kind. createRedactor runs a rule's regex only on
 * a string that holds one of the rule's needles. The hook redacts each payload in a new process,
 * where a regex is compiled the first time it runs, so skipping the rules a payload cannot match
 * saves most of the hook's redaction time. Lower-casing is safe for an `i` regex without the `u`
 * flag: it matches an ASCII letter only with an ASCII letter, so lower-casing the text can add a
 * needle but never hide one. test/core/redact.test.ts checks that every match holds a needle.
 */
export const SECRET_NEEDLES: Readonly<Record<string, RuleNeedles>> = {
  "private-key": { any: ["-----BEGIN "] },
  "anthropic-key": { any: ["sk-ant-"] },
  "openai-key": { any: ["sk-"] },
  "github-token": { any: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"] },
  "gitlab-token": { any: GITLAB_PREFIXES.map((p) => `gl${p}-`) },
  "slack-token": { any: ["xox", "xapp-"] },
  "slack-webhook": { any: ["https://hooks.slack.com/services/"] },
  "aws-access-key": { any: ["AKIA", "ASIA", "AROA", "AIDA"] },
  "google-api-key": { any: ["AIza"] },
  "stripe-key": { any: ["_live_", "_test_"] },
  "npm-token": { any: ["npm_"] },
  "coding-sh-key": { any: ["csh_"] },
  "vercel-ai-gateway-key": { any: ["vck_"] },
  "huggingface-token": { any: ["hf_"] },
  "groq-key": { any: ["gsk_"] },
  "replicate-token": { any: ["r8_"] },
  "xai-key": { any: ["xai-"] },
  "perplexity-key": { any: ["pplx-"] },
  "google-oauth-token": { any: ["ya29."] },
  "google-oauth-secret": { any: ["GOCSPX-"] },
  "sendgrid-key": { any: ["SG."] },
  "digitalocean-token": { any: ["dop_v1_", "doo_v1_", "dor_v1_"] },
  "shopify-token": { any: ["shpat_", "shpca_", "shppa_", "shpss_"] },
  "pypi-token": { any: ["pypi-AgE"] },
  "docker-token": { any: ["dckr_pat_", "dckr_oat_"] },
  "linear-key": { any: ["lin_api_", "lin_oauth_"] },
  "vault-token": { any: ["hvs.", "hvb.", "hvr."] },
  "stripe-webhook-secret": { any: ["whsec_"] },
  "atlassian-token": { any: ["ATATT3"] },
  "databricks-token": { any: ["dapi"] },
  "age-secret-key": { any: ["AGE-SECRET-KEY-1"] },
  "postman-key": { any: ["PMAK-"] },
  "sentry-token": { any: ["sntrys_", "sntryu_"] },
  "pinecone-key": { any: ["pcsk_"] },
  "langsmith-key": { any: ["lsv2_pt_", "lsv2_sk_"] },
  "tavily-key": { any: ["tvly-"] },
  "nvidia-key": { any: ["nvapi-"] },
  "grafana-token": { any: ["glsa_", "glc_"] },
  "figma-token": { any: ["figd_"] },
  "azure-storage-key": { any: ["AccountKey="] },
  "encoded-private-key": { any: [ENCODED_BEGIN] },
  jwt: { any: ["eyJ"] },
  bearer: { any: ["earer"] },
  "basic-auth": { any: ["authorization"], fold: true },
  "auth-header": { any: ["authorization"], fold: true },
  cookie: { any: ["cookie"], fold: true },
  password: { any: ["://"] },
  "url-secret": { any: [...SECRET_NAME_NEEDLES, "sig"], fold: true },
  "secret-assignment": { any: ["KEY", "SECRET", "TOKEN", "PASSW", "CREDENTIAL"] },
  "secret-field": { any: SECRET_NAME_NEEDLES, fold: true },
  "prose-secret": { any: ["pat", "token", "pass", "key", "secret"], fold: true },
  netrc: { any: ["password"] },
  "secret-value": { any: SECRET_NAME_NEEDLES, fold: true },
};

const needles = new WeakMap<RedactRule, RuleNeedles>();

/** Built-in "secrets" rules. Order matters: specific vendor formats first. */
export function secretRules(): RedactRule[] {
  const rules = builtInSecretRules();
  for (const rule of rules) {
    const n = SECRET_NEEDLES[rule.kind];
    if (n) needles.set(rule, n);
  }
  return rules;
}

function builtInSecretRules(): RedactRule[] {
  const privateKey: RedactRule = {
    kind: "private-key",
    // A BEGIN line to its END line; with no END after it, to the end of the text when key data
    // (16 base64 characters, or a PEM Proc-Type header) follows the BEGIN line.
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?=\s*(?:[A-Za-z0-9+/=]{16}|Proc-Type:))[\s\S]*$)/g,
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
    // GitLab tokens can carry dotted suffixes (glpat-<id>.<n>.<more>); redact the whole token.
    { kind: "gitlab-token", pattern: new RegExp(`(?<![A-Za-z0-9_-])gl(?:${GITLAB_PREFIXES.join("|")})-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*`, "g") },
    // Bot and user tokens (xoxb-, xoxp-, ...) and app-level tokens (xapp-1-...).
    { kind: "slack-token", pattern: /(?<![A-Za-z0-9_-])(?:xox[abposr]-|xapp-\d-)[A-Za-z0-9-]{10,}/g },
    { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
    { kind: "aws-access-key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}(?![A-Z0-9])/g },
    { kind: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
    { kind: "stripe-key", pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { kind: "npm-token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
    // coding.sh serve ingest/read keys (csh_ik_… / csh_rk_…).
    { kind: "coding-sh-key", pattern: /(?<![A-Za-z0-9_-])csh_(?:ik|rk)_[A-Za-z0-9_-]{32,}/g },
    { kind: "vercel-ai-gateway-key", pattern: /(?<![A-Za-z0-9_-])vck_[A-Za-z0-9_-]{20,}/g },
    // More vendors by their published prefixes. A fixed-length format also needs a break after it.
    { kind: "huggingface-token", pattern: /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}/g },
    { kind: "groq-key", pattern: /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{40,}/g },
    { kind: "replicate-token", pattern: /(?<![A-Za-z0-9_-])r8_[A-Za-z0-9]{30,}/g },
    { kind: "xai-key", pattern: /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{40,}/g },
    { kind: "perplexity-key", pattern: /(?<![A-Za-z0-9_-])pplx-[A-Za-z0-9]{32,}/g },
    { kind: "google-oauth-token", pattern: /(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{30,}/g },
    { kind: "google-oauth-secret", pattern: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{24,}/g },
    { kind: "sendgrid-key", pattern: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
    { kind: "digitalocean-token", pattern: /(?<![A-Za-z0-9_-])do[opr]_v1_[a-f0-9]{64}(?![A-Za-z0-9_-])/g },
    { kind: "shopify-token", pattern: /(?<![A-Za-z0-9_-])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}(?![A-Za-z0-9_-])/g },
    { kind: "pypi-token", pattern: /(?<![A-Za-z0-9_-])pypi-AgE[A-Za-z0-9_-]{50,}/g },
    { kind: "docker-token", pattern: /(?<![A-Za-z0-9_-])dckr_(?:pat|oat)_[A-Za-z0-9_-]{24,}/g },
    { kind: "linear-key", pattern: /(?<![A-Za-z0-9_-])lin_(?:api|oauth)_[A-Za-z0-9]{32,}/g },
    // HashiCorp Vault (hvs., hvb., hvr.); a digit keeps a dotted name out.
    { kind: "vault-token", pattern: /(?<![A-Za-z0-9_-])hv[sbr]\.(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}/g },
    { kind: "stripe-webhook-secret", pattern: /(?<![A-Za-z0-9_-])whsec_[A-Za-z0-9]{24,}/g },
    { kind: "atlassian-token", pattern: /(?<![A-Za-z0-9_-])ATATT3[A-Za-z0-9_=-]{50,}/g },
    { kind: "databricks-token", pattern: /(?<![A-Za-z0-9_-])dapi[a-f0-9]{32}(?:-\d)?(?![A-Za-z0-9_-])/g },
    { kind: "age-secret-key", pattern: /(?<![A-Za-z0-9_-])AGE-SECRET-KEY-1[0-9A-Z]{58}(?![A-Za-z0-9_-])/g },
    { kind: "postman-key", pattern: /(?<![A-Za-z0-9_-])PMAK-[a-f0-9]{24}-[a-f0-9]{34}(?![A-Za-z0-9_-])/g },
    { kind: "sentry-token", pattern: /(?<![A-Za-z0-9_-])sntry[su]_[A-Za-z0-9+/=_-]{40,}/g },
    { kind: "pinecone-key", pattern: /(?<![A-Za-z0-9_-])pcsk_[A-Za-z0-9_]{40,}/g },
    { kind: "langsmith-key", pattern: /(?<![A-Za-z0-9_-])lsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}(?![A-Za-z0-9_-])/g },
    { kind: "tavily-key", pattern: /(?<![A-Za-z0-9_-])tvly-[A-Za-z0-9-]{24,}/g },
    { kind: "nvidia-key", pattern: /(?<![A-Za-z0-9_-])nvapi-[A-Za-z0-9_-]{40,}/g },
    { kind: "grafana-token", pattern: /(?<![A-Za-z0-9_-])(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9_-])|glc_[A-Za-z0-9+/=]{32,})/g },
    { kind: "figma-token", pattern: /(?<![A-Za-z0-9_-])figd_[A-Za-z0-9_-]{30,}/g },
    // The key in an Azure storage connection string. Azurite's published key is in many docs and
    // fixtures, so this kind only counts and does not tag the session.
    { kind: "azure-storage-key", pattern: /(?<![A-Za-z0-9])(AccountKey=)[A-Za-z0-9+/]{20,}={0,2}/g, replace: keepPrefix("azure-storage-key") },
    // A private key block in base64 (kubeconfig's client-key-data): replaced when it decodes to a BEGIN line.
    {
      kind: "encoded-private-key",
      pattern: new RegExp(`${ENCODED_BEGIN}[A-Za-z0-9+/=]{20,}`, "g"),
      replace: (m) => (isEncodedPrivateKey(m) ? marker("encoded-private-key") : m),
    },
    { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
    // "Bearer <token>" / "Basic <b64>" in headers and curl commands; keep the scheme word.
    { kind: "bearer", pattern: /(\b[Bb]earer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, replace: keepPrefix("bearer") },
    { kind: "basic-auth", pattern: /(\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replace: keepPrefix("basic-auth") },
    // Any other Authorization (or Proxy-Authorization) value: "Token <t>", "ApiKey <t>" or a bare
    // token, as a header or a quoted key. Keeps the scheme word; a value already redacted is left.
    // This rule, cookie, netrc and secret-value end a value at a backslash: in the text of a JSON
    // document inside a string it starts an escape (\n, \"), which the document needs to parse.
    {
      kind: "auth-header",
      pattern: /(\bauthorization["']?[ \t]*:[ \t]*["']?(?:[A-Za-z][\w-]{0,30}[ \t]+)?)([^\s"'`,;\\]{8,})/gi,
      replace: (m, pre, v) => (isLiteralSecret(v) ? `${pre}${marker("auth-header")}` : m),
    },
    // Cookie and Set-Cookie headers: every name=value pair to the end of the line or quote.
    { kind: "cookie", pattern: /(\b(?:set-)?cookie["']?[ \t]*:[ \t]*["']?)(?=[\w.-]+=)[^\r\n'"\\]*/gi, replace: keepPrefix("cookie") },
    // scheme://user:password@host, or scheme://:password@host with no user (redis://) — keep
    // user and host. The scheme is checked by a lookbehind once "://" is found: scanning forward
    // from every word start in a long dotted/dashed run is quadratic. The scheme stays in the
    // output either way, so only where the match starts changes.
    // This rule, url-secret, secret-assignment and secret-field leave a value that is exactly a
    // marker an earlier rule wrote, so a vendor token after a secret name keeps its kind.
    {
      kind: "password",
      pattern: /(:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:)(?!\[redacted:[a-z0-9-]+\]@)([^\s@/]+)(@)/gi,
      replace: (_m, pre, _pw, at) => `${pre}${marker("password")}${at}`,
    },
    // ?password=…&token=… in URLs and form bodies, and the signature of a signed URL
    // (Azure SAS sig=, S3 X-Amz-Signature=, GCS X-Goog-Signature=).
    {
      kind: "url-secret",
      pattern: new RegExp(`([?&](?:[a-z0-9_-]*[_-])?(?:${SECRET_NAME}|sig|signature)=)(?!\\[redacted:[a-z0-9-]+\\](?:[&\\s#"'<>]|$))[^&\\s#"'<>]+`, "gi"),
      replace: keepPrefix("url-secret"),
    },
    // FOO_API_KEY=value / export DB_PASSWORD="value" (shell, .env). No spaces
    // around "=" (that's code, not env), value isn't a $reference or a number.
    {
      kind: "secret-assignment",
      pattern: new RegExp(`(\\b${ENV_SECRET_NAME}=)(["']?)(?![$])(?!\\[redacted:[a-z0-9-]+\\](?:[\\s"'\`;|&]|$))(?!\\d+\\b)([^\\s"'\`;|&]{8,})\\2`, "g"),
      replace: (_m, name, q) => `${name}${q}${marker("secret-assignment")}${q}`,
    },
    // "api_key": "value" in JSON/YAML-ish text. The match starts at the secret
    // word: the name it suffixes ("client_api_key", "x-api-key") is left as is, so
    // there is no need for a `(?:[A-Za-z0-9]+[_-])*` prefix loop, which rescans the
    // whole identifier from every start position (quadratic on long words).
    {
      kind: "secret-field",
      pattern: new RegExp(`(${SECRET_NAME}["']?\\s*:\\s*["'])(?!\\[redacted:[a-z0-9-]+\\]["'])([^"'\\s]{8,})(["'])`, "gi"),
      replace: (_m, pre, _v, post) => `${pre}${marker("secret-field")}${post}`,
    },
    withFastApply(proseSecret, redactProseSecrets),
    // A .netrc entry: machine <host> login <user> password <value>, on one line or several.
    {
      kind: "netrc",
      pattern: /(\b(?:machine\s+\S+|default)\s+login\s+\S+\s+password\s+)([^\s\\]+)/g,
      replace: (m, pre, v) => (isLiteralSecret(v) ? `${pre}${marker("netrc")}` : m),
    },
    // The value after a secret name and ":" or "=", quoted or not, with spaces or not: .env
    // (DB_PASSWORD = …), YAML (client_secret: …), TOML (api_key = "…"), INI, connection strings
    // (Password=…;) and headers (X-Api-Key: …). Only a value written by hand (isLiteralSecret),
    // so `token: string`, `password = os.environ[...]` and `$SECRET` stay.
    {
      kind: "secret-value",
      pattern: new RegExp(`(${SECRET_NAME}["']?[ \\t]*[:=][ \\t]*)(["']?)([^\\s"'\`,;)\\\\]{8,})`, "gi"),
      replace: (m, pre, q, v) => (isLiteralSecret(v) ? `${pre}${q}${marker("secret-value")}` : m),
    },
  ];
}

// The private-key regex lazily scans to the next END line from every BEGIN line,
// so many unterminated BEGIN lines cost O(n²). Up to the end of the last END line,
// each BEGIN line finds its END and the scan consumes it, so the regex runs on that
// prefix only. Past it no BEGIN line has an END: the first one followed by key data
// runs to the end of the text, which is what the regex's second branch matches.
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/y;
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_DATA = /\s*(?:[A-Za-z0-9+/=]{16}|Proc-Type:)/y;
function redactPrivateKeys(s: string, re: RegExp, onMatch?: OnMatch): string {
  let cut = -1;
  for (let q = s.lastIndexOf("-----END "); q >= 0; q = q > 0 ? s.lastIndexOf("-----END ", q - 1) : -1) {
    PRIVATE_KEY_END.lastIndex = q;
    if (PRIVATE_KEY_END.test(s)) {
      cut = PRIVATE_KEY_END.lastIndex; // END lines can't nest, so the last one ends last
      break;
    }
  }
  if (!s.includes("-----BEGIN ")) return s;
  const parts: string[] = [];
  let pos = 0;
  if (cut >= 0) {
    const head = s.slice(0, cut);
    re.lastIndex = 0;
    for (let m = re.exec(head); m; m = re.exec(head)) {
      onMatch?.("private-key", m[0]);
      parts.push(s.slice(pos, m.index), marker("private-key"));
      pos = m.index + m[0].length;
    }
  }
  // A BEGIN line past the last match has no END after it (a clip or a cut paste dropped it):
  // when key data follows it, the key runs to the end of the text. A BEGIN line in prose is left.
  PRIVATE_KEY_BEGIN.lastIndex = pos;
  let open = PRIVATE_KEY_BEGIN.exec(s);
  for (; open; open = PRIVATE_KEY_BEGIN.exec(s)) {
    PRIVATE_KEY_DATA.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    if (PRIVATE_KEY_DATA.test(s)) break;
    // The next BEGIN line can start inside this one: its dashes may be this line's last five.
    PRIVATE_KEY_BEGIN.lastIndex = open.index + 1;
  }
  if (open) {
    onMatch?.("private-key", s.slice(open.index));
    parts.push(s.slice(pos, open.index), marker("private-key"));
    pos = s.length;
  }
  if (!parts.length) return s;
  parts.push(s.slice(pos));
  return parts.join("");
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
 * `@2x.png` image name is not an address. That label is matched as the last
 * label, not checked by a lookbehind at each end the matcher tries, so a long
 * label is read a bounded number of times and the time is linear.
 */
export function emailRules(): RedactRule[] {
  return [{ kind: "email", pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?!\d+x\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g }];
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
    return process.getBuiltinModule("node:fs").statSync(value, { throwIfNoEntry: false }) !== undefined;
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
  // By position in `rules`, the redactor's public array: built again when that array changes.
  let ix = needleIndex(rules);
  // marks[i] === scanned in apply: the text it scanned last holds a needle of rules[i].
  let marks = new Float64Array(rules.length);
  let mark = 0;
  const reindex = (): void => {
    ix = needleIndex(rules);
    marks = new Float64Array(rules.length);
  };

  const string = (s: string, tally?: RedactionTally, only?: RuleFilter): string => {
    if (!tally) return apply(s, undefined, only);
    let placeholders: Record<string, number> | undefined;
    const out = apply(s, (kind, m) => {
      if (kind === "private-key" ? !isPlaceholderPrivateKey(m) : !isPlaceholderSecret(m)) return;
      placeholders ??= {};
      placeholders[kind] = (placeholders[kind] ?? 0) + 1;
    }, only);
    if (out !== s) tallyChange(tally, s, out, placeholders);
    else if (!tally.preexisting && s.includes("[redacted:")) tally.preexisting = true;
    return out;
  };

  const apply = (s: string, onMatch?: OnMatch, only?: RuleFilter): string => {
    let out = s;
    // `only`, from a text that holds `s`, skips the rules it holds no needle of until a rule
    // changes `s`. On that text itself it is the whole needle check.
    let at = ix;
    let live = only?.ix === at ? only.live : undefined;
    let exact = live !== undefined && only!.text === s;
    // The mark of `out`'s scan in `marks`; 0 until the first rule with needles scans it.
    let scanned = 0;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      if (r !== ix.rules[i]) reindex();
      if (ix !== at) {
        // Built again for changed rules: `only` and the scan hold the old positions.
        at = ix;
        live = undefined;
        exact = false;
        scanned = 0;
      }
      // On the text as the rules before left it: a marker they wrote can hold a needle.
      if (ix.gated[i]) {
        if (live && !live[i]) continue;
        if (!exact) {
          if (scanned === 0) markNeedles(ix, out, marks, (scanned = ++mark));
          if (marks[i] !== scanned) continue;
        }
      }
      const next = applyRule(r, out, onMatch);
      // A callback that redacted another text marked that text's needles: scan `out` again.
      if (mark !== scanned) scanned = 0;
      if (next === out) continue;
      out = next;
      live = undefined;
      exact = false;
      scanned = 0;
    }
    return out;
  };

  const value = <T>(v: T, tally?: RedactionTally): T => walk(v, tally ? (x) => string(x, tally) : apply, 0, tally) as T;

  /** Which rules `text` holds a needle of, as apply checks them (a rule without needles always runs). */
  const filter = (text: string): RuleFilter => {
    if (ix.rules.length !== rules.length || rules.some((r, i) => r !== ix.rules[i])) reindex();
    const live = new Uint8Array(rules.length);
    markNeedles(ix, text, live, 1);
    for (let i = 0; i < rules.length; i++) if (!ix.gated[i]) live[i] = 1;
    return { live, text, ix };
  };

  const redactor: Redactor = {
    rules,
    string: (s, tally) => string(s, tally),
    value,
    event: (e, tally) => ({ ...e, payload: value(e.payload, tally) }),
  };
  passes.set(redactor, {
    filter,
    string,
    // A string redactArgv rewrote, and a subtree too deep to walk, are new text: the full check.
    // redactBlobValue only serializes the result, so what comes out the same is not copied.
    value: (v, tally, only) => walk(v, (x) => string(x, tally, only), 0, tally, (x) => string(x, tally), true),
  });
  return redactor;
}

/**
 * The rules a text can match by their needles (RuleNeedles): `live[i]` for `rules[i]`. Taken on a
 * value's JSON text, it holds for every string in the value: no needle holds a character that JSON
 * escapes (`"`, `\`, a control character, a lone surrogate), so the text holds every needle a string
 * holds, lower-cased or not. A rule that changes a string makes new text (a marker can hold a
 * needle), so apply drops the filter from then on.
 */
interface RuleFilter {
  live: Uint8Array;
  text: string;
  /** The index it was taken with: `live` holds that index's positions. */
  ix: NeedleIndex;
}

/** A redactor's passes with the rules limited by a RuleFilter, for redactBlobValue. */
interface FilteredPasses {
  filter(text: string): RuleFilter;
  string(s: string, tally: RedactionTally, only: RuleFilter): string;
  value(v: unknown, tally: RedactionTally, only: RuleFilter): unknown;
}

const passes = new WeakMap<Redactor, FilteredPasses>();

/**
 * A redactor's rule needles by their first two characters, so one pass over a text finds the
 * rules it holds a needle of (a check per rule would scan the text once per needle).
 */
interface NeedleIndex {
  /** The rules it was built for, in order. */
  rules: readonly RedactRule[];
  /** `gated[i]`: rules[i] runs only on a text that holds one of its needles. */
  gated: Uint8Array;
  /** By two ASCII characters `a`, `b` at a position (`a << 7 | b`): 1 + the bucket of needles that start with them. */
  exact: Uint16Array;
  /** The same for the `fold` needles, looked for in the lower-cased text; absent without one. */
  fold?: Uint16Array;
  buckets: { text: string; rules: number[] }[][];
}

/** Every built-in needle starts with two ASCII characters. A rule with a needle that does not runs on every text. */
const indexableNeedle = (n: string): boolean => n.length >= 2 && n.charCodeAt(0) < 128 && n.charCodeAt(1) < 128;

function needleIndex(rules: readonly RedactRule[]): NeedleIndex {
  const gated = new Uint8Array(rules.length);
  const exact = new Uint16Array(1 << 14);
  let fold: Uint16Array | undefined;
  const buckets: NeedleIndex["buckets"] = [];
  const entries = new Map<string, { text: string; rules: number[] }>();
  for (let i = 0; i < rules.length; i++) {
    const need = needles.get(rules[i]!);
    if (!need || !need.any.every(indexableNeedle)) continue;
    gated[i] = 1;
    const table = need.fold ? (fold ??= new Uint16Array(1 << 14)) : exact;
    for (const text of need.any) {
      const key = (need.fold ? "fold:" : "exact:") + text;
      let entry = entries.get(key);
      if (!entry) {
        entries.set(key, (entry = { text, rules: [] }));
        const slot = (text.charCodeAt(0) << 7) | text.charCodeAt(1);
        if (!table[slot]) table[slot] = buckets.push([]);
        buckets[table[slot]! - 1]!.push(entry);
      }
      if (!entry.rules.includes(i)) entry.rules.push(i);
    }
  }
  return { rules: rules.slice(), gated, exact, fold, buckets };
}

/** Sets `marks[i] = mark` for each gated rule whose needles `s` holds, as holdsAny would find them. */
function markNeedles(ix: NeedleIndex, s: string, marks: Float64Array | Uint8Array, mark: number): void {
  scanNeedles(s, ix.exact, ix.buckets, marks, mark);
  if (ix.fold) scanNeedles(s.toLowerCase(), ix.fold, ix.buckets, marks, mark);
}

function scanNeedles(s: string, table: Uint16Array, buckets: NeedleIndex["buckets"], marks: Float64Array | Uint8Array, mark: number): void {
  // A needle is two characters or more, so the last position starts none.
  const end = s.length - 1;
  for (let i = 0; i < end; i++) {
    const a = s.charCodeAt(i);
    if (a > 127) continue;
    const b = s.charCodeAt(i + 1);
    if (b > 127) {
      i++;
      continue;
    }
    const bucket = table[(a << 7) | b]!;
    if (bucket === 0) continue;
    for (const entry of buckets[bucket - 1]!) if (s.startsWith(entry.text, i)) for (const r of entry.rules) marks[r] = mark;
  }
}

/** `s` with one rule applied. */
function applyRule(r: RedactRule, s: string, onMatch?: OnMatch): string {
  const fast = fastApply.get(r);
  if (fast) return fast(s, onMatch);
  r.pattern.lastIndex = 0;
  if (!r.pattern.test(s)) return s;
  r.pattern.lastIndex = 0;
  if (r.replace) return s.replace(r.pattern, r.replace as (m: string, ...g: unknown[]) => string);
  if (onMatch && HIGH_CONFIDENCE_KINDS.has(r.kind)) {
    return s.replace(r.pattern, (m) => {
      onMatch(r.kind, m);
      return marker(r.kind);
    });
  }
  return s.replace(r.pattern, marker(r.kind));
}

/**
 * True for an object or array as JSON.parse makes them: JSON.stringify writes its own keys, as it
 * would a copy's. A Date, a boxed string or anything with toJSON serializes as something else.
 */
function isJsonData(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return (Array.isArray(v) ? proto === Array.prototype : proto === Object.prototype || proto === null) && typeof (v as { toJSON?: unknown }).toJSON !== "function";
}

/** Sets an own data property, as JSON.parse does (a `__proto__` key too). */
function defineOwn(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true });
}

/** True when `o` has `k` as an own data property: not a getter, and not deleted or a hole. */
function hasValue(o: object, k: string | number): boolean {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && "value" in d;
}

let utilTypes: typeof import("node:util").types | undefined;
/** True for a Proxy. node:util is loaded on first use (see the top of this file). */
const isProxy = (v: object) => (utilTypes ??= process.getBuiltinModule("node:util").types).isProxy(v);

/** What mapStrings met in a value besides plain parsed JSON. */
interface Met {
  /** A Proxy, a getter, a hole, a value isJsonData rejects, or a subtree too deep to follow. */
  other: boolean;
}

/**
 * `v` with `f` applied to every string in it (keys are kept). An object or array that comes out
 * the same is `v` itself when it is plain parsed JSON: JSON data (isJsonData), not a Proxy, and
 * with no getter. Anything else within 64 levels is a new value, built from one read of each
 * property. A subtree deeper than that is followed through its JSON text. Both set `met.other`.
 * `copy` says `v` is part of such a copy, which holds no cycle.
 */
function mapStrings(v: unknown, f: (s: string) => string, depth = 0, met?: Met, copy = false): unknown {
  if (typeof v === "string") return f(v);
  if (v === null || typeof v !== "object") return v;
  const same = !isProxy(v) && isJsonData(v);
  if (!same && met) met.other = true;
  if (v instanceof Uint8Array) return v;
  if (depth > 64) {
    if (met) met.other = true;
    try {
      // Part of a copy: followed on from depth 0, not copied again, so a stack that runs out leaves
      // only the levels below as they were.
      if (copy) return mapStrings(v, f, 0, met, true);
      // Too deep to follow: a copy parsed from the subtree's JSON text, mapped from depth 0.
      const text = JSON.stringify(v);
      if (text === undefined) return v;
      const out = mapStrings(JSON.parse(text), f, 0, undefined, true);
      return JSON.stringify(out) === text ? v : out;
    } catch {
      return v; // a cycle, or too deep for the stack: the redaction walk replaces it
    }
  }
  if (Array.isArray(v)) {
    // A loop, not map: one stack frame a level, so an array is followed as deep as an object.
    // Its length is read as map reads it (ToLength): an array Proxy's can be a fraction or below 0.
    const len = Math.floor(v.length);
    const n = len > 0 ? len : 0;
    const out: unknown[] = new Array(n);
    for (let i = 0; i < n; i++) if (i in v) out[i] = mapStrings(v[i], f, depth + 1, met, copy);
    if (!same) return out;
    // A getter read again can give another value: keep the copy of what it gave once.
    for (let i = 0; i < v.length; i++) {
      if (hasValue(v, i)) continue;
      if (met) met.other = true;
      return out;
    }
    return out.every((x, i) => x === v[i]) ? v : out;
  }
  const entries = Object.entries(v);
  let out: Record<string, unknown> | undefined = same ? undefined : {};
  for (let i = 0; i < entries.length; i++) {
    const [k, x] = entries[i]!;
    const y = mapStrings(x, f, depth + 1, met, copy);
    const getter = same && !hasValue(v, k);
    if (getter && met) met.other = true;
    if (!out) {
      if (y === x && !getter) continue;
      out = {};
      for (let j = 0; j < i; j++) defineOwn(out, entries[j]![0], entries[j]![1]);
    }
    defineOwn(out, k, y);
  }
  return out ?? v;
}

/** The document in a string that looks like a JSON object or array; anything else is undefined. */
function jsonDocument(s: string): object | undefined {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const doc: unknown = JSON.parse(t);
    return typeof doc === "object" && doc !== null ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** JSON documents inside strings are followed this deep (a tool result inside a messages attribute). */
const JSON_STRING_DEPTH = 3;

/**
 * Redacts a value for a blob: every string on its own (Redactor.value), and a
 * string that holds a JSON document as that document, so a blob hides what the
 * events hide. Such a string is rewritten, as compact JSON, only when that found
 * something. Redacting the serialized text alone misses a `NAME=value` after a
 * newline: in JSON text the name follows the `n` of `\n`, with no word break.
 */
export function redactForBlob(r: Redactor, v: unknown, tally: RedactionTally, level = 0): unknown {
  if (level >= JSON_STRING_DEPTH) return r.value(v, tally);
  return r.value(documentsRedacted(r, v, tally, level), tally);
}

/** `v` with each string that holds a JSON document redacted as that document: redactForBlob's first step. */
function documentsRedacted(r: Redactor, v: unknown, tally: RedactionTally, level: number, met?: Met): unknown {
  return mapStrings(v, (s) => {
    const doc = jsonDocument(s);
    if (doc === undefined) return s;
    const found = redactionTally();
    let clean: string;
    try {
      clean = JSON.stringify(redactForBlob(r, doc, found, level + 1));
      if (clean === JSON.stringify(doc)) return s;
    } catch {
      return tooDeepMarker(tally); // a document too deep to serialize
    }
    for (const [k, n] of Object.entries(found.kinds)) tally.kinds[k] = (tally.kinds[k] ?? 0) + n;
    return clean;
  }, 0, met);
}

/**
 * The text of a blob for `v`: redactForBlob, then serialized, and the string rules on that text too.
 * For an object or array that is plain parsed JSON (what JSON.parse returns), the rules are first
 * limited to those whose needles its JSON text holds (RuleFilter): each string's own check is then
 * needed only for those, and the text pass needs none while the walk changed nothing. The walks
 * copy only what they change, so a value with nothing to redact is serialized once. A value that
 * holds anything else (Met) takes every rule on the walk's copy, as redactForBlob does. The output
 * is the same.
 */
export function redactBlobValue(r: Redactor, v: unknown, tally: RedactionTally): string {
  const p = passes.get(r);
  if (!p || typeof v !== "object" || v === null) return blobText(r, redactForBlob(r, v, tally), tally);
  const met: Met = { other: false };
  const docs = documentsRedacted(r, v, tally, 0, met);
  // A getter, a Proxy or toJSON could give the filter's text one value and the walk another.
  if (met.other) return blobText(r, r.value(docs, tally), tally);
  let text: string | undefined;
  try {
    text = JSON.stringify(docs);
  } catch {
    // not serializable: the walk and the serializing below report it as before
  }
  const only = text === undefined ? undefined : p.filter(text);
  const clean = only ? p.value(docs, tally, only) : r.value(docs, tally);
  if (typeof clean === "string") return clean;
  // A walk that changed nothing gives `docs` back: its text is the one the filter was taken on.
  const out = only && clean === docs ? only.text : (JSON.stringify(clean) ?? "");
  return only && out === only.text ? p.string(out, tally, only) : r.string(out, tally);
}

/** A redacted value's blob text: a string as it is; anything else serialized, with the string rules on that text. */
function blobText(r: Redactor, clean: unknown, tally: RedactionTally): string {
  return typeof clean === "string" ? clean : r.string(JSON.stringify(clean) ?? "", tally);
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
    // A flag starts with "-": other elements skip the regex.
    if (typeof a !== "string" || a.charCodeAt(0) !== 45) continue;
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

/**
 * `full`: the redact for text the walk made (an argv marker, a too-deep copy), when `redact` is limited to the input's text.
 * `keep`: an object or array that comes out the same is returned as is when it is JSON data (isJsonData), for a caller
 * that only serializes the result. Without it every object and array is a new one.
 * `copy`: `v` is part of a copy tooDeep made, which holds no cycle.
 */
function walk(v: unknown, redact: (s: string) => string, depth: number, tally?: RedactionTally, full = redact, keep = false, copy = false): unknown {
  if (typeof v === "string") return redact(v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 64) return copy ? walkOn(v, full, tally) : tooDeep(v, full, tally);
  // Arrays may be argv (wrapper session.start args, tool command vectors).
  if (Array.isArray(v)) {
    const argv = redactArgv(v);
    if (tally) for (let i = 0; i < argv.length; i++) if (argv[i] !== v[i] && typeof v[i] === "string") tallyChange(tally, v[i] as string, argv[i] as string);
    // A loop, not map: one stack frame a level, so an array is followed as deep as an object.
    const out: unknown[] = [];
    for (let i = 0; i < argv.length; i++) out.push(walk(argv[i], argv[i] === v[i] ? redact : full, depth + 1, tally, full, keep, copy));
    return keep && isJsonData(v) && out.every((x, i) => x === v[i]) ? v : out;
  }
  if (v instanceof Uint8Array) return v;
  const entries = Object.entries(v as Record<string, unknown>);
  let out: Record<string, unknown> | undefined = keep && isJsonData(v) ? undefined : {};
  for (let i = 0; i < entries.length; i++) {
    const [k, x] = entries[i]!;
    const secretKey = typeof x === "string" && x.length > 0 && isSecretAttrKey(k) && !isAlreadyRedacted(x);
    if (secretKey && tally) tally.kinds["secret-field"] = (tally.kinds["secret-field"] ?? 0) + 1;
    const val = secretKey
      ? marker("secret-field")
      : walk(x, redact, depth + 1, tally, full, keep, copy);
    if (!out) {
      if (val === x) continue;
      out = {};
      for (let j = 0; j < i; j++) defineOwn(out, entries[j]![0], entries[j]![1]);
    }
    defineOwn(out, k, val);
  }
  return out ?? v;
}

/**
 * A subtree deeper than the walk goes: a copy of it, parsed from its JSON text, is walked from depth
 * 0, so every rule sees each string as a string. A copy that comes out the same keeps the subtree as
 * it was. A subtree with no JSON text (a cycle), or too deep for the stack, becomes a marker.
 */
function tooDeep(v: object, redact: (s: string) => string, tally?: RedactionTally): unknown {
  try {
    const text = JSON.stringify(v);
    if (text === undefined) return v;
    const out = walk(JSON.parse(text), redact, 0, tally, redact, false, true);
    return JSON.stringify(out) === text ? v : out;
  } catch {
    return tooDeepMarker(tally);
  }
}

/**
 * Part of tooDeep's copy past depth 64, walked on from depth 0. The copy is not copied again. Too
 * deep for the stack, it becomes a marker, and the levels above are kept.
 */
function walkOn(v: object, redact: (s: string) => string, tally?: RedactionTally): unknown {
  try {
    return walk(v, redact, 0, tally, redact, false, true);
  } catch {
    return tooDeepMarker(tally);
  }
}

/**
 * The marker for a value too deep to copy, counted as `too-deep`: a caller that keeps its input
 * when the tally is empty (the spool, a side file's scrub) writes the marker instead.
 */
function tooDeepMarker(tally?: RedactionTally): string {
  if (tally) tally.kinds["too-deep"] = (tally.kinds["too-deep"] ?? 0) + 1;
  return marker("too-deep");
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
 * tool input/output, paths, cwd, repo root and blob refs. A weights checkpoint
 * keeps its two file hashes.
 */
export function toMetadata(event: AgentEvent): AgentEvent {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.payload ?? {})) {
    if (typeof v === "number" || typeof v === "boolean") payload[k] = v;
    else if (typeof v === "string" && METADATA_STRING_KEYS.has(k) && v.length <= 200) payload[k] = v;
    // The tools a model call offered, by name (the proxy), like `tool` on tool events.
    else if (k === "toolNames" && Array.isArray(v)) payload[k] = v.filter((n): n is string => typeof n === "string" && n.length <= 200).slice(0, 128);
  }
  // A weights checkpoint keeps the hashes of its two files: they are the key that joins the session
  // to the experiments that ran the file (which store the same value in any mode). The note is dropped.
  const checkpoint = event.kind === "notification" ? weightsCheckpointOf(event.payload ?? {}) : undefined;
  if (checkpoint) {
    payload.sha256 = checkpoint.sha256;
    if (checkpoint.baseSha256) payload.baseSha256 = checkpoint.baseSha256;
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
