// The hook writes a payload without loading the redaction engine when src/spool/gate.ts says
// the default rules would leave it as it is. These tests hold the gate to that: every payload
// the engine changes passes mayHoldSecret, for examples written by hand for each rule and for
// generated text, each in the ways a payload can spell it (JSON escapes, keys, argv, JSON
// documents inside strings). RULES_HASH ties the tests to the rules they were written for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SpoolLine } from "../../src/core/types.ts";
import { defaultConfigToml } from "../../src/core/config.ts";
import { createRedactor, redactionTally, secretRules } from "../../src/core/redact.ts";
import { isDefaultCaptureConfig, mayHoldSecret, needsRedaction } from "../../src/spool/gate.ts";
import { redactPayload, spoolRedactor } from "../../src/spool/redact.ts";
import { PKG_ROOT, bundleHook, tsNodeArgs } from "../capture/_helpers.ts";

const KINDS = [
  "private-key", "anthropic-key", "openai-key", "github-token", "gitlab-token", "slack-token", "slack-webhook",
  "aws-access-key", "google-api-key", "stripe-key", "npm-token", "coding-sh-key", "vercel-ai-gateway-key",
  "huggingface-token", "groq-key", "replicate-token", "xai-key", "perplexity-key", "google-oauth-token",
  "google-oauth-secret", "sendgrid-key", "digitalocean-token", "shopify-token", "pypi-token", "docker-token",
  "linear-key", "vault-token", "stripe-webhook-secret", "atlassian-token", "databricks-token", "age-secret-key",
  "postman-key", "sentry-token", "pinecone-key", "langsmith-key", "tavily-key", "nvidia-key", "grafana-token",
  "figma-token", "azure-storage-key", "encoded-private-key", "jwt", "bearer", "basic-auth", "auth-header", "cookie",
  "password", "url-secret", "secret-assignment", "secret-field", "prose-secret", "netrc", "secret-value",
];

/** sha256 of the secret rules and of the lines in src/core/redact.ts that name secret keys and flags. */
const RULES_HASH = "eaeaa5d51d43c7f47ab915f9b8eac4b1f251012e966a1b247d2979602102a7f1";

function rulesHash(): string {
  const source = readFileSync(join(PKG_ROOT, "src", "core", "redact.ts"), "utf8").split(/\r?\n/);
  const names = ["const SECRET_NAME =", "const ENV_SECRET_NAME =", "const SECRET_KEY =", "const SECRET_FLAG ="].map((start) => {
    const line = source.find((l) => l.startsWith(start));
    assert.ok(line, `src/core/redact.ts has a line that starts with ${start}`);
    return line;
  });
  const rules = secretRules().map((r) => `${r.kind} ${r.pattern.source} ${r.pattern.flags}`);
  return createHash("sha256").update([...rules, ...names].join("\n")).digest("hex");
}

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function home() {
  const root = mkdtempSync(join(tmpdir(), "csh-gate-"));
  roots.push(root);
  const h = join(root, "home");
  mkdirSync(h);
  return { h, env: { CODING_SH_HOME: h, HOME: join(root, "user"), USERPROFILE: join(root, "user"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv };
}

// ---------------------------------------------------------------- text

const BS = String.fromCharCode(92);
const ch = (...codes: number[]): string => String.fromCharCode(...codes);
/** A \u escape of one UTF-16 unit, its hex digits in lower or upper case. */
const esc = (code: number, upper = false): string => {
  const hex = code.toString(16).padStart(4, "0");
  return BS + "u" + (upper ? hex.toUpperCase() : hex);
};

/** Deterministic PRNG (mulberry32), so every run checks the same inputs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = UPPER + LOWER + DIGITS;
const HEX = "0123456789abcdef";
const B64 = ALNUM + "+/";
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const draw = (r: Rand, chars: string, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(r() * chars.length)];
  return s;
};
/** n random letters and digits with at least one of each, as the rules that need both look for. */
const mixed = (r: Rand, n: number): string => draw(r, ALNUM, n - 2) + draw(r, DIGITS, 1) + draw(r, LOWER, 1);

// ---------------------------------------------------------------- payloads

const SHORT = new Map([[0x22, '"'], [0x5c, BS], [0x08, "b"], [0x0c, "f"], [0x0a, "n"], [0x0d, "r"], [0x09, "t"]]);

/**
 * JSON text for `v` with the escapes other serializers write: \/, \u escapes of control and
 * non-ASCII characters and of < > & (lower- or upper-case hex), and \u escapes of the characters
 * that have short ones. With `any`, a \u escape of any character now and then.
 */
function escapedJson(v: unknown, r: Rand, any = false): string {
  const str = (s: string): string => {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const short = SHORT.get(c);
      if (short !== undefined) out += r() < 0.75 ? BS + short : esc(c, r() < 0.5);
      else if (c < 0x20) out += esc(c, r() < 0.5);
      else if (c > 0x7e || c === 0x3c || c === 0x3e || c === 0x26) out += r() < 0.8 ? esc(c, r() < 0.5) : s[i];
      else if (c === 0x2f && r() < 0.5) out += BS + "/";
      else if (any && r() < 0.1) out += esc(c, r() < 0.5);
      else out += s[i];
    }
    return out + '"';
  };
  const walk = (x: unknown): string => {
    if (typeof x === "string") return str(x);
    if (Array.isArray(x)) return `[${x.map(walk).join(",")}]`;
    if (x !== null && typeof x === "object") return `{${Object.entries(x).map(([k, y]) => `${str(k)}:${walk(y)}`).join(",")}}`;
    return JSON.stringify(x);
  };
  const text = walk(v);
  assert.deepEqual(JSON.parse(text), v, "the escapes spell the same value");
  return text;
}

const serialize = (v: unknown, r: Rand): string => {
  const x = r();
  return x < 0.25 ? JSON.stringify(v) : x < 0.5 ? JSON.stringify(v, null, 2) : escapedJson(v, r, x > 0.85);
};

/**
 * `s` in payloads the hook may read: the text itself, and JSON with `s` as a value, a key, argv,
 * and a string inside JSON documents inside strings (up to four deep; the rules follow three).
 */
function payloads(s: string, r: Rand): string[] {
  const out = [
    s,
    ch(0xfeff) + JSON.stringify({ prompt: s }), // not JSON with the BOM: the rules see the text
    JSON.stringify(s),
    JSON.stringify({ session_id: "s", tool_input: { command: s } }),
    JSON.stringify({ cwd: "/w", [s]: "x1" }),
    JSON.stringify({ args: s.split(" ") }),
    escapedJson({ prompt: s, args: s.split(" ") }, r),
    escapedJson({ [s]: "x1" }, r, true),
  ];
  let doc: unknown = { stdout: s };
  for (let depth = 1 + Math.floor(r() * 4); depth > 0; depth--) doc = { tool_response: { stdout: serialize(doc, r) } };
  out.push(serialize(doc, r));
  return out;
}

/**
 * JSON strings for `s` with one character written as a \u escape, one for each character the
 * gate looks for, and no other such escape in the text (escapesNeedle answers for the text).
 */
function oneEscaped(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!/[A-Za-z0-9 +\-./:=@\\_~]/.test(s[i]!)) continue;
    out.push(JSON.stringify(s.slice(0, i)).slice(0, -1) + esc(s.charCodeAt(i), i % 2 === 1) + JSON.stringify(s.slice(i + 1)).slice(1));
  }
  return out;
}

