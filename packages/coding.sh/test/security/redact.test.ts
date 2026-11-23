// Redaction holds for the formats and places it covers: each secret format is replaced
// under its kind and the hook's gate lets it through to the rules, a vendor token keeps
// its kind after a secret name, a JSON document inside a string stays a document and
// has its keys redacted at every depth, text that only looks like a secret is left as
// it is, and from the hook to the index no secret is written. Every value here is made
// up at run time, so the source holds no key-shaped literal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { Adapter } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createRedactor, HIGH_CONFIDENCE_KINDS, redactionTally } from "../../src/core/redact.ts";
import { exposesSecret } from "../../src/core/redaction-stats.ts";
import { mayHoldSecret } from "../../src/spool/gate.ts";
import { redactPayload } from "../../src/spool/redact.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { PKG_ROOT, tsNodeArgs } from "../capture/_helpers.ts";

const J = (...parts: string[]): string => parts.join("");
let seed = 20261122;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const B64 = `${AN}+/`;
const URLB64 = `${AN}-_`;
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** A hand-written password: letters and digits, starting with letters. */
const pw = (n = 12): string => J("Pw", pick(AN, n), "9");

/** True when some 10-character run of letters and digits from `secret` is still in `out`. */
function kept(out: string, secret: string): boolean {
  for (let i = 0; i + 10 <= secret.length; i++) {
    const run = secret.slice(i, i + 10);
    if (/^[A-Za-z0-9]{10}$/.test(run) && out.includes(run)) return true;
  }
  return false;
}

const r = createRedactor();

