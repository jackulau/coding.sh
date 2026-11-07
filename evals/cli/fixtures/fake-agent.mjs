#!/usr/bin/env node
// Stand-in coding agent run under `coding.sh run --`: records the user prompt
// as a Claude Code UserPromptSubmit spool line for the wrapper's session
// (CODING_SH_SESSION_ID), then applies a file edit in the cwd.
//   node fake-agent.mjs --prompt <text> --write <file> --content <text>
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sid = process.env.CODING_SH_SESSION_ID;
const home = process.env.CODING_SH_HOME;
if (!sid || !home) {
  process.stderr.write("fake-agent: run me under `coding.sh run --`\n");
  process.exit(2);
}
const ts = Date.now();
const dir = join(home, "spool", "claude-code");
mkdirSync(dir, { recursive: true });
const line = { v: 0, agent: "claude-code", event: "UserPromptSubmit", ts, pid: process.pid, ppid: process.ppid, cwd: process.cwd(), raw: { session_id: sid, hook_event_name: "UserPromptSubmit", cwd: process.cwd(), prompt: flag("--prompt") ?? "" } };
appendFileSync(join(dir, `${new Date(ts).toISOString().slice(0, 10)}.${process.pid}.jsonl`), JSON.stringify(line) + "\n");
const file = flag("--write");
if (file) writeFileSync(file, (flag("--content") ?? "").replaceAll("\\n", "\n"));