// ---------------------------------------------------------------- the check

const engine = createRedactor();

/** The kinds the default rules replace in a payload as the hook reads it: parsed as JSON, else as text. */
function engineFinds(text: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = text;
  }
  const tally = redactionTally();
  redactPayload(engine, v, tally);
  return Object.keys(tally.kinds);
}

/** The kinds the rules replace in `text`; fails when there are some and mayHoldSecret(text) is false. */
function check(text: string): string[] {
  const kinds = engineFinds(text);
  if (kinds.length) assert.ok(mayHoldSecret(text), `the rules replace ${kinds.join(", ")} in ${JSON.stringify(text)}, and mayHoldSecret is false`);
  return kinds;
}

describe("the rules the gate was written for", () => {
  it("are the rules in src/core/redact.ts", () => {
    assert.deepEqual(secretRules().map((r) => r.kind), KINDS);
    const hash = rulesHash();
    assert.equal(hash, RULES_HASH, `The secret rules or the names of secret keys and flags changed (hash now ${hash}). Check that every text they match holds a part VENDOR or WORDS in src/spool/gate.ts finds (its header says how), add an example for a new rule below, then update KINDS and RULES_HASH.`);
  });
});

describe("mayHoldSecret on payloads the default rules change", () => {
  it("passes each rule's example, in every payload form", () => {
    const r = prng(1);
    const v = (n = 24) => mixed(r, n);
    const examples: [string, string][] = [
      ["private-key", ["-----BEGIN RSA PRIVATE KEY-----", draw(r, ALNUM + "+/", 64), draw(r, ALNUM + "+/", 64), "-----END RSA PRIVATE KEY-----"].join("\n")],
      ["anthropic-key", ["sk-", "ant-", "api03-", v(40)].join("")],
      ["openai-key", ["sk", "-proj-", v(40)].join("")],
      ["github-token", ["gh", "p_", draw(r, ALNUM, 36)].join("")],
      ["gitlab-token", ["gl", "pat-", draw(r, ALNUM, 20)].join("")],
      ["slack-token", ["xo", "xb-", draw(r, DIGITS, 12), "-", draw(r, ALNUM, 24)].join("")],
      ["slack-webhook", ["https://hooks.", "slack.com/services/T", draw(r, UPPER + DIGITS, 8), "/B", draw(r, UPPER + DIGITS, 8), "/", draw(r, ALNUM, 24)].join("")],
      ["aws-access-key", `id ${["AK", "IA", draw(r, UPPER + DIGITS, 16)].join("")} ok`],
      ["google-api-key", `key ${["AI", "za", draw(r, ALNUM, 35)].join("")} ok`],
      ["stripe-key", ["sk", "_live_", draw(r, ALNUM, 24)].join("")],
      ["npm-token", `${["np", "m_", draw(r, ALNUM, 36)].join("")} ok`],
      ["coding-sh-key", ["cs", "h_ik_", draw(r, ALNUM, 32)].join("")],
      ["vercel-ai-gateway-key", ["vc", "k_", draw(r, ALNUM, 24)].join("")],
      ["huggingface-token", ["hf", "_", draw(r, ALNUM, 34)].join("")],
      ["groq-key", ["gs", "k_", draw(r, ALNUM, 52)].join("")],
      ["replicate-token", ["r8", "_", draw(r, ALNUM, 37)].join("")],
      ["xai-key", ["xa", "i-", draw(r, ALNUM, 80)].join("")],
      ["perplexity-key", ["pp", "lx-", draw(r, ALNUM, 48)].join("")],
      ["google-oauth-token", ["ya", "29.", draw(r, ALNUM + "_-", 120)].join("")],
      ["google-oauth-secret", ["GOC", "SPX-", draw(r, ALNUM + "_-", 28)].join("")],
      ["sendgrid-key", ["S", "G.", draw(r, ALNUM + "_-", 22), ".", draw(r, ALNUM + "_-", 43)].join("")],
      ["digitalocean-token", ["do", "p_v1_", draw(r, HEX, 64)].join("")],
      ["shopify-token", ["sh", "pat_", draw(r, HEX, 32)].join("")],
      ["pypi-token", ["py", "pi-AgE", draw(r, ALNUM + "_-", 70)].join("")],
      ["docker-token", ["dc", "kr_pat_", draw(r, ALNUM + "_-", 27)].join("")],
      ["linear-key", ["li", "n_api_", draw(r, ALNUM, 40)].join("")],
      ["vault-token", ["hv", "s.", mixed(r, 90)].join("")],
      ["stripe-webhook-secret", ["wh", "sec_", draw(r, ALNUM, 32)].join("")],
      ["atlassian-token", ["ATA", "TT3", draw(r, ALNUM + "_=-", 180)].join("")],
      ["databricks-token", ["da", "pi", draw(r, HEX, 32)].join("")],
      ["age-secret-key", ["AGE-", "SECRET-KEY-1", draw(r, UPPER + DIGITS, 58)].join("")],
      ["postman-key", ["PM", "AK-", draw(r, HEX, 24), "-", draw(r, HEX, 34)].join("")],
      ["sentry-token", ["sn", "trys_", draw(r, B64 + "=_-", 60)].join("")],
      ["pinecone-key", ["pc", "sk_", draw(r, ALNUM, 6), "_", draw(r, ALNUM, 60)].join("")],
      ["langsmith-key", ["ls", "v2_pt_", draw(r, HEX, 32), "_", draw(r, HEX, 10)].join("")],
      ["tavily-key", ["tv", "ly-", draw(r, ALNUM, 32)].join("")],
      ["nvidia-key", ["nv", "api-", draw(r, ALNUM + "_-", 64)].join("")],
      ["grafana-token", ["gl", "sa_", draw(r, ALNUM, 32), "_", draw(r, HEX, 8)].join("")],
      ["grafana-token", ["gl", "c_", draw(r, B64 + "=", 48)].join("")],
      ["figma-token", ["fi", "gd_", draw(r, ALNUM + "_-", 40)].join("")],
      ["azure-storage-key", `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${draw(r, B64, 86)}==;EndpointSuffix=core.windows.net`],
      ["encoded-private-key", `client-key-data: ${Buffer.from([["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), draw(r, B64, 64)].join("\n")).toString("base64")}`],
      ["jwt", ["ey", "J", draw(r, ALNUM, 20), ".ey", "J", draw(r, ALNUM, 30), ".", draw(r, ALNUM + "_-", 43)].join("")],
      ["bearer", `curl -H 'Bearer ${v(32)}'`],
      ["basic-auth", `Authorization: Basic ${draw(r, ALNUM + "+/", 20)}==`],
      ["auth-header", `Authorization: Token ${v(40)}`],
      ["auth-header", `curl -H "Proxy-Authorization: ApiKey ${v(32)}"`],
      ["cookie", `Cookie: sessionid=${v(32)}; csrftoken=${v(12)}`],
      ["cookie", `Set-Cookie: sid=${v(32)}; Path=/; HttpOnly`],
      ["password", `postgres://admin:${v(12)}@db.internal:5432/app`],
      ["password", `redis://:${v(16)}@cache.internal:6379/0`],
      ["url-secret", `https://api.test/v1?access_token=${v(20)}&x=1`],
      ["url-secret", `https://demo.blob.core.windows.net/c/f.txt?sv=2022-11-02&sig=${v(40)}%3D`],
      ["url-secret", `https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${draw(r, HEX, 63)}1`],
      ["secret-assignment", `export OPENAI_API_KEY=${v()}`],
      ["secret-assignment", `GOOGLE_CREDENTIALS=${v(20)}`],
      ["secret-field", `client_secret: '${v(20)}'`],
      ["prose-secret", `here is the PAT: ${v()}`],
      ["prose-secret", `the password is ${v(12)}`],
      ["prose-secret", `my api key: ${v()}`],
      ["prose-secret", `pass phrase = ${v(12)}`],
      ["netrc", `machine api.test login demo password ${v(12)}`],
      ["netrc", `machine api.test\n  login demo\n  password ${v(12)}`],
      ["secret-value", `DB_PASSWORD = ${v(12)}`],
      ["secret-value", `client_secret: ${v(30)}`],
      ["secret-value", `api_key = "${v(30)}"`],
    ];
    assert.deepEqual(KINDS.filter((k) => !examples.some(([kind]) => kind === k)), [], "every rule has an example");
    for (const [kind, s] of examples) {
      assert.ok(engineFinds(s).includes(kind), `the rules find ${kind} in ${JSON.stringify(s)}`);
      for (const text of [...payloads(s, r), ...oneEscaped(s)]) check(text);
    }
  });

  it("passes the secret keys and flags", () => {
    const r = prng(2);
    const keys = ["api_key", "db.password", "app.api.key", "Authorization", "x-api-key", "set-cookie", "proxy-authorization", "clientSecret", "accessKeyId", "http.request.header.authorization"];
    for (const key of keys) {
      for (const text of [JSON.stringify({ [key]: "v1" }), escapedJson({ attributes: { [key]: mixed(r, 12) } }, r)]) assert.ok(check(text).includes("secret-field"), text);
    }
    for (const args of [["--api-key", mixed(r, 12)], [`--token=${mixed(r, 12)}`], ["-client-secret", mixed(r, 12)]]) {
      for (const text of [JSON.stringify({ args }), escapedJson({ args }, r)]) assert.ok(check(text).includes("secret-flag"), text);
    }
  });

  it("passes payloads whose fixed parts sit next to escapes", () => {
    const r = prng(3);
    const v = () => mixed(r, 24);
    const sk = ["sk", "-proj-"].join("");
    const cases: [string, string][] = [
      ["openai-key", `{"p":"x${BS}n${sk}${v()}"}`],
      ["openai-key", `{"p":"x${esc(1)}${sk}${v()}"}`],
      ["openai-key", `{"p":"x${esc(0x22)}${sk}${v()}"}`],
      ["prose-secret", `{"p":"${BS}tPAT: ${v()}"}`],
      ["prose-secret", `{"p":"${esc(0xa0, true)}pat is ${v()}"}`],
      ["bearer", `{"h":"Bearer${BS}n${v()}"}`],
      ["bearer", `{"h":"Bearer${esc(0x0b)}${v()}"}`],
      ["bearer", `{"h":"Bearer${ch(0xa0)}${v()}"}`],
      ["bearer", `{"h":"Bearer ab${BS}/cd${BS}/${v()}"}`],
      ["password", `{"u":"postgres:${BS}/${BS}/admin:${mixed(r, 12)}@db/x"}`],
      ["password", `{"u":"postgres://ad${BS}"min:p${BS}${BS}w${mixed(r, 8)}@db/x"}`],
      ["secret-field", `{"api${esc(0x5f)}key":"v1"}`],
      ["secret-field", `{"d":"{${BS}"token${BS}":${BS}"v1${BS}"}"}`],
      ["secret-assignment", `{"d":"{${BS}"out${BS}":${BS}"ok${BS}${BS}nGOOGLE_CREDENTIALS=${v()}${BS}"}"}`],
      ["secret-value", `{"d":"{${BS}"out${BS}":${BS}"ok${BS}${BS}nDB_PASSWORD = ${v()}${BS}"}"}`],
    ];
    for (const [kind, text] of cases) assert.ok(check(text).includes(kind), `${kind} in ${text}`);
    // Three documents deep: a name and "=" after an escaped newline, escaped again at each level.
    for (const [kind, name] of [["secret-assignment", "GOOGLE_CREDENTIALS="], ["secret-value", "DB_PASSWORD = "]] as const) {
      let doc = JSON.stringify({ stdout: `loaded\n${name}${v()}\n` }, null, 2);
      for (let i = 0; i < 3; i++) doc = JSON.stringify({ tool_response: { stdout: doc } });
      assert.ok(check(doc).includes(kind), `${kind} three documents deep`);
    }
    // JSON text held in a string: in the string, each token follows the letter or digit that
    // ends an escape (`\n`, or a \u escape of any character).
    const ak = ["sk-", "ant-", "api03-", mixed(r, 40)].join("");
    const gh = ["gh", "p_", draw(r, ALNUM, 36)].join("");
    for (const e of [BS + "n", BS + "t", esc(0xe9), esc(0x30), esc(0x4b, true)]) {
      for (const [kind, token] of [["anthropic-key", ak], ["github-token", gh], ["prose-secret", `PAT: ${v()}`], ["secret-assignment", `GOOGLE_CREDENTIALS=${v()}`]] as const) {
        const text = JSON.stringify({ prompt: `see {"msg":"a${e}${token}"}` });
        assert.ok(check(text).includes(kind), `${kind} in ${text}`);
      }
    }
    // A rule with the `i` flag takes an upper-case escape letter too, and so does WORDS.
    for (const [kind, text] of [["prose-secret", `a${BS}NPAT: ${v()}`], ["basic-auth", `a${BS}U0041Authorization: Basic ${draw(r, ALNUM + "+/", 20)}==`]] as const) {
      assert.ok(check(JSON.stringify({ prompt: text })).includes(kind), `${kind} in ${text}`);
    }
  });

  it("passes generated text, in every payload form", () => {
    const r = prng(4);
    const kinds = new Set<string>();
    let texts = 0;
    let changed = 0;
    for (let i = 0; i < 4000; i++) {
      for (const text of payloads(fuzzString(r), r)) {
        texts++;
        const found = check(text);
        if (found.length) changed++;
        for (const k of found) kinds.add(k);
      }
    }
    assert.deepEqual([...KINDS, "secret-flag"].filter((k) => !kinds.has(k)), [], "every rule changed some generated payload");
    assert.ok(changed > texts / 4, `${changed} of ${texts} generated payloads changed`);
  });

  it("passes generated text with any one character escaped", () => {
    const r = prng(8);
    let texts = 0;
    for (let i = 0; i < 1500; i++) {
      const s = fuzzString(r);
      if (!engineFinds(s).length) continue;
      for (const text of oneEscaped(s)) {
        check(text);
        texts++;
      }
    }
    assert.ok(texts > 10000, `${texts} payloads`);
  });

  it("passes each vendor token at and around the length its rule needs", () => {
    const r = prng(7);
    for (const [prefix, chars, need] of PREFIXES) {
      let changed = 0;
      for (let n = need - 3; n <= need + 1; n++) {
        for (const end of ["", " ", "x", "-", '"', "\n", "."]) {
          for (const text of payloads(`id ${prefix}${tokenOf(r, chars, n)}${end}`, r)) if (check(text).length) changed++;
        }
      }
      assert.ok(changed > 0, `the rules find ${prefix} with ${need} characters after it`);
    }
  });

  it("passes generated keys, in plain and escaped JSON", () => {
    const r = prng(5);
    const cores = ["api{}key", "apikey", "secret", "secret{}key", "client{}secret", "access{}token", "refresh{}token", "auth{}token", "session{}token", "bearer{}token", "token", "passwd", "password", "private{}key", "access{}key", "access{}key{}id", "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];
    let secret = 0;
    for (let i = 0; i < 3000; i++) {
      const core = pick(r, cores).replace(/\{\}/g, () => pick(r, ["", "_", "-", ".", " "]));
      const key = cased(r, pick(r, ["", "", "db.", "app_", "x-", "my-", "http.request.header.", "A1_", "foo", "a.b."]) + core + pick(r, ["", "", "", "s", "_id", ".value", "2", "_", "-"]));
      for (const text of [JSON.stringify({ [key]: "v1" }), escapedJson({ [key]: "v1" }, r, r() < 0.2)]) if (check(text).includes("secret-field")) secret++;
    }
    assert.ok(secret > 1000, `${secret} generated keys were secret keys`);
  });

  it("passes generated flags, as argv in plain and escaped JSON", () => {
    const r = prng(6);
    const cores = ["api-key", "apikey", "secret", "secret_key", "client-secret", "access-token", "refresh_token", "auth-token", "session-token", "bearer-token", "token", "passwd", "password", "private-key", "access-key", "access-key-id"];
    let secret = 0;
    for (let i = 0; i < 3000; i++) {
      const flag = pick(r, ["-", "--"]) + cased(r, pick(r, ["", "", "openai-", "db_", "my-app-", "x-"]) + pick(r, cores) + pick(r, ["", "", "", "s", "-file"]));
      const args = r() < 0.5 ? ["cli", `${flag}=${mixed(r, 10)}`] : ["cli", flag, mixed(r, 10)];
      for (const text of [JSON.stringify({ args }), escapedJson({ args }, r, r() < 0.2)]) if (check(text).includes("secret-flag")) secret++;
    }
    assert.ok(secret > 2000, `${secret} generated flags were secret flags`);
  });

  it("passes every line of the test fixtures", () => {
    const root = join(import.meta.dirname, "..", "fixtures");
    let lines = 0;
    for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!e.isFile() || e.name.endsWith(".ts")) continue;
      for (const line of readFileSync(join(e.parentPath, e.name), "utf8").split("\n")) {
        check(line);
        lines++;
      }
    }
    assert.ok(lines > 1000, `${lines} lines`);
  });
});

