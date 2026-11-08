// Tool output the agent's harness cut before the model saw it. Our own storage
// clip (clipText → `truncated`) is a different thing: this is what the model got.
//
// Read from the delivered text (Codex's function_call_output, Claude Code's
// tool_result), never from the produced output a hook sees:
// - codex-head: `Warning: truncated output (original token count: N)` (Codex
//   exec_command and code-mode cells), usually with a middle elision too;
// - middle: `…N tokens truncated…` or `…N chars truncated…` alone;
// - persisted: Claude Code's `<persisted-output>Output too large (737.4KB). Full
//   output saved to: <path>` with a 2 KB preview (the model can page the file);
// - lines: `[... omitted N of M lines ...]`;
// - marker: `[truncated N bytes]`, `…[N characters omitted]…`.
// One pass of bounded regexes; JSON.parse only on a body that starts with { or [.

export interface OutputCut {
  by: "codex-head" | "middle" | "persisted" | "lines" | "marker";
  /** Size of the output before the cut, as the harness reported it. */
  originalTokens?: number;
  originalBytes?: number;
  /** What the harness elided: Codex's middle marker counts tokens or characters. */
  cutTokens?: number;
  cutChars?: number;
  /** Lines the harness omitted (lines). */
  omittedLines?: number;
  /** Bytes of the text the model got. */
  deliveredBytes: number;
  /** The body was JSON (or JSON lines) and no longer parses. */
  jsonBroken?: true;
  /** Where Claude Code saved the full output (persisted). */
  savedTo?: string;
}

const HEAD = /Warning: truncated output \(original token count: (\d+)\)/;
const MIDDLE = /…(\d+) (tokens|chars) truncated…?/;
const PERSISTED = /<persisted-output>\s*Output too large \(([\d.]+) ?(B|KB|MB|GB)\)\. Full output saved to: (\S+)/;
const LINES = /\[\.\.\. omitted (\d+) of (\d+) lines \.\.\.\]/;
const MARKER = /\[truncated (\d+) bytes\]|…\[(\d+) characters omitted\]…/;
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
/** Lines Codex writes before a command's output (exec_command, code-mode cells). */
const PREAMBLE = /^(?:Chunk ID:|Wall time|Process exited with code|Process running with session ID|Original token count:|Output:|Script (?:completed|running|failed|errored)\b|Warning: truncated output|Total output lines:)/;

/** The cut in a tool output the model got, or undefined when the harness delivered it whole. */
export function outputCutOf(text: string): OutputCut | undefined {
  if (!text) return undefined;
  const persisted = PERSISTED.exec(text);
  if (persisted) {
    return { by: "persisted", originalBytes: Math.round(Number(persisted[1]) * UNITS[persisted[2]!]!), deliveredBytes: Buffer.byteLength(text), savedTo: persisted[3] };
  }
  const head = HEAD.exec(text);
  const middle = MIDDLE.exec(text);
  const lines = head || middle ? null : LINES.exec(text);
  const marker = head || middle || lines ? null : MARKER.exec(text);
  if (!head && !middle && !lines && !marker) return undefined;
  const deliveredBytes = Buffer.byteLength(text);
  const cut: OutputCut = { by: head ? "codex-head" : middle ? "middle" : lines ? "lines" : "marker", deliveredBytes };
  if (head) cut.originalTokens = Number(head[1]);
  if (middle) {
    if (middle[2] === "tokens") cut.cutTokens = Number(middle[1]);
    else cut.cutChars = Number(middle[1]);
  }
  if (lines) cut.omittedLines = Number(lines[1]);
  if (marker) {
    if (marker[1] !== undefined) cut.originalBytes = deliveredBytes + Number(marker[1]);
    else cut.cutChars = Number(marker[2]);
  }
  if (jsonBroken(text)) cut.jsonBroken = true;
  return cut;
}

/** The body after Codex's preamble starts like JSON, and neither it nor each of its lines parses. */
function jsonBroken(text: string): boolean {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (PREAMBLE.test(lines[i]!) || !lines[i]!.trim())) i++;
  const body = lines.slice(i).join("\n").trim();
  if (body[0] !== "{" && body[0] !== "[") return false;
  if (parses(body)) return false;
  // JSON lines: broken unless every line parses, leaving out a line that is only the harness's marker.
  const rows = body.split("\n").filter((l) => l.trim() && !MARKER_LINE.test(l));
  return rows.length < 2 || !rows.every(parses);
}

const MARKER_LINE = /^\s*(?:…\d+ (?:tokens|chars) truncated…?|\[\.\.\. omitted \d+ of \d+ lines \.\.\.\]|\[truncated \d+ bytes\]|…\[\d+ characters omitted\]…)\s*$/;

const parses = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
