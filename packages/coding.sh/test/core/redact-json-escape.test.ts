// JSON text can sit inside a string: an OTLP log body, a prompt that quotes a tool result, a
// model's output messages. In that text a newline is written as the two characters `\n`, and
// other characters as a `\u` escape (a backslash, `u` and four hex digits), so a token right after
// one follows a letter or a digit. Most rules start with a break that rejects a letter or a digit
// before the token, and orAfterEscape also lets them start right after an escape. These tests put
// each rule's example after every escape, redact the event as ingest and the OTLP receiver do
// (redactEventCounted), and check that the text still parses as JSON afterwards.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { createRedactor, piiRules, redactEventCounted, secretRules, type Redactor } from "../../src/core/redact.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const BS = String.fromCharCode(92);
// Vendor-shaped values are joined at run time so no whole one sits in this file.
const j = (...parts: string[]): string => parts.join("");

const rand = mulberry32(7);
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = UPPER + LOWER + DIGITS;
const HEX = "0123456789abcdef";
const B64 = `${ALNUM}+/`;
const draw = (chars: string, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * chars.length)];
  return s;
};
/** Random letters and digits that hold a digit and a lower-case letter, as a written value does. */
const mixed = (n = 24): string => draw(ALNUM, n - 2) + draw(DIGITS, 1) + draw(LOWER, 1);

/** A rule's example: the text, and the parts of it no redacted text may hold. */
interface Example {
  kind: string;
  text: string;
  secret: string[];
}
const token = (kind: string, ...parts: string[]): Example => ({ kind, text: j(...parts), secret: [j(...parts)] });
const valued = (kind: string, before: string, value: string, after = ""): Example => ({ kind, text: before + value + after, secret: [value] });
const cookie = (a: string, b: string): Example => ({ kind: "cookie", text: `Cookie: sessionid=${a}; csrftoken=${b}`, secret: [a, b] });

