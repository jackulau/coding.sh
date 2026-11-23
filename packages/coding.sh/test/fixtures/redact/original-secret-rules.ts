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

// Added on purpose with the rules that use them: a base64 BEGIN line, and a value written by hand.
function isEncodedPrivateKey(b64: string): boolean {
  const head = b64.slice(0, Math.min(64, b64.length - (b64.length % 4)));
  return /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/.test(Buffer.from(head, "base64").toString("latin1"));
}

function isLiteralSecret(v: string): boolean {
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v) || /^[${(<]/.test(v) || /[[(]/.test(v)) return false;
  return !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v);
}

const RULES: Rule[] = [
  {
    kind: "private-key",
    // Updated on purpose: a BEGIN line with no END after it, followed by key data, is a key that
    // runs to the end of the text.
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?=\s*(?:[A-Za-z0-9+/=]{16}|Proc-Type:))[\s\S]*$)/g,
  },
  { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  // Updated on purpose: every GitLab token prefix, not only glpat-.
  { kind: "gitlab-token", pattern: /(?<![A-Za-z0-9_-])gl(?:pat|oas|dt|rtr|rt|cbt|ptt|ft|imt|agent|soat|ffct)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g },
  // Updated on purpose: Slack app-level tokens (xapp-1-...).
  { kind: "slack-token", pattern: /(?<![A-Za-z0-9_-])(?:xox[abposr]-|xapp-\d-)[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: "aws-access-key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  { kind: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { kind: "stripe-key", pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "npm-token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { kind: "coding-sh-key", pattern: /(?<![A-Za-z0-9_-])csh_(?:ik|rk)_[A-Za-z0-9_-]{32,}/g },
  { kind: "vercel-ai-gateway-key", pattern: /(?<![A-Za-z0-9_-])vck_[A-Za-z0-9_-]{20,}/g },
  // Added on purpose: more vendor formats, by their published prefixes.
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
  // Added on purpose: the key in an Azure storage connection string, and a base64 private key block.
  { kind: "azure-storage-key", pattern: /(?<![A-Za-z0-9])(AccountKey=)[A-Za-z0-9+/]{20,}={0,2}/g, replace: keepPrefix("azure-storage-key") },
  {
    kind: "encoded-private-key",
    pattern: /LS0tLS1CRUdJTi[A-Za-z0-9+/=]{20,}/g,
    replace: (m) => (isEncodedPrivateKey(m) ? marker("encoded-private-key") : m),
  },
  { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "bearer", pattern: /(\b[Bb]earer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, replace: keepPrefix("bearer") },
  { kind: "basic-auth", pattern: /(\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replace: keepPrefix("basic-auth") },
  // Added on purpose: any other Authorization value, and Cookie and Set-Cookie headers.
  {
    kind: "auth-header",
    pattern: /(\bauthorization["']?[ \t]*:[ \t]*["']?(?:[A-Za-z][\w-]{0,30}[ \t]+)?)([^\s"'`,;\\]{8,})/gi,
    replace: (m, pre, v) => (isLiteralSecret(v) ? `${pre}${marker("auth-header")}` : m),
  },
  { kind: "cookie", pattern: /(\b(?:set-)?cookie["']?[ \t]*:[ \t]*["']?)(?=[\w.-]+=)[^\r\n'"\\]*/gi, replace: keepPrefix("cookie") },
  // Updated on purpose: password, url-secret, secret-assignment and secret-field leave a value that
  // is exactly a marker an earlier rule wrote, so a vendor token after a secret name keeps its kind.
  {
    kind: "password",
    // Updated on purpose: the user may be empty (redis://:password@host).
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)(?!\[redacted:[a-z0-9-]+\]@)([^\s@/]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${marker("password")}${at}`,
  },
  {
    kind: "url-secret",
    // Updated on purpose: the signature of a signed URL (sig=, X-Amz-Signature=).
    pattern: new RegExp(`([?&](?:[a-z0-9_-]*[_-])?(?:${SECRET_NAME}|sig|signature)=)(?!\\[redacted:[a-z0-9-]+\\](?:[&\\s#"'<>]|$))[^&\\s#"'<>]+`, "gi"),
    replace: keepPrefix("url-secret"),
  },
  {
    kind: "secret-assignment",
    pattern: new RegExp(`(\\b${ENV_SECRET_NAME}=)(["']?)(?![$])(?!\\[redacted:[a-z0-9-]+\\](?:[\\s"'\`;|&]|$))(?!\\d+\\b)([^\\s"'\`;|&]{8,})\\2`, "g"),
    replace: (_m, name, q) => `${name}${q}${marker("secret-assignment")}${q}`,
  },
  {
    kind: "secret-field",
    pattern: new RegExp(`(["']?(?:[A-Za-z0-9]+[_-])*${SECRET_NAME}["']?\\s*:\\s*["'])(?!\\[redacted:[a-z0-9-]+\\]["'])([^"'\\s]{8,})(["'])`, "gi"),
    replace: (_m, pre, _v, post) => `${pre}${marker("secret-field")}${post}`,
  },
  {
    kind: "prose-secret",
    pattern: /(\b(?:PAT|personal access token|token|password|passwd|passcode|pass phrase|passphrase|api[ _-]?key|secret)\b[^\n[\]:=]{0,24}?(?::|=|\bis\b)\s*)(?![$[])(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`,;)]{8,}/gi,
    replace: keepPrefix("prose-secret"),
  },
  // Added on purpose: a .netrc entry, and the value after a secret name with or without spaces or quotes.
  {
    kind: "netrc",
    pattern: /(\b(?:machine\s+\S+|default)\s+login\s+\S+\s+password\s+)([^\s\\]+)/g,
    replace: (m, pre, v) => (isLiteralSecret(v) ? `${pre}${marker("netrc")}` : m),
  },
  {
    kind: "secret-value",
    pattern: new RegExp(`(${SECRET_NAME}["']?[ \\t]*[:=][ \\t]*)(["']?)([^\\s"'\`,;)\\\\]{8,})`, "gi"),
    replace: (m, pre, q, v) => (isLiteralSecret(v) ? `${pre}${q}${marker("secret-value")}` : m),
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
