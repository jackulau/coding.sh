// How busy the machine's cores were between two os.cpus() samples. scripts/test-ci.mjs prints it
// after the tests, so a slow leg says whether its cores were full or waiting.

/** The cores, their model, and the share of their time between the samples that was not idle. */
export function runnerLoad(before, after) {
  let busy = 0;
  let total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    for (const [kind, ms] of Object.entries(after[i].times)) {
      const spent = ms - (before[i].times[kind] ?? 0);
      total += spent;
      if (kind !== "idle") busy += spent;
    }
  }
  return { cores: after.length, model: after[0]?.model.trim() || "unknown model", busy: total > 0 ? busy / total : undefined };
}

/** One line for the log: `Runner: 4 cores (model), 87% busy over 150 s`. */
export function describeLoad(before, after, seconds) {
  const { cores, model, busy } = runnerLoad(before, after);
  const share = busy === undefined ? "load not measured" : `${Math.round(busy * 100)}% busy`;
  return `Runner: ${cores} ${cores === 1 ? "core" : "cores"} (${model}), ${share} over ${Math.round(seconds)} s`;
}
