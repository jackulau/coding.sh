// The shapes of vendor secrets that must never ship. One list for the release
// smoke test (scripts/release/smoke.sh reads SECRET_ERE), the gate's dist scan
// and the vendor-literal lint rule. Every source is valid as a JavaScript
// RegExp and as a POSIX extended regular expression, so grep -E reads it too.
// Zero dependencies.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {{ name: string, source: string }[]} */
const SHAPES = [
  { name: "anthropic-api-key", source: "sk-ant-api[0-9A-Za-z_-]{20,}" },
  { name: "github-token", source: "ghp_[0-9A-Za-z]{36}" },
  { name: "github-fine-grained-token", source: "github_pat_[0-9A-Za-z_]{40,}" },
  { name: "aws-access-key-id", source: "AKIA[0-9A-Z]{16}" },
  { name: "npm-token", source: "npm_[0-9A-Za-z]{36}" },
  { name: "stripe-key", source: "sk_(test|live)_[0-9A-Za-z]{10,}" },
  { name: "slack-token", source: "xox[abprs]-[0-9A-Za-z-]{10,}" },
  { name: "private-key", source: "BEGIN [A-Z ]*PRIVATE KEY" },
];

/** Named patterns, as RegExp (no flags: one match per call). */
export const SECRET_PATTERNS = SHAPES.map(({ name, source }) => ({ name, source, re: new RegExp(source) }));

/** All patterns as one grep -E expression. */
export const SECRET_ERE = SHAPES.map((s) => s.source).join("|");

/** The names of the patterns that match `text`. */
export const secretsIn = (text) => SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);

// `node scripts/release/secret-patterns.mjs` prints SECRET_ERE for shell scripts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(`${SECRET_ERE}\n`);
