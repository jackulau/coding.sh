// Shared shapes for the agent-free model driver (§4.2, §11).
import type { Usage } from "../../schema/index.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason?: string;
  ttftMs?: number;
  ttfThinkingMs?: number;
  responseModel?: string;
  /** Provider-specific assistant content to append to the history. */
  raw: unknown;
}

export interface Conversation {
  /** One streamed model call over the current history. */
  call(signal?: AbortSignal): Promise<ModelTurn>;
  /** Appends the assistant turn and its tool results to the history. */
  pushToolResults(turn: ModelTurn, results: ToolResult[]): void;
}

export interface ConversationInit {
  model: string;
  system: string;
  instruction: string;
  tools: ToolDef[];
  apiKey: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
  fetch: typeof fetch;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly body: string;
  constructor(status: number, body: string, retryAfter?: string | null) {
    super(`provider HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    if (retryAfter) {
      const s = Number(retryAfter);
      const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(ms) && ms >= 0) this.retryAfterMs = ms;
    }
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
  /** A 400 that names the tool schema: counted apart from agent failures. */
  get schemaRejected(): boolean {
    return this.status === 400 && /schema|input_schema|parameters|tools\.\d+/i.test(this.body);
  }
}

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function safeToolName(name: string, taken: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base.slice(0, 60)}_${i}`;
  taken.add(n);
  base = n;
  return base;
}
