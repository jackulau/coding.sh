// Redaction before a payload reaches the spool. The hook (./hook.ts) and the
// `coding.sh run` wrapper write every payload through appendSpool (./write.ts),
// which passes it through spoolRedactor() first, so no secret the rules know
// waits on disk for ingest. Ingest redacts again with the same rules
// (core/redact.ts): a value already redacted comes out unchanged, so it stores
// the same event as it would from the original payload. The counts, which a
// second pass cannot see, travel on the line (SpoolLine.redactions) and ingest
// puts them on the line's first event (withSpoolRedactions).
//
// On the hook's hot path: node:fs plus core/redact.ts, core/paths.ts and
// core/toml.ts, no other module.
import { readFileSync } from "node:fs";
import type { AgentEvent } from "../schema/index.ts";
import { createRedactor, redactForBlob, redactionCounts, type RedactionTally, type Redactor } from "../core/redact.ts";
import { paths } from "../core/paths.ts";
import { parseToml } from "../core/toml.ts";

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
    text = readFileSync(paths(env).config, "utf8");
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

/** `v` with `f` applied to every string that may hold a JSON document; the same object where none changed. */
function mapJsonStrings(v: unknown, f: (s: string) => string, depth = 0): unknown {
  if (typeof v === "string") return mayBeJson(v) ? f(v) : v;
  if (v === null || typeof v !== "object" || depth > 64) return v;
  if (Array.isArray(v)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < v.length; i++) {
      const x = mapJsonStrings(v[i], f, depth + 1);
      if (x !== v[i]) (out ??= v.slice())[i] = x;
    }
    return out ?? v;
  }
  let out: Record<string, unknown> | undefined;
  for (const [k, x] of Object.entries(v)) {
    const y = mapJsonStrings(x, f, depth + 1);
    if (y === x) continue;
    out ??= { ...(v as Record<string, unknown>) };
    Object.defineProperty(out, k, { value: y, writable: true, enumerable: true, configurable: true });
  }
  return out ?? v;
}

/**
 * Redacts a hook payload (parsed JSON, or the text when it did not parse). Every
 * string goes through the rules as ingest redacts an event's payload
 * (Redactor.value); then a string holding a JSON document is redacted as that
 * document, as a blob is (redactForBlob), which finds a `NAME=value` after an
 * escaped newline. A document with nothing more to redact keeps its text, so an
 * event built from the result matches the one ingest builds from the original.
 */
export function redactPayload(r: Redactor, v: unknown, tally: RedactionTally): unknown {
  if (!r.rules.length) return v;
  return mapJsonStrings(r.value(v, tally), (s) => redactForBlob(r, s, tally) as string);
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
