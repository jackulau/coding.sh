// Redaction before a payload reaches the spool. The hook (./hook.ts) and the
// `coding.sh run` wrapper write every payload through appendSpool (./write.ts)
// with spoolLineRedactor(), so no secret the rules know waits on disk for
// ingest. The hook skips it for a payload the rules would leave as it is
// (./gate.ts). Ingest redacts again with the same rules (core/redact.ts): a
// value already redacted comes out unchanged, so it stores the same event as it
// would from the original payload. The counts, which a second pass cannot see,
// travel on the line (SpoolLine.redactions) and ingest puts them on the line's
// first event (withSpoolRedactions).
//
// The build bundles this file on its own, to dist/hook-redact.mjs, and the hook
// imports it only when ./gate.ts says a payload needs it: the rules and the TOML
// parser cost the hook more time to load than the rest of its work.
// It loads node:fs, from process.getBuiltinModule as ./hook.ts says, and imports
// core/redact.ts (which brings core/weights.ts and core/ids.ts), core/paths.ts and
// core/toml.ts.
import type { AgentEvent } from "../schema/index.ts";
import type { SpoolLine } from "../core/types.ts";
import { createRedactor, redactForBlob, redactionCounts, redactionTally, type BlobMemo, type RedactionTally, type Redactor } from "../core/redact.ts";
import { paths } from "../core/paths.ts";
import { parseToml } from "../core/toml.ts";
import type { RedactLine } from "./write.ts";

const cache = new WeakMap<NodeJS.ProcessEnv, Redactor>();

/**
 * The redactor for the user's config: `capture.redact` and `capture.redactPatterns`
 * in `<data dir>/config.toml` (default: the "secrets" rules), as ingest builds it
 * for a directory with no repo config. A repo config only adds rules; ingest applies
 * those. A config that can't be read or names an unknown redactor gets the default
 * rules, so a bad config never leaves a payload unredacted.
 */
export function spoolRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  let r = cache.get(env);
  if (!r) {
    try {
      r = createRedactor({ ...userCaptureRules(env), env });
    } catch {
      r = createRedactor({ env });
    }
    cache.set(env, r);
  }
  return r;
}

function userCaptureRules(env: NodeJS.ProcessEnv): { redact?: string[]; patterns?: string[] } {
  let text: string;
  try {
    text = process.getBuiltinModule("node:fs").readFileSync(paths(env).config, "utf8");
  } catch {
    return {};
  }
  const capture = parseToml(text).capture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return {};
  const strings = (v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error("not a list of strings");
    return v as string[];
  };
  const c = capture as Record<string, unknown>;
  const out: { redact?: string[]; patterns?: string[] } = {};
  const redact = strings(c.redact)?.filter((x) => x !== "none");
  const patterns = strings(c.redactPatterns);
  if (redact) out.redact = redact;
  if (patterns) out.patterns = patterns;
  return out;
}

/** A string that may hold a JSON document: redactForBlob parses it and redacts the document too. */
const mayBeJson = (s: string): boolean => {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
};

/**
 * `v` with `f` applied to every string that may hold a JSON document, given the string at the
 * same place in `before` (the value `v` was made from, with the same shape) when there is one; the
 * same object where none changed.
 */
function mapJsonStrings(v: unknown, before: unknown, f: (s: string, before: string | undefined) => string, depth = 0): unknown {
  if (typeof v === "string") {
    const b = typeof before === "string" ? before : undefined;
    return mayBeJson(v) || (b !== undefined && mayBeJson(b)) ? f(v, b) : v;
  }
  if (v === null || typeof v !== "object" || depth > 64) return v;
  if (Array.isArray(v)) {
    const was = Array.isArray(before) ? before : [];
    let out: unknown[] | undefined;
    for (let i = 0; i < v.length; i++) {
      const x = mapJsonStrings(v[i], was[i], f, depth + 1);
      if (x !== v[i]) (out ??= v.slice())[i] = x;
    }
    return out ?? v;
  }
  const was = before !== null && typeof before === "object" && !Array.isArray(before) ? before : {};
  let out: Record<string, unknown> | undefined;
  for (const [k, x] of Object.entries(v)) {
    const y = mapJsonStrings(x, Object.getOwnPropertyDescriptor(was, k)?.value, f, depth + 1);
    if (y === x) continue;
    out ??= { ...(v as Record<string, unknown>) };
    Object.defineProperty(out, k, { value: y, writable: true, enumerable: true, configurable: true });
  }
  return out ?? v;
}

