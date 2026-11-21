// Whether a hook payload needs the redaction engine. Loading the engine (./redact.ts with
// ../core/redact.ts and ../core/toml.ts, bundled to dist/hook-redact.mjs) adds about 2.2 ms to
// a hook call (docs/perf.md). Most payloads hold nothing the default rules replace, and the
// payload's text shows it before any of it is parsed. When needsRedaction() is false, the
// engine would leave the payload as it is, so the hook writes it without loading the engine.
//
// Why a false answer is safe. With the default rules (capture.redact = ["secrets"], no
// redactPatterns), every rule, secret key (api_key, Authorization, ...) and secret flag
// (--token) matches only text that holds a fixed part: a vendor prefix with the token
// characters after it (sk- and 20 more, ghp_ and 36 more, ...), a secret word (token,
// password, api_key, ...) followed by a character that ends a word, Bearer with a token, or
// "://" with a user and a password. VENDOR and WORDS below look for those parts. The engine
// works on the strings of the parsed payload, and in the payload's JSON text each character
// of a string appears as it is or as an escape:
//
// - A \uXXXX escape of a character the tests look for (a letter, a digit, space, or one of
//   + - . / : = @ \ _ ~) makes the answer true (escapesNeedle).
// - A slash may be written \/. The two tests that look for one (Bearer's token and "://")
//   accept a slash after any number of backslashes.
// - The other escapes (\n, \", \\, \t, ...) stand for characters the tests only need to be
//   something other than a letter, a digit or "_". After a word, the test sees the escape's
//   backslash. Before sk- and PAT, the only fixed parts that need a word break before them,
//   the tests accept an escape. The whitespace after Bearer may be an escape too.
//
// A string that holds a JSON document is redacted again as that document, three levels deep.
// Each level only adds backslashes in front of an escape, and the tests accept any number of
// them. A regex with the `i` flag and no `u` flag matches an ASCII letter only with an ASCII
// letter, in the rules as in WORDS. test/spool/gate.test.ts runs the engine on payloads written
// by hand and generated, spelled in each of these ways, and fails when the engine changes one
// that mayHoldSecret() is false for. It also fails when the rules or the secret key and flag
// names change (RULES_HASH), until they are checked against VENDOR and WORDS.
//
// The hook compiles each regex on first use, which costs more than the test itself, so a
// first pass runs before VENDOR and WORDS: VENDOR_PARTS and WORD_PARTS are short and quick
// to compile, and every text VENDOR or WORDS matches also holds one of their parts.
//
// On the hook's hot path: node:fs and ../core/paths.ts only.
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../core/paths.ts";

/**
 * The case-sensitive parts: each vendor prefix with as many token characters as its rule
 * needs at least, the start of a private key block, CREDENTIALS= (secret-assignment), Bearer
 * with 16 token characters, and "://" with a user and a password. Before sk- comes a character
 * that is not part of a word, as its rules need, or an escape (a backslash and one of b f n r t,
 * or a \u escape). After Bearer the whitespace may be an escape. A slash may follow any number
 * of backslashes.
 */
const VENDOR =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY|sk-(?<=(?:^|[^A-Za-z0-9_-]|\\[bfnrt]|\\u[0-9A-Fa-f]{4})sk-)[A-Za-z0-9_-]{20}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22}|glpat-[A-Za-z0-9_-]{20}|xox[abposr]-[A-Za-z0-9-]{10}|hooks\.slack\.com|A(?:KIA|SIA|ROA|IDA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16}|npm_[A-Za-z0-9]{36}|csh_[ir]k_[A-Za-z0-9_-]{32}|vck_[A-Za-z0-9_-]{20}|eyJ[A-Za-z0-9_-]{8}|[Bb]earer(?:\s|\\+[nrtf]|\\+u[0-9A-Fa-f]{4})+(?:[A-Za-z0-9._~+-]|\\*\/){16}|CREDENTIALS?=|:\\*\/\\*\/[^\s:@/]+:[^\s@/]+@/;

/**
 * The secret words of the case-insensitive rules and the secret keys (SECRET_NAME, the
 * prose-secret words, Authorization, Cookie), each followed by a character that ends a word
 * (`\b` after a letter). PAT also needs a word break before it, as the prose-secret rule
 * does. Without the `u` flag, \b and \W know only the ASCII letters, digits and "_" as word
 * characters, with or without `i`.
 */
