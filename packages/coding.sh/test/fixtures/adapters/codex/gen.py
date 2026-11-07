# Synthetic Codex fixtures (no real user content): two rollout generations, a
# subagent thread, and hook spool lines as hook.mjs would write them.
import json
import os
from datetime import datetime, timezone
T0 = 1793527200000; CWD = "/work/demo"
SID = "0193aaaa-1111-7222-8333-444455556666"; SUB = "0193bbbb-1111-7222-8333-444455556666"; OLD = "0193cccc-1111-7222-8333-444455556666"
T1 = "turn-0001"; T9 = "turn-sub-01"
def iso(ms): return datetime.fromtimestamp(ms/1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms%1000:03d}Z"
def R(t, typ, payload, ordn=None):
    o = {"timestamp": iso(T0+t), "type": typ, "payload": payload}
    if ordn is not None: o["ordinal"] = ordn
    return o
def usage(i, c, o, r=0, w=0): return {"input_tokens": i, "cached_input_tokens": c, "cache_write_input_tokens": w, "output_tokens": o, "reasoning_output_tokens": r, "total_tokens": i+o}
def item(t, it, t0=None, t1=None, turn=T1, thread=SID):
    return ("event_msg", {"type": "item_completed", "thread_id": thread, "turn_id": turn, "item": it, "started_at_ms": T0+(t0 if t0 is not None else t), "completed_at_ms": T0+(t1 if t1 is not None else t)})