// Generated text: secret-shaped parts near characters that JSON escapes or that sit on a rule's edge.
const WS = [" ", "\t", "\n", "\r", ch(0x0b), ch(0x0c), ch(0xa0), ch(0x2028), ch(0x2029), ch(0xfeff), "  "];
const ODD = [...WS, '"', "'", "`", BS, "/", ch(0x08), ch(0x01), ch(0x1f), ch(0x7f), ch(0x212a), ch(0x17f), ch(0xe9), ch(0x130), ch(0xd83d, 0xde00), ch(0xd800), "<", ">", "&", ":", "=", "@", "?", "#", ";", ",", ")", "[", "]", "$", "-", "_", ".", "+", "~"];
/** Random text for the formats with a fixed-length part before the token (SG.<22>.<43>, PMAK-<24>-<34>, ...). */
const MID = prng(9);
/**
 * Each vendor prefix, the characters of its token and how many its rule needs at least (for a
 * format of fixed length, exactly that many, with a break after them).
 */
const PREFIXES: [string, string, number][] = [
  [["sk", "-"].join(""), ALNUM + "_-", 20],
  [["sk", "-ant-"].join(""), ALNUM + "_-", 20],
  [["sk", "-proj-"].join(""), ALNUM, 15],
  [["gh", "p_"].join(""), ALNUM, 36],
  [["gh", "s_"].join(""), ALNUM, 36],
  [["github", "_pat_"].join(""), ALNUM + "_", 22],
  [["gl", "pat-"].join(""), ALNUM + "_-", 20],
  [["xo", "xb-"].join(""), ALNUM + "-", 10],
  [["https://hooks.", "slack.com/services/"].join(""), ALNUM + "/_-", 20],
  [["AK", "IA"].join(""), UPPER + DIGITS, 16],
  [["AS", "IA"].join(""), UPPER + DIGITS, 16],
  [["AI", "za"].join(""), ALNUM + "_-", 35],
  [["sk", "_live_"].join(""), ALNUM, 16],
  [["rk", "_test_"].join(""), ALNUM, 16],
  [["np", "m_"].join(""), ALNUM, 36],
  [["cs", "h_ik_"].join(""), ALNUM + "_-", 32],
  [["vc", "k_"].join(""), ALNUM + "_-", 20],
  [["hf", "_"].join(""), ALNUM, 30],
  [["gs", "k_"].join(""), ALNUM, 40],
  [["r8", "_"].join(""), ALNUM, 30],
  [["xa", "i-"].join(""), ALNUM, 40],
  [["pp", "lx-"].join(""), ALNUM, 32],
  [["ya", "29."].join(""), ALNUM + "_-", 30],
  [["GOC", "SPX-"].join(""), ALNUM + "_-", 24],
  [["S", "G.", draw(MID, ALNUM + "_-", 22), "."].join(""), ALNUM + "_-", 43],
  [["do", "p_v1_"].join(""), HEX, 64],
  [["sh", "pat_"].join(""), HEX, 32],
  [["py", "pi-AgE"].join(""), ALNUM + "_-", 50],
  [["dc", "kr_pat_"].join(""), ALNUM + "_-", 24],
  [["li", "n_api_"].join(""), ALNUM, 32],
  [["hv", "s."].join(""), ALNUM + "_-", 24],
  [["wh", "sec_"].join(""), ALNUM, 24],
  [["ATA", "TT3"].join(""), ALNUM + "_=-", 50],
  [["da", "pi"].join(""), HEX, 32],
  [["AGE-", "SECRET-KEY-1"].join(""), UPPER + DIGITS, 58],
  [["PM", "AK-", draw(MID, HEX, 24), "-"].join(""), HEX, 34],
  [["sn", "trys_"].join(""), B64 + "=_-", 40],
  [["pc", "sk_"].join(""), ALNUM + "_", 40],
  [["ls", "v2_pt_", draw(MID, HEX, 32), "_"].join(""), HEX, 10],
  [["tv", "ly-"].join(""), ALNUM + "-", 24],
  [["nv", "api-"].join(""), ALNUM + "_-", 40],
  [["gl", "sa_", draw(MID, ALNUM, 32), "_"].join(""), HEX, 8],
  [["gl", "c_"].join(""), B64 + "=", 32],
  [["fi", "gd_"].join(""), ALNUM + "_-", 30],
  [["gl", "dt-"].join(""), ALNUM + "_-", 20],
  [["gl", "rt-"].join(""), ALNUM + "_-", 20],
  [["xa", "pp-1-"].join(""), ALNUM + "-", 10],
  ["AccountKey=", B64, 20],
];
const SECRET_WORDS = ["token", "pat", "password", "passwd", "passcode", "pass phrase", "passphrase", "personal access token", "api key", "api_key", "api-key", "apikey", "api.key", "secret", "secret_key", "client_secret", "access_token", "refresh-token", "private_key", "access.key.id", "authorization", "cookie", "x-api-key", "credentials"];
const SEPS = [": ", ":", " : ", "=", " = ", " is ", "\tis ", '": "', "': '", '"', "'", ": '", '="', " here ya go: ", "\t:", "-", "_", " ", "", ch(0xa0) + ":"];
const VALUES = ["$VAR", "${TOKEN}", "12345678", "abcdefgh", "[x]", "hunter22", "a1b2c3d4e5", "x"];
const ENV_NAMES = ["MY_API_KEY=", "DB_PASSWORD=", "GITHUB_TOKEN=", "AWS_ACCESS_KEY_ID=", "GOOGLE_CREDENTIALS=", "CREDENTIAL=", "SECRET=", "MAX_TOKENS=", "APIKEY=", "API_KEY=$", "export ", "TOKEN='", 'PASSWORD="'];
const URL_PARTS = ["https://api.test/v1", "?", "&", "?password=", "&access_token=", "?client-secret=", "&my_api_key=", "?x_token=", "#", "&sig=", "?sv=1&sig=", "?X-Amz-Signature=", "&x-goog-signature="];
const SCHEMES = ["postgres://", "https://", "a+b.c-d://", "1a://", "mongodb+srv://", "-x://", "://", "redis://"];
/** Header names and secret names before a value, for auth-header, cookie and secret-value. */
const LABELS = ["Authorization: Token ", "authorization: ApiKey ", "Proxy-Authorization: ", '"Authorization": "', "Authorization:", "Cookie: sid=", "Set-Cookie: session=", "cookie:a=", "COOKIE: x.y-z=", "DB_PASSWORD = ", "client_secret: ", 'api_key = "', "X-Api-Key: ", "access_token:\t"];
const NETRC = ["machine api.test login demo password ", "default login demo password ", "machine h\n  login u\n  password ", "machine a login b password\t", "machine x login password "];
const FLAGS = [" --api-key ", " --token=", " -token ", " --db-password ", " --openai-api-key=", " --client-secret ", " --access-key-id ", " --passWithNoTests "];
const BEGINS = ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN ENCRYPTED PRIVATE KEY-----"];
const FILLER = ["the", "here", "users", "C:", "path", "ok", "x", "1", "task-1", "keyboard", "tokens", "secretary", "compat"];

