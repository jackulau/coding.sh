/** What the reporter writes: each file's own count of its tests, and the results the run received. */
export interface Report {
  summaries: Record<string, number>;
  arrived: number;
}
/** The node:test reporter. */
export default function reportComplete(source: AsyncIterable<{ type: string; data?: unknown }>): AsyncGenerator<string>;
/** What is wrong with a run's report, one line per problem; none when it is whole. */
export function reportProblems(files: string[], failed: string[], report: Report | undefined): string[];
/** One spelling per file: on Windows a path can differ in case and in its slashes. */
export function fileKey(file: string): string;
