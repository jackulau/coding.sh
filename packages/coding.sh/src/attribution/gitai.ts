// git-ai authorship notes (refs/notes/ai, Git AI Standard v3), read as a
// second attribution source. A note is an attestation section (a path at
// column 0, then "  <key> <ranges>" lines), a line "---", and JSON metadata
// that resolves each key to an agent (`sessions`, legacy `prompts`) or a
// person (`humans`). Line numbers refer to the file in the noted commit.
// Human keys are skipped: attribution only names agents.

export interface GitAiRange {
  path: string;
  /** Inclusive 1-based line ranges. */
  ranges: [number, number][];
  /** git-ai's agent id: the conversation id the tool reported. */
  sessionId?: string;
  /** git-ai's tool name ("claude", "cursor", "codex", …). */
  tool?: string;
  model?: string;
}

/** git-ai tool names → coding.sh agent ids. Unknown names pass through. */
const TOOL_AGENT: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  "github-copilot": "copilot-cli",
  copilot: "copilot-cli",
  opencode: "opencode",
  amp: "amp",
  droid: "droid",
  goose: "goose",
  aider: "aider",
};

export function gitAiAgent(tool: string | undefined): string {
  if (!tool) return "unknown";
  return TOOL_AGENT[tool.toLowerCase()] ?? tool.toLowerCase();
}

function unquote(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** "1-10,15,20-22" → [[1,10],[15,15],[20,22]]; undefined when malformed. */
export function parseRangeSpec(spec: string): [number, number][] | undefined {
  const out: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return undefined;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 1 || b < a) return undefined;
    out.push([a, b]);
  }
  return out.length ? out : undefined;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The agent ranges of one git-ai note. Malformed notes give []. */
export function parseGitAiNote(text: string): GitAiRange[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sep = lines.indexOf("---");
  if (sep < 0) return [];
  let meta: Obj;
  try {
    meta = obj(JSON.parse(lines.slice(sep + 1).join("\n")));
  } catch {
    return [];
  }
  const sessions = obj(meta.sessions);
  const prompts = obj(meta.prompts);
  const agentOf = (key: string): Obj | undefined => {
    if (key.startsWith("h_")) return undefined;
    const sid = key.includes("::") ? key.slice(0, key.indexOf("::")) : key;
    const rec = obj(sessions[sid] ?? prompts[sid]);
    const a = obj(rec.agent_id);
    return Object.keys(a).length ? a : undefined;
  };
  const out: GitAiRange[] = [];
  let path: string | undefined;
  for (const l of lines.slice(0, sep)) {
    if (!l.trim()) continue;
    if (!l.startsWith(" ")) {
      path = unquote(l.trimEnd());
      continue;
    }
    if (!path) continue;
    const m = /^ {2}(\S+) (\S+)$/.exec(l.trimEnd());
    if (!m) continue;
    const agent = agentOf(m[1]!);
    const ranges = parseRangeSpec(m[2]!);
    if (!agent || !ranges) continue;
    out.push({ path, ranges, sessionId: str(agent.id), tool: str(agent.tool), model: str(agent.model) });
  }
  return out;
}
