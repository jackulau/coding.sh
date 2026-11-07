import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { createRedactor, sessionToMetadata, toMetadata } from "../../src/core/redact.ts";

const r = createRedactor({ redact: ["secrets"] });

describe("redact: secrets", () => {
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
    const er = createRedactor({ redact: ["env"], patterns: ["ACME-\\d{4}"], env: { MY_SECRET: "verysecretvalue", HOME: "/home/u", SHORT_TOKEN: "abc" } });
    assert.equal(er.string("x verysecretvalue y ACME-1234 /home/u abc"), "x [redacted:env] y [redacted:pattern] /home/u abc");
    assert.throws(() => createRedactor({ patterns: ["("] }), /redactPatterns\[0\] is not a valid regular expression/);
    assert.throws(() => createRedactor({ patterns: ["a*"] }), /matches the empty string/);
    assert.throws(() => createRedactor({ redact: ["nope"] }), /unknown redactor "nope"/);
  });

  it("redacts a large string quickly", () => {
    const big = "const x = 1; // normal code line with words and numbers 12345\n".repeat(20_000);
    const t = performance.now();
    assert.equal(r.string(big), big);
    assert.ok(performance.now() - t < 1000, "1.2 MB in under 1s");
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
