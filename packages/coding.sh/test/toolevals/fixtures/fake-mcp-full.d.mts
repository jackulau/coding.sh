export const TOOLS: { name: string; description: string; inputSchema: object; execution?: { taskSupport: string } }[];
export const GUIDE: string;
export interface FullHttpServer {
  url: string;
  origin: string;
  log: Record<string, unknown>[];
  oauthLog: Record<string, unknown>[];
  close(): Promise<void>;
}
export function startFullHttp(opts?: { oauth?: boolean }): Promise<FullHttpServer>;
