// `coding.sh/judge`: the judge functions that have no command yet. See
// docs/guides/evals.md ("Does the judge read the trace?" and "Waste judge").
//
//   import { anthropicProvider, createJudge, judgeGrader, pairedDiscrimination, formatDiscrimination } from "coding.sh/judge";
//   const judge = judgeGrader(createJudge({ name: "safe", rubric: "…", provider: anthropicProvider() }));
//   console.log(formatDiscrimination(await pairedDiscrimination(judge, cases)));   // cases: [{ input, output, trace }]
//
//   import { createWasteJudge } from "coding.sh/judge";
//   const report = await createWasteJudge({ provider: anthropicProvider() }).analyze(events);
//
// Zero dependencies, and none of the CLI: only what these functions import.
// slop-allow barrel-file: the published coding.sh/judge entry point; a package export is its re-exports
export {
  MUTATION_OPS,
  formatDiscrimination,
  pairedDiscrimination,
  traceMutations,
  type DiscriminationOpts,
  type DiscriminationReport,
  type Gradeable,
  type MutationOp,
  type OpDiscrimination,
  type TraceMutation,
} from "./discriminate.ts";
export {
  STRICT_WASTE,
  WASTE_KINDS,
  WASTE_STREAMS,
  createWasteJudge,
  wasteGrader,
  type WasteAnalyzeOpts,
  type WasteEvent,
  type WasteGraderOpts,
  type WasteJudge,
  type WasteJudgeOptions,
  type WasteKind,
  type WasteReport,
  type WasteSpan,
  type WasteStream,
} from "./waste.ts";
// A judge to measure, and the model behind either judge.
export { createJudge, judgeGrader, type Judge, type JudgeOptions } from "./judge.ts";
export type { CachedVerdict, JudgeCache } from "./cache.ts";
export { anthropicProvider, openAICompatibleProvider, type AnthropicOpts, type ChatProvider, type ChatRequest, type ChatResponse, type OpenAICompatOpts } from "./providers.ts";
export type { CalibrationStatus, Citation, GradeContext, GradeResult, Grader, JudgeVerdict, JudgeVersion, TraceEvent } from "../datasets/types.ts";
