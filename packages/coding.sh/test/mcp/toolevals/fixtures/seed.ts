// Tool-eval setup: seeds the deterministic MCP test world into a trial.
//   node seed.ts <trialRoot> <dataDir> <answersFile>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seed, worldAt } from "../../helpers.ts";

const [root, data, answers] = process.argv.slice(2);
if (!root || !data || !answers) {
  process.stderr.write("usage: seed.ts <trialRoot> <dataDir> <answersFile>\n");
  process.exit(2);
}
await seed(worldAt(root, data));
mkdirSync(dirname(answers), { recursive: true });
// Ground truth from the seed spec (see helpers.ts), never from the server under test.
writeFileSync(answers, JSON.stringify({ failingTool: "Bash", llmP95Ms: "2500", latestPrompt: "Refactor the tokenizer for speed", subagentsOfA: "2", codexCostUsd: "0.005" }));