const SECRETS: Example[] = [
  token("anthropic-key", "sk-", "ant-", "api03-", mixed(40)),
  token("openai-key", "sk", "-proj-", mixed(40)),
  token("github-token", "gh", "p_", draw(ALNUM, 36)),
  token("github-token", "git", "hub_pat_", draw(ALNUM, 30)),
  token("gitlab-token", "gl", "pat-", draw(ALNUM, 20)),
  token("slack-token", "xo", "xb-", draw(DIGITS, 12), "-", draw(ALNUM, 24)),
  token("aws-access-key", "AK", "IA", draw(UPPER + DIGITS, 16)),
  token("google-api-key", "AI", "za", draw(ALNUM, 35)),
  token("stripe-key", "sk", "_live_", draw(ALNUM, 24)),
  token("npm-token", "np", "m_", draw(ALNUM, 36)),
  token("coding-sh-key", "cs", "h_ik_", draw(ALNUM, 32)),
  token("vercel-ai-gateway-key", "vc", "k_", draw(ALNUM, 24)),
  token("huggingface-token", "hf", "_", draw(ALNUM, 34)),
  token("groq-key", "gs", "k_", draw(ALNUM, 52)),
  token("replicate-token", "r8", "_", draw(ALNUM, 37)),
  token("xai-key", "xa", "i-", draw(ALNUM, 80)),
  token("perplexity-key", "pp", "lx-", draw(ALNUM, 48)),
  token("google-oauth-token", "ya", "29.", draw(`${ALNUM}_-`, 120)),
  token("google-oauth-secret", "GOC", "SPX-", draw(`${ALNUM}_-`, 28)),
  token("sendgrid-key", "S", "G.", draw(`${ALNUM}_-`, 22), ".", draw(`${ALNUM}_-`, 43)),
  token("digitalocean-token", "do", "p_v1_", draw(HEX, 64)),
  token("shopify-token", "sh", "pat_", draw(HEX, 32)),
  token("pypi-token", "py", "pi-AgE", draw(`${ALNUM}_-`, 70)),
  token("docker-token", "dc", "kr_pat_", draw(`${ALNUM}_-`, 27)),
  token("linear-key", "li", "n_api_", draw(ALNUM, 40)),
  token("vault-token", "hv", "s.", mixed(90)),
  token("stripe-webhook-secret", "wh", "sec_", draw(ALNUM, 32)),
  token("atlassian-token", "ATA", "TT3", draw(`${ALNUM}_=-`, 180)),
  token("databricks-token", "da", "pi", draw(HEX, 32)),
  token("age-secret-key", "AGE-", "SECRET-KEY-1", draw(UPPER + DIGITS, 58)),
  token("postman-key", "PM", "AK-", draw(HEX, 24), "-", draw(HEX, 34)),
  token("sentry-token", "sn", "trys_", draw(`${B64}=_-`, 60)),
  token("pinecone-key", "pc", "sk_", draw(ALNUM, 6), "_", draw(ALNUM, 60)),
  token("langsmith-key", "ls", "v2_pt_", draw(HEX, 32), "_", draw(HEX, 10)),
  token("tavily-key", "tv", "ly-", draw(ALNUM, 32)),
  token("nvidia-key", "nv", "api-", draw(`${ALNUM}_-`, 64)),
  token("grafana-token", "gl", "sa_", draw(ALNUM, 32), "_", draw(HEX, 8)),
  token("grafana-token", "gl", "c_", draw(`${B64}=`, 48)),
  token("figma-token", "fi", "gd_", draw(`${ALNUM}_-`, 40)),
  token("jwt", "ey", "J", draw(ALNUM, 20), ".ey", "J", draw(ALNUM, 30), ".", draw(`${ALNUM}_-`, 43)),
  valued("azure-storage-key", "AccountKey=", `${draw(B64, 86)}==`, ";EndpointSuffix=core.windows.net"),
  valued("bearer", "Bearer ", mixed(32)),
  valued("basic-auth", "Authorization: Basic ", `${draw(`${ALNUM}+/`, 20)}==`),
  valued("auth-header", "Authorization: Token ", mixed(40)),
  cookie(mixed(32), mixed(12)),
  valued("secret-assignment", "GOOGLE_CREDENTIALS=", mixed(20)),
  valued("prose-secret", "PAT: ", mixed()),
  valued("prose-secret", "password is ", mixed(12)),
  valued("netrc", "machine api.test login demo password ", mixed(12)),
];

const PII: Example[] = [
  valued("card", "", j("4111 ", "1111 1111 1111")),
  valued("card", "", j("40128888", "88881881")),
  valued("phone", "", "+44 20 7946 0958"),
  valued("phone", "", "(415) 555-2671"),
  valued("phone", "", "415-555-2671"),
  valued("iban", "", j("GB82WEST", "12345698765432")),
  valued("national-id", "", "536-22-1234"),
  valued("national-id", "", "AB 12 34 56 C"),
  valued("national-id", "", "130 692 544"),
];

/** The escapes a token can follow in JSON text: the letter ones and `\u` ones, upper and lower hex. */
const ESCAPES = ["b", "f", "n", "r", "t", "u000a", "u000A", "u00e9", "u0030", "u004B"].map((e) => BS + e);
/** `\"`, `\\` and `\/` end in a character that is not a letter or a digit: a token after one was found before. */
const ESCAPES_BEFORE = ['"', BS, "/"].map((e) => BS + e);

const event = (text: string): AgentEvent => ({ id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "user.message", payload: { text } });

/** Redacts `{"msg":"x<escape><example>"}` as ingest does and checks the result against the example on its own. */
function checkAfter(red: Redactor, ex: Example, escape: string): void {
  const text = `{"msg":"x${escape}${ex.text}"}`;
  const label = `${ex.kind} after ${escape}`;
  const alone = redactEventCounted(red, event(ex.text));
  const out = redactEventCounted(red, event(text));
  const outText = out.payload.text as string;
  assert.deepEqual(JSON.parse(outText), { msg: (JSON.parse(`"x${escape}"`) as string) + (alone.payload.text as string) }, label);
  for (const part of ex.secret) assert.ok(!outText.includes(part), label);
  assert.deepEqual(out.payload.redactions, alone.payload.redactions, label);
}

