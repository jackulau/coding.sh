// The quickstart's example agent: a script that labels a coding.sh GitHub issue.
// scripts/shots/seed-docs.mjs runs this exact TypeScript file with the SDK (OpenAI
// calls go to scripts/e2e/stub-model.mjs) for the docs/sdk-session screenshot, so
// the code on the page and the run in the picture agree.

export const TRIAGE_SYSTEM = "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.";
export const TRIAGE_ISSUE = "Viewer search misses tool output";
export const TRIAGE_MODEL = "gpt-5-mini";
export const TRIAGE_ANSWER = "bug, viewer";

export const TRIAGE_TS = `import OpenAI from "openai";
import { observe } from "@codingdotsh/sdk";

// observe() records each call: the messages, the answer, tokens, latency and cost.
const openai = observe(new OpenAI());

const issue = process.argv[2] ?? "${TRIAGE_ISSUE}";
const res = await openai.chat.completions.create({
  model: "${TRIAGE_MODEL}",
  messages: [
    { role: "system", content: "${TRIAGE_SYSTEM}" },
    { role: "user", content: issue },
  ],
});
console.log(res.choices[0].message.content);`;

export const TRIAGE_PY = `import sys

import coding_sh
from openai import OpenAI

# observe() records each call: the messages, the answer, tokens, latency and cost.
client = coding_sh.observe(OpenAI())

issue = sys.argv[1] if len(sys.argv) > 1 else "${TRIAGE_ISSUE}"
res = client.chat.completions.create(
    model="${TRIAGE_MODEL}",
    messages=[
        {"role": "system", "content": "${TRIAGE_SYSTEM}"},
        {"role": "user", "content": issue},
    ],
)
print(res.choices[0].message.content)
coding_sh.flush()  # send before the script exits`;

// The same agent on Anthropic's client: system and max_tokens are their own fields,
// and the answer is a content block.
export const TRIAGE_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export const TRIAGE_ANTHROPIC_TS = `import Anthropic from "@anthropic-ai/sdk";
import { observe } from "@codingdotsh/sdk";

// observe() records each call: the messages, the answer, tokens, latency and cost.
const anthropic = observe(new Anthropic());

const issue = process.argv[2] ?? "${TRIAGE_ISSUE}";
const res = await anthropic.messages.create({
  model: "${TRIAGE_ANTHROPIC_MODEL}",
  max_tokens: 1024,
  system: "${TRIAGE_SYSTEM}",
  messages: [{ role: "user", content: issue }],
});
console.log(res.content[0].text);`;

export const TRIAGE_ANTHROPIC_PY = `import sys

import coding_sh
from anthropic import Anthropic

# observe() records each call: the messages, the answer, tokens, latency and cost.
client = coding_sh.observe(Anthropic())

issue = sys.argv[1] if len(sys.argv) > 1 else "${TRIAGE_ISSUE}"
res = client.messages.create(
    model="${TRIAGE_ANTHROPIC_MODEL}",
    max_tokens=1024,
    system="${TRIAGE_SYSTEM}",
    messages=[{"role": "user", "content": issue}],
)
print(res.content[0].text)
coding_sh.flush()  # send before the script exits`;
