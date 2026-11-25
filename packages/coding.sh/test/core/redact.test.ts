import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { createRedactor, isSecretAttrKey, redactArgv, redactBlobValue, redactionTally, SECRET_NEEDLES, secretRules, sessionToMetadata, toMetadata, type RedactRule } from "../../src/core/redact.ts";
import { originalSecretRedact } from "../fixtures/redact/original-secret-rules.ts";
import { median, timeMs } from "../helpers-timing.ts";

const r = createRedactor({ redact: ["secrets"] });

/**
 * Redacting `make(n)` grows linearly with n. A 1 MB input under `budgetMs` passes
 * at once (an idle machine takes a few tens of ms). A slower run is either load
 * or super-linear growth, so measure the growth: median of 3 at 256 KB and at
 * 1 MB, interleaved. Linear time grows about 4x, O(n²) about 16x. The O(n²)
 * rules this guards against took seconds to minutes at 1 MB, past the hard cap.
 */
function assertLinear(label: string, make: (n: number) => string, budgetMs = 500, check?: (input: string, out: string) => void, red = r): void {
  const MB = 1 << 20;
  const input = make(MB);
  let out = "";
  const ms = timeMs(() => (out = red.string(input)));
  check?.(input, out);
  if (ms < budgetMs) return;
  assert.ok(ms < 10_000, `${label}: ${ms.toFixed(0)} ms for 1 MB`);
  const quarter = make(MB / 4);
  const small: number[] = [];
  const big: number[] = [];
  for (let i = 0; i < 3; i++) {
    small.push(timeMs(() => red.string(quarter)));
    big.push(timeMs(() => red.string(input)));
  }
  const growth = median(big) / Math.max(median(small), 0.01);
  assert.ok(growth < 8, `${label}: ${median(small).toFixed(1)} ms at 256 KB, ${median(big).toFixed(1)} ms at 1 MB (${growth.toFixed(1)}x; linear is ~4x, O(n²) ~16x)`);
}

// Vendor-shaped values are built with join so no whole one sits in this file (esbuild folds "a" + "b").
const GITHUB_CLASSIC = ["ghp_", "0123456789abcdefghijABCDEFGHIJ012345"].join("");
const GITHUB_FINE = ["github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"].join("");
const SLACK_BOT = ["xox", "b-1234567890-0987654321-AbCdEfGh"].join("");
const SLACK_USER = ["xox", "p-1234567890-abcdef"].join("");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const STRIPE_LIVE = ["sk_li", "ve_", "51H8abcdefghijklmnop"].join("");

