// Build-time helpers for shell blocks in the docs (Code.astro, Terminal.astro).
// Nothing here runs in the browser.

const PROMPT = /^\$ /;

/**
 * The commands of a transcript, for its Copy button: the "$ " lines without
 * the prompt, and the lines a trailing backslash continues. Output lines are
 * left out. Undefined when no line starts with "$ ", so the block copies its
 * own text.
 */
export function promptCommands(text: string): string | undefined {
  const lines = text.split("\n");
  if (!lines.some((l) => PROMPT.test(l))) return undefined;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PROMPT.test(lines[i]!)) continue;
    out.push(lines[i]!.slice(2));
    while (out.at(-1)!.endsWith("\\") && i + 1 < lines.length) out.push(lines[++i]!);
  }
  return out.join("\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'" };

/** The text of an HTML fragment: tags dropped, the common entities decoded. */
export function htmlText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e: string) => ENTITIES[e]!);
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, s: string) => `<span class="sh-${cls}">${escHtml(s)}</span>`;

/**
 * A sh/bash block as HTML, coloured by four classes (doc.css): sh-cmd for the
 * command word, sh-flag for an option, sh-str for a quoted string and sh-com
 * for a comment. Everything else is escaped text. In a "$ " transcript only
 * the commands are coloured; the output lines stay plain. A heredoc body is
 * left plain. Built once at build time, so the browser runs nothing.
 */
export function shellHtml(text: string): string {
  const lines = text.split("\n");
  const transcript = lines.some((l) => PROMPT.test(l));
  let continued = false;
  let heredoc: string | undefined;
  return lines
    .map((line) => {
      if (heredoc !== undefined) {
        if (line.trim() === heredoc) heredoc = undefined;
        return escHtml(line);
      }
      let lead = "";
      if (transcript && !continued) {
        if (!PROMPT.test(line)) return escHtml(line);
        lead = "$ ";
        line = line.slice(2);
      }
      const out = lead + colourLine(line, !continued);
      continued = line.endsWith("\\");
      heredoc = /<<-?\s*(['"]?)(\w+)\1/.exec(line)?.[2];
      return out;
    })
    .join("\n");
}

/** One line of shell; `start` when its first word is a command, not a continued argument. */
function colourLine(line: string, start: boolean): string {
  let out = "";
  let expect = start;
  for (let i = 0; i < line.length; ) {
    const ch = line[i]!;
    const rest = line.slice(i);
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)![0];
      out += m;
      i += m.length;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      out += span("com", rest);
      break;
    } else if (ch === "'" || ch === '"') {
      const m = (ch === "'" ? /^'[^']*'?/ : /^"(?:\\.|[^"\\])*"?/).exec(rest)![0];
      out += span("str", m);
      i += m.length;
      expect = false;
    } else if (/^(?:\|\|?|&&?|;|\$?\()/.test(rest) && !(ch === "&" && /[<>]/.test(line[i - 1] ?? ""))) {
      const m = /^(?:\|\|?|&&?|;|\$?\()/.exec(rest)![0];
      out += escHtml(m);
      i += m.length;
      expect = true;
    } else {
      const m = /^[^\s'"|&;()]+/.exec(rest)?.[0] ?? ch;
      i += m.length;
      if (expect && !/^\w+=/.test(m) && !/^[<>\d]/.test(m) && m !== "\\") {
        out += span("cmd", m);
        expect = false;
      } else if (/^--?[\w-]/.test(m) && !expect) out += span("flag", m);
      else out += escHtml(m);
    }
  }
  return out;
}
