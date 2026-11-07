export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; input?: unknown }[];
  usage?: { input: number; output: number; cacheRead?: number };
  status?: number;
  retryAfter?: number;
  message?: string;
  delayMs?: number;
}
export interface FakeProvider {
  url: string;
  requests: { path: string | undefined; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[];
  close(): Promise<void>;
}
export function startFakeProvider(script: FakeTurn[] | ((body: Record<string, unknown>, n: number) => FakeTurn | undefined), opts?: { model?: string }): Promise<FakeProvider>;
