// Mock chat provider (grader spec `provider: "mock"`): deterministic verdicts
// with no network call, no API key and no cache writes. For dry runs of an
// experiment wiring (dataset → task → graders → report) before paying for, or
// configuring, a real judge model. It answers whichever reply shape is asked
// for, from the request's JSON schema:
//
//  - llm judge verdict        → {"score", "pass", "reason", "citations"}
//  - llm-checklist item       → {"answer", "explanation", "citations"}
//  - llm-checklist batched    → {"answers": [{"id", …}]} for every `- [id]` question line
//  - pairwise judge           → {"winner": "tie"} (it never picks a side)
//
// Its name and model are "mock", so its judge versions never collide with (or
// inherit calibration from) a real model's.
import type { ChatProvider, ChatRequest, ChatResponse } from "../judge/providers.ts";

export type MockAnswer = "yes" | "no";

export interface MockProviderOpts {
  /** Every verdict / checklist answer. Default "yes" (pass). */
  answer?: MockAnswer;
}

const REASON = 'mock verdict (provider "mock": no model was called)';

function wants(schema: Record<string, unknown> | undefined, prop: string): boolean {
  const props = schema?.properties;
  return !!props && typeof props === "object" && prop in props;
}

/** Question ids from a batched checklist prompt (`- [id] question`). Unknown extras are ignored by the parser. */
function batchIds(user: string): string[] {
  const ids: string[] = [];
  for (const m of user.matchAll(/^- \[([^\]\n]+)\] /gm)) if (!ids.includes(m[1] as string)) ids.push(m[1] as string);
  return ids;
}

export function mockProvider(opts: MockProviderOpts = {}): ChatProvider {
  const answer: MockAnswer = opts.answer ?? "yes";
  if (answer !== "yes" && answer !== "no") throw new TypeError(`mock provider: answer must be "yes" or "no"`);
  const yes = answer === "yes";
  return {
    name: "mock",
    model: "mock",
    params: { answer },
    async complete(req: ChatRequest): Promise<ChatResponse> {
      let body: unknown;
      if (wants(req.jsonSchema, "answers")) body = { answers: batchIds(req.user).map((id) => ({ id, answer, explanation: REASON, citations: [] })) };
      else if (wants(req.jsonSchema, "winner")) body = { winner: "tie", reason: REASON };
      else if (wants(req.jsonSchema, "answer")) body = { answer, explanation: REASON, citations: [] };
      else body = { score: yes ? 1 : 0, pass: yes, reason: REASON, citations: [] };
      return { text: JSON.stringify(body), model: "mock", stopReason: "end_turn" };
    },
  };
}
