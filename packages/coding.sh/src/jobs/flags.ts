// The flags durable runs share (exp run/aa/sweep, compare, workflows run,
// bench run). Static metadata only, so cli/registry.ts can import it.
import type { FlagSpec } from "../cli/args.ts";

/** Ids of resumable records: exp_…, pair_…, sweep_…, bench_…, wfx_… (and a bench run's date). */
export const RESUME_ID = /^(?:(?:exp|pair|sweep|bench|wfx)_[0-9A-Za-z]{10,}|\d{4}-\d{2}-\d{2})$/;

export function resumeFlag(what = "run"): FlagSpec {
  return {
    name: "resume",
    type: "string",
    optionalValue: true,
    valuePattern: RESUME_ID,
    value: "<ID>",
    desc: `Continue an interrupted ${what}: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config)`,
  };
}

export const RETRIES_FLAG: FlagSpec = {
  name: "retries",
  type: "number",
  value: "<N>",
  desc: "Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried)",
  default: "3",
};

export const STOP_AFTER_INFRA_FLAG: FlagSpec = {
  name: "stop-after-infra",
  type: "number",
  value: "<N>",
  desc: "Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops",
  default: "5",
};

export const TRIAL_TIMEOUT_FLAG: FlagSpec = { name: "trial-timeout", type: "number", value: "<SEC>", desc: "Time limit per trial, retries included; a trial over it fails" };

/** What a durable command adds to its flags. */
export function durableFlags(what?: string, o: { timeout?: boolean } = {}): FlagSpec[] {
  return [resumeFlag(what), RETRIES_FLAG, STOP_AFTER_INFRA_FLAG, ...(o.timeout === false ? [] : [TRIAL_TIMEOUT_FLAG])];
}
