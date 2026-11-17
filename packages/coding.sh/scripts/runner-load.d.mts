/** One core of an os.cpus() sample: its model and the milliseconds it spent in each state. */
export interface CoreSample {
  model: string;
  times: Record<string, number>;
}
/** The cores, their model, and the share of their time between the samples that was not idle. */
export function runnerLoad(before: CoreSample[], after: CoreSample[]): { cores: number; model: string; busy: number | undefined };
/** One line for the log: `Runner: 4 cores (model), 87% busy over 150 s`. */
export function describeLoad(before: CoreSample[], after: CoreSample[], seconds: number): string;
