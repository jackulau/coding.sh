// Graders that run user code: a command in any language (JSON on stdin, score
// from JSON stdout or the exit code) and a JS module exporting a grade function.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../core/ids.ts";
import { shortHash } from "../datasets/hash.ts";
import type { Citation, GradeContext, GradeResult, Grader } from "../datasets/types.ts";
import { extractJson } from "../judge/extract.ts";
import { result } from "./builtin.ts";
import { describeFailure, formatArgv, runProcess, type CommandSpec } from "./proc.ts";

export class GraderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderError";
  }
}

/**
 * Coerce what user code returned into a GradeResult:
 * boolean → pass/fail; number → score (pass at ≥ threshold);
 * { score?, pass?, reason?, citations? } → as given (pass defaults to score ≥ threshold).
 */
export function coerceGrade(v: unknown, threshold = 0.5, where = "grader"): GradeResult {
  if (typeof v === "boolean") return result(v ? 1 : 0, v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new GraderError(`${where} returned a non-finite score`);
    return result(v, v >= threshold);
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const hasScore = typeof o.score === "number" && Number.isFinite(o.score);
    const hasPass = typeof o.pass === "boolean";
    if (!hasScore && !hasPass) throw new GraderError(`${where} returned an object without "score" or "pass"`);
    const score = hasScore ? (o.score as number) : o.pass ? 1 : 0;
    const pass = hasPass ? (o.pass as boolean) : score >= threshold;
    const r = result(score, pass, typeof o.reason === "string" ? o.reason : undefined);
    if (Array.isArray(o.citations)) {
      const cites: Citation[] = [];
      for (const c of o.citations) {
        if (c && typeof c === "object" && typeof (c as Citation).quote === "string") {
          const cite: Citation = { quote: (c as Citation).quote };
          if (typeof (c as Citation).eventId === "string") cite.eventId = (c as Citation).eventId as string;
          cites.push(cite);
        }
      }
      if (cites.length) r.citations = cites;
    }
    return r;
  }
  throw new GraderError(`${where} returned ${v === null ? "null" : typeof v}; expected boolean, number or { score, pass }`);
}

// ---------------------------------------------------------------- command

export interface CommandGraderSpec extends CommandSpec {
  kind: "command";
  name?: string;
  /** Pass threshold for a bare numeric score. Default 0.5. */
  passThreshold?: number;
}

/**
 * Runs `command args…` once per grade with `{input, output, expected,
 * metadata, caseId, trace}` as JSON on stdin. If stdout holds JSON (a number,
 * boolean, or `{score, pass, reason}`) that is the grade; otherwise exit 0 is
 * a pass and anything else a fail. A timeout or a command that cannot start
 * is an error (the grade is unknown), never a silent fail.
 */
export function commandGrader(spec: Omit<CommandGraderSpec, "kind">): Grader {
  const { name, env, ...rest } = spec;
  // Env values may carry secrets; only their names enter the version hash.
  const config = { ...rest, envKeys: Object.keys(env ?? {}).sort() };
  return {
    id: name ?? "command",
    kind: "command",
    version: shortHash({ kind: "command", config }),
    async grade(ctx: GradeContext): Promise<GradeResult> {
      const payload = { input: ctx.input, output: ctx.output, expected: ctx.expected, metadata: ctx.metadata, caseId: ctx.caseId, trace: ctx.trace };
      const r = await runProcess({ ...spec, stdin: JSON.stringify(payload), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (r.spawnError || r.timedOut) throw new GraderError(`${formatArgv(spec)}: ${describeFailure(r, spec.timeoutMs)}`);
      const out = r.stdout.trim();
      if (out) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          const lines = out.split("\n");
          try {
            parsed = JSON.parse((lines[lines.length - 1] as string).trim());
          } catch {
            parsed = extractJson(out, { accept: (v) => !!v && typeof v === "object" && ("score" in v || "pass" in v) });
          }
        }
        if (parsed !== undefined && (typeof parsed !== "string")) return coerceGrade(parsed, spec.passThreshold ?? 0.5, formatArgv(spec));
      }
      if (r.exitCode === 0) return result(1, true);
      return result(0, false, describeFailure(r));
    },
  };
}

// ---------------------------------------------------------------- module

export interface ModuleGraderSpec {
  kind: "module";
  name?: string;
  /** `file://…/grader.mjs` URL or a filesystem path (relative to `baseDir`/cwd). */
  module: string;
  /** Export to call (default "default"). */
  export?: string;
  /** Passed as the second argument to the grade function. */
  options?: unknown;
  passThreshold?: number;
}

export type GradeFn = (ctx: GradeContext, options?: unknown) => unknown;

function moduleUrl(spec: string, baseDir: string): URL {
  if (spec.startsWith("file:")) return new URL(spec);
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^[a-z]:[\\/]/i.test(spec)) {
    throw new GraderError(`module grader only loads local files (got ${spec})`);
  }
  return pathToFileURL(isAbsolute(spec) ? spec : resolve(baseDir, spec));
}

/**
 * Load a JS module grader. Its version hashes the spec AND the module's source
 * bytes, so editing the grader changes the version (and busts the import cache).
 */
export async function moduleGrader(spec: Omit<ModuleGraderSpec, "kind">, opts: { baseDir?: string } = {}): Promise<Grader> {
  const url = moduleUrl(spec.module, opts.baseDir ?? process.cwd());
  const source = await readFile(fileURLToPath(url));
  const codeHash = sha256Hex(source).slice(0, 16);
  const versioned = new URL(url.href);
  versioned.searchParams.set("v", codeHash);
  const mod = (await import(versioned.href)) as Record<string, unknown>;
  const exportName = spec.export ?? "default";
  const fn = mod[exportName];
  if (typeof fn !== "function") throw new GraderError(`${spec.module} has no function export ${JSON.stringify(exportName)}`);
  const { name, ...config } = spec;
  return {
    id: name ?? "module",
    kind: "module",
    version: shortHash({ kind: "module", config: { ...config, module: url.href }, codeHash }),
    async grade(ctx) {
      return coerceGrade(await (fn as GradeFn)(ctx, spec.options), spec.passThreshold ?? 0.5, spec.module);
    },
  };
}

/** Wrap an in-process function as a grader (versioned by its source text). */
export function functionGrader(name: string, fn: GradeFn, opts: { passThreshold?: number; options?: unknown } = {}): Grader {
  return {
    id: name,
    kind: "function",
    version: shortHash({ kind: "function", name, source: fn.toString(), options: opts.options ?? null }),
    async grade(ctx) {
      return coerceGrade(await fn(ctx, opts.options), opts.passThreshold ?? 0.5, name);
    },
  };
}