describe("redaction right after a JSON escape", () => {
  const red = createRedactor();
  const pii = createRedactor({ redact: ["pii"] });

  it("each example is redacted on its own", () => {
    for (const ex of SECRETS) assert.ok(red.string(`x ${ex.text}`).includes(`[redacted:${ex.kind}]`), ex.kind);
    for (const ex of PII) assert.ok(pii.string(`x ${ex.text}`).includes(`[redacted:${ex.kind}]`), ex.kind);
  });

  it("finds an Anthropic key and a GitHub token after `\\n` and `\\t` in a prompt", () => {
    const ak = j("sk-", "ant-", "api03-", mixed(40));
    const gh = j("gh", "p_", draw(ALNUM, 36));
    const out = redactEventCounted(red, event(`see {"msg":"a${BS}n${ak} b${BS}t${gh}"}`));
    assert.equal(out.payload.text, `see {"msg":"a${BS}n[redacted:anthropic-key] b${BS}t[redacted:github-token]"}`);
    assert.deepEqual(out.payload.redactions, { "anthropic-key": 1, "github-token": 1 });
  });

  it("finds every secret example after each escape, and the text still parses", () => {
    for (const ex of SECRETS) for (const e of [...ESCAPES, ...ESCAPES_BEFORE]) checkAfter(red, ex, e);
  });

  it("finds every PII example after each escape, and the text still parses", () => {
    for (const ex of PII) for (const e of [...ESCAPES, ...ESCAPES_BEFORE]) checkAfter(pii, ex, e);
  });

  it("every rule with a leading break also passes right after an escape", () => {
    const AFTER = `(?<=${BS}${BS}[bfnrt])`;
    const AFTER_U = `(?<=${BS}${BS}u[0-9A-Fa-f]{4})`;
    // These rules start without a break: a fixed opening, a quote or a name of their own.
    const noBreak = new Set(["private-key", "slack-webhook", "encoded-private-key", "password", "url-secret", "secret-field", "secret-value", "email"]);
    const rules = [...secretRules(), ...piiRules()];
    for (const kind of noBreak) assert.ok(rules.some((r) => r.kind === kind), kind);
    for (const rule of rules) {
      const src = rule.pattern.source;
      if (noBreak.has(rule.kind)) {
        assert.ok(!src.includes(AFTER), rule.kind);
        continue;
      }
      assert.ok(src.includes(AFTER) && src.includes(AFTER_U), `${rule.kind}: ${src.slice(0, 80)}`);
      const found = [...SECRETS, ...PII].some((ex) => {
        if (ex.kind !== rule.kind) return false;
        rule.pattern.lastIndex = 0;
        const hit = rule.pattern.test(`a${BS}n${ex.text}`);
        rule.pattern.lastIndex = 0;
        return hit;
      });
      assert.ok(found, `no example of ${rule.kind} matches ${src.slice(0, 80)} after an escape`);
    }
  });

  it("the assignment rule's leading lookahead changes no match", () => {
    // The lookahead lets the engine pass over places where no name starts. Without it the rule must
    // find the same matches, so a change to the names that lets one start elsewhere fails here.
    const rule = secretRules().find((r) => r.kind === "secret-assignment");
    assert.ok(rule);
    const AHEAD = "(?=[A-Z0-9_])";
    assert.ok(rule.pattern.source.startsWith(AHEAD), rule.pattern.source.slice(0, 40));
    const bare = new RegExp(rule.pattern.source.slice(AHEAD.length), rule.pattern.flags);
    const escapes = ["n", "t", "b", "u00e9", "u004B", "/", '"', "", BS].map((e) => BS + e);
    const parts = ["DB_PASSWORD=", "API_KEY=", "AWS_CREDENTIALS=", "x_token=", "Secret=", "A", "_", "9", "x", "n", "u", " ", "=", "$", "'", '"', "`", ";", "[redacted:email]", mixed(10), "12345678", ...escapes];
    const matches = (re: RegExp, s: string): string[] => [...s.matchAll(re)].map((m) => JSON.stringify([m.index, ...m]));
    const next = mulberry32(11);
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      let s = "";
      for (let n = 1 + Math.floor(next() * 16); n > 0; n--) s += parts[Math.floor(next() * parts.length)];
      const want = matches(bare, s);
      if (want.length) hits++;
      assert.deepEqual(matches(rule.pattern, s), want, JSON.stringify(s));
    }
    assert.ok(hits > 400, `${hits} strings hold a match`);
  });

  it("does not match inside a word that follows an escape", () => {
    const tok = j("sk", "-", "q7w8e9r0t1y2u3i4o5p6");
    // Each `sk-` here follows a letter that does not end an escape, as in `task-` and `risk-`.
    for (const text of [`{"t":"a${BS}ta${tok}"}`, `{"t":"a${BS}nta${tok}"}`, `{"t":"a${BS}tri${tok}"}`, `{"t":"a${BS}u00e9ta${tok}"}`]) {
      assert.equal(red.string(text), text);
    }
    assert.equal(red.string(`{"t":"a${BS}t${tok}"}`), `{"t":"a${BS}t[redacted:openai-key]"}`);
  });
});

