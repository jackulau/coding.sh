// Server-sent events: an incremental parser for streamed model responses and
// MCP Streamable HTTP replies. Only the fields we use: event, data, id.

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/** Incremental parser: feed text chunks, get completed events. */
export class SseParser {
  private buf = "";
  private cur: { event?: string; data: string[]; id?: string } = { data: [] };

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let i: number;
    while ((i = this.buf.search(/\r?\n/)) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + (this.buf[i] === "\r" ? 2 : 1));
      this.line(line, out);
    }
    return out;
  }

  /** Flushes a final event that had no trailing blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.cur.data.length || this.cur.event) {
        const e: SseEvent = { data: this.cur.data.join("\n") };
        if (this.cur.event) e.event = this.cur.event;
        if (this.cur.id !== undefined) e.id = this.cur.id;
        out.push(e);
      }
      this.cur = { data: [] };
      return;
    }
    if (line.startsWith(":")) return;
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.cur.data.push(value);
    else if (field === "event") this.cur.event = value;
    else if (field === "id") this.cur.id = value;
  }
}

export function parseSse(text: string): SseEvent[] {
  const p = new SseParser();
  return [...p.push(text), ...p.end()];
}

/** Events from a fetch body as they arrive. */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) return;
  const decoder = new TextDecoder();
  const p = new SseParser();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const e of p.push(decoder.decode(value, { stream: true }))) yield e;
    }
    for (const e of p.push(decoder.decode())) yield e;
    for (const e of p.end()) yield e;
  } finally {
    reader.releaseLock();
  }
}
