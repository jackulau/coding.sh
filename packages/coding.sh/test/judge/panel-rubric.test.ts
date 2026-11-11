// An llm-panel grader with no rubric is refused when it is built, with a
// message that names the field, instead of crashing later on rubric.trim().
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGrader } from "../../src/graders/index.ts";

describe("llm-panel without a rubric", () => {
  for (const rubric of [undefined, "", "  "]) {
    it(`rubric ${JSON.stringify(rubric)} is refused with a message`, async () => {
      const spec: Record<string, unknown> = { kind: "llm-panel", name: "p", members: [{ provider: "mock" }] };
      if (rubric !== undefined) spec.rubric = rubric;
      await assert.rejects(
        async () => {
          const g = await createGrader(spec as never);
          await g.grade({ input: "q", output: "a" });
        },
        (e: unknown) => e instanceof Error && /panel "p" needs a rubric/.test(e.message),
      );
    });
  }
});
