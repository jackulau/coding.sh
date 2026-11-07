// Raw Markdown -> HTML with the syntax tinted, for the AGENT view. The text is
// shown as written (an agent reads it verbatim); only markers, headings, links
// and code get classes. Loaded on demand, never on a plain page view.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  // Split out `code` first so link syntax inside it stays literal.
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<span class="md-code">${esc(part)}</span>`;
      return esc(part)
        .replace(
          /\[([^\]]+)\]\(([^)\s]+)\)/g,
          (_, text, url) =>
            `<span class="md-mk">[</span>${/^(https?:\/\/|\/)/.test(url) ? `<a class="md-link" href="${url.replace(/"/g, "%22")}">${text}</a>` : `<strong>${text}</strong>`}<span class="md-mk">](</span><span class="md-url">${url}</span><span class="md-mk">)</span>`,
        )
        .replace(/\*\*([^*]+)\*\*/g, '<span class="md-mk">**</span><strong>$1</strong><span class="md-mk">**</span>');
    })
    .join("");
}

export function highlight(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  // YAML frontmatter.
  if (lines[0] === "---") {
    out.push('<span class="md-mk">---</span>');
    for (i = 1; i < lines.length && lines[i] !== "---"; i++) {
      const m = lines[i].match(/^([\w-]+):(.*)$/);
      out.push(m ? `<span class="md-key">${esc(m[1])}:</span><span class="md-val">${esc(m[2])}</span>` : `<span class="md-val">${esc(lines[i])}</span>`);
    }
    if (i < lines.length) out.push('<span class="md-mk">---</span>');
    i++;
  }

  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^(`{3,})(.*)$/);
    if (fence) {
      if (f && f[1].length >= fence.length && !f[2].trim()) {
        out.push(`<span class="md-mk">${esc(line)}</span>`);
        fence = null;
      } else out.push(`<span class="md-pre">${esc(line)}</span>`);
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(`<span class="md-mk">${esc(line)}</span>`);
      continue;
    }
    const h = line.match(/^(#{1,6}) (.*)$/);
    if (h) {
      out.push(`<span class="md-h md-h${h[1].length}"><span class="md-mk">${h[1]}</span> ${inline(h[2])}</span>`);
      continue;
    }
    const q = line.match(/^(>\s?)(.*)$/);
    if (q) {
      out.push(`<span class="md-mk">${esc(q[1])}</span><span class="md-quote">${inline(q[2])}</span>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)(\s.*)$/);
    if (li) {
      out.push(`${li[1]}<span class="md-mk">${esc(li[2])}</span>${inline(li[3])}`);
      continue;
    }
    if (/^\|/.test(line)) {
      out.push(esc(line).replace(/\|/g, '<span class="md-mk">|</span>'));
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n");
}
