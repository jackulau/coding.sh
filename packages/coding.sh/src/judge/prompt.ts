// Judge prompts: a rubric-driven template rendered with the case's input,
// output, expected value, and trace (each event tagged with its id so the
// judge can cite it). Rendering is deterministic and size-bounded, so the
// same inputs always produce the same prompt — and therefore the same cache key.
import type { Citation, GradeContext, TraceEvent } from "../datasets/types.ts";
import { asText } from "../graders/builtin.ts";

export const DEFAULT_SYSTEM = `You are a strict, impartial evaluator of AI agent behavior.
Judge ONLY against the rubric. Do not reward length, confidence, or style the rubric does not ask for.
Base every claim on the material provided; quote it exactly when you cite it.
Reply with a single JSON object and nothing else:
{"score": <number 0..1>, "pass": <true|false>, "confidence": <number 0..1>, "reason": "<one or two sentences>", "citations": [{"eventId": "<id of the trace event, or \\"\\" if quoting the output>", "quote": "<exact excerpt>"}]}`;

export const DEFAULT_TEMPLATE = `Criterion: {{criterion}}

Rubric:
{{rubric}}

{{input}}

{{output}}

{{expected}}

{{trace}}

Evaluate the output (and trace, if given) against the rubric. Cite the specific passages that decided your verdict.`;

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: { type: "number" },
    pass: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: { eventId: { type: "string" }, quote: { type: "string" } },
        required: ["eventId", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "pass", "confidence", "reason", "citations"],
  additionalProperties: false,
};

export interface RenderLimits {
  /** Max characters per input/output/expected block. Default 20 000. */
  maxFieldChars?: number;
  /** Max characters per trace event. Default 2 000. */
  maxEventChars?: number;
  /** Max characters for the whole trace. Default 60 000. */
  maxTraceChars?: number;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} characters omitted]…\n${s.slice(s.length - tail)}`;
}

function block(tag: string, v: unknown, max: number): string {
  if (v === undefined) return "";
  return `<${tag}>\n${clip(asText(v), max)}\n</${tag}>`;
}

/** One-line-ish text for a trace event: message text, tool name + input/output, or the payload. */
export function eventText(e: TraceEvent): string {
  const p = e.payload ?? {};
  if (typeof p.text === "string") return p.text;
  const parts: string[] = [];
  if (typeof p.tool === "string") parts.push(`tool=${p.tool}`);
  if (p.input !== undefined) parts.push(`input=${asText(p.input)}`);
  if (p.output !== undefined) parts.push(`output=${asText(p.output)}`);
  if (typeof p.ok === "boolean") parts.push(`ok=${p.ok}`);
  if (parts.length) return parts.join(" ");
  return Object.keys(p).length ? asText(p) : "";
}

export function renderTrace(trace: readonly TraceEvent[], limits: RenderLimits = {}): string {
  const maxEvent = limits.maxEventChars ?? 2000;
  const maxTotal = limits.maxTraceChars ?? 60_000;
  const lines = trace.map((e) => `[${e.id}] ${e.kind}: ${clip(eventText(e), maxEvent).replaceAll("\n", "\n    ")}`);
  let total = lines.reduce((a, l) => a + l.length + 1, 0);
  if (total <= maxTotal) return lines.join("\n");
  // Keep the beginning (the task) and the end (the outcome); drop the middle.
  const head: string[] = [];
  const tail: string[] = [];
  let budget = maxTotal - 64;
  let i = 0;
  let j = lines.length - 1;
  let takeHead = true;
  while (i <= j) {
    const l = (takeHead ? lines[i] : lines[j]) as string;
    if (l.length + 1 > budget) break;
    budget -= l.length + 1;
    if (takeHead) head.push(lines[i++] as string);
    else tail.unshift(lines[j--] as string);
    takeHead = !takeHead;
  }
  total = j - i + 1;
  return [...head, `…[${total} events omitted]…`, ...tail].join("\n");
}

export interface RenderedPrompt {
  system: string;
  user: string;
  /** Everything the judge was shown, keyed for citation checks: event id → text, plus "" → output. */
  material: Map<string, string>;
}

export function renderPrompt(
  opts: { system?: string; template?: string; criterion: string; rubric: string } & RenderLimits,
  ctx: Pick<GradeContext, "input" | "output" | "expected" | "trace">,
): RenderedPrompt {
  const maxField = opts.maxFieldChars ?? 20_000;
  const values: Record<string, string> = {
    criterion: opts.criterion,
    rubric: opts.rubric.trim(),
    input: block("input", ctx.input, maxField),
    output: block("output", ctx.output, maxField),
    expected: block("expected", ctx.expected, maxField),
    trace: ctx.trace && ctx.trace.length ? `<trace>\n${renderTrace(ctx.trace, opts)}\n</trace>` : "",
  };
  // Single pass, so a value containing "{{x}}" is never substituted again.
  const user = (opts.template ?? DEFAULT_TEMPLATE)
    .replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? (values[k] as string) : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const material = new Map<string, string>();
  material.set("", `${asText(ctx.output)}\n${asText(ctx.input)}\n${asText(ctx.expected)}`);
  for (const e of ctx.trace ?? []) material.set(e.id, eventText(e));
  return { system: opts.system ?? DEFAULT_SYSTEM, user, material };
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Mark each citation verified iff its quote occurs in the cited event (or anywhere shown, without an id). */
export function verifyCitations(citations: readonly Citation[], material: ReadonlyMap<string, string>): Citation[] {
  const all = squash([...material.values()].join("\n"));
  return citations.map((c) => {
    const q = squash(c.quote);
    const scope = c.eventId && material.has(c.eventId) ? squash(material.get(c.eventId) as string) : c.eventId ? "" : all;
    const out: Citation = { quote: c.quote, verified: q.length > 0 && scope.includes(q) };
    if (c.eventId) out.eventId = c.eventId;
    return out;
  });
}
