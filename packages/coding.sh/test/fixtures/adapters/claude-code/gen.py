# Generates the synthetic Claude Code fixtures (no real user content).
import json, os, datetime
T0 = int(datetime.datetime(2026,11,1,10,0,0,tzinfo=datetime.timezone.utc).timestamp()*1000)
def iso(ms): return datetime.datetime.fromtimestamp(ms/1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.')+f"{ms%1000:03d}Z"
SID="11111111-2222-4333-8444-555555555555"; CWD="/work/demo"; V="2.1.300"
base=dict(sessionId=SID, cwd=CWD, version=V, gitBranch="main", userType="external", entrypoint="cli")
def usage(i,o,cr=0,cw=0): return {"input_tokens":i,"output_tokens":o,"cache_read_input_tokens":cr,"cache_creation_input_tokens":cw}
def A(uuid, t, mid, content, u, stop=None, model="claude-opus-4-5"):
    return {**base, "type":"assistant","uuid":uuid,"parentUuid":None,"timestamp":iso(T0+t),"requestId":"req_"+mid,
            "message":{"id":mid,"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"usage":u}}
def U(uuid, t, content, **kw):
    return {**base, "type":"user","uuid":uuid,"parentUuid":None,"timestamp":iso(T0+t),"message":{"role":"user","content":content}, **kw}
vitest_out = "\n RUN  v3.2.4 /work/demo\n\n ✓ sum.test.js (3 tests) 4ms\n ✗ sum.test.js > handles strings\n\n Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)\n   Start at  10:00:03\n"
main = [
 {"type":"mode","mode":"default","sessionId":SID},
 U("u1",0,"Add a sum function in sum.js and run the tests", promptId="p1"),
 {**base,"type":"attachment","uuid":"att1","timestamp":iso(T0+10),"attachment":{"type":"date"}},
 A("a1",1200,"msg_01",[{"type":"text","text":"I'll create sum.js."}],usage(1200,40,8000,500)),
 A("a2",1500,"msg_01",[{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"/work/demo/sum.js","content":"export function sum(a, b) {\n  return a + b;\n}\n"}}],usage(1200,90,8000,500),stop="tool_use"),
 U("u2",1600,[{"type":"tool_result","tool_use_id":"toolu_01","content":"File created successfully at: /work/demo/sum.js","is_error":False}], toolUseResult={"type":"create","filePath":"/work/demo/sum.js","content":"..."}),
 A("a3",2600,"msg_02",[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"npx vitest run","description":"Run tests"}}],usage(50,30,9200,0),stop="tool_use"),
 U("u3",4600,[{"type":"tool_result","tool_use_id":"toolu_02","content":"Error: Exit code 1"+vitest_out,"is_error":True}], toolUseResult="Error: Exit code 1"+vitest_out),
 A("a4",5400,"msg_03",[{"type":"tool_use","id":"toolu_03","name":"Edit","input":{"file_path":"/work/demo/sum.js","old_string":"  return a + b;","new_string":"  return Number(a) + Number(b);"}}],usage(60,55,9300,0),stop="tool_use"),
 U("u4",5500,[{"type":"tool_result","tool_use_id":"toolu_03","content":"The file /work/demo/sum.js has been updated.","is_error":False}], toolUseResult={"filePath":"/work/demo/sum.js","oldString":"  return a + b;","newString":"  return Number(a) + Number(b);"}),
 A("a5",6000,"msg_04",[{"type":"tool_use","id":"toolu_04","name":"Agent","input":{"description":"Find callers","prompt":"List files that import sum.js","subagent_type":"Explore"}}],usage(40,60,9400,0),stop="tool_use"),
 U("u5",9000,[{"type":"tool_result","tool_use_id":"toolu_04","content":[{"type":"text","text":"Only sum.test.js imports sum.js."}]}], toolUseResult={"status":"completed","agentId":"abc123"}),
 A("a6",9800,"msg_05",[{"type":"text","text":"Done: sum.js now coerces inputs and all tests pass."}],usage(30,25,9500,0),stop="end_turn"),
 {**base,"type":"system","subtype":"turn_duration","uuid":"s1","timestamp":iso(T0+9900),"durationMs":9900,"isMeta":True},
 {**base,"type":"system","subtype":"compact_boundary","uuid":"s2","timestamp":iso(T0+20000),"content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":120000,"postTokens":9000,"durationMs":3000}},
 U("u6",20001,"This session is being continued from a previous conversation...", isCompactSummary=True),
 U("u7",30000,"Thanks!", promptId="p2"),
 A("a7",31000,"msg_06",[{"type":"text","text":"You're welcome."}],usage(10,5,9000,0),stop="end_turn"),
 {"type":"ai-title","aiTitle":"Sum function","sessionId":SID},
]
sub_base = {**base, "isSidechain": True, "agentId":"abc123"}
sub = [
 {**sub_base,"type":"user","uuid":"su1","timestamp":iso(T0+6100),"promptId":"p1","message":{"role":"user","content":"List files that import sum.js"}},
 {**sub_base,"type":"assistant","uuid":"sa1","timestamp":iso(T0+7000),"message":{"id":"msg_s1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"tool_use","id":"toolu_s1","name":"Grep","input":{"pattern":"from './sum","path":"/work/demo"}}],"stop_reason":"tool_use","usage":usage(300,20,0,0)}},
 {**sub_base,"type":"user","uuid":"su2","timestamp":iso(T0+7200),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_s1","content":"sum.test.js"}]}},
 {**sub_base,"type":"assistant","uuid":"sa2","timestamp":iso(T0+8800),"message":{"id":"msg_s2","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Only sum.test.js imports sum.js."}],"stop_reason":"end_turn","usage":usage(320,12,0,0)}},
]
d = "config/projects/-work-demo"
os.makedirs(f"{d}/{SID}/subagents", exist_ok=True)
open(f"{d}/{SID}.jsonl","w").write("".join(json.dumps(x)+"\n" for x in main))
open(f"{d}/{SID}/subagents/agent-abc123.jsonl","w").write("".join(json.dumps(x)+"\n" for x in sub))
json.dump({"agentType":"Explore","description":"Find callers","toolUseId":"toolu_04","finished":True}, open(f"{d}/{SID}/subagents/agent-abc123.meta.json","w"))
TP="${FIXTURES}/claude-code/"+d+f"/{SID}.jsonl"
STP="${FIXTURES}/claude-code/"+d+f"/{SID}/subagents/agent-abc123.jsonl"
common = {"session_id":SID,"transcript_path":TP,"cwd":CWD,"permission_mode":"default"}
def L(t, ev, raw, pid=4000): return {"v":0,"agent":"claude-code","event":ev,"ts":T0+t,"pid":pid+t%97,"ppid":3999,"cwd":CWD,"raw":{**common,"hook_event_name":ev,**raw}}
spool = [
 L(-50,"SessionStart",{"source":"startup","model":"claude-opus-4-5"}),
 L(5,"UserPromptSubmit",{"prompt":"Add a sum function in sum.js and run the tests"}),
 L(1510,"PreToolUse",{"tool_name":"Write","tool_use_id":"toolu_01","tool_input":main[4]["message"]["content"][0]["input"]}),
 L(1590,"PostToolUse",{"tool_name":"Write","tool_use_id":"toolu_01","tool_input":main[4]["message"]["content"][0]["input"],"tool_response":{"type":"create","filePath":"/work/demo/sum.js","content":"export function sum(a, b) {\n  return a + b;\n}\n","structuredPatch":[]}}),
 L(2610,"PreToolUse",{"tool_name":"Bash","tool_use_id":"toolu_02","tool_input":{"command":"npx vitest run","description":"Run tests"}}),
 L(4590,"PostToolUseFailure",{"tool_name":"Bash","tool_use_id":"toolu_02","tool_input":{"command":"npx vitest run","description":"Run tests"},"error":"Exit code 1"+vitest_out,"is_interrupt":False}),
 L(5410,"PreToolUse",{"tool_name":"Edit","tool_use_id":"toolu_03","tool_input":main[8]["message"]["content"][0]["input"]}),
 L(5490,"PostToolUse",{"tool_name":"Edit","tool_use_id":"toolu_03","tool_input":main[8]["message"]["content"][0]["input"],"tool_response":{"filePath":"/work/demo/sum.js","oldString":"  return a + b;","newString":"  return Number(a) + Number(b);"}}),
 L(6010,"PreToolUse",{"tool_name":"Agent","tool_use_id":"toolu_04","tool_input":main[10]["message"]["content"][0]["input"]}),
 L(6050,"SubagentStart",{"agent_id":"abc123","agent_type":"Explore"}),
 L(7010,"PreToolUse",{"tool_name":"Grep","tool_use_id":"toolu_s1","tool_input":{"pattern":"from './sum","path":"/work/demo"},"agent_id":"abc123","agent_type":"Explore"}),
 L(7190,"PostToolUse",{"tool_name":"Grep","tool_use_id":"toolu_s1","tool_input":{"pattern":"from './sum","path":"/work/demo"},"tool_response":{"mode":"files_with_matches","filenames":["sum.test.js"],"numFiles":1},"agent_id":"abc123","agent_type":"Explore"}),
 L(8900,"SubagentStop",{"agent_id":"abc123","agent_type":"Explore","agent_transcript_path":STP,"stop_hook_active":False,"last_assistant_message":"Only sum.test.js imports sum.js."}),
 L(8990,"PostToolUse",{"tool_name":"Agent","tool_use_id":"toolu_04","tool_input":main[10]["message"]["content"][0]["input"],"tool_response":{"status":"completed","content":[{"type":"text","text":"Only sum.test.js imports sum.js."}]}}),
 L(9850,"Stop",{"stop_hook_active":False,"last_assistant_message":"Done: sum.js now coerces inputs and all tests pass."}),
 L(19000,"PreCompact",{"trigger":"manual","custom_instructions":""}),
 L(29000,"Notification",{"message":"Claude is waiting for your input","notification_type":"idle_prompt"}),
 L(40000,"SessionEnd",{"reason":"prompt_input_exit"}),
 # Cursor firing the same Claude hook (third-party hooks): must be dropped.
 {"v":0,"agent":"claude-code","event":"PreToolUse","ts":T0+41000,"pid":5001,"cwd":CWD,"raw":{"conversation_id":"c-1","generation_id":"g-1","cursor_version":"1.7.0","workspace_roots":[CWD],"hook_event_name":"PreToolUse","tool_name":"Shell","tool_input":{"command":"ls"}}},
]
open("hooks.spool.jsonl","w").write("".join(json.dumps(x)+"\n" for x in spool))