describe("a redaction keeps JSON text valid", () => {
  const red = createRedactor();
  const email = createRedactor({ redact: ["email"] });
  const Q = `${BS}"`;
  const cases: [string, Redactor, string, string][] = [
    ["a value that runs to an escaped quote", red, `{"cmd":"echo ${Q}API_TOKEN=x1y2z3w4v5${Q}"}`, `{"cmd":"echo ${Q}API_TOKEN=[redacted:secret-assignment]${Q}"}`],
    ["a quoted field value that runs to an escaped quote", red, `{"api_key":"x1y2z3w4${Q}more"}`, `{"api_key":"[redacted:secret-field]${Q}more"}`],
    ["a URL parameter that runs to an escaped quote", red, `{"u":"https://x.test/?token=x1y2z3w4${Q}"}`, `{"u":"https://x.test/?token=[redacted:url-secret]${Q}"}`],
    ["a URL parameter that ends as the marker does", red, `{"u":"https://x.test/?token=x1y2z3w4${BS}t]"}`, `{"u":"https://x.test/?token=[redacted:url-secret]"}`],
    ["a written secret that runs to an escaped quote", red, `{"t":"password: x1y2z3w4${Q}"}`, `{"t":"password: [redacted:prose-secret]${Q}"}`],
    ["a written secret after `is`", red, `{"t":"the password is x1y2z3w4${Q}"}`, `{"t":"the password is [redacted:prose-secret]${Q}"}`],
    ["a written secret that ends as the marker does", red, `{"t":"password: x1y2z3w4${BS}t]"}`, `{"t":"password: [redacted:prose-secret]"}`],
    ["a bearer token before an escaped quote", red, `{"t":"Bearer x1y2z3w4v5u6t7s8${Q}"}`, `{"t":"Bearer [redacted:bearer]${Q}"}`],
    ["basic auth before an escaped quote", red, `{"t":"Authorization: Basic eDF5MnozdzQ=${Q}"}`, `{"t":"Authorization: Basic [redacted:basic-auth]${Q}"}`],
    ["a netrc password at the end of a string", red, `{"t":"machine api.test login demo password x1y2z3w4"}`, `{"t":"machine api.test login demo password [redacted:netrc]"}`],
    ["a netrc password before an escape", red, `{"t":"machine api.test login demo password x1y2z3w4${BS}nnext"}`, `{"t":"machine api.test login demo password [redacted:netrc]${BS}nnext"}`],
    ["a netrc entry after an escaped newline", red, `{"t":"x${BS}nmachine api.test login demo password x1y2z3w4"}`, `{"t":"x${BS}nmachine api.test login demo password [redacted:netrc]"}`],
    // Right after an escape, the value ends at the next `\n` (or `\t`, ...), so the next line stays.
    ["an assignment after an escaped newline", red, `{"out":"x${BS}nDB_PASSWORD=x1y2z3w4v5${BS}nPORT=8080"}`, `{"out":"x${BS}nDB_PASSWORD=[redacted:secret-assignment]${BS}nPORT=8080"}`],
    ["an assignment with no value before the next line", red, `{"m":"x${BS}nDB_PASSWORD=${BS}nAWS_CREDENTIALS=x1y2z3w4v5"}`, `{"m":"x${BS}nDB_PASSWORD=${BS}nAWS_CREDENTIALS=[redacted:secret-assignment]"}`],
    ["a netrc password before the next key", red, `{"t":"machine api.test login demo password x1y2z3w4","u":"v"}`, `{"t":"machine api.test login demo password [redacted:netrc]","u":"v"}`],
    ["a marker before an escape is left as it is", red, `{"r":"one${BS}nDB_PASSWORD=[redacted:secret-assignment]${BS}nexport X=1"}`, `{"r":"one${BS}nDB_PASSWORD=[redacted:secret-assignment]${BS}nexport X=1"}`],
    ["a value after a marker and an escape is still found", red, `{"r":"one${BS}nDB_PASSWORD=[redacted:secret-assignment]${BS}nAPI_KEY=x1y2z3w4v5"}`, `{"r":"one${BS}nDB_PASSWORD=[redacted:secret-assignment]${BS}nAPI_KEY=[redacted:secret-assignment]"}`],
    // A match that starts inside an escape: the escape is finished as U+FFFD, so the text still
    // parses and the escape keeps none of the match's characters.
    ["an address that starts at the letter of `\\n`", email, `{"t":"a${BS}nbob@example.com"}`, `{"t":"a${BS}ufffd[redacted:email]"}`],
    ["an address that starts at the `u` of an escape", email, `{"t":"a${BS}u00e9bob@example.com"}`, `{"t":"a${BS}ufffd[redacted:email]"}`],
  ];
  for (const [name, r, input, want] of cases) {
    it(name, () => {
      JSON.parse(input);
      const out = r.string(input);
      assert.equal(out, want);
      JSON.parse(out);
    });
  }

  it("in plain text, a backslash or a quote inside a value stays in it", () => {
    assert.equal(red.string(`DB_PASSWORD=ab${BS}cd1234efgh`), "DB_PASSWORD=[redacted:secret-assignment]");
    assert.equal(red.string(`DB_PASSWORD=ab${BS}ncd1234efgh`), "DB_PASSWORD=[redacted:secret-assignment]");
    assert.equal(red.string(`DB_PASSWORD=ab${BS}${BS}ncd1234efgh`), "DB_PASSWORD=[redacted:secret-assignment]");
    assert.equal(red.string(`GOOGLE_CREDENTIALS=D:${BS}uploads${BS}demo${BS}key.json`), "GOOGLE_CREDENTIALS=[redacted:secret-assignment]");
    assert.equal(red.string(`machine api.test login demo password ab"cd1234`), "machine api.test login demo password [redacted:netrc]");
    assert.equal(red.string(`machine api.test login demo password ab",cd1234`), "machine api.test login demo password [redacted:netrc]");
    assert.equal(red.string(`machine api.test login demo password ab"}cd1234`), "machine api.test login demo password [redacted:netrc]");
  });

  it("in plain text, a match that starts inside what reads as a JSON escape is replaced whole", () => {
    // `\b` and `\u2024` read as JSON escapes, `\d` does not.
    assert.equal(email.string(`DOMAIN${BS}bob@example.com`), `DOMAIN${BS}ufffd[redacted:email]`);
    assert.equal(email.string(`CORP${BS}dev.ops@example.com`), `CORP${BS}[redacted:email]`);
    const year = createRedactor({ redact: ["none"], patterns: [String.raw`\d{4}`] });
    assert.equal(year.string(`C:${BS}u2024${BS}report`), `C:${BS}ufffd[redacted:pattern]${BS}report`);
  });

  it("an assignment in JSON text held in JSON text keeps both levels", () => {
    const input = JSON.stringify({ o: JSON.stringify({ m: 'a\nDB_PASSWORD=x1y2z3w4v5"' }) });
    const out = red.string(input);
    const inner = JSON.parse((JSON.parse(out) as { o: string }).o) as { m: string };
    assert.deepEqual(inner, { m: 'a\nDB_PASSWORD=[redacted:secret-assignment]"' });
  });
});