/** `s` as written, upper-cased, or with each letter's case picked at random. */
function cased(r: Rand, s: string): string {
  const x = r();
  if (x < 0.5) return s;
  if (x < 0.7) return s.toUpperCase();
  let out = "";
  for (const c of s) out += r() < 0.5 ? c.toUpperCase() : c;
  return out;
}

/** n characters from `chars`, the last a digit (some rules need one). */
const tokenOf = (r: Rand, chars: string, n: number): string => (n > 0 ? draw(r, chars, n - 1) + draw(r, DIGITS, 1) : "");

/** A part shaped like what one rule looks for, or close to it. */
function secretPart(r: Rand): string {
  const x = r();
  if (x < 0.28) {
    const [prefix, chars, need] = pick(r, PREFIXES);
    return prefix + tokenOf(r, chars, r() < 0.5 ? need : need - 2 + Math.floor(r() * 9));
  }
  if (x < 0.46) {
    let word = cased(r, pick(r, SECRET_WORDS));
    // Kelvin sign and long s: an `i` regex without `u` matches neither with k or s.
    if (r() < 0.05) word = word.replace(/k/g, ch(0x212a)).replace(/s/g, ch(0x17f));
    return word + pick(r, SEPS) + (r() < 0.7 ? mixed(r, 6 + Math.floor(r() * 18)) : pick(r, VALUES));
  }
  if (x < 0.53) return pick(r, ["Bearer", "bearer", "BEARER", "Authorization: Bearer", "Bearer:"]) + pick(r, WS) + (r() < 0.3 ? pick(r, WS) : "") + tokenOf(r, ALNUM + "._~+/-", 12 + Math.floor(r() * 14));
  if (x < 0.57) return pick(r, ["Authorization: Basic ", "authorization:basic  ", "AUTHORIZATION: BASIC\t"]) + draw(r, ALNUM + "+/", 6 + Math.floor(r() * 20)) + pick(r, ["", "=", "=="]);
  // The user may be empty (redis://:password@host).
  if (x < 0.64) return pick(r, SCHEMES) + (r() < 0.8 ? draw(r, ALNUM, Math.floor(r() * 9)) : pick(r, ODD)) + ":" + mixed(r, 4 + Math.floor(r() * 10)) + (r() < 0.8 ? "@" : pick(r, ODD)) + "db.internal";
  if (x < 0.71) return pick(r, ENV_NAMES) + (r() < 0.7 ? mixed(r, 6 + Math.floor(r() * 14)) : pick(r, VALUES));
  if (x < 0.76) return pick(r, URL_PARTS) + (r() < 0.6 ? mixed(r, 4 + Math.floor(r() * 16)) : "");
  if (x < 0.8) return pick(r, BEGINS) + pick(r, ["\n", "", " ", "\r\n"]) + draw(r, ALNUM + "+/=", Math.floor(r() * 90)) + (r() < 0.5 ? "\n" + pick(r, BEGINS).replace("BEGIN", "END") : "");
  if (x < 0.84) return ["ey", "J"].join("") + draw(r, ALNUM, 6 + Math.floor(r() * 10)) + "." + ["ey", "J"].join("") + draw(r, ALNUM, 6 + Math.floor(r() * 10)) + "." + draw(r, ALNUM + "_-", 8 + Math.floor(r() * 10));
  if (x < 0.9) return pick(r, LABELS) + (r() < 0.7 ? mixed(r, 6 + Math.floor(r() * 18)) : pick(r, VALUES));
  if (x < 0.93) return pick(r, NETRC) + (r() < 0.7 ? mixed(r, 6 + Math.floor(r() * 12)) : pick(r, VALUES));
  if (x < 0.95) {
    // A private key block in base64 (kubeconfig's client-key-data), cut at any length.
    const encoded = Buffer.from(pick(r, BEGINS) + "\n" + draw(r, B64, 64)).toString("base64");
    return pick(r, ["client-key-data: ", "", "key="]) + encoded.slice(0, 14 + Math.floor(r() * (encoded.length - 13)));
  }
  return pick(r, FLAGS) + mixed(r, 8 + Math.floor(r() * 8));
}