/** The document in a string that looks like a JSON object or array; anything else is undefined. */
function jsonDocument(s: string): object | undefined {
  if (!mayBeJson(s)) return undefined;
  try {
    const doc: unknown = JSON.parse(s);
    return typeof doc === "object" && doc !== null ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** How many JSON documents `s` is or holds in its strings, as deep as redactForBlob follows them (3). */
function documents(s: string, level = 0): number {
  const doc = level < 3 ? jsonDocument(s) : undefined;
  if (doc === undefined) return 0;
  let n = 1;
  const visit = (v: unknown, depth: number): void => {
    if (typeof v === "string") n += documents(v, level + 1);
    else if (v !== null && typeof v === "object" && depth <= 64) for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(doc, 0);
  return n;
}

const MARKER_ONLY = /^\[redacted:[a-z0-9-]+\]$/;

/** The characters a redacted string still shows: its length without markers, or for a document the same over its strings, as deep as documents() follows them. */
function shownLength(s: string, level = 0): number {
  const doc = level < 3 ? jsonDocument(s) : undefined;
  if (doc === undefined) return s.replace(/\[redacted:[a-z0-9-]+\]/g, "").length;
  let n = 0;
  const visit = (v: unknown, depth: number): void => {
    if (typeof v === "string") n += shownLength(v, level + 1);
    else if (v !== null && typeof v === "object" && depth <= 64) for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(doc, 0);
  return n;
}

/**
 * Redacts a hook payload (parsed JSON, or the text when it did not parse). Every
 * string goes through the rules as ingest redacts an event's payload
 * (Redactor.value); then a string holding a JSON document is redacted as that
 * document, as a blob is (redactForBlob), which finds a value that only its key
 * shows to be secret. A document with nothing more to redact keeps its text, so an
 * event built from the result matches the one ingest builds from the original.
 *
 * A rule run on the text keeps whole each JSON escape a match starts or ends
 * inside, at every depth, but a match can still run past the end of one of a
 * document's strings (a private key with no END line runs to the end of the text),
 * and a document in the text then no longer parses, at any depth. A match can also
 * stop at an escape inside a value (below). The text's result is kept only when as
 * many documents parse in it as in the original and it shows no more than the
 * original redacted as documents. Otherwise the original is redacted as documents
 * instead (redactForBlob), and the counts the rules made on its text are taken
 * back, so each value is counted once. The documents in the two texts hold mostly
 * the same strings, and the passes over them share a BlobMemo, so each string is
 * redacted once.
 */
export function redactPayload(r: Redactor, v: unknown, tally: RedactionTally): unknown {
  if (!r.rules.length) return v;
  const memo: BlobMemo = new Map();
  return mapJsonStrings(r.value(v, tally), v, (s, before) => {
    if (before === undefined || before === s || MARKER_ONLY.test(s)) return redactForBlob(r, s, tally, 0, memo) as string;
    const docs = documents(before);
    if (docs === 0) return redactForBlob(r, s, tally, 0, memo) as string;
    let viaDoc: RedactionTally | undefined;
    let doc: string | undefined;
    if (documents(s) >= docs) {
      // A match the text pass started right after an escape can stop at an escape inside its value
      // (\u00e9, \", \/): the rest of the value then follows a marker, where the document pass does
      // not look again. The text's result is kept only when it shows no more than the original
      // redacted as documents.
      const viaText = redactionTally();
      const clean = redactForBlob(r, s, viaText, 0, memo) as string;
      viaDoc = redactionTally();
      doc = redactForBlob(r, before, viaDoc, 0, memo) as string;
      if (clean === doc || shownLength(clean) <= shownLength(doc)) {
        addTally(tally, viaText);
        return clean;
      }
    }
    const onText = redactionTally();
    r.string(before, onText);
    for (const [k, n] of Object.entries(onText.kinds)) {
      const left = (tally.kinds[k] ?? 0) - n;
      if (left > 0) tally.kinds[k] = left;
      else delete tally.kinds[k];
    }
    if (doc === undefined || viaDoc === undefined) return redactForBlob(r, before, tally, 0, memo) as string;
    addTally(tally, viaDoc);
    return doc;
  });
}

function addTally(into: RedactionTally, from: RedactionTally): void {
  for (const [k, n] of Object.entries(from.kinds)) into.kinds[k] = (into.kinds[k] ?? 0) + n;
  if (from.preexisting) into.preexisting = true;
}

/**
 * The line with its payload redacted, and the side-file text when the payload came
 * as text too long to inline (the hook parses only a payload that fits, so it is
 * parsed here, as a reader parses the side file). A payload with nothing to redact
 * comes back as it was, so its side file keeps the bytes the agent sent.
 */
export function redactLine(line: SpoolLine, rawText: string | undefined, r: Redactor): { line: SpoolLine; rawText: string | undefined } {
  if (!r.rules.length) return { line, rawText };
  const fromText = rawText !== undefined && line.raw === undefined;
  let value: unknown = line.raw;
  let json = true;
  if (fromText) {
    try {
      value = JSON.parse(rawText);
    } catch {
      value = rawText;
      json = false;
    }
  }
  const tally = redactionTally();
  const clean = redactPayload(r, value, tally);
  if (!Object.keys(tally.kinds).length) return { line, rawText };
  const out: SpoolLine = { ...line, redactions: { ...tally.kinds } };
  if (!fromText) {
    out.raw = clean;
    return { line: out, rawText: undefined };
  }
  return { line: out, rawText: json ? JSON.stringify(clean) : String(clean) };
}

/** appendSpool's `redact` with the rules of the user's config (spoolRedactor). */
export function spoolLineRedactor(env: NodeJS.ProcessEnv = process.env): RedactLine {
  const r = spoolRedactor(env);
  return (line, rawText) => redactLine(line, rawText, r);
}

/**
 * The event with the counts a spool writer recorded (SpoolLine.redactions) added to
 * its `payload.redactions`. Ingest calls it for the first event of a line: the
 * payload it redacted held markers already, so its own pass counted nothing for them.
 */
export function withSpoolRedactions(e: AgentEvent, counts: unknown): AgentEvent {
  const add = redactionCounts(counts);
  if (!add || !Object.values(add).some((n) => n > 0)) return e;
  const kinds = { ...(redactionCounts(e.payload.redactions) ?? {}) };
  for (const [k, n] of Object.entries(add)) if (n > 0) kinds[k] = (kinds[k] ?? 0) + n;
  return { ...e, payload: { ...e.payload, redactions: kinds } };
}
