// Frozen copy of the built-in "secrets" rules as they were before they were made
// linear-time (src/core/redact.ts). test/core/redact.test.ts checks that the
// current redactor produces exactly the same output as these on many inputs.
// Do not edit to follow changes in src: a deliberate behaviour change should
// update this reference and say so in the commit.
// Several of these patterns are O(n²) on long tokens: only feed them short input.

const marker = (kind: string): string => `[redacted:${kind}]`;

const SECRET_NAME = "(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|token|passw(?:or)?d|private[_-]?key|access[_-]?key(?:[_-]?id)?)";
const ENV_SECRET_NAME = "[A-Z0-9_]*(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|CREDENTIALS?)";

interface Rule {
  kind: string;
  pattern: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

function keepPrefix(kind: string): (m: string, ...g: string[]) => string {
  return (_m, ...g) => `${g[0] ?? ""}${marker(kind)}`;
}

const RULES: Rule[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "gitlab-token", pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g },
  { kind: "slack-token", pattern: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: "aws-access-key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  { kind: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { kind: "stripe-key", pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "npm-token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { kind: "coding-sh-key", pattern: /(?<![A-Za-z0-9_-])csh_(?:ik|rk)_[A-Za-z0-9_-]{32,}/g },
  { kind: "vercel-ai-gateway-key", pattern: /(?<![A-Za-z0-9_-])vck_[A-Za-z0-9_-]{20,}/g },
  { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "bearer", pattern: /(\b[Bb]earer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, replace: keepPrefix("bearer") },
  { kind: "basic-auth", pattern: /(\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replace: keepPrefix("basic-auth") },
  {
    kind: "password",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${marker("password")}${at}`,
  },
  {
    kind: "url-secret",
    pattern: new RegExp(`([?&](?:[a-z0-9_-]*[_-])?${SECRET_NAME}=)[^&\\s#"'<>]+`, "gi"),
    replace: keepPrefix("url-secret"),
  },
  {
    kind: "secret-assignment",
    pattern: new RegExp(`(\\b${ENV_SECRET_NAME}=)(["']?)(?![$])(?!\\d+\\b)([^\\s"'\`;|&]{8,})\\2`, "g"),
    replace: (_m, name, q) => `${name}${q}${marker("secret-assignment")}${q}`,
  },
  {
    kind: "secret-field",
    pattern: new RegExp(`(["']?(?:[A-Za-z0-9]+[_-])*${SECRET_NAME}["']?\\s*:\\s*["'])([^"'\\s]{8,})(["'])`, "gi"),
    replace: (_m, pre, _v, post) => `${pre}${marker("secret-field")}${post}`,
  },
  {
    kind: "prose-secret",
    pattern: /(\b(?:PAT|personal access token|token|password|passwd|passcode|pass phrase|passphrase|api[ _-]?key|secret)\b[^\n[\]:=]{0,24}?(?::|=|\bis\b)\s*)(?![$[])(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`,;)]{8,}/gi,
    replace: keepPrefix("prose-secret"),
  },
];

/** The kinds, in order, of the original rules. */
export const ORIGINAL_SECRET_KINDS: readonly string[] = RULES.map((r) => r.kind);

/** What `createRedactor({ redact: ["secrets"] }).string(s)` returned with the original rules. */
export function originalSecretRedact(s: string): string {
  let out = s;
  for (const r of RULES) {
    r.pattern.lastIndex = 0;
    if (!r.pattern.test(out)) continue;
    r.pattern.lastIndex = 0;
    out = r.replace
      ? out.replace(r.pattern, r.replace as (m: string, ...g: unknown[]) => string)
      : out.replace(r.pattern, marker(r.kind));
  }
  return out;
}