/** A part no rule looks for on its own: a character JSON escapes or one on a rule's edge, a value, a word. */
function plainPart(r: Rand): string {
  const x = r();
  return x < 0.6 ? pick(r, ODD) : x < 0.8 ? pick(r, VALUES) : pick(r, FILLER);
}

/**
 * One secret-shaped part (now and then two) among plain ones. With one, a payload the rules
 * change passes the gate only if the gate finds that part.
 */
function fuzzString(r: Rand): string {
  let s = "";
  for (let n = Math.floor(r() * 3); n > 0; n--) s += plainPart(r);
  s += secretPart(r);
  if (r() < 0.1) s += secretPart(r);
  for (let n = Math.floor(r() * 3); n > 0; n--) s += plainPart(r);
  return s;
}

describe("mayHoldSecret on payloads with nothing to redact", () => {
  it("is false for words and paths that hold part of a secret word or prefix", () => {
    const plain = [
      JSON.stringify({ cwd: ["C:", "Users", "dev", "work"].join(BS), transcript_path: ["c:", "users", "dev", ".claude", "x.jsonl"].join(BS) }),
      JSON.stringify({ permission_mode: "bypassPermissions", tool_input: { command: "npx vitest --passWithNoTests" } }),
      "passed https://example.com/x task-1 npm_config_cache keyboard tokenizer max_tokens MAX_TOKENS=1000 token_count input_tokens compat path secretary",
      "from huggingface_hub import hf_hub_download; xai-org rapidapi MSG.x signal=1 design=2 cookies machine-readable",
    ];
    for (const text of plain) {
      assert.equal(mayHoldSecret(text), false, text);
      assert.deepEqual(engineFinds(text), [], text);
    }
  });

  it("is false for the hook benchmark's payload at 2 KB and 1 MB", () => {
    for (const bytes of [2048, 1 << 20]) {
      const text = JSON.stringify({ session_id: "bench-0000", transcript_path: "/nonexistent", cwd: "/work/demo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bench", tool_input: { command: "ls -la" }, tool_response: { stdout: "x".repeat(bytes - 400), stderr: "", interrupted: false }, duration_ms: 12 });
      assert.equal(mayHoldSecret(text), false, `${bytes} bytes`);
    }
  });
});

