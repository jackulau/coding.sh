import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { createRedactor, sessionToMetadata, toMetadata } from "../../src/core/redact.ts";
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
function assertLinear(label: string, make: (n: number) => string, budgetMs = 500, check?: (input: string, out: string) => void): void {
  const MB = 1 << 20;
  const input = make(MB);
  let out = "";
  const ms = timeMs(() => (out = r.string(input)));
  check?.(input, out);
  if (ms < budgetMs) return;
  assert.ok(ms < 10_000, `${label}: ${ms.toFixed(0)} ms for 1 MB`);
  const quarter = make(MB / 4);
  const small: number[] = [];
  const big: number[] = [];
  for (let i = 0; i < 3; i++) {
    small.push(timeMs(() => r.string(quarter)));
    big.push(timeMs(() => r.string(input)));
  }
  const growth = median(big) / Math.max(median(small), 0.01);
  assert.ok(growth < 8, `${label}: ${median(small).toFixed(1)} ms at 256 KB, ${median(big).toFixed(1)} ms at 1 MB (${growth.toFixed(1)}x; linear is ~4x, O(n²) ~16x)`);
}

const positives: [string, string, string][] = [
  ["anthropic", "key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc", "anthropic-key"],
  ["openai", "OPENAI sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34", "openai-key"],
  ["openai classic", "use sk-1234567890abcdefghijklmnopqrstuv now", "openai-key"],
  ["github classic", "token ghp_0123456789abcdefghijABCDEFGHIJ012345", "github-token"],
  ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "github-token"],
  ["gitlab", "glpat-abcdefghij0123456789", "gitlab-token"],
  ["prose PAT", "here is the PAT here ya go: abcD3f-ghiJkl-mnoPqr", "prose-secret"],
  ["prose password", "the password is hunter22x", "prose-secret"],
  ["slack bot", "xoxb-1234567890-0987654321-AbCdEfGh", "slack-token"],
  ["slack user", "xoxp-1234567890-abcdef", "slack-token"],
  ["aws access key", "aws_access_key_id AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
  ["google", "AIzaSyA-1234567890abcdefghijklmnopqrstu", "google-api-key"],
  ["stripe", "sk_live_51H8abcdefghijklmnop", "stripe-key"],
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
  "/Users/jack/code/sk-tools/README.md",
  "npm install @anthropic-ai/sdk",
  "SECRET_LENGTH=32",
  "the token is required here",
  "pat the dog: good boy",
  "password: process.env.DB_PASSWORD",
  "max tokens: 4096",
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

  it("redacts a large string quickly", () => {
    const line = "const x = 1; // normal code line with words and numbers 12345\n";
    assertLinear("1 MB of plain code", (n) => line.repeat(Math.ceil(n / line.length)), 1000, (input, out) => assert.equal(out, input));
  });
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
      cwd: "/Users/jack/secret-project",
      repo: { root: "/Users/jack/secret-project", head: "abc", snapshot: "snap" },
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
      stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
      flags: ["compaction"],
      parent: { sessionId: "p" },
    };
    const m = sessionToMetadata(s);
    assert.equal(m.title, undefined);
    assert.equal(m.cwd, undefined);
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
    headers: ["Bearer ", "bearer\t", "Bearer\n", "Authorization: Basic ", "authorization:basic  ", "Authorization: Bearer ", "=", "==", "/", "+", "~"],
    urls: ["https://", "postgres://", "a+b.c-d://", "-x://", "1a://", "x.", "a-", "://", "u:", ":", "@", "@h", "/", "?", "&", "#", "?password=", "&access_token=", "?client-secret=", "&my_api_key=", "?x_token=", "<", ">"],
    env: ["export ", "MY_API_KEY=", "DB_PASSWORD=\"", "GITHUB_TOKEN='", "AWS_ACCESS_KEY_ID=", "CREDENTIALS=", "SECRET_KEY=", "MAX_TOKENS=", "API_KEY=$", "TOKEN=", "_", "|", "&", ";"],
    fields: ['"api_key": "', "'client_secret': '", 'x-api-key: "', "token:'", 'password : "', "secret_key", "access-token", "my_", "x-", "Xtoken", '"', "'", ": ", ":"],
    prose: ["token", "TOKEN", "PAT", "pat", "personal access token", "password", "passwd", "passcode", "pass phrase", "passphrase", "api key", "api_key", "API-KEY", "apikey", "secret", "is", " is ", "IS", "iS ", "is-", "here ya go", ": ", "="],
    pem: ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\n", "-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", "-----END ", "-----BEGIN ", "PRIVATE KEY", " BLOCK", "-----", "RSA ", "EC ", "MIIEow\n"],
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
});
