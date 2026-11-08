const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const e = process.env;
  fs.mkdirSync("/tmp/capture/hook-env", { recursive: true });
  fs.writeFileSync(path.join("/tmp/capture/hook-env", "plugin-PostToolUse" + "-" + Date.now() + ".json"), JSON.stringify({ entrypoint: e.CLAUDE_CODE_ENTRYPOINT, pluginRoot: e.CLAUDE_PLUGIN_ROOT, input: JSON.parse(input || "{}") }));
  process.stdout.write("{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"TERSE-READ: summarize files in one line.\"}}");
});
