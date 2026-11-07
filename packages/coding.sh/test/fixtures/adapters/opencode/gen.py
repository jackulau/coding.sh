# Synthetic OpenCode fixtures: spool lines as the coding.sh plugin forwards them
# (v2 and v1 flavours) and a 1.x JSON storage tree for backfill.
import json, os
T0 = 1793527200000; CWD = "/work/demo"
def L(t, ev, raw, api=2): return {"v":0,"agent":"opencode","event":ev,"ts":T0+t,"pid":8000+t%83,"ppid":7999,"cwd":CWD,"raw":{"cwd":CWD,"api":api,**raw}}
pytest_out = "....F.\nFAILED tests/test_calc.py::test_div - ZeroDivisionError\n==== 1 failed, 10 passed, 2 skipped in 0.52s ====\n"
v2 = [
 L(0,"session.created",{"sessionID":"ses_main","id":"evt_1","created":T0,"data":{"id":"ses_main","title":"Fix division","version":"2.2.5","model":{"providerID":"anthropic","id":"claude-sonnet-4-5"}}}),
 L(1000,"tool.execute.before",{"sessionID":"ses_main","tool":"bash","id":"call_1","messageID":"msg_a1","agent":"build","input":{"command":"pytest -q","description":"Run tests"}}),
 L(2200,"tool.execute.after",{"sessionID":"ses_main","tool":"bash","id":"call_1","messageID":"msg_a1","agent":"build","input":{"command":"pytest -q"},"status":"completed","result":{"output":pytest_out,"metadata":{"exit":1}},"durationMs":1200}),
 L(3000,"tool.execute.before",{"sessionID":"ses_main","tool":"edit","id":"call_2","input":{"filePath":"/work/demo/calc.py","oldString":"return a / b","newString":"if b == 0:\n        return None\n    return a / b"}}),
 L(3100,"tool.execute.after",{"sessionID":"ses_main","tool":"edit","id":"call_2","input":{"filePath":"/work/demo/calc.py","oldString":"return a / b","newString":"if b == 0:\n        return None\n    return a / b"},"status":"completed","result":{"output":"Edit applied"},"durationMs":100}),
 L(3200,"tool.execute.after",{"sessionID":"ses_main","tool":"write","id":"call_3","input":{"filePath":"/work/demo/notes.md","content":"x"},"status":"error","error":"permission denied","durationMs":5}),
 L(4000,"session.step.ended",{"sessionID":"ses_main","id":"evt_7","created":T0+4000,"durationMs":2400,"data":{"assistantMessageID":"msg_a1","finish":"tool-calls","cost":0.0123,"tokens":{"input":1000,"output":200,"reasoning":50,"cache":{"read":3000,"write":0}}}}),
 L(4500,"session.created",{"sessionID":"ses_child","parentSessionID":"ses_main","id":"evt_8","created":T0+4500,"data":{"id":"ses_child","parentID":"ses_main","agent":"general","title":"Search callers"}}),
 L(5000,"tool.execute.before",{"sessionID":"ses_child","parentSessionID":"ses_main","tool":"grep","id":"call_c1","input":{"pattern":"divide("}}),
 L(6000,"session.execution.succeeded",{"sessionID":"ses_child","parentSessionID":"ses_main","id":"evt_10","created":T0+6000,"durationMs":1500,"data":{}}),
 L(8000,"session.text.ended",{"sessionID":"ses_main","id":"evt_11","created":T0+8000,"data":{"text":"Division by zero now returns None; all tests pass."}}),
 L(8100,"session.execution.succeeded",{"sessionID":"ses_main","id":"evt_12","created":T0+8100,"durationMs":8100,"data":{}}),
 L(9000,"session.compaction.ended",{"sessionID":"ses_main","id":"evt_13","created":T0+9000,"data":{}}),
]
v1 = [
 L(0,"session.created",{"sessionID":"ses_v1","data":{"id":"ses_v1","title":"Add README","directory":CWD,"version":"1.0.150"}},api=1),
 L(10,"message.part.updated",{"sessionID":"ses_v1","data":{"id":"prt_u1","messageID":"msg_u1","role":"user","text":"Write a README"}},api=1),
 L(500,"tool.execute.before",{"sessionID":"ses_v1","tool":"write","id":"call_v1","input":{"filePath":"/work/demo/README.md","content":"# Demo\n\nHello.\n"}},api=1),
 L(600,"tool.execute.after",{"sessionID":"ses_v1","tool":"write","id":"call_v1","input":{"filePath":"/work/demo/README.md","content":"# Demo\n\nHello.\n"},"status":"completed","result":{"output":"","title":"README.md"},"durationMs":100},api=1),
 L(1500,"message.part.updated",{"sessionID":"ses_v1","data":{"id":"prt_a1","messageID":"msg_a1","role":"assistant","text":"Added README.md.","time":{"start":T0+1400,"end":T0+1500}}},api=1),
 L(1510,"message.updated",{"sessionID":"ses_v1","data":{"id":"msg_a1","role":"assistant","modelID":"gpt-5","providerID":"openai","time":{"created":T0+20,"completed":T0+1505},"tokens":{"input":800,"output":120,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.004,"finish":"stop"}},api=1),
 L(1600,"session.idle",{"sessionID":"ses_v1","data":{"sessionID":"ses_v1"}},api=1),
]
open("opencode/v2.spool.jsonl","w").write("".join(json.dumps(x)+"\n" for x in v2))
open("opencode/v1.spool.jsonl","w").write("".join(json.dumps(x)+"\n" for x in v1))
st = "opencode/data/opencode/storage"
def W(p, o): os.makedirs(os.path.dirname(p), exist_ok=True); json.dump(o, open(p,"w"), indent=1)
W(f"{st}/session/prj_1/ses_v1.json", {"id":"ses_v1","projectID":"prj_1","directory":CWD,"title":"Add README","version":"1.0.150","time":{"created":T0,"updated":T0+1600}})
W(f"{st}/session/prj_1/ses_v1c.json", {"id":"ses_v1c","projectID":"prj_1","parentID":"ses_v1","directory":CWD,"title":"Subtask","version":"1.0.150","time":{"created":T0+700,"updated":T0+900}})
W(f"{st}/message/ses_v1/msg_u1.json", {"id":"msg_u1","sessionID":"ses_v1","role":"user","time":{"created":T0+10}})
W(f"{st}/message/ses_v1/msg_a1.json", {"id":"msg_a1","sessionID":"ses_v1","role":"assistant","modelID":"gpt-5","providerID":"openai","time":{"created":T0+20,"completed":T0+1505},"tokens":{"input":800,"output":120,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.004,"finish":"stop"})
W(f"{st}/part/msg_u1/prt_u1.json", {"id":"prt_u1","messageID":"msg_u1","sessionID":"ses_v1","type":"text","text":"Write a README"})
W(f"{st}/part/msg_a1/prt_0t1.json", {"id":"prt_0t1","messageID":"msg_a1","sessionID":"ses_v1","type":"tool","callID":"call_v1","tool":"write","state":{"status":"completed","input":{"filePath":"/work/demo/README.md","content":"# Demo\n\nHello.\n"},"output":"","title":"README.md","time":{"start":T0+500,"end":T0+600}}})
W(f"{st}/part/msg_a1/prt_a1.json", {"id":"prt_a1","messageID":"msg_a1","sessionID":"ses_v1","type":"text","text":"Added README.md.","time":{"start":T0+1400,"end":T0+1500}})
