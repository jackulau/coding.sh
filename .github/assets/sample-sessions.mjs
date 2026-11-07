// Writes six made-up Claude Code transcripts into a throwaway HOME, for the README screenshots
// (viewer-session.png, viewer-sessions.png). No real session data goes into those images.
//
// Regenerate:
//   R=$(mktemp -d); export HOME=$R/home CODING_SH_HOME=$R/home/.coding.sh CODING_SH_NO_UPDATE_CHECK=1
//   node .github/assets/sample-sessions.mjs "$HOME"
//   node packages/coding.sh/dist/cli.mjs ingest --backfill
//   node packages/coding.sh/dist/cli.mjs ui     # 1280 wide, 2x, dark; session 1, its file.change step
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
const cwd = "/home/dev/coding.sh";
const dir = join(home, ".claude", "projects", "-home-dev-coding-sh");
mkdirSync(dir, { recursive: true });

const sessions = [
  { prompt: "coding.sh usage --by model prints NaN for cache hits when a session has no model calls. Fix it and add a test.", model: "claude-opus-4-5", ok: true, mins: 0,
    steps: [["Grep", { pattern: "cacheHit", path: "packages/coding.sh/src" }, "src/cli/commands/usage.ts:88"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/usage.ts` }, "...usage.ts (212 lines)"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/usage.ts`, old_string: "hits / calls", new_string: "calls ? hits / calls : 0" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- usage" }, "# pass 14\n# fail 0"]],
    reply: "Guarded the division in usage.ts and added a test for a session with no model calls. 14 tests pass." },
  { prompt: "Add a --since flag to coding.sh search", model: "claude-sonnet-4-5", ok: true, mins: 42,
    steps: [["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/registry.ts` }, "...registry.ts"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/search.ts` }, "...search.ts"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/registry.ts`, old_string: "flags: [LIMIT(20)]", new_string: "flags: [SINCE, LIMIT(20)]" }, "The file has been updated."], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/search.ts`, old_string: "const rows =", new_string: "const since = parseSince(flags.since);\n  const rows =" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- search" }, "# pass 9\n# fail 0"]],
    reply: "search now takes --since (7d, 12h, 30m or a date). Tests pass." },
  { prompt: "The viewer's session list jumps when a new session arrives. Can you make it keep scroll position?", model: "claude-opus-4-5", ok: false, mins: 95,
    steps: [["Read", { file_path: `${cwd}/packages/coding.sh/src/viewer/app.ts` }, "...app.ts"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/viewer/app.ts`, old_string: "list.innerHTML = html", new_string: "const y = list.scrollTop;\n  list.innerHTML = html;\n  list.scrollTop = y" }, "The file has been updated."]],
    reply: "I kept the scroll offset across re-renders in app.ts. I didn't run the viewer tests." },
  { prompt: "Why does coding.sh doctor warn about the wrapper agent on a fresh install?", model: "claude-sonnet-4-5", ok: true, mins: 160,
    steps: [["Grep", { pattern: "wrapper", path: "packages/coding.sh/src/cli/commands/doctor.ts" }, "doctor.ts:141"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/doctor.ts` }, "...doctor.ts"], ["Bash", { command: "node packages/coding.sh/dist/cli.mjs doctor --json" }, "{\"ok\":true,\"warnings\":1}"]],
    reply: "doctor treats the wrapper like a hook-based agent and expects hooks it never installs. It should skip the hook check for wrapper." },
  { prompt: "Bump the OTLP receiver body limit to 8 MB and document it", model: "claude-opus-4-5", ok: true, mins: 230,
    steps: [["Grep", { pattern: "MAX_BODY", path: "packages/coding.sh/src/otel" }, "receiver.ts:22"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/otel/receiver.ts`, old_string: "4 << 20", new_string: "8 << 20" }, "The file has been updated."], ["Edit", { file_path: `${cwd}/docs/guides/explore.md`, old_string: "4 MB", new_string: "8 MB" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- otel" }, "# pass 31\n# fail 0"]],
    reply: "Raised the limit to 8 MB in receiver.ts and updated the docs. OTLP tests pass." },
  { prompt: "Run the eval suite and tell me what regressed", model: "claude-sonnet-4-5", ok: true, mins: 300,
    steps: [["Bash", { command: "node packages/coding.sh/dist/cli.mjs exp run evals/cli --json" }, "{\"passed\":46,\"failed\":2}"], ["Read", { file_path: `${cwd}/evals/cli/tasks/show-latest.yaml` }, "...show-latest.yaml"]],
    reply: "46 of 48 tasks pass. show-latest and usage-by-day fail on the new column order." },
];

const base = Date.now() - 6 * 3600_000;
sessions.forEach((s, i) => {
  const sid = `5a3e0000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  let t = base + s.mins * 60_000;
  const iso = () => new Date(t).toISOString();
  const common = { sessionId: sid, cwd, version: "2.1.300", gitBranch: "main", userType: "external", entrypoint: "cli" };
  const rows = [{ type: "mode", mode: "default", sessionId: sid }];
  let u = 0;
  const uuid = () => `u${i}-${u++}`;
  rows.push({ ...common, type: "user", uuid: uuid(), parentUuid: null, timestamp: iso(), message: { role: "user", content: s.prompt }, promptId: `p${i}` });
  let input = 3200, cache = 14000;
  s.steps.forEach(([name, inp, out], k) => {
    t += 1800 + k * 900;
    const id = `toolu_${i}_${k}`;
    rows.push({ ...common, type: "assistant", uuid: uuid(), parentUuid: null, timestamp: iso(), requestId: `req_${i}_${k}`,
      message: { id: `msg_${i}_${k}`, type: "message", role: "assistant", model: s.model, content: [{ type: "tool_use", id, name, input: inp }], stop_reason: "tool_use",
        usage: { input_tokens: input, output_tokens: 120 + k * 40, cache_read_input_tokens: cache, cache_creation_input_tokens: 600 } } });
    t += name === "Bash" ? 6400 : 300;
    rows.push({ ...common, type: "user", uuid: uuid(), parentUuid: null, timestamp: iso(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: false }] } });
    input += 900; cache += 4000;
  });
  t += 2500;
  rows.push({ ...common, type: "assistant", uuid: uuid(), parentUuid: null, timestamp: iso(), requestId: `req_${i}_end`,
    message: { id: `msg_${i}_end`, type: "message", role: "assistant", model: s.model, content: [{ type: "text", text: s.reply }], stop_reason: "end_turn",
      usage: { input_tokens: input, output_tokens: 180, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});
console.log(`wrote ${sessions.length} sessions to ${dir}`);
