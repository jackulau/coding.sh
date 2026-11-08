// MCP prompts: the improve loop as two user messages a client can offer (in
// Claude Code, /mcp__coding-sh__improve and /mcp__coding-sh__did-it-help).
import type { PromptDef } from "./protocol.ts";

const inRepo = (a: Record<string, string>) => (a.repo ? ` with repo ${JSON.stringify(a.repo)}` : "");

export function buildPrompts(): PromptDef[] {
  return [
    {
      name: "improve",
      title: "Improve my agent setup",
      description: "Find what goes wrong most in this repo's agent sessions and the CLAUDE.md or AGENTS.md line that fixes it.",
      arguments: [{ name: "repo", description: "A repo path or folder name. Default: the repo the server runs in." }],
      render: (a) =>
        [
          `Call the coding.sh improve tool${inRepo(a)}.`,
          "Take the first issue. Open its example session with session_get and check the problem is real, in one or two sentences.",
          "If the issue has a line, show me the line and the file it goes in, and add it only if I say yes. If it has no line (a broken command or test), tell me what to fix instead.",
          "Then tell me how to keep it: commit the file, and after a few new sessions ask whether the change helped (the harness_changes tool).",
          "If improve's changes list shows an earlier change, give its verdict in one sentence.",
        ].join("\n"),
    },
    {
      name: "did-it-help",
      title: "Did my CLAUDE.md change help?",
      description: "Whether a committed CLAUDE.md, AGENTS.md, rule or skill change made the agent's sessions better, from the sessions before and after it.",
      arguments: [
        { name: "commit", description: "The change's commit sha. Default: the recent changes." },
        { name: "repo", description: "A repo path or folder name. Default: the repo the server runs in." },
      ],
      render: (a) =>
        [
          `Call the coding.sh harness_changes tool${inRepo(a)}${a.commit ? ` and commit ${JSON.stringify(a.commit)}` : ""}.`,
          "For each change, give the verdict in one sentence with the counts behind it: flagged sessions before and after, and how often the agent followed each new line.",
          'If the verdict is "too-early" or "no-sessions-after", say so plainly: the answer needs more sessions with the change (at least 5).',
          "List the sessions still flagged after it (after.flaggedSessions) with their flags. If it regressed, open the newest of them with session_get and say what went wrong.",
          "Do not claim more than the numbers show.",
        ].join("\n"),
    },
  ];
}
