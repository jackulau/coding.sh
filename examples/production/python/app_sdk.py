"""J2 (SDK path): one OpenAI call and one Anthropic call in conversation session "j2-sdk".

    pip install coding-sh openai anthropic          # or: pip install -e packages/sdk-python
    CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=csh_ik_... python app_sdk.py

The base URLs default to the shared mock LLM (examples/production/mock-llm, port 9999), so this
runs without real API keys. Against the real APIs, drop base_url/api_key and use real models.
"""

import os

import coding_sh
from anthropic import Anthropic
from openai import OpenAI

# The two lines that attach coding.sh to an app.
openai_client = coding_sh.observe(
    OpenAI(base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:9999/v1"), api_key=os.environ.get("OPENAI_API_KEY", "mock"))
)
claude = coding_sh.observe(
    Anthropic(base_url=os.environ.get("ANTHROPIC_BASE_URL", "http://127.0.0.1:9999"), api_key=os.environ.get("ANTHROPIC_API_KEY", "mock"))
)

session = os.environ.get("SESSION_ID", "j2-sdk")
question = [{"role": "user", "content": "ping"}]

with coding_sh.trace("j2", session_id=session, input="ping"):
    r1 = openai_client.chat.completions.create(model=os.environ.get("OPENAI_MODEL", "mock-gpt"), messages=question)
    print(r1.choices[0].message.content)
    r2 = claude.messages.create(model=os.environ.get("ANTHROPIC_MODEL", "mock-claude"), max_tokens=64, messages=question)
    print(r2.content[0].text)

# Scripts exit right away; the atexit flush would also send this (bounded to 2 s).
coding_sh.flush(5)
