// A guard for tests that must never reach a real provider: every socket connect to a
// host that is not loopback fails with ECONNREFUSED, and the attempt is recorded.
import net from "node:net";

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|\[::1\])$/;

/** Blocks non-loopback connects until the returned function runs. `blocked` lists the hosts that were tried. */
export function blockRemoteSockets(): { blocked: string[]; restore: () => void } {
  const blocked: string[] = [];
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // net.connect() hands over the already normalized [options, callback] pair.
    const a0 = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; path?: string; port?: number } | number | string | undefined;
    const host = typeof a0 === "object" && a0 !== null ? a0.host : typeof a0 === "number" ? (typeof args[1] === "string" ? args[1] : "localhost") : undefined;
    const isIpc = typeof a0 === "object" && a0 !== null && a0.path !== undefined && a0.host === undefined && a0.port === undefined; // an https request options bag also carries the URL path
    if (!isIpc && typeof a0 !== "string" && !(host === undefined ? true : LOOPBACK.test(host))) {
      blocked.push(host ?? "?");
      queueMicrotask(() => this.destroy(Object.assign(new Error(`blocked by the test: connect ${host}`), { code: "ECONNREFUSED" })));
      return this;
    }
    return (orig as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return { blocked, restore: () => void (net.Socket.prototype.connect = orig) };
}
