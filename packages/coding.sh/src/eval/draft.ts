// Model-drafted eval content for `coding.sh eval init --draft`: cases for an
// app or prompt, and should / should_not prompts for a skill. Everything a
// model drafts is marked draft and meant to be read and fixed before it is
// trusted (Anthropic: unambiguous tasks that two experts would grade the same,
// and balanced sets that test where a behavior should and should not occur).
import type { ChatProvider } from "../judge/providers.ts";
import { extractJson } from "../judge/extract.ts";

export interface DraftedCase {
  input: string;
  /** The exact answer, when there is one. */
  expected?: string;
  /** true: the behavior should happen; false: a should-not / edge case. */
  should: boolean;
  note?: string;
}

export interface DraftedTriggers {
  should: string[];
  shouldNot: string[];
}

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

const CASES_SYSTEM = `You write evaluation cases for an AI application. Rules:
- Each case is one input the application receives, written the way a real user would write it.
- Make every case unambiguous: two experts reading it would agree on the right answer.
- Balance the set: about half the cases where the behavior should happen, half where it should not (edge cases, near misses, inputs that look similar but need a different answer).
- When the right answer is short and exact (a label, a number, yes/no), put it in "expected", in exactly the format the application returns. Otherwise leave "expected" out.
- Never repeat a case. Keep inputs under 400 characters.
Reply with JSON only: {"cases": [{"input": "...", "expected": "...", "should": true, "note": "why this case"}]}`;

const TRIGGERS_SYSTEM = `You write routing tests for an agent skill: prompts where the agent should load the skill, and prompts where it should not.
Rules:
- Write prompts the way a real user would type them to a coding agent, one request each.
- "should": requests the skill's description clearly covers, in varied wording (not just its keywords).
- "should_not": near misses that share words or topic with the skill but need something else, plus a few unrelated requests.
- Never repeat a prompt. Keep each under 200 characters.
Reply with JSON only: {"should": ["..."], "should_not": ["..."]}`;

const CASES_SCHEMA = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      items: { type: "object", properties: { input: { type: "string" }, expected: { type: "string" }, should: { type: "boolean" }, note: { type: "string" } }, required: ["input", "should"], additionalProperties: false },
    },
  },
  required: ["cases"],
  additionalProperties: false,
};

const TRIGGERS_SCHEMA = {
  type: "object",
  properties: { should: { type: "array", items: { type: "string" } }, should_not: { type: "array", items: { type: "string" } } },
  required: ["should", "should_not"],
  additionalProperties: false,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function ask(provider: ChatProvider, system: string, user: string, schema: Record<string, unknown>, accept: (v: unknown) => boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const r = await provider.complete({ system, user, jsonSchema: schema, ...(signal ? { signal } : {}) });
  const found = extractJson(r.text, { accept });
  if (!isObj(found)) throw new DraftError(`${provider.name} ${provider.model}: the reply had no JSON draft (got ${JSON.stringify(r.text.slice(0, 120))})`);
  return found;
}

/** Up to `n` cases (default 12) for an application described in plain words. */
export async function draftCases(provider: ChatProvider, o: { description: string; n?: number; examples?: readonly { input: unknown; expected?: unknown }[]; signal?: AbortSignal }): Promise<DraftedCase[]> {
  const n = o.n ?? 12;
  const ex = (o.examples ?? []).slice(0, 5).map((e) => JSON.stringify(e)).join("\n");
  const user = `The application:\n${o.description.trim()}\n\n${ex ? `Existing cases, for format (do not repeat them):\n${ex}\n\n` : ""}Write ${n} cases.`;
  const found = await ask(provider, CASES_SYSTEM, user, CASES_SCHEMA, (v) => isObj(v) && Array.isArray(v.cases), o.signal);
  const seen = new Set<string>();
  const out: DraftedCase[] = [];
  for (const c of found.cases as unknown[]) {
    if (!isObj(c)) continue;
    const input = text(c.input);
    if (!input || seen.has(input)) continue;
    seen.add(input);
    const expected = text(c.expected);
    const note = text(c.note);
    out.push({ input, ...(expected ? { expected } : {}), should: c.should !== false, ...(note ? { note } : {}) });
    if (out.length >= n) break;
  }
  if (!out.length) throw new DraftError(`${provider.name} ${provider.model}: the draft had no usable cases`);
  return out;
}

/** About `n` prompts per side (default 8) for a skill, from its name and description. */
export async function draftTriggers(provider: ChatProvider, o: { skill: string; description: string; siblings?: readonly { name: string; description: string }[]; n?: number; signal?: AbortSignal }): Promise<DraftedTriggers> {
  const n = o.n ?? 8;
  const sib = (o.siblings ?? []).slice(0, 20).map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const user = `Skill "${o.skill}":\n${o.description.trim()}\n\n${sib ? `Other skills the agent has (prompts for these belong in should_not):\n${sib}\n\n` : ""}Write ${n} should and ${n} should_not prompts.`;
  const found = await ask(provider, TRIGGERS_SYSTEM, user, TRIGGERS_SCHEMA, (v) => isObj(v) && Array.isArray(v.should) && Array.isArray(v.should_not), o.signal);
  const uniq = (xs: unknown[]) => [...new Set(xs.map(text).filter((x): x is string => !!x))].slice(0, n);
  const should = uniq(found.should as unknown[]);
  const shouldNot = uniq(found.should_not as unknown[]).filter((p) => !should.includes(p));
  if (!should.length || !shouldNot.length) throw new DraftError(`${provider.name} ${provider.model}: the draft needs both should and should_not prompts`);
  return { should, shouldNot };
}
