# Synthetic Cursor CLI hook payloads (field names per cursor.com/docs/agent/hooks).
import json, os
T0 = 1793527200000
CID = "c0ffee00-1111-4222-8333-444455556666"; CWD = "/work/demo"
common = {"conversation_id": CID, "generation_id": CID + "-g1", "model": "gpt-5.1-codex", "cursor_version": "2026.10.30-abc1234", "workspace_roots": [CWD], "user_email": "dev@example.invalid", "transcript_path": None}
def L(t, ev, raw): return {"v":0,"agent":"cursor","event":ev,"ts":T0+t,"pid":7000+t%89,"ppid":6999,"cwd":os.path.expanduser("~/.cursor").replace(os.path.expanduser("~"),"/home/dev"),"raw":{**common,"hook_event_name":ev,**raw}}
jest = "PASS src/a.test.js\nFAIL src/b.test.js\n\nTests:       1 failed, 1 skipped, 7 passed, 9 total\nTime:        1.2 s\n"
spool = [
 L(0,"sessionStart",{"session_id":CID,"is_background_agent":False,"composer_mode":"agent"}),
 L(100,"beforeSubmitPrompt",{"prompt":"Fix the failing test in b.test.js","attachments":[]}),
 L(2100,"postToolUse",{"tool_name":"Read","tool_input":{"path":"/work/demo/src/b.js"},"tool_use_id":"call_r1","cwd":CWD,"tool_output":"{\"content\":\"export const b = 1;\\n\"}","duration":40}),
 L(4000,"afterFileEdit",{"file_path":"/work/demo/src/b.js","edits":[{"old_string":"export const b = 1;","new_string":"export const b = 2;\nexport const c = 3;"}]}),
 L(9000,"postToolUse",{"tool_name":"Shell","tool_input":{"command":"npx jest"},"tool_use_id":"call_s1","cwd":CWD,"tool_output":json.dumps({"exitCode":1,"stdout":jest,"stderr":""}),"duration":3500}),
 L(9500,"postToolUseFailure",{"tool_name":"Shell","tool_input":{"command":"rm -rf build"},"tool_use_id":"call_s2","cwd":CWD,"error_message":"Command rejected by user","failure_type":"permission_denied","duration":5,"is_interrupt":False}),
 L(9800,"postToolUse",{"tool_name":"Delete","tool_input":{"path":"/work/demo/tmp.txt"},"tool_use_id":"call_d1","cwd":CWD,"tool_output":"{}","duration":3}),
 L(15000,"subagentStop",{"subagent_type":"explore","status":"completed","task":"Find other users of b","description":"Search for b","summary":"Only src/b.test.js uses b.","duration_ms":4000,"message_count":3,"tool_call_count":2,"loop_count":0,"modified_files":[],"agent_transcript_path":"/home/dev/.cursor/projects/work-demo/agent-transcripts/sub-9999.jsonl"}),
 L(16000,"afterAgentResponse",{"text":"Fixed: b is now 2 and the jest suite passes except one skipped test."}),
 L(16010,"stop",{"status":"completed","loop_count":0}),
 L(17000,"preCompact",{"trigger":"auto","context_usage_percent":91.5,"context_tokens":183000,"context_window_size":200000,"message_count":44,"messages_to_compact":30,"is_first_compaction":True}),
 L(30000,"sessionEnd",{"session_id":CID,"reason":"user_exit","duration_ms":30000,"is_background_agent":False,"final_status":"completed"}),
]
open("cursor/hooks.spool.jsonl","w").write("".join(json.dumps(x)+"\n" for x in spool))
d = "cursor/config/projects/work-demo/agent-transcripts/" + CID
os.makedirs(d, exist_ok=True)
lines = [
 {"role":"user","message":{"content":[{"type":"text","text":"Fix the failing test in b.test.js"}]}},
 {"role":"assistant","message":{"content":[{"type":"text","text":"Looking at src/b.js first."}]}},
 {"role":"assistant","message":{"content":[{"type":"text","text":"Fixed: b is now 2."}]}},
]
open(f"{d}/{CID}.jsonl","w").write("".join(json.dumps(x)+"\n" for x in lines))