const WORDS =
  /(?:api[ ._-]?key|private[._-]?key|access[._-]?key(?:[._-]?id)?|secret(?:[._-]?key)?|token|pass(?:w(?:or)?d|code| ?phrase)|authorization|cookie)\b|pat(?<=(?:^|\W|\\[bfnrt]|\\u[0-9a-f]{4})pat)\b/i;

/**
 * The first pass for VENDOR: every text VENDOR matches holds one of these. sk-, npm_ and
 * "://" keep what VENDOR needs after them, because URLs, task-1 and npm_config_ are common
 * in payloads.
 */
const VENDOR_PARTS = /-----BEGIN |sk-[A-Za-z0-9_-]{20}|gh[pousr]_|github_pat_|glpat-|xox|hooks\.slack\.com|A(?:KIA|SIA|ROA|IDA|Iza)|[sr]k_(?:live|test)_|npm_[A-Za-z0-9]{36}|csh_|vck_|eyJ|[Bb]earer|CREDENTIALS?=|:\\*\/\\*\/[^\s:@/]+:[^\s@/]+@/;

/**
 * The first pass for WORDS: every text WORDS matches holds one of these. Bare "key" and
 * "pass" would also find keyboard and bypassPermissions, which many payloads hold.
 */
const WORD_PARTS = /(?:api|private|access)[ ._-]?key|secret|token\b|passw|passcode|pass ?phrase|authorization|cookie|pat\b/i;

/** A character the tests above look for: a letter, a digit, space or one of + - . / : = @ \ _ ~ */
function isNeedleCode(c: number): boolean {
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return true;
  return c === 0x20 || c === 0x2b || c === 0x2d || c === 0x2e || c === 0x2f || c === 0x3a || c === 0x3d || c === 0x40 || c === 0x5c || c === 0x5f || c === 0x7e;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  const l = c | 0x20;
  return l >= 0x61 && l <= 0x66 ? l - 0x57 : -1;
}

/** True when the text holds a \uXXXX escape of a character the tests look for. */
function escapesNeedle(text: string): boolean {
  for (let i = text.indexOf("\\u"); i >= 0; i = text.indexOf("\\u", i + 2)) {
    let code = 0;
    for (let j = i + 2; j < i + 6; j++) {
      const h = hexValue(text.charCodeAt(j));
      if (h < 0) {
        code = -1;
        break;
      }
      code = code * 16 + h;
    }
    if (code >= 0 && isNeedleCode(code)) return true;
  }
  return false;
}

/**
 * False when the default redaction rules find nothing in this payload text (JSON or not):
 * the engine would return it as it is. True when they may find something.
 */
export function mayHoldSecret(text: string): boolean {
  // includes() first: most payloads hold no \u escape, and the hook compiles escapesNeedle on its first call.
  return (VENDOR_PARTS.test(text) && VENDOR.test(text)) || (WORD_PARTS.test(text) && WORDS.test(text)) || (text.includes("\\u") && escapesNeedle(text));
}

/**
 * True when config.toml's text (undefined: no file, or one that can't be read) leaves the
 * capture rules at their default: every line that mentions "redact" is one of the two lines
 * `coding.sh init` writes. Anything else is false, and so is any text with a \u, \U or \x
 * escape, which can spell a quoted key ("re\x64act" is TOML 1.1). A config that sets the
 * defaults another way is false too; that only costs the engine's load time.
 */
export function isDefaultCaptureConfig(text: string | undefined): boolean {
  if (text === undefined) return true;
  if (/\\[uUx]/.test(text)) return false;
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes("redact")) continue;
    const t = line.trim();
    if (t !== 'redact = ["secrets"]' && t !== "redactPatterns = []") return false;
  }
  return true;
}

function readConfig(file: string): string | undefined {
  try {
    // existsSync first: a missing file is the common case, and a throw costs more than the check.
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the hook must run the redaction engine on this payload: the text may hold a
 * secret, or the user's config sets other rules (`capture.redact`, `capture.redactPatterns`).
 */
export function needsRedaction(text: string, env: NodeJS.ProcessEnv): boolean {
  if (mayHoldSecret(text)) return true;
  // No config file is the default config: skip the check, which the hook would compile first.
  const config = readConfig(paths(env).config);
  return config !== undefined && !isDefaultCaptureConfig(config);
}
