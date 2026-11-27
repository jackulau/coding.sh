// coding.sh hook entry — THE hot path. Bundled to dist/hook.mjs and copied to
// ~/.coding.sh/bin/hook.mjs. Agents invoke it as:
//
//   node ~/.coding.sh/bin/hook.mjs <agent> <event> [--echo-continue | --reply '<json>']   < hook JSON on stdin
//
// Outside Windows, agents run the POSIX sh fast path instead (./hook.sh, copied
// to ~/.coding.sh/bin/hook.sh): it writes the same SpoolLine without starting
// node, and hands every case it does not cover to this file. Both must keep
// the contract below (test/capture/hook.test.ts runs it against both).
//
// Contract with the agent:
// - Exits 0, always. A capture bug must never block or fail the agent.
//   Failures go to ~/.coding.sh/spool/errors.log.
// - Prints NOTHING to stdout by default: several agents interpret hook stdout
//   (as JSON decisions, or as text injected into the model's context).
// - `--echo-continue` (or CODING_SH_ECHO_CONTINUE=1) prints exactly
//   `{"continue":true}` + "\n" for agents whose hook protocol requires a JSON
//   reply to proceed (e.g. some Cursor hook events). It is printed even when
//   capture is disabled or failed, so the agent always proceeds.
// - `--reply '<json>'` (or `--reply=<json>`) is the generic form: prints that
//   JSON document (compacted) + "\n", always, like --echo-continue. Adapters use
//   it for events whose protocol needs an answer. It must never be used to
//   answer a permission question with "allow": that would pre-empt the user's
//   own approval. Invalid JSON prints nothing (logged), which agents treat as
//   "no opinion" on non-permission events.
// - `--sh-pids=<pid>,<ppid>` comes from hook.sh when it hands a call on: it
//   waits for this process instead of exec'ing it (so a node that cannot run
//   never fails the agent), and the line records the pid and ppid of the hook
//   process the agent started, not this child's.
// - CODING_SH_DISABLE=1: drain stdin and write no line. The payload's session
//   id goes to spool/disabled-sessions (./write.ts), so ingest and backfill
//   leave that session out.
// - CODING_SH_HOME overrides the data dir; CODING_SH_RUN_ID is recorded as runId.
// - A host app's env marker (T3 Code, see ./host.ts) is recorded as host.
// - Parent agents' session ids in the env (CLAUDE_CODE_SESSION_ID,
//   CODEX_THREAD_ID: this agent was started from their shell tool) are recorded
//   as spawnedBy (./spawned.ts).
// - Devin CLI runs Claude Code's hooks too. A `claude-code` call that Devin
//   made (DEVIN_PROJECT_DIR is set and the payload names no Claude transcript)
//   is recorded as `devin`, or writes nothing when a coding.sh hook for Devin
//   writes that event's line as well (./devin.ts).
//
// Work done: read stdin (synchronously, capped at 64 MB; a TTY counts as empty),
// JSON.parse it when possible, redact it when ./gate.ts finds it may hold a
// secret, and append one SpoolLine via appendSpool(). No
// network and no git work: the hook neither runs git nor reads .git. The repo
// and the HEAD a session started from are worked out at ingest, from the
// reflog (../core/repo-state.ts). The one child process: on end-of-turn/session
// events the hook starts a detached, lock-guarded `coding.sh ingest
// --background` and does not wait for it (./kick.ts).
//
// The work is in ./hook-run.ts (runHook), which tests call in-process; this file
// runs it with the process's own stdin, stdout, argv and env.
//
// Built-in modules: node:fs and node:path only (in ./hook-run.ts, ./write.ts, ./kick.ts,
// ./gate.ts, ./devin.ts and ../core/paths.ts, plus the pure
// ../integrations/gateway/ids.ts), and node:os only when HOME and USERPROFILE are
// unset or ../core/lock.ts checks a lock's holder.
// The redaction rules (./redact.ts with ../core/redact.ts and ../core/toml.ts,
// bundled to dist/hook-redact.mjs) are imported only for a payload ./gate.ts
// says may hold a secret; node:child_process only when an ingest starts.
//
// Every module the hook loads takes built-in modules from process.getBuiltinModule,
// never from an import (test/verify/hook-imports.test.ts checks it). The first import
// of a built-in makes Node build an ES module for it, which reads each of its exports:
// for node:fs that loads Node's stream modules as well, several milliseconds of a hook
// call. process.getBuiltinModule returns the module Node has already loaded. A node too old to
// have it gets it from the first lines of hook.mjs (HOOK_BANNER in scripts/bundle.mjs).
import { processIO, runHook } from "./hook-run.ts";
import { logSpoolError } from "./write.ts";

process.on("uncaughtException", (e) => {
  logSpoolError(e, { where: "uncaughtException" });
  process.exit(0);
});
runHook(process.argv.slice(2), processIO()).then(
  () => {
    process.exitCode = 0;
  },
  (e: unknown) => logSpoolError(e, { where: "main" }),
);
