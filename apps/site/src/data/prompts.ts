// The quick start's prompts: what a person pastes into their agent to set coding.sh up, and a first
// task that uses it. Each setup prompt says how to run each step and how to check it worked. Every
// command named here is in the CLI reference (/docs/cli) or the SDK reference (/docs/sdk).

export interface QuickstartPath {
  id: string;
  label: string;
  /** Paste into your agent: install, wire up, verify. */
  setup: string;
  /** Then ask your agent this. */
  first: string;
}

const STOP = "If a release-age policy or a permission error blocks an install, stop and ask me instead of changing it.";
// npm also installs an extensionless sh script named coding.sh, and PowerShell and cmd open it instead of
// running coding.sh.cmd. codingsh is the same CLI (docs/guides/install.md#windows).
const WIN = "On Windows, in PowerShell or cmd, run codingsh instead of coding.sh.";

export const SETUP_PROMPT = `Set up coding.sh on this machine. It needs Node.js 22.16 or newer. ${WIN}

1. Install the CLI: npm install -g coding.sh. ${STOP}
2. Run coding.sh init --dry-run and show me the plan. When I agree, run coding.sh init --yes. It adds a capture hook and the coding.sh MCP server to each agent it finds, and imports their past sessions.
3. Verify with coding.sh doctor --json. Fix what it reports, or tell me what it needs from me. Codex runs new hooks only after I approve them with /hooks in Codex: never write its trust state yourself.
4. Tell me which agents you set up, and that a session started before init is not recorded live, so I should start a new one.

For anything this misses, follow https://coding.sh/agents.md`;

const sdkSetup = (lang: "TypeScript" | "Python") => {
  const ts = lang === "TypeScript";
  const pkg = ts ? "@codingdotsh/sdk with the project's package manager" : "coding-sh with the project's package manager (pip install coding-sh)";
  const wrap = ts
    ? `import { observe } from "@codingdotsh/sdk" and wrap each OpenAI or Anthropic client the agent creates: observe(new OpenAI()).`
    : `import coding_sh and wrap each OpenAI or Anthropic client the agent creates: coding_sh.observe(OpenAI()). Call coding_sh.flush() before a script exits.`;
  return `Add coding.sh tracing to the ${lang} agent in this project. ${WIN}

1. Install the coding.sh CLI (npm install -g coding.sh, Node.js 22.16 or newer) and ${pkg}. ${STOP}
2. Read https://coding.sh/docs/sdk.md. Then ${wrap} Change nothing else in the agent.
3. Start coding.sh serve in another terminal and leave it running. Where the agent runs, set CODING_SH_URL=http://127.0.0.1:4318 and CODING_SH_SERVICE to a short lowercase name such as support-bot. Without CODING_SH_URL the SDK does nothing, so the code is safe to ship.
4. Verify: run the agent once, then coding.sh sessions --agent <that name> --json. Each model call outside trace() is its own session, with its tokens and cost. Tell me the session ids and what they recorded.`;
};

const SDK_FIRST = `Run my agent on three different inputs. Then use coding.sh sessions and coding.sh show to tell me which run cost the most, which was slowest, and why. Quote the numbers coding.sh printed. ${WIN}`;

export const FIRST_PROMPT = `Use coding.sh to look at my agent sessions from the last 7 days. Run coding.sh improve --repo all and tell me the top problem, the sessions it comes from, and the AGENTS.md line it proposes. Don't edit AGENTS.md until I say so. ${WIN}`;

export const QUICKSTART_PATHS: QuickstartPath[] = [
  { id: "coding-agents", label: "Coding agents", setup: SETUP_PROMPT, first: FIRST_PROMPT },
  { id: "typescript", label: "TypeScript agent", setup: sdkSetup("TypeScript"), first: SDK_FIRST },
  { id: "python", label: "Python agent", setup: sdkSetup("Python"), first: SDK_FIRST },
];
