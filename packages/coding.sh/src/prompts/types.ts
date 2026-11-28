// Types for the local-first versioned prompt registry (src/prompts).
// Erasable TypeScript only: no enums, namespaces or parameter properties.

export const PROMPT_ROLES = ["system", "user", "assistant"] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

export interface PromptMessage {
  role: PromptRole;
  content: string;
}

export interface PromptConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PromptContentText {
  type: "text";
  template: string;
}

export interface PromptContentChat {
  type: "chat";
  messages: PromptMessage[];
}

export type PromptContent = PromptContentText | PromptContentChat;

export interface PromptVersionBase {
  slug: string;
  name: string;
  /** Monotonic version label: "v1", "v2", ... */
  version: string;
  /** Numeric version counter: 1, 2, ... */
  versionNumber: number;
  /** SHA-256 hex digest of canonical content and config. */
  hash: string;
  /** Epoch milliseconds when this version was stored. */
  createdAt: number;
  note?: string;
  config?: PromptConfig;
  /** Sorted unique {{var}} names extracted from the template or messages. */
  variables: string[];
}

export type PromptVersion =
  | (PromptVersionBase & PromptContentText)
  | (PromptVersionBase & PromptContentChat);

export interface PromptVersionMeta {
  version: string;
  versionNumber: number;
  hash: string;
  type: "text" | "chat";
  createdAt: number;
  note?: string;
}

/** Mutable label pointers, e.g. { latest: "v2", production: "v1", staging: "v2" }. */
export type PromptLabels = Record<string, string>;

export interface PromptListing {
  slug: string;
  name: string;
  type: "text" | "chat";
  latest: string;
  versions: number;
  labels: PromptLabels;
  updatedAt: number;
}

export interface PutPromptInput {
  name: string;
  type: "text" | "chat";
  template?: string;
  messages?: readonly PromptMessage[];
  config?: PromptConfig;
  note?: string;
  labels?: readonly string[];
  now?: number;
}

export interface PutPromptResult {
  created: boolean;
  version: PromptVersion;
  labels: PromptLabels;
}

export interface RenderPromptOptions {
  allowMissing?: boolean;
}

export type RenderedPrompt =
  | { type: "text"; text: string }
  | { type: "chat"; messages: PromptMessage[] };

export interface PromptDiffLine {
  kind: "context" | "add" | "remove";
  line: string;
}

export interface PromptDiff {
  slug: string;
  from: { ref: string; version: string; hash: string };
  to: { ref: string; version: string; hash: string };
  identical: boolean;
  added: number;
  removed: number;
  lines: PromptDiffLine[];
  unified: string;
}
