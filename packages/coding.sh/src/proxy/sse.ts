// Incremental Server-Sent Events parser for the proxy's side copy of a stream.
// The client gets the upstream bytes untouched; this only reads a copy, so it
// never holds a chunk back. Handles events split across chunks, CRLF/CR/LF line
// ends, multi-line data and UTF-8 sequences cut at a chunk boundary.

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buf = "";
  private event: string | undefined;
  private data: string[] = [];
  /** Data seen so far, in characters (a stream that is not SSE stops being parsed past the cap). */
  private seen = 0;

  /** Feeds one chunk; returns the events it completed. */
  push(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.seen += text.length;
    this.buf += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (;;) {
      const nl = this.lineEnd(start);
      if (nl < 0) break;
      const line = this.buf.slice(start, nl);
      // A CR at the very end of the buffer may be the first half of CRLF: wait for more.
      if (this.buf[nl] === "\r" && nl + 1 === this.buf.length) break;
      start = nl + (this.buf[nl] === "\r" && this.buf[nl + 1] === "\n" ? 2 : 1);
      this.line(line, out);
    }
    this.buf = start ? this.buf.slice(start) : this.buf;
    return out;
  }

  /** Flushes a final event that had no trailing blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    const rest = this.decoder.decode();
    if (rest) this.buf += rest;
    if (this.buf) this.line(this.buf.replace(/\r$/, ""), out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  get chars(): number {
    return this.seen;
  }

  private lineEnd(from: number): number {
    const n = this.buf.indexOf("\n", from);
    const r = this.buf.indexOf("\r", from);
    if (n < 0) return r;
    if (r < 0) return n;
    return Math.min(n, r);
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length) {
        const ev: SseEvent = { data: this.data.join("\n") };
        if (this.event) ev.event = this.event;
        out.push(ev);
      }
      this.data = [];
      this.event = undefined;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
  }
}