// ---------------------------------------------------------------- config

describe("isDefaultCaptureConfig", () => {
  const init = defaultConfigToml(home().env);
  const defaults: [string, string | undefined][] = [
    ["no file", undefined],
    ["an empty file", ""],
    ["the file init writes", init],
    ["that file with CRLF line ends", init.replace(/\n/g, "\r\n")],
    ["that file after a BOM", ch(0xfeff) + init],
    ["a capture table without redact", `[capture]\nmode = "metadata"\n`],
    ["the default list written out", `[capture]\nredact = ["secrets"]\n`],
  ];
  const others: [string, string][] = [
    ["email added", `[capture]\nredact = ["secrets", "email"]\n`],
    ["no rules", `[capture]\nredact = ["none"]\n`],
    ["an empty list", `[capture]\nredact = []\n`],
    ["a pattern", `[capture]\nredactPatterns = ["internal-[0-9]+"]\n`],
    ["a list over several lines", `[capture]\nredact = [\n  "secrets",\n  "email",\n]\n`],
    ["an inline table", `capture = { redact = ["email"] }\n`],
    ["a dotted key", `capture.redact = ["email"]\n`],
    ["a quoted key spelled with an x escape", `[capture]\n"re${BS}x64act" = ["email"]\n`],
    ["a quoted key spelled with a u escape", `[capture]\n"re${esc(0x64)}act" = ["email"]\n`],
    ["upper case", `[capture]\nREDACT = ["email"]\n`],
    ["a comment after the default", `[capture]\nredact = ["secrets"] # default\n`],
    ["single quotes", `[capture]\nredact = ['secrets']\n`],
  ];
  const rules = (r: { rules: readonly { kind: string; pattern: RegExp }[] }) => r.rules.map((x) => [x.kind, x.pattern.source, x.pattern.flags]);

  it("is true for configs that leave the rules at their default, as the engine reads them", () => {
    const want = rules(createRedactor());
    for (const [name, text] of defaults) {
      assert.equal(isDefaultCaptureConfig(text), true, name);
      const { h, env } = home();
      if (text !== undefined) writeFileSync(join(h, "config.toml"), text);
      assert.deepEqual(rules(spoolRedactor(env)), want, name);
    }
  });

  it("is false for any other line that mentions redact, and for escapes that could spell it", () => {
    for (const [name, text] of others) assert.equal(isDefaultCaptureConfig(text), false, name);
  });
});

