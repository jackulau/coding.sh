// An agent's final answer from its headless stdout: the last stream-json line
// that carries a text result (Claude's `result`, Codex's `item.text`, …), else
// the raw stdout. Shared by `bench` contenders and the eval runner.

export function agentAnswerText(stdout: string): string {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      for (const k of ["result", "text", "message", "content"]) if (typeof o[k] === "string") return o[k] as string;
      const item = o.item as Record<string, unknown> | undefined;
      if (item && typeof item.text === "string") return item.text;
    } catch {
      // not JSON: keep looking
    }
  }
  return stdout.trim();
}