PATCH = "*** Begin Patch\n*** Update File: src/math.ts\n@@\n-  return a - b;\n+  return a + b;\n*** End Patch\n"
VITEST_FAIL = " FAIL  src/math.test.ts > add\n Test Files  1 failed (1)\n      Tests  1 failed | 5 passed (6)\n"
VITEST_OK = " Test Files  1 passed (1)\n      Tests  6 passed (6)\n"
main = [
 (0, "session_meta", {"id": SID, "session_id": SID, "timestamp": iso(T0), "cwd": CWD, "originator": "codex_exec", "cli_version": "0.166.0", "source": "exec", "thread_source": "user", "model_provider": "openai", "base_instructions": {"text": "synthetic"}}),
 (1, "turn_context", {"turn_id": T1, "cwd": CWD, "model": "gpt-5.5", "effort": "medium"}),
 (2, "event_msg", {"type": "task_started", "turn_id": T1, "started_at": (T0+2)//1000}),
 (10,) + item(10, {"type": "UserMessage", "id": "um-1", "content": [{"type": "text", "text": "Fix the failing test", "text_elements": []}]}),
 (800, "response_item", {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "x"}),
 (900, "response_item", {"type": "function_call", "status": "completed", "id": "fc_1", "name": "exec_command", "arguments": json.dumps({"cmd": "npx vitest run"}), "call_id": "call_1"}),
 (950, "token_usage_record", {"thread_id": SID, "turn_id": T1, "session_id": SID, "response_id": "resp_1", "usage": usage(5000, 4000, 120, 64)}),
 (3000, "response_item", {"type": "function_call_output", "call_id": "call_1", "output": VITEST_FAIL}),
 (3600, "response_item", {"type": "reasoning", "id": "rs_2", "summary": [], "encrypted_content": "x"}),
 (4000, "response_item", {"type": "custom_tool_call", "status": "completed", "id": "ctc_2", "name": "apply_patch", "input": PATCH, "call_id": "call_2"}),
 (4050, "token_usage_record", {"thread_id": SID, "turn_id": T1, "session_id": SID, "response_id": "resp_2", "usage": usage(6000, 5000, 80, 10, 200)}),
 (4150,) + item(4150, {"type": "FileChange", "id": "call_2", "changes": {CWD + "/src/math.ts": {"type": "update", "unified_diff": "@@ -1 +1 @@\n-  return a - b;\n+  return a + b;\n", "move_path": None}}, "status": "completed"}, 4100, 4150),
 (4200, "response_item", {"type": "custom_tool_call_output", "call_id": "call_2", "output": [{"type": "input_text", "text": "Success. Updated the following files:\nM src/math.ts"}]}),
 (7000,) + item(7000, {"type": "CommandExecution", "id": "exec-1", "command": ["/bin/zsh", "-lc", "npx vitest run"], "cwd": CWD, "status": "completed", "exit_code": 0, "aggregated_output": VITEST_OK}, 5000, 7000),
 (7500, "response_item", {"type": "function_call", "status": "completed", "id": "fc_3", "name": "spawn_agent", "namespace": "collaboration", "arguments": json.dumps({"task_name": "audit"}), "call_id": "call_3"}),
 (7600, "response_item", {"type": "function_call_output", "call_id": "call_3", "output": json.dumps({"task_name": "audit"})}),
 (8300,) + item(8300, {"type": "McpToolCall", "id": "mcp-1", "server": "docs", "tool": "search", "arguments": {"q": "vitest"}, "status": "completed", "result": {"content": [{"type": "text", "text": "found 2 pages"}]}}, 8000, 8300),
 (9000, "token_usage_record", {"thread_id": SID, "turn_id": T1, "session_id": SID, "response_id": "resp_3", "usage": usage(7000, 6500, 40)}),
 (9100,) + item(9100, {"type": "AgentMessage", "id": "am-1", "content": [{"type": "Text", "text": "Fixed: add() now adds; all 6 tests pass."}], "phase": "final_answer"}),
 (9200, "event_msg", {"type": "task_complete", "turn_id": T1, "last_agent_message": "Fixed", "started_at": T0//1000, "completed_at": (T0+9200)//1000, "duration_ms": 9200, "time_to_first_token_ms": 790}),
 (9500, "compacted", {"message": "", "window_number": 2, "window_id": "win-2"}),
 (9600, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(18000, 15500, 240), "last_token_usage": usage(7000, 6500, 40)}}),
]
sub = [
 (7550, "session_meta", {"id": SUB, "session_id": SID, "parent_thread_id": SID, "forked_from_id": SID, "timestamp": iso(T0+7550), "cwd": CWD, "originator": "codex_exec", "cli_version": "0.166.0", "source": {"subagent": {"thread_spawn": {"parent_thread_id": SID, "depth": 1, "agent_path": "/root/audit", "agent_role": "explorer"}}}, "thread_source": "subagent", "agent_role": "explorer", "agent_path": "/root/audit", "model_provider": "openai", "subagent_history_start_ordinal": 3}),
 (10,) + item(10, {"type": "UserMessage", "id": "um-1", "content": [{"type": "text", "text": "Fix the failing test"}]}, thread=SUB),
 (11, "event_msg", {"type": "task_started", "turn_id": T1}),
 (7560, "turn_context", {"turn_id": T9, "cwd": CWD, "model": "gpt-5.5-mini"}),
 (7561, "event_msg", {"type": "task_started", "turn_id": T9}),
 (7570,) + item(7570, {"type": "UserMessage", "id": "um-s1", "content": [{"type": "text", "text": "Audit callers of add()"}]}, turn=T9, thread=SUB),
 (7900, "response_item", {"type": "function_call", "status": "completed", "id": "fc_s1", "name": "exec_command", "arguments": json.dumps({"cmd": "rg -n 'add\\('"}), "call_id": "call_s1"}),
 (7950, "token_usage_record", {"thread_id": SUB, "turn_id": T9, "session_id": SID, "response_id": "resp_s1", "usage": usage(900, 0, 30)}),
 (8100, "response_item", {"type": "function_call_output", "call_id": "call_s1", "output": "src/math.ts:1:export function add(a, b) {"}),
 (8400, "token_usage_record", {"thread_id": SUB, "turn_id": T9, "session_id": SID, "response_id": "resp_s2", "usage": usage(1000, 800, 25)}),
 (8450,) + item(8450, {"type": "AgentMessage", "id": "am-s1", "content": [{"type": "Text", "text": "One caller: src/math.ts."}], "phase": "final_answer"}, turn=T9, thread=SUB),
 (8500, "event_msg", {"type": "task_complete", "turn_id": T9, "duration_ms": 939}),
]
old = [
 (0, "session_meta", {"id": OLD, "timestamp": iso(T0), "cwd": CWD, "originator": "codex_cli_rs", "cli_version": "0.40.0", "source": "cli", "model_provider": "openai"}),
 (1, "turn_context", {"cwd": CWD, "model": "gpt-5"}),
 (5, "event_msg", {"type": "user_message", "message": "Run the tests", "kind": "plain"}),
 (5, "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Run the tests"}]}),
 (700, "response_item", {"type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["bash", "-lc", "pytest -q"]}), "call_id": "call_o1"}),
 (750, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(800, 0, 20), "last_token_usage": usage(800, 0, 20)}}),
 (760, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(800, 0, 20), "last_token_usage": usage(800, 0, 20)}}),
 (770, "event_msg", {"type": "token_count", "info": None}),
 (1500, "response_item", {"type": "function_call_output", "call_id": "call_o1", "output": json.dumps({"output": "F...\n1 failed, 3 passed in 0.20s\n", "metadata": {"exit_code": 1, "duration_seconds": 0.5}})}),
 (2500, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(1800, 600, 50), "last_token_usage": usage(1000, 600, 30)}}),
 (2600, "event_msg", {"type": "agent_message", "message": "One test fails: test_div."}),
 (2700, "event_msg", {"type": "task_complete", "turn_id": "old-turn", "last_agent_message": "One test fails"}),
]
def write(path, recs, ordinals=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for i, r in enumerate(recs): f.write(json.dumps(R(r[0], r[1], r[2], i if ordinals else None)) + "\n")
base = "codex/home/sessions/2026/11/01"
write(f"{base}/rollout-2026-11-01T10-00-00-{SID}.jsonl", main)
write(f"{base}/rollout-2026-11-01T10-00-07-{SUB}.jsonl", sub)
write(f"{base}/rollout-2026-11-01T09-00-00-{OLD}.jsonl", old, ordinals=False)
F = "${FIXTURES}/" + base
def H(t, ev, raw): return {"v": 0, "agent": "codex", "event": ev, "ts": T0+t, "pid": 9000+t % 97, "ppid": 8999, "cwd": CWD, "raw": {"session_id": SID, "cwd": CWD, "hook_event_name": ev, "model": "gpt-5.5", "transcript_path": f"{F}/rollout-2026-11-01T10-00-00-{SID}.jsonl", "permission_mode": "bypassPermissions", **raw}}
spool = [
 H(1, "SessionStart", {"source": "startup"}),
 H(9, "UserPromptSubmit", {"turn_id": T1, "prompt": "Fix the failing test"}),
 H(901, "PreToolUse", {"turn_id": T1, "tool_name": "Bash", "tool_use_id": "call_1", "tool_input": {"command": "npx vitest run"}}),
 H(3001, "PostToolUse", {"turn_id": T1, "tool_name": "Bash", "tool_use_id": "call_1", "tool_input": {"command": "npx vitest run"}, "tool_response": VITEST_FAIL}),
 H(4001, "PreToolUse", {"turn_id": T1, "tool_name": "apply_patch", "tool_use_id": "call_2", "tool_input": {"command": PATCH}}),
 H(4201, "PostToolUse", {"turn_id": T1, "tool_name": "apply_patch", "tool_use_id": "call_2", "tool_input": {"command": PATCH}, "tool_response": "Success. Updated the following files:\nM src/math.ts"}),
 H(7540, "SubagentStart", {"turn_id": T1, "agent_id": SUB, "agent_type": "explorer"}),
 H(7901, "PreToolUse", {"turn_id": T9, "agent_id": SUB, "agent_type": "explorer", "tool_name": "Bash", "tool_use_id": "call_s1", "tool_input": {"command": "rg -n 'add\\('"}}),
 H(8600, "SubagentStop", {"turn_id": T1, "agent_id": SUB, "agent_type": "explorer", "agent_transcript_path": f"{F}/rollout-2026-11-01T10-00-07-{SUB}.jsonl", "last_assistant_message": "One caller: src/math.ts.", "stop_hook_active": False}),
 H(9150, "Stop", {"turn_id": T1, "last_assistant_message": "Fixed: add() now adds; all 6 tests pass.", "stop_hook_active": False}),
 H(9400, "PreCompact", {"turn_id": T1, "trigger": "auto"}),
 H(9900, "SessionEnd", {"reason": "other"}),
]
open("codex/hooks.spool.jsonl", "w").write("".join(json.dumps(x) + "\n" for x in spool))

# Code mode (codex-rs tools/code_mode): the model calls one `exec` tool with JS; each
# tool the cell calls is a nested call `exec-<uuid>` with its own item_completed, written
# between the exec call and its output. Cell 1 runs two commands and prints only the
# first; the second exits 2 and its record lands just after the cell's output. Cell 2 yields ("Script running with cell
# ID 7"); its command finishes during `wait`. Cell 3's MCP call fails and the script goes on.
CM = "0193dddd-1111-7222-8333-444455556666"; TC = "turn-cm-01"
EA = "exec-0a0a0a0a-0000-4000-8000-000000000001"; EB = "exec-0b0b0b0b-0000-4000-8000-000000000002"; EC = "exec-0c0c0c0c-0000-4000-8000-000000000003"; ED = "exec-0d0d0d0d-0000-4000-8000-000000000004"
def cmd(id, c, code, out): return {"type": "CommandExecution", "id": id, "command": ["/bin/zsh", "-lc", c], "cwd": CWD, "source": "unified_exec_startup", "status": "completed", "exit_code": code, "aggregated_output": out}
def cell_out(status, *chunks): return [{"type": "input_text", "text": f"{status}\nWall time 0.1 seconds\nOutput:\n"}] + [{"type": "input_text", "text": json.dumps(c)} for c in chunks]
LINT = "text(await tools.exec_command({cmd:\"npm run lint\"}));\nawait tools.exec_command({cmd:\"npm test\"});\n"
BUILD = "text(await tools.exec_command({cmd:\"make build\", yield_time_ms: 100}));\n"
SEARCH = "try { text(await tools.mcp__docs__search({q:\"lint rules\"})); } catch { text(\"no results\"); }\n"
cm = [
 (0, "session_meta", {"id": CM, "session_id": CM, "timestamp": iso(T0), "cwd": CWD, "originator": "codex_exec", "cli_version": "0.166.0", "source": "exec", "model_provider": "openai"}),
 (1, "turn_context", {"turn_id": TC, "cwd": CWD, "model": "gpt-5.5"}),
 (2, "event_msg", {"type": "task_started", "turn_id": TC}),
 (10,) + item(10, {"type": "UserMessage", "id": "um-cm", "content": [{"type": "text", "text": "Run lint and tests"}]}, turn=TC, thread=CM),
 (1000, "response_item", {"type": "custom_tool_call", "status": "completed", "id": "ctc_c1", "call_id": "call_c1", "name": "exec", "input": LINT}),
 (1050, "token_usage_record", {"thread_id": CM, "turn_id": TC, "session_id": CM, "response_id": "resp_c1", "usage": usage(3000, 2000, 60)}),
 (1500,) + item(1500, cmd(EA, "npm run lint", 0, "lint ok\n"), 1100, 1500, turn=TC, thread=CM),
 (3010, "response_item", {"type": "custom_tool_call_output", "call_id": "call_c1", "output": cell_out("Script completed", {"exit_code": 0, "output": "lint ok\n"})}),
 (3020,) + item(3020, cmd(EB, "npm test", 2, "1 test failed\n"), 1600, 3000, turn=TC, thread=CM),
 (4000, "response_item", {"type": "custom_tool_call", "status": "completed", "id": "ctc_c2", "call_id": "call_c2", "name": "exec", "input": BUILD}),
 (4050, "token_usage_record", {"thread_id": CM, "turn_id": TC, "session_id": CM, "response_id": "resp_c2", "usage": usage(3500, 3000, 40)}),
 (4200, "response_item", {"type": "custom_tool_call_output", "call_id": "call_c2", "output": cell_out("Script running with cell ID 7")}),
 (6000, "response_item", {"type": "function_call", "status": "completed", "id": "fc_w1", "call_id": "call_w1", "name": "wait", "arguments": json.dumps({"cell_id": "7", "yield_time_ms": 5000})}),
 (8000,) + item(8000, cmd(EC, "make build", 0, "built\n"), 4100, 8000, turn=TC, thread=CM),
 (8010, "response_item", {"type": "function_call_output", "call_id": "call_w1", "output": cell_out("Script completed", {"exit_code": 0, "output": "built\n"})}),
 (8500, "response_item", {"type": "custom_tool_call", "status": "completed", "id": "ctc_c3", "call_id": "call_c3", "name": "exec", "input": SEARCH}),
 (8700,) + item(8700, {"type": "McpToolCall", "id": ED, "server": "docs", "tool": "search", "arguments": {"q": "lint rules"}, "status": "failed", "error": {"message": "search unavailable"}}, 8550, 8700, turn=TC, thread=CM),
 (8710, "response_item", {"type": "custom_tool_call_output", "call_id": "call_c3", "output": cell_out("Script completed", "no results")}),
 (9000, "token_usage_record", {"thread_id": CM, "turn_id": TC, "session_id": CM, "response_id": "resp_c3", "usage": usage(4000, 3500, 30)}),
 (9100,) + item(9100, {"type": "AgentMessage", "id": "am-cm", "content": [{"type": "Text", "text": "Lint passes; one test fails; the build works."}], "phase": "final_answer"}, turn=TC, thread=CM),
 (9200, "event_msg", {"type": "task_complete", "turn_id": TC, "duration_ms": 9200}),
]
write(f"codex/code-mode/rollout-2026-11-01T10-00-00-{CM}.jsonl", cm)
FC = "${FIXTURES}/codex/code-mode"
def HC(t, ev, raw): return H(t, ev, {"session_id": CM, "transcript_path": f"{FC}/rollout-2026-11-01T10-00-00-{CM}.jsonl", "turn_id": TC, **raw})
cm_spool = [
 HC(1101, "PreToolUse", {"tool_name": "Bash", "tool_use_id": EA, "tool_input": {"command": "npm run lint"}}),
 HC(1501, "PostToolUse", {"tool_name": "Bash", "tool_use_id": EA, "tool_input": {"command": "npm run lint"}, "tool_response": {"exit_code": 0, "output": "lint ok\n"}}),
 HC(1601, "PreToolUse", {"tool_name": "Bash", "tool_use_id": EB, "tool_input": {"command": "npm test"}}),
 HC(3001, "PostToolUse", {"tool_name": "Bash", "tool_use_id": EB, "tool_input": {"command": "npm test"}, "tool_response": {"exit_code": 2, "output": "1 test failed\n"}}),
 HC(4101, "PreToolUse", {"tool_name": "Bash", "tool_use_id": EC, "tool_input": {"command": "make build"}}),
 HC(8001, "PostToolUse", {"tool_name": "Bash", "tool_use_id": EC, "tool_input": {"command": "make build"}, "tool_response": {"exit_code": 0, "output": "built\n"}}),
 HC(8551, "PreToolUse", {"tool_name": "mcp__docs__search", "tool_use_id": ED, "tool_input": {"q": "lint rules"}}),
]
open("codex/code-mode/hooks.spool.jsonl", "w").write("".join(json.dumps(x) + "\n" for x in cm_spool))