describe("needsRedaction", () => {
  const GITHUB = ["gh", "p_", "R4nd0mT0k3nV4lu3xQ9zLm2Wp8Ks5Yt7Hc1D"].join("");
  const plain = JSON.stringify({ session_id: "s", prompt: "hello" });
  const secret = JSON.stringify({ session_id: "s", prompt: `use ${GITHUB}` });

  it("is true for a payload that may hold a secret, else when the config sets other rules", () => {
    const none = home();
    assert.equal(needsRedaction(plain, none.env), false);
    assert.equal(needsRedaction(secret, none.env), true);
    const init = home();
    writeFileSync(join(init.h, "config.toml"), defaultConfigToml(init.env));
    assert.equal(needsRedaction(plain, init.env), false);
    for (const config of [`[capture]\nredact = ["secrets", "email"]\n`, `[capture]\nredactPatterns = ["internal-[0-9]+"]\n`]) {
      const { h, env } = home();
      writeFileSync(join(h, "config.toml"), config);
      assert.equal(needsRedaction(plain, env), true, config);
    }
    // A config.toml that can't be read: spoolRedactor uses the default rules, so the gate does too.
    const dir = home();
    mkdirSync(join(dir.h, "config.toml"));
    assert.equal(needsRedaction(plain, dir.env), false);
    assert.equal(needsRedaction(secret, dir.env), true);
  });
});