/** [kind, text before, the secret, text after] */
const FORMATS: [string, string, string, string?][] = [
  ["huggingface-token", "", J("h", "f_", pick(AN, 34))],
  ["groq-key", "", J("gs", "k_", pick(AN, 52))],
  ["replicate-token", "", J("r", "8_", pick(AN, 37))],
  ["xai-key", "", J("xa", "i-", pick(AN, 80))],
  ["perplexity-key", "", J("ppl", "x-", pick(AN, 48))],
  ["google-oauth-token", "", J("ya", "29.", pick(URLB64, 120))],
  ["google-oauth-secret", "", J("GOC", "SPX-", pick(URLB64, 28))],
  ["sendgrid-key", "", J("S", "G.", pick(URLB64, 22), ".", pick(URLB64, 43))],
  ["digitalocean-token", "", J("do", "p_v1_", pick(HEX, 64))],
  ["shopify-token", "", J("shp", "at_", pick(HEX, 32))],
  ["pypi-token", "", J("py", "pi-AgE", pick(URLB64, 70))],
  ["docker-token", "", J("dck", "r_pat_", pick(URLB64, 27))],
  ["linear-key", "", J("lin", "_api_", pick(AN, 40))],
  ["vault-token", "", J("hv", "s.", pick(URLB64, 40), "7", pick(URLB64, 40))],
  ["stripe-webhook-secret", "", J("whs", "ec_", pick(AN, 32))],
  ["slack-token", "", J("xa", "pp-1-A0", pick(UP, 9), "-", pick("0123456789", 13), "-", pick(HEX, 64))],
  ["atlassian-token", "", J("ATA", "TT3", pick(URLB64, 170))],
  ["databricks-token", "", J("da", "pi", pick(HEX, 32))],
  ["age-secret-key", "", J("AGE-SEC", "RET-KEY-1", pick("QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58))],
  ["postman-key", "", J("PM", "AK-", pick(HEX, 24), "-", pick(HEX, 34))],
  ["sentry-token", "", J("sntr", "ys_", pick(B64, 60))],
  ["pinecone-key", "", J("pcs", "k_", pick(AN, 6), "_", pick(AN, 60))],
  ["langsmith-key", "", J("lsv", "2_pt_", pick(HEX, 32), "_", pick(HEX, 10))],
  ["tavily-key", "", J("tvl", "y-", pick(AN, 32))],
  ["nvidia-key", "", J("nva", "pi-", pick(URLB64, 64))],
  ["grafana-token", "", J("gls", "a_", pick(AN, 32), "_", pick(HEX, 8))],
  ["figma-token", "", J("fig", "d_", pick(URLB64, 40))],
  ["gitlab-token", "", J("gl", "dt-", pick(URLB64, 20))],
  ["gitlab-token", "", J("gl", "rt-", pick(URLB64, 20))],
  ["azure-storage-key", "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=", J(pick(B64, 86), "=="), ";EndpointSuffix=core.windows.net"],
  ["encoded-private-key", "    client-key-data: ", Buffer.from(J("-----BEG", "IN RSA PRIV", "ATE KEY-----\n", pick(B64, 64))).toString("base64")],
  ["auth-header", "Authorization: Token ", pick(HEX, 40)],
  ["auth-header", "Authorization: ApiKey ", pick(AN, 40)],
  ["auth-header", "Authorization: ", pick(AN, 40)],
  ["cookie", "Cookie: sessionid=", pick(AN, 32), "; csrftoken=x"],
  ["cookie", "Set-Cookie: sid=", pick(AN, 32), "; Path=/; HttpOnly"],
  ["password", "redis://:", J("Pw", pick(AN, 14)), "@cache.internal:6379/0"],
  ["url-secret", "https://demo.blob.core.windows.net/c/f.txt?sv=2022-11-02&ss=b&sig=", J(pick(AN, 40), "%3D")],
  ["url-secret", "https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=", pick(HEX, 64)],
  ["url-secret", "https://storage.googleapis.com/b/o?X-Goog-Signature=", pick(HEX, 128)],
  ["netrc", "machine api.example.invalid login demo password ", pw()],
  ["secret-value", "DB_PASSWORD = ", pw()],
  ["secret-value", "client_secret: ", J("Cs", pick(AN, 30))],
  ["secret-value", "secret_key: ", J("Sk", pick(AN, 30), "7")],
  // Which rule takes a value depends on its quotes and separator: unquoted with a digit after a
  // plain secret word, prose-secret; quoted after ":", secret-field; quoted after "=", secret-value.
  ["prose-secret", "password: ", pw()],
  ["secret-field", 'password: "', pw(), '"'],
  ["secret-value", 'api_key = "', J("Ak", pick(AN, 30)), '"'],
  ["secret-value", 'token = "', J("Tk", pick(AN, 30)), '"'],
  ["prose-secret", "X-Api-Key: ", J(pick(AN, 31), "4")],
  ["secret-field", "x-api-key: '", J(pick(AN, 31), "4"), "'"],
  ["prose-secret", "Server=tcp:db;Database=app;User Id=app;Password=", J(pw(), "1"), ";"],
  ["secret-value", "Server=tcp:db;Database=app;User Id=app;Password='", J(pw(), "1"), "';"],
  ["secret-value", "aws_secret_access_key = ", pick(B64, 40)],
  ["secret-value", "secretAccessKey: ", pick(B64, 40)],
];

describe("secret formats", () => {
  for (const [kind, before, secret, afterText = ""] of FORMATS) {
    const text = before + secret + afterText;
    it(`${kind}: ${JSON.stringify(before || secret.slice(0, 6))} is replaced, and the gate passes it to the rules`, () => {
      const tally = redactionTally();
      const out = r.string(text, tally);
      assert.ok(!kept(out, secret), `the value is still in ${JSON.stringify(out)}`);
      assert.ok(out.includes(`[redacted:${kind}]`), `${kind} in ${JSON.stringify(out)}`);
      assert.ok(mayHoldSecret(JSON.stringify({ text })), "the gate would write the payload unredacted");
      // Inside a JSON document inside a string, as a tool result holds one.
      const nested = { tool_response: { stdout: JSON.stringify({ out: `x\n${text}\ny` }, null, 2) } };
      const clean = redactPayload(r, nested, redactionTally()) as typeof nested;
      assert.ok(!kept(JSON.stringify(clean), secret));
      assert.ok(JSON.parse(clean.tool_response.stdout), "the document still parses");
    });
  }

  it("every vendor kind tags the session as exposing a secret, and the Azure key does not", () => {
    for (const [kind] of FORMATS) {
      const vendor = !["azure-storage-key", "encoded-private-key", "auth-header", "cookie", "password", "url-secret", "netrc", "secret-value", "prose-secret", "secret-field"].includes(kind);
      assert.equal(exposesSecret({ [kind]: 1 }), vendor, kind);
    }
  });
});

describe("private keys", () => {
  const begin = (label: string): string => J("-----BEG", "IN ", label, " KEY-----");
  const data = pick(B64, 64);
  const cases: [string, string][] = [
    ["a block with its END line", [begin("RSA PRIVATE"), data, J("-----EN", "D RSA PRIVATE KEY-----")].join("\n")],
    ["a block cut before its END line", ["log:", begin("OPENSSH PRIVATE"), data].join("\n")],
    ["a BEGIN line that starts in the closing dashes of the one before it", J(begin("PRIVATE"), "BEG", "IN PRIVATE KEY-----", data)],
    ["a BEGIN line after one in prose", ["see", begin("EC PRIVATE"), "above", begin("EC PRIVATE"), data].join("\n")],
  ];
  for (const [name, text] of cases) {
    it(`${name}: the key data is replaced`, () => {
      const tally = redactionTally();
      const out = r.string(text, tally);
      assert.ok(!kept(out, data), out);
      assert.deepEqual(tally.kinds, { "private-key": 1 });
      assert.ok(mayHoldSecret(JSON.stringify({ text })));
    });
  }
});

describe("a vendor token after a secret name keeps its kind", () => {
  const anthropic = J("sk-", "ant-", "api03-", pick(URLB64, 93), "AA");
  const github = J("gh", "p_", pick(AN, 36));
  const cases: [string, string, string][] = [
    ["anthropic-key", `export ANTHROPIC_API_KEY=${anthropic}`, anthropic],
    ["anthropic-key", `ANTHROPIC_API_KEY="${anthropic}"`, anthropic],
    ["github-token", `GITHUB_TOKEN=${github}`, github],
    ["anthropic-key", JSON.stringify({ api_key: anthropic }), anthropic],
    ["github-token", `token = "${github}"`, github],
    ["github-token", `https://example.invalid/?token=${github}`, github],
    ["github-token", `https://x-access-token:${github}@example.invalid/demo/repo.git`, github],
  ];
  for (const [kind, text, secret] of cases) {
    it(JSON.stringify(text.replace(secret, "…")), () => {
      const tally = redactionTally();
      const out = r.string(text, tally);
      assert.ok(!out.includes(secret));
      assert.deepEqual(tally.kinds, { [kind]: 1 });
      assert.ok(HIGH_CONFIDENCE_KINDS.has(kind) && exposesSecret(tally.kinds));
    });
  }

  it("the rest of a value split after the token is still replaced", () => {
    const text = `export ANTHROPIC_API_KEY=${anthropic.slice(0, 40)}\\n${anthropic.slice(40)}`;
    const out = r.string(text);
    assert.ok(!kept(out, anthropic.slice(40)), out);
  });
});

describe("JSON documents inside strings", () => {
  const short = J("hun", "ter");
  const value = J("Xk3", pick(AN, 21));
  // Text a rule replaces up to a quote, next to a value only the document's key shows to be secret.
  const neighbors = [
    `see https://example.invalid/a?token=${value}`,
    `the password is ${value}`,
    `export API_TOKEN=${value}`,
    `Authorization: Token ${value}`,
    `Cookie: sid=${value}`,
    `client_secret: ${value}`,
  ];
  for (const text of neighbors) {
    it(`two levels down, next to ${JSON.stringify(text.replace(value, "…"))}: every value is replaced and counted once`, () => {
      const inner = JSON.stringify({ password: short, log: text });
      const payload = { tool_response: { stdout: JSON.stringify({ content: inner }) } };
      const tally = redactionTally();
      const out = JSON.stringify(redactPayload(r, payload, tally));
      assert.ok(!out.includes(short) && !out.includes(value), out);
      assert.equal(tally.kinds["secret-field"], 1);
      assert.equal(Object.values(tally.kinds).reduce((a, b) => a + b, 0), 2, JSON.stringify(tally.kinds));
    });
  }

  it("a document with nothing more to redact inside keeps its text", () => {
    const doc = JSON.stringify({ log: `see https://example.invalid/a?token=${value}` }, null, 2);
    const tally = redactionTally();
    const out = redactPayload(r, { doc }, tally) as { doc: string };
    assert.equal(out.doc, doc.replace(value, "[redacted:url-secret]"));
    assert.deepEqual(tally.kinds, { "url-secret": 1 });
  });
});

describe("text that only looks like a secret", () => {
  const LOOKALIKES = [
    pick(HEX, 40),
    "123e4567-e89b-12d3-a456-426614174000",
    J("integrity sha512-", pick(B64, 86), "=="),
    J('"integrity": "sha512-', pick(B64, 86), '=="'),
    J("data:image/png;base64,iVBORw0KGgo", pick(B64, 200)),
    J("sha256:", pick(HEX, 64)),
    "the tokenizer splits text into tokens: 12345 tokens total",
    "MAX_TOKENS=4096",
    "password: string",
    "https://github.com/demo/repo.git",
    "ssh://git@github.com:22/demo/repo.git",
    "left-pad@1.3.0 lodash@4.17.21",
    "from huggingface_hub import hf_hub_download",
    "the dapi folder",
    "SG.Net version 2 is out",
    "tokens start with ya29. in Google",
    "redis://localhost:6379/0",
    "Set the Cookie: header to keep the session",
    "Authorization: required",
    'password = os.environ["DB_PASSWORD"]',
    "token: 2048",
    "input_token: 1200 output_token: 300",
    'headers["Authorization"] = `Bearer ${token}`',
    "Authorization: Bearer $TOKEN",
    "DB_PASSWORD = ${DB_PASSWORD}",
    "api_key: <your key here>",
  ];
  for (const text of LOOKALIKES) {
    it(JSON.stringify(text.slice(0, 50)), () => assert.equal(r.string(text), text));
  }
});

describe("from the hook to the index", () => {
  const roots: string[] = [];
  after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("no spool file, event or blob holds a secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-sec-redact-"));
    roots.push(root);
    const h = join(root, "home");
    const env = { CODING_SH_HOME: h, HOME: join(root, "user"), USERPROFILE: join(root, "user"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
    const secrets = [FORMATS[0]![2], FORMATS[30]![2], pw(), J("hun", "ter")];
    const doc = JSON.stringify({ content: JSON.stringify({ password: secrets[3], log: `DB_PASSWORD = ${secrets[2]}` }) });
    const input = JSON.stringify({ session: "sec-1", text: `hf ${secrets[0]} kube ${FORMATS[30]![1]}${secrets[1]}`, doc });
    const res = spawnSync(process.execPath, [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts"), "fake", "UserPromptSubmit"], { input, env: { ...env, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    const files = readdirSync(h, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
    assert.ok(files.some((f) => f.endsWith(".jsonl")), "the hook wrote a spool line");
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const s of secrets) assert.ok(!text.includes(s), `${f} holds a secret`);
    }

    const fake: Adapter = {
      id: "fake",
      displayName: "Fake",
      tier: "A",
      detect: async () => ({ installed: true, hooked: true }),
      install: async () => [],
      uninstall: async () => [],
      async normalize(line, ctx) {
        const raw = line.raw as { session: string; text: string; doc: string };
        const e: AgentEvent = { id: ctx.id(line.agent, raw.session, line.event), v: 0, sessionId: raw.session, ts: 1, agent: line.agent, kind: "user.message", cwd: line.cwd, payload: { text: raw.text, doc: raw.doc } };
        return [e];
      },
    };
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const done = await ingest({ config: defaultConfig(env), index, blobs, adapters: new Map([["fake", fake]]), env, lock: false });
    assert.deepEqual([done.errors, done.events], [[], 1]);
    const stored = JSON.stringify(await index.listEvents("sec-1"));
    for (const s of secrets) assert.ok(!stored.includes(s), "an event holds a secret");
    assert.match(stored, /\[redacted:huggingface-token\]/);
    assert.match(stored, /\[redacted:encoded-private-key\]/);
  });
});