const HEX = "0123456789abcdef";
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64 = `${B62}+/`;
const B64URL = `${B62}-_`;
const valueRand = prng(99);
/** `n` random characters from `chars`, the same on every run; `lead` keeps a digit and a letter in front. */
const fill = (chars: string, n: number, lead = ""): string => [lead, randomFrom(valueRand, chars, n)].join("");
/** One value of each vendor format, by kind: [kind, value]. */
const VENDOR_VALUES: [string, string][] = [
  ["huggingface-token", ["hf_", fill(B62, 34)].join("")],
  ["groq-key", ["gsk_", fill(B62, 52)].join("")],
  ["replicate-token", ["r8_", fill(B62, 37)].join("")],
  ["xai-key", ["xai-", fill(B62, 80)].join("")],
  ["perplexity-key", ["pplx-", fill(B62, 48)].join("")],
  ["google-oauth-token", ["ya29.", fill(B64URL, 100)].join("")],
  ["google-oauth-secret", ["GOCSPX-", fill(B64URL, 28)].join("")],
  ["sendgrid-key", ["SG.", fill(B64URL, 22), ".", fill(B64URL, 43)].join("")],
  ["digitalocean-token", ["dop_v1_", fill(HEX, 64)].join("")],
  ["shopify-token", ["shpat_", fill(HEX, 32)].join("")],
  ["pypi-token", ["pypi-AgEIcHlwaS5vcmc", fill(B64URL, 70)].join("")],
  ["docker-token", ["dckr_pat_", fill(B64URL, 27)].join("")],
  ["linear-key", ["lin_api_", fill(B62, 40)].join("")],
  ["vault-token", ["hvs.", fill(B64URL, 90, "C4")].join("")],
  ["stripe-webhook-secret", ["whsec_", fill(B62, 32)].join("")],
  ["atlassian-token", ["ATATT3", fill(B64URL, 120)].join("")],
  ["databricks-token", ["dapi", fill(HEX, 32)].join("")],
  ["age-secret-key", ["AGE-SECRET-KEY-1", fill("QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58)].join("")],
  ["postman-key", ["PMAK-", fill(HEX, 24), "-", fill(HEX, 34)].join("")],
  ["sentry-token", ["sntrys_", fill(B64, 60)].join("")],
  ["pinecone-key", ["pcsk_", fill(B62, 6), "_", fill(B62, 60)].join("")],
  ["langsmith-key", ["lsv2_pt_", fill(HEX, 32), "_", fill(HEX, 10)].join("")],
  ["tavily-key", ["tvly-", fill(B62, 32)].join("")],
  ["nvidia-key", ["nvapi-", fill(B64URL, 64)].join("")],
  ["grafana-token", ["glsa_", fill(B62, 32), "_", fill(HEX, 8)].join("")],
  ["grafana-token", ["glc_", fill(B64, 48)].join("")],
  ["figma-token", ["figd_", fill(B64URL, 40)].join("")],
  ["gitlab-token", ["gldt-", fill(B64URL, 20)].join("")],
  ["gitlab-token", ["glrt-", fill(B64URL, 20)].join("")],
  ["slack-token", ["xapp-1-A0", fill("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 9), "-", fill("0123456789", 13), "-", fill(HEX, 64)].join("")],
];
/** A private key block in base64, as kubeconfig's client-key-data holds one; the PEM is built so no BEGIN line sits in this file. */
const pemBase64 = (label: string): string => Buffer.from([`-----BEGIN ${label}-----`, fill(B64, 64), `-----END ${label}-----`, ""].join("\n")).toString("base64");
const ENCODED_KEY = pemBase64(["RSA PRIVATE", "KEY"].join(" "));
const ENCODED_CERT = pemBase64("CERTIFICATE");
/** Two BEGIN lines that share five dashes, with key data and no END line after the second. */
const OVERLAPPING_BEGIN = [["-----BEGIN", "PRIVATE", "KEY-----BEGIN", "PRIVATE", "KEY-----"].join(" "), fill(B64, 64)].join("");

const positives: [string, string, string][] = [
  ...VENDOR_VALUES.map(([kind, value]): [string, string, string] => [`${kind} ${value.slice(0, 5)}`, `key ${value} end`, kind]),
  ["azure storage key", `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${fill(B64, 86)}==;EndpointSuffix=core.windows.net`, "azure-storage-key"],
  ["encoded private key", `    client-key-data: ${ENCODED_KEY}`, "encoded-private-key"],
  ["authorization token scheme", `Authorization: Token ${fill(HEX, 40, "a1")}`, "auth-header"],
  ["authorization apikey scheme", `authorization: ApiKey ${fill(B62, 40, "k7")}`, "auth-header"],
  ["proxy authorization, bare", `Proxy-Authorization: ${fill(B62, 40, "q4")}`, "auth-header"],
  ["authorization as a quoted key", `{"Authorization": "Token ${fill(HEX, 40, "c3")}"}`, "auth-header"],
  ["cookie header", `Cookie: sessionid=${fill(B62, 32)}; csrftoken=${fill(B62, 32)}`, "cookie"],
  ["set-cookie header", `Set-Cookie: sid=${fill(B62, 32)}; Path=/; HttpOnly`, "cookie"],
  ["url password with no user", `redis://:${fill(B62, 16, "Pw7")}@cache.internal:6379/0`, "password"],
  ["signed url sig", `https://demo.blob.core.windows.net/c/f.txt?sv=2022-11-02&ss=b&sig=${fill(B62, 40)}%3D`, "url-secret"],
  ["signed url signature", `https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${fill(HEX, 64)}`, "url-secret"],
  ["netrc", `machine api.example.invalid login demo password ${fill(B62, 13, "Pw7")}`, "netrc"],
  ["netrc on several lines", `machine api.example.invalid\n  login demo\n  password ${fill(B62, 13, "Pw7")}`, "netrc"],
  ["dotenv with spaces", `DB_PASSWORD = ${fill(B62, 13, "Pw9")}`, "secret-value"],
  ["yaml client_secret", `client_secret: ${fill(B62, 30, "Cs4")}`, "secret-value"],
  ["toml api_key", `api_key = "${fill(B62, 30, "Ak2")}"`, "secret-value"],
  ["anthropic", "key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc", "anthropic-key"],
  ["openai", "OPENAI sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34", "openai-key"],
  ["openai classic", "use sk-1234567890abcdefghijklmnopqrstuv now", "openai-key"],
  ["github classic", `token ${GITHUB_CLASSIC}`, "github-token"],
  ["github fine-grained", GITHUB_FINE, "github-token"],
  ["gitlab", "glpat-abcdefghij0123456789", "gitlab-token"],
  ["prose PAT", "here is the PAT here ya go: abcD3f-ghiJkl-mnoPqr", "prose-secret"],
  ["prose password", "the password is hunter22x", "prose-secret"],
  ["slack bot", SLACK_BOT, "slack-token"],
  ["slack user", SLACK_USER, "slack-token"],
  ["aws access key", `aws_access_key_id ${AWS_KEY}`, "aws-access-key"],
  ["google", "AIzaSyA-1234567890abcdefghijklmnopqrstu", "google-api-key"],
  ["stripe", STRIPE_LIVE, "stripe-key"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
  ["bearer", "curl -H 'Authorization: Bearer abc123def456ghi789jkl'", "bearer"],
  ["url password", "postgres://admin:hunter2secret@db.internal:5432/app", "password"],
  ["url param", "https://api.example.com/v1?user=bob&password=s3cr3t!&x=1", "url-secret"],
  ["url token param", "https://x.io/cb?access_token=ya29.a0AfH6&state=1", "url-secret"],
  ["env assignment", "export DATABASE_PASSWORD=correct-horse-battery", "secret-assignment"],
  ["env api key", "MY_SERVICE_API_KEY=\"abcd1234efgh\" node app.js", "secret-assignment"],
  ["json field", '{"client_secret": "abc123XYZ789", "id": 1}', "secret-field"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "private-key"],
  ["openssh key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----", "private-key"],
];

const negatives = [
  "commit 3f786850e387550fdab836ed7e6dc881de23001b",
  "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "const task-scheduler-for-the-whole-world = 1",
  "risk-assessment-for-the-quarterly-plan",
  "const apiKey = process.env.OPENAI_API_KEY;",
  "const token = getToken(user);",
  "MAX_TOKENS=100000000",
  "export API_KEY=$OPENAI_API_KEY",
  "the bearer of responsibilities was here",
  "import { useState } from 'react'; function App() { return <div className=\"sk-container\" /> }",
  "https://github.com/user/repo/blob/main/src/index.ts?plain=1",
  "password: string; // field type",
  "def tokenize(text: str) -> list[str]:",
  "AKIA is a prefix but AKIASHORT is not a key",
  "eyJ alone is not a token",
  "uuid 123e4567-e89b-12d3-a456-426614174000",
  "/Users/dev/code/sk-tools/README.md",
  "npm install @anthropic-ai/sdk",
  "SECRET_LENGTH=32",
  "the token is required here",
  "pat the dog: good boy",
  "password: process.env.DB_PASSWORD",
  "max tokens: 4096",
  'password = os.environ["DB_PASSWORD"]',
  "token: 2048",
  "input_token: 1200 output_token: 300",
  "authorization: required",
  "Set the Cookie: header to keep the session",
  "redis://localhost:6379/0",
  "from huggingface_hub import hf_hub_download",
  "SG.Net version 2 is out",
  "the dapi folder",
  "machine api.test login demo password $NETRC_PASSWORD",
  'headers["Authorization"] = `Bearer ${token}`',
  "client_secret: config.secret2",
  "access_token: getToken(user1)",
  "DB_PASSWORD = ${DB_PASSWORD_V2}",
  `client-certificate-data: ${ENCODED_CERT}`,
  `integrity sha512-${fill(B64, 86)}==`,
];

describe("redact: secrets", () => {
  for (const [name, input, kind] of positives) {
    it(`redacts ${name}`, () => {
      const out = r.string(input);
      assert.ok(out.includes(`[redacted:${kind}]`), `${out}`);
    });
  }

  it("redacts dotted GitLab token suffixes and prose secrets whole", () => {
    assert.equal(r.string("glpat-AbCdEfGhIjKlMnOpQrStU1.01.abcdefghi done"), "[redacted:gitlab-token] done");
    assert.equal(r.string("PAT here ya go: abcD3f-ghiJkl-mnoPqr thanks"), "PAT here ya go: [redacted:prose-secret] thanks");
  });

  it("keeps the structure around a redacted value", () => {
    assert.equal(r.string("postgres://admin:pw123456@db:5432/x"), "postgres://admin:[redacted:password]@db:5432/x");
    assert.equal(r.string("Authorization: Bearer abc123def456ghi789jkl"), "Authorization: Bearer [redacted:bearer]");
    assert.equal(r.string("export GITHUB_TOKEN=abcdef123456"), "export GITHUB_TOKEN=[redacted:secret-assignment]");
    assert.equal(r.string("?token=abc&x=1"), "?token=[redacted:url-secret]&x=1");
  });

  it("keeps the name, scheme and separators around a value the wider rules replace", () => {
    assert.equal(r.string("redis://:pw123456@cache:6379/0"), "redis://:[redacted:password]@cache:6379/0");
    assert.equal(r.string("Authorization: Token 0f3a9c7e21b5d8f4"), "Authorization: Token [redacted:auth-header]");
    assert.equal(r.string("Cookie: sid=a1b2c3d4; theme=dark"), "Cookie: [redacted:cookie]");
    assert.equal(r.string("?sv=2022-11-02&sig=Ab12Cd34%3D&se=1"), "?sv=2022-11-02&sig=[redacted:url-secret]&se=1");
    assert.equal(r.string('api_key = "Ak3jH5mN7pQ9"'), 'api_key = "[redacted:secret-value]"');
    assert.equal(r.string("DB_PASSWORD = Pw7kQ2mX9vL4"), "DB_PASSWORD = [redacted:secret-value]");
    assert.equal(r.string("machine h login u password Pw7kQ2mX9"), "machine h login u password [redacted:netrc]");
    assert.equal(r.string(`AccountKey=${fill(B64, 86)}==;EndpointSuffix=core.windows.net`), "AccountKey=[redacted:azure-storage-key];EndpointSuffix=core.windows.net");
  });

  it("redacts key data after a BEGIN line that starts in the dashes of the BEGIN line before it", () => {
    // The second BEGIN line starts at 22, on the first one's closing dashes.
    assert.equal(r.string(OVERLAPPING_BEGIN), `${OVERLAPPING_BEGIN.slice(0, 22)}[redacted:private-key]`);
  });

  it("keeps the kind of a vendor token after a secret name", () => {
    // Random-looking values: a made-up one (a run like 0123…) counts as placeholder-key instead.
    const anthropic = ["sk-", "ant-", "api03-", "Rq7Lm2Xv9Pz4Kw8Nt3Bc6Hd1Fg5Js0Ya7Ue2Wi9Oo4"].join("");
    const github = ["gh", "p_", "R4nd0mT0k3nV4lu3xQ9zLm2Wp8Ks5Yt7Hc1D"].join("");
    const cases: [string, string, string][] = [
      [`export ANTHROPIC_API_KEY=${anthropic}`, "export ANTHROPIC_API_KEY=[redacted:anthropic-key]", "anthropic-key"],
      [`GITHUB_TOKEN="${github}"`, 'GITHUB_TOKEN="[redacted:github-token]"', "github-token"],
      [`{"api_key": "${anthropic}"}`, '{"api_key": "[redacted:anthropic-key]"}', "anthropic-key"],
      [`https://api.test/v1?access_token=${github}&x=1`, "https://api.test/v1?access_token=[redacted:github-token]&x=1", "github-token"],
      [`https://x-access-token:${github}@git.test/r.git`, "https://x-access-token:[redacted:github-token]@git.test/r.git", "github-token"],
    ];
    for (const [input, out, kind] of cases) {
      const tally = redactionTally();
      assert.equal(r.string(input, tally), out);
      assert.deepEqual(tally.kinds, { [kind]: 1 });
    }
    // A value that goes on past the token is still replaced whole.
    assert.equal(r.string(`ANTHROPIC_API_KEY=${anthropic}\\n${anthropic}`), "ANTHROPIC_API_KEY=[redacted:secret-assignment]");
  });

  for (const s of negatives) {
    it(`leaves ${JSON.stringify(s.slice(0, 50))} alone`, () => {
      assert.equal(r.string(s), s);
    });
  }

  it("deep-redacts nested values and secret-named keys without mutating input", () => {
    const input = {
      command: "curl -H 'Authorization: Bearer abc123def456ghi789jkl' https://x",
      headers: { authorization: "Basic dXNlcjpwYXNz", "x-api-key": "plainvalue" },
      nested: [{ password: "hunter2" }, { text: "my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrSt" }],
      inputTokens: 12,
      pwd: "/home/u/project",
      token: "",
    };
    const copy = structuredClone(input);
    const out = r.value(input);
    assert.deepEqual(input, copy, "input not mutated");
    assert.equal(out.headers.authorization, "[redacted:secret-field]");
    assert.equal(out.headers["x-api-key"], "[redacted:secret-field]");
    assert.equal(out.nested[0]!.password, "[redacted:secret-field]");
    assert.match(out.nested[1]!.text!, /\[redacted:anthropic-key\]/);
    assert.match(out.command, /Bearer \[redacted:bearer\]/);
    assert.equal(out.inputTokens, 12);
    assert.equal(out.pwd, "/home/u/project", "pwd is a directory, not a password");
    assert.equal(out.token, "");
  });

  it("is idempotent", () => {
    const s = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx and password=abc12345 and Bearer abc123def456ghi789jkl";
    const once = r.string(s);
    assert.equal(r.string(once), once);
  });

  it("supports env and custom patterns, and rejects bad ones", () => {
    const er = createRedactor({ redact: ["env"], patterns: ["TICKET-\\d{4}"], env: { MY_SECRET: "verysecretvalue", HOME: "/home/u", SHORT_TOKEN: "abc" } });
    assert.equal(er.string("x verysecretvalue y TICKET-1234 /home/u abc"), "x [redacted:env] y [redacted:pattern] /home/u abc");
    assert.throws(() => createRedactor({ patterns: ["("] }), /redactPatterns\[0\] is not a valid regular expression/);
    assert.throws(() => createRedactor({ patterns: ["a*"] }), /matches the empty string/);
    assert.throws(() => createRedactor({ redact: ["nope"] }), /unknown redactor "nope"/);
  });

  // Gaps seen on real data (research queue RT-2). Literals are joined at run time.
  it("RT-2: a dotted GitLab token and a pasted PAT redact whole", () => {
    assert.equal(r.string(["glpat-", "AbCdEfGhIjKlMnOpQrStU1", ".01.abcdefghi"].join("")), "[redacted:gitlab-token]");
    assert.equal(r.string(["here is the PAT here ya go: ", "abcD3f-ghiJkl-mnoPqr"].join("")), "here is the PAT here ya go: [redacted:prose-secret]");
    assert.equal(r.string("the token is valid"), "the token is valid");
    assert.equal(r.string("key: value"), "key: value");
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.equal(r.string(`token ${sha}`), `token ${sha}`);
    assert.equal(r.string(`${sha} token`), `${sha} token`);
  });

  it("RT-2: env redaction leaves the cwd and other places, and still redacts a key", (t) => {
    const key = ["sk-", "proj-", "Xy7", "Qm2Lp9Rs4Tv8Wn3Kd6"].join("");
    const dir = mkdtempSync(join(tmpdir(), "csh-redact-env-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const er = createRedactor({
      redact: ["env"],
      env: { PWD: "/Users/x/proj", OLDPWD: "/Users/x/old-proj", SESSION_MANAGER: "local/host:@/tmp/.ICE-unix/1234", AUTH_CONFIG_DIR: "/etc/auth-config", SSH_AUTH_SOCK: "/private/tmp/launch-abc/Listeners", MY_SECRET_HOME: dir, OPENAI_API_KEY: key },
    });
    assert.equal(er.string("edit /Users/x/proj/src/a.ts"), "edit /Users/x/proj/src/a.ts");
    assert.equal(er.string("cd /Users/x/old-proj && ls /etc/auth-config /private/tmp/launch-abc/Listeners"), "cd /Users/x/old-proj && ls /etc/auth-config /private/tmp/launch-abc/Listeners");
    assert.equal(er.string(`ls ${dir}/a`), `ls ${dir}/a`, "a value that is an existing directory");
    assert.equal(er.string(`OPENAI=${key} at /Users/x/proj/src/a.ts`), "OPENAI=[redacted:env] at /Users/x/proj/src/a.ts");
  });

  it("names a secret attribute key whatever its case, and nothing else", () => {
    for (const key of ["db.password", "app.API.key", "http.request.header.Authorization", "X-API-KEY", "Set-Cookie", "PROXY-AUTHORIZATION", "client_secret", "GITHUB_TOKEN"]) {
      assert.equal(isSecretAttrKey(key), true, key);
    }
    // "to\u212Aen" has the Kelvin sign, which lower-cases to k but which an `i` regex without `u` does not match with k.
    for (const key of ["session_id", "max_tokens", "tokenizer", "keyboard", "to\u212Aen", "path", ""]) assert.equal(isSecretAttrKey(key), false, key);
  });

  it("redacts secret flag values in argv arrays", () => {
    const args = ["--model", "gpt-5", "--openai-api-key", "plainvalue", "--api-key=hunterhunter", "--anthropic-api-key", "x", "--db-password=p", "--token", "--yes", "-k", "kept", "--max-tokens", "100", "--api-key="];
    const want = ["--model", "gpt-5", "--openai-api-key", "[redacted:secret-flag]", "--api-key=[redacted:secret-flag]", "--anthropic-api-key", "[redacted:secret-flag]", "--db-password=[redacted:secret-flag]", "--token", "--yes", "-k", "kept", "--max-tokens", "100", "--api-key="];
    assert.deepEqual(redactArgv(args), want);
    assert.deepEqual(r.value({ args }), { args: want }, "the ingest redactor applies it to any array");
    assert.deepEqual(redactArgv(want), want, "idempotent");
    assert.equal(args[3], "plainvalue", "input not mutated");
  });

  it("redacts a large string quickly", () => {
    const line = "const x = 1; // normal code line with words and numbers 12345\n";
    assertLinear("1 MB of plain code", (n) => line.repeat(Math.ceil(n / line.length)), 1000, (input, out) => assert.equal(out, input));
  });
});

describe("redact: email", () => {
  const er = createRedactor({ redact: ["email"] });
  it("redacts email addresses, and only those", () => {
    assert.equal(er.string("mail jane.doe+ci@mail.example.co.uk or ops@corp.example.org."), "mail [redacted:email] or [redacted:email].");
    assert.equal(er.string("Author: Jane <JANE_D@Example.COM>"), "Author: Jane <[redacted:email]>");
    for (const keep of ["npm i zod@3.22.4", "npx @scope/pkg@latest", "icon@2x.png", "user@localhost", "a @ b.com", "@decorator.call()"]) assert.equal(er.string(keep), keep, keep);
  });

  it("is not in the secrets set; capture opts in with capture.redact", () => {
    assert.equal(r.string("jane@example.com"), "jane@example.com");
    assert.equal(createRedactor({ redact: ["secrets", "email"] }).string("jane@example.com sk-ant-api03-Zq8Jx2Lm4Np6Rt0Vw3Yb5Kd7Hf9Gs1Ce"), "[redacted:email] [redacted:anthropic-key]");
  });

  const rand = prng(7);
  for (const [name, make] of [
    ["address characters with no @", (n: number) => randomFrom(rand, `${ALNUM}._%+-`, n)],
    ["a@ repeated", (n: number) => "a@".repeat(n / 2)],
    ["a domain of single letters (x@a.a.a.…1)", (n: number) => `x@${"a.".repeat(n / 2)}1`],
  ] as const) {
    it(`redacts 1 MB of ${name} in linear time`, () => assertLinear(name, make, 500, undefined, er));
  }
});

describe("toMetadata", () => {
  it("keeps structure, numbers and tool names; drops content", () => {
    const e: AgentEvent = {
      id: "e1",
      v: 0,
      sessionId: "s",
      ts: 1,
      durationMs: 12,
      subagentId: "sub",
      agent: "claude-code",
      model: "m",
      kind: "tool.end",
      cwd: "/Users/dev/secret-project",
      repo: { root: "/Users/dev/secret-project", head: "abc", snapshot: "snap" },
      payload: { tool: "Bash", toolUseId: "tu", ok: false, durationMs: 5, output: "secret output", input: { command: "cat .env" }, exitCode: 1 },
      blobs: ["a".repeat(64)],
      usage: { inputTokens: 1, outputTokens: 2 },
      runId: "r",
    };
    const m = toMetadata(e);
    assert.deepEqual(m.payload, { tool: "Bash", toolUseId: "tu", ok: false, durationMs: 5, exitCode: 1 });
    assert.equal(m.cwd, undefined);
    assert.equal(m.blobs, undefined);
    assert.deepEqual(m.repo, { root: "", head: "abc", snapshot: "snap" });
    assert.deepEqual(m.usage, { inputTokens: 1, outputTokens: 2 });
    assert.equal(m.model, "m");
    assert.equal(m.durationMs, 12);
    assert.equal(m.subagentId, "sub");
    assert.equal(m.runId, "r");
    assert.deepEqual(toMetadata(m), m, "idempotent");
    const msg = toMetadata({ ...e, kind: "user.message", payload: { text: "my prompt" } });
    assert.deepEqual(msg.payload, {});
  });

  it("strips session titles and paths", () => {
    const s: Session = {
      id: "s",
      agent: "codex",
      title: "fix the auth bug in /secret",
      cwd: "/x",
      repo: { root: "/x", head: "h" },
      startedAt: 1,
      stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, memoryUse: [{ use: "read", path: "/secret/CLAUDE.md", ts: 1 }] },
      flags: ["compaction"],
      parent: { sessionId: "p" },
    };
    const m = sessionToMetadata(s);
    assert.equal(m.title, undefined);
    assert.equal(m.cwd, undefined);
    assert.equal(m.stats.memoryUse, undefined, "the paths of the memory files it used");
    assert.equal(s.stats.memoryUse?.length, 1, "input untouched");
    assert.deepEqual(m.repo, { root: "", head: "h" });
    assert.deepEqual(m.flags, ["compaction"]);
    assert.deepEqual(m.parent, { sessionId: "p" });
    assert.equal(s.title, "fix the auth bug in /secret", "input untouched");
  });
});

// ------------------------------------------------- linear time and equivalence

/** Deterministic PRNG (mulberry32) so generated inputs are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${LETTERS}0123456789`;

function randomFrom(rand: () => number, chars: string, n: number): string {
  let out = "";
  const chunk = new Array<number>(Math.min(n, 8192));
  for (let done = 0; done < n; done += chunk.length) {
    chunk.length = Math.min(chunk.length, n - done);
    for (let i = 0; i < chunk.length; i++) chunk[i] = chars.charCodeAt(Math.floor(rand() * chars.length));
    out += String.fromCharCode(...chunk);
  }
  return out;
}

describe("redact: linear time on long input", () => {
  // Before the rules were made linear, the 1 MB cases below took (Apple M-series,
  // extrapolated from 100 KB, all O(n²)): secret-field ~20-50 min on the first two,
  // password ~6-9 min on dotted runs, prose-secret ~3 min on "token:" repeats,
  // private-key ~14 s on unterminated BEGIN lines. Now each is a few tens of ms.
  const rand = prng(42);
  const cases: [string, (n: number) => string][] = [
    ["alphanumeric", (n) => randomFrom(rand, ALNUM, n)],
    ["[A-Za-z0-9_-]", (n) => randomFrom(rand, `${ALNUM}_-`, n)],
    ["'token: ' + letters", (n) => `token: ${randomFrom(rand, LETTERS, n)}`],
    ["'Bearer ' + letters", (n) => `Bearer ${randomFrom(rand, LETTERS, n)}`],
    ["'password is ' + letters", (n) => `password is ${randomFrom(rand, LETTERS, n)}`],
    ["'sk-' + letters and dashes", (n) => `sk-${randomFrom(rand, `${LETTERS}-`, n)}`],
    ["dotted words (a.a.a.…)", (n) => "a.".repeat(n / 2)],
    ["dashed words (sk-sk-…)", (n) => "sk-".repeat(Math.floor(n / 3))],
    ["repeated 'token:'", (n) => "token:".repeat(Math.floor(n / 6))],
    ["repeated 'password='", (n) => "password=".repeat(Math.floor(n / 9))],
    ["unterminated BEGIN PRIVATE KEY lines", (n) => "-----BEGIN PRIVATE KEY-----".repeat(Math.floor(n / 27))],
    ["repeated 'authorization: '", (n) => "authorization: ".repeat(Math.floor(n / 15))],
    ["'Cookie: ' + a run of 'a-'", (n) => `Cookie: ${"a-".repeat(Math.floor(n / 2))}`],
    ["repeated 'machine a login b password '", (n) => "machine a login b password ".repeat(Math.floor(n / 27))],
    ["repeated 'secret = '", (n) => "secret = ".repeat(Math.floor(n / 9))],
    ["'AccountKey=' + base64", (n) => `AccountKey=${randomFrom(rand, B64, n)}`],
    ["repeated base64 BEGIN", (n) => "LS0tLS1CRUdJTi".repeat(Math.floor(n / 14))],
  ];
  for (const [name, make] of cases) {
    it(`redacts 1 MB of ${name} in linear time (under 500 ms, else linear growth)`, () => assertLinear(name, make));
  }
});

describe("redact: same output as the original secret rules", () => {
  const check = (inputs: Iterable<string>): number => {
    let n = 0;
    for (const s of inputs) {
      assert.equal(r.string(s), originalSecretRedact(s), JSON.stringify(s));
      n++;
    }
    return n;
  };

  const handWritten = [
    ...positives.map(([, input]) => input),
    ...negatives,
    "glpat-AbCdEfGhIjKlMnOpQrStU1.01.abcdefghi done",
    "PAT here ya go: abcD3f-ghiJkl-mnoPqr thanks",
    "postgres://admin:pw123456@db:5432/x",
    "Authorization: Bearer abc123def456ghi789jkl",
    "export GITHUB_TOKEN=abcdef123456",
    "?token=abc&x=1",
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx and password=abc12345 and Bearer abc123def456ghi789jkl",
    "my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
    "Basic dXNlcjpwYXNz",
    "Authorization: Basic dXNlcjpwYXNz",
    `use sk-ant-api03-${"A".repeat(40)}`,
    `key vck_${"x".repeat(8)}TESTONLY${"y".repeat(16)} end`,
    "postgres://user:hunter2@db/x",
    `Bearer csh_ik_${"a1B2".repeat(10)}`,
    "const x = 1; // normal code line with words and numbers 12345\n".repeat(50),
    // Overlaps between rules and between candidate starts.
    'x-api-key: "abcdefgh12" and "my_client_secret": \'zzzzzzzz9\'',
    "access_token-access_token: 'a1b2c3d4e5'",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaatoken: \"abcdefghij\"",
    "1a://u:p@h -a://u:p@h a.b+c-d://user:pass@host x://:@ http://u:p:q@h/x",
    "token: token: token: abcdefgh1 password=password=abc12345x",
    "personal access token is ghijklmn0 pass phrase: correct horse battery9",
    "the api key is $NOT_A_VALUE and the secret is [placeholder1]",
    "secret is-abc12345 secret IS abc12345, token = 'abcdefg1'",
    "-----BEGIN PRIVATE KEY-----\na\n-----BEGIN PRIVATE KEY-----\nb\n-----END PRIVATE KEY-----END PRIVATE KEY-----",
    "-----END PRIVATE KEY----- -----BEGIN EC PRIVATE KEY-----\nxyz\n-----END EC PRIVATE KEY BLOCK-----tail",
    OVERLAPPING_BEGIN,
  ];

  it("on the hand-written redaction examples", () => {
    check(handWritten);
    // Pairs, so one example's tail runs into the next one's head.
    const joined: string[] = [];
    for (const a of handWritten) for (const b of handWritten.slice(0, 20)) joined.push(`${a}${b}`, `${a} ${b}`, `${a}:${b}`);
    check(joined);
  });

  it("on every line of the test fixtures", () => {
    const root = join(import.meta.dirname, "..", "fixtures");
    const lines: string[] = [];
    const walkDir = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name);
        if (ent.isDirectory()) walkDir(path);
        else if (!ent.name.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          lines.push(text, ...text.split("\n"));
        }
      }
    };
    walkDir(root);
    assert.ok(check(lines) > 100);
  });

  // Atoms that hit every rule's prefix, separators and value shapes, plus
  // characters whose case folding or whitespace class could trip a hand-written
  // matcher (ſ, K, İ, NBSP, U+2028).
  const common = [" ", "  ", "\t", "\n", "\u00a0", "\u2028", '"', "'", "`", ",", ";", ")", "(", "[", "]", "$", ":", "=", "@", "/", "?", "&", "#", ".", "-", "_", "+", "~", "ſ", "K", "İ", "0", "7", "a", "Z"];
  const values = ["abc", "abcdefgh", "abcdefghij", "12345678", "a1b2c3d4", "hunter22", "Ab12Cd34Ef56Gh78Ij90Kl12", "0123456789abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOP", "dXNlcjpwYXNz", "x".repeat(40)];
  const families: Record<string, string[]> = {
    vendor: ["sk-", "sk-ant-", "sk-proj-", "ghp_", "gho_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "AKIA", "ASIA", "AIza", "sk_live_", "rk_test_", "npm_", "csh_ik_", "csh_rk_", "vck_", "eyJ", "eyJhbGciOiJIUzI1NiJ9.", "https://hooks.slack.com/services/", ".", "-", "_"],
    // The other vendor formats, by prefix, and the start of an Azure connection string's key.
    formats: ["hf_", "gsk_", "r8_", "xai-", "pplx-", "ya29.", "GOCSPX-", "SG.", "dop_v1_", "shpat_", "pypi-AgE", "dckr_pat_", "lin_api_", "hvs.", "whsec_", "ATATT3", "dapi", "AGE-SECRET-KEY-1", "PMAK-", "sntrys_", "pcsk_", "lsv2_pt_", "tvly-", "nvapi-", "glsa_", "glc_", "figd_", "gldt-", "glrt-", "xapp-1-", "AccountKey=", ";", ".", "-", "_"],
    headers: ["Bearer ", "bearer\t", "Bearer\n", "Authorization: Basic ", "authorization:basic  ", "Authorization: Bearer ", "=", "==", "/", "+", "~", "Authorization: Token ", "authorization: ", '"Authorization": "', "Proxy-Authorization: ", "ApiKey ", "Cookie: ", "Set-Cookie: ", "cookie:", "sid=", "; "],
    urls: ["https://", "postgres://", "a+b.c-d://", "-x://", "1a://", "x.", "a-", "://", "u:", ":", "@", "@h", "/", "?", "&", "#", "?password=", "&access_token=", "?client-secret=", "&my_api_key=", "?x_token=", "<", ">", "redis://:", "&sig=", "?X-Amz-Signature=", "&signature="],
    env: ["export ", "MY_API_KEY=", "DB_PASSWORD=\"", "GITHUB_TOKEN='", "AWS_ACCESS_KEY_ID=", "CREDENTIALS=", "SECRET_KEY=", "MAX_TOKENS=", "API_KEY=$", "TOKEN=", "_", "|", "&", ";"],
    fields: ['"api_key": "', "'client_secret': '", 'x-api-key: "', "token:'", 'password : "', "secret_key", "access-token", "my_", "x-", "Xtoken", '"', "'", ": ", ":", "DB_PASSWORD = ", "client_secret: ", 'api_key = "', "X-Api-Key: ", "secret=", "token = "],
    netrc: ["machine ", "machine api.test", " login ", "login demo", " password ", "password ", "default login ", "default", "\n  ", " ", "$"],
    prose: ["token", "TOKEN", "PAT", "pat", "personal access token", "password", "passwd", "passcode", "pass phrase", "passphrase", "api key", "api_key", "API-KEY", "apikey", "secret", "is", " is ", "IS", "iS ", "is-", "here ya go", ": ", "="],
    // A BEGIN line in base64 is built here, so no BEGIN line sits in this file.
    pem: ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\n", "-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", "-----END ", "-----BEGIN ", "PRIVATE KEY", " BLOCK", "-----", "RSA ", "EC ", "MIIEow\n", Buffer.from(["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")).toString("base64"), "LS0tLS1CRUdJTi"],
    // Upper- and mixed-case text for the rules that ignore case, "BEARER " for one that does not, and
    // words with \u017F (long s) and \u212A (Kelvin sign), which only a `u` regex matches with s and k.
    case: ["AUTHORIZATION: BASIC ", "Authorization:basic ", "BEARER ", "?PASSWORD=", "&Api_Key=", "?ACCESS-TOKEN=", "&X_SECRET=", '"API_KEY": "', "'Client_Secret': '", '"PassWord" : "', "TOKEN: ", "Token is ", "PASSPHRASE: ", "Personal Access Token: ", "API KEY = ", "SECRET IS ", "Pat: ", "pa\u017F\u017Fword: ", "to\u212Aen: ", "\u212Aey=", "AUTHORIZATION: TOKEN ", "COOKIE: ", "&SIG=", "Machine ", "PASSWORD = ", "accountkey="],
  };
  const all = Object.values(families).flat();

  function corpus(seed: number, atoms: string[], count: number): string[] {
    const rand = prng(seed);
    const pick = (xs: string[]): string => xs[Math.floor(rand() * xs.length)]!;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const parts: string[] = [];
      const len = 1 + Math.floor(rand() * 24);
      for (let j = 0; j < len; j++) {
        const x = rand();
        parts.push(x < 0.55 ? pick(atoms) : x < 0.75 ? pick(values) : x < 0.9 ? pick(common) : randomFrom(rand, `${ALNUM}_-.:=/@ "'`, 1 + Math.floor(rand() * 10)));
      }
      out.push(parts.join(""));
    }
    return out;
  }

  for (const [i, [name, atoms]] of Object.entries(families).entries()) {
    it(`on a generated corpus around ${name} rules`, () => {
      check(corpus(1000 + i, atoms, 5000));
    });
  }
  it("on a generated corpus mixing every rule", () => {
    check(corpus(7, all, 20_000));
  });

  it("runs each rule on every string it can match: each match holds one of the rule's needles", () => {
    const npm = ["npm_", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
    const webhook = ["https://hooks.slack.com/services/", "abcdefghijklmnopqrstuvwxyz"].join("");
    const inputs = [...handWritten, npm, webhook, ...corpus(11, all, 20_000)];
    for (const rule of secretRules()) {
      const need = SECRET_NEEDLES[rule.kind];
      assert.ok(need, `${rule.kind} has needles`);
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let matches = 0;
      for (const s of inputs) {
        for (const m of s.matchAll(re)) {
          const text = need.fold ? m[0].toLowerCase() : m[0];
          assert.ok(need.any.some((n) => text.includes(n)), `${rule.kind} matched ${JSON.stringify(m[0])}, which holds none of ${JSON.stringify(need.any)}`);
          matches++;
        }
      }
      assert.ok(matches > 0, `${rule.kind} matched none of the inputs`);
    }
  });

  it("finds each needle by the two ASCII characters it starts with", () => {
    // One pass over a text looks needles up by their first two characters; a rule with a needle
    // that does not start with two ASCII characters would run on every text.
    for (const [kind, need] of Object.entries(SECRET_NEEDLES)) {
      for (const n of need.any) assert.match(n, /^[\x00-\x7f]{2}/, `${kind}: ${JSON.stringify(n)}`);
    }
  });

  it("keeps each rule's needles when a redactor's rules change", () => {
    const gh = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const aws = ["AK", "IA", "Q3EGRIX7ZLBM2NWD"].join("");
    const red = createRedactor();
    const rules = red.rules as RedactRule[];
    // The rules after the one taken out move up a place.
    rules.splice(rules.findIndex((x) => x.kind === "github-token"), 1);
    assert.equal(red.string(`${gh} ${aws}`), `${gh} [redacted:aws-access-key]`);
    assert.equal(redactBlobValue(red, { a: [aws] }, redactionTally()), '{"a":["[redacted:aws-access-key]"]}');
    rules.push({ kind: "pattern", pattern: /zzz+/g });
    assert.equal(red.string(`${aws} zzzz`), "[redacted:aws-access-key] [redacted:pattern]");
  });

  it("checks a text's needles again after a rule's callback redacts another text", () => {
    const gh = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const red = createRedactor();
    const rules = red.rules as RedactRule[];
    // The first rule has needles: the text is checked for them before the rule below runs.
    assert.ok(SECRET_NEEDLES[rules[0]!.kind]);
    // No needles, so it runs on every text. Its callback redacts another text with the same token.
    rules.splice(1, 0, {
      kind: "probe",
      pattern: /PROBE/g,
      replace: (m) => {
        red.string(`other ${gh}`);
        return m;
      },
    });
    red.string("warm up"); // takes in the changed rules
    assert.equal(red.string(`PROBE ${gh}`), "PROBE [redacted:github-token]");
  });

  it("checks the text a rule wrote for the needles of the rules after it", () => {
    const gh = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const red = createRedactor();
    const rules = red.rules as RedactRule[];
    assert.ok(SECRET_NEEDLES[rules[0]!.kind]);
    rules.splice(1, 0, { kind: "expand", pattern: /EXPANDME/g, replace: () => gh });
    red.string("warm up"); // takes in the changed rules
    assert.equal(red.string("EXPANDME"), "[redacted:github-token]");
  });

  it("runs every rule after one that changed a string, whatever the payload's text held", () => {
    const secret = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");
    const red = createRedactor();
    const rules = red.rules as RedactRule[];
    // The rule that finds this value has a needle in the string, and none in the payload's text.
    rules.unshift({ kind: "expand", pattern: /EXPANDME/g, replace: () => `api_token\t=\t${secret}` });
    const out = redactBlobValue(red, { a: "EXPANDME" }, redactionTally());
    assert.equal(out, JSON.stringify({ a: "api_token\t=\t[redacted:secret-value]" }));
  });
});