// ---------------------------------------------------------------- the hook

describe("the hook with the gate", () => {
  const GITHUB = ["gh", "p_", "Zq8Lm3Np5Rt7Vb9Cd1Ef3Gh5Jk7Mn9Pq2St4"].join("");
  const MAIL = ["dev", "@", "example.org"].join("");
  let bin = "";
  let lone = "";

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-gate-bin-"));
    roots.push(root);
    bin = join(root, "bin");
    await bundleHook(bin);
    // A hook.mjs whose rules are gone.
    lone = join(root, "lone");
    mkdirSync(lone);
    copyFileSync(join(bin, "hook.mjs"), join(lone, "hook.mjs"));
  });

  const fromSource = (): string[] => [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts")];

  function runHook(script: string[], env: NodeJS.ProcessEnv, input: string): void {
    const r = spawnSync(process.execPath, [...script, "fake", "UserPromptSubmit"], { input, env: { ...env, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }

  function spoolLines(h: string): SpoolLine[] {
    const dir = join(h, "spool", "fake");
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SpoolLine));
  }

  /** Every file under `dir` whose bytes hold `needle`. */
  function holding(dir: string, needle: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name)).includes(needle)).map((e) => join(e.parentPath, e.name));
  }

  it("from source: loads the rules for a payload with no secret when the config adds rules", () => {
    for (const [config, prompt, kind] of [
      [`[capture]\nredact = ["secrets", "email"]\n`, `mail ${MAIL}`, "email"],
      [`[capture]\nredactPatterns = ["internal-[0-9]+"]\n`, "see internal-4821", "pattern"],
    ] as const) {
      const { h, env } = home();
      writeFileSync(join(h, "config.toml"), config);
      const text = JSON.stringify({ session_id: "s", cwd: "/w", prompt });
      assert.equal(mayHoldSecret(text), false);
      runHook(fromSource(), env, text);
      const [line, ...rest] = spoolLines(h);
      assert.deepEqual(rest, []);
      assert.deepEqual(line!.redactions, { [kind]: 1 });
      assert.match((line!.raw as { prompt: string }).prompt, new RegExp(`\\[redacted:${kind}\\]$`));
    }
  });

  it("bundled: writes a plain payload as it came, and redacts one with a secret", () => {
    const { h, env } = home();
    const plain = JSON.stringify({ session_id: "s", cwd: "/w", prompt: "hello" });
    runHook([join(bin, "hook.mjs")], env, plain);
    runHook([join(bin, "hook.mjs")], env, JSON.stringify({ session_id: "s", cwd: "/w", prompt: `use ${GITHUB}` }));
    const [a, b] = spoolLines(h);
    assert.deepEqual([a!.raw, a!.redactions], [JSON.parse(plain), undefined]);
    assert.deepEqual([b!.raw, b!.redactions], [{ session_id: "s", cwd: "/w", prompt: "use [redacted:github-token]" }, { "github-token": 1 }]);
    assert.deepEqual(holding(h, GITHUB), []);
  });

  it("bundled without its rules: writes a plain payload, and no line for one that may hold a secret", () => {
    const { h, env } = home();
    const plain = JSON.stringify({ session_id: "s", cwd: "/w", prompt: "hello" });
    runHook([join(lone, "hook.mjs")], env, plain);
    runHook([join(lone, "hook.mjs")], env, JSON.stringify({ session_id: "s", cwd: "/w", prompt: `use ${GITHUB}` }));
    assert.deepEqual(spoolLines(h).map((l) => l.raw), [JSON.parse(plain)]);
    const errors = readFileSync(join(h, "spool", "errors.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { code?: string });
    assert.deepEqual(errors.map((e) => e.code), ["ERR_MODULE_NOT_FOUND"]);
    assert.deepEqual(holding(h, GITHUB), []);
  });
});
