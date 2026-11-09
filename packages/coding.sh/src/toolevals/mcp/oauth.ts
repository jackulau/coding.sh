// OAuth for MCP over HTTP (§10.4), as the 2025-06-18+ authorization spec lays
// it out: on a 401 the client reads the protected-resource metadata (RFC 9728,
// from the WWW-Authenticate `resource_metadata` URL or the well-known path),
// then the authorization server's metadata (RFC 8414, or OpenID discovery),
// registers itself when no client id is configured (RFC 7591), and gets a
// token for the resource (RFC 8707 `resource`).
//
// Grants: client_credentials, or authorization_code with PKCE (S256) against
// an authorization server that redirects straight back (a local stub, or a
// client the server pre-approves): nothing opens a browser, and a login page
// is an error. Tokens live in memory for the process, per resource and
// client; they are never written to the tap, the store or a log.
import { createHash, randomBytes } from "node:crypto";

export interface OAuthConfig {
  /** A registered client; without one the client registers itself (dynamic client registration). */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  grant?: "authorization_code" | "client_credentials";
  /** Where the authorization server sends the code. Nothing listens there: the redirect's Location is read. */
  redirectUri?: string;
  fetch?: typeof fetch;
}

export class OAuthError extends Error {
  readonly reason: string;
  constructor(message: string, reason = "oauth_failed") {
    super(message);
    this.name = "OAuthError";
    this.reason = reason;
  }
}

export const DEFAULT_REDIRECT = "http://127.0.0.1:33418/callback";
const MAX_REDIRECTS = 5;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `key="value"` parameters of a WWW-Authenticate Bearer challenge. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  return out;
}

/** Well-known URLs for a resource or issuer, path-inserted first (RFC 8414 §3.1, RFC 9728 §3.1). */
function wellKnown(url: string, suffix: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  const out = path && path !== "/" ? [`${u.origin}/.well-known/${suffix}${path}`] : [];
  out.push(`${u.origin}/.well-known/${suffix}`);
  return out;
}

/** OAuth state for one process: a token per (resource, client). */
export class OAuthSession {
  private readonly cfg: OAuthConfig;
  private readonly tokens = new Map<string, string>();
  private client?: { id: string; secret?: string };

  constructor(cfg: OAuthConfig = {}) {
    this.cfg = cfg;
    if (cfg.clientId) this.client = { id: cfg.clientId, ...(cfg.clientSecret ? { secret: cfg.clientSecret } : {}) };
  }

  /** The Authorization header for an MCP URL, once authorized. */
  authorization(mcpUrl: string): string | undefined {
    const t = this.tokens.get(new URL(mcpUrl).origin + new URL(mcpUrl).pathname);
    return t ? `Bearer ${t}` : undefined;
  }

  private get fetch(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }

  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown> | undefined> {
    const r = await this.fetch(url, init);
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return undefined;
    }
    const v = (await r.json().catch(() => undefined)) as unknown;
    return isObj(v) ? v : undefined;
  }

  private async firstJson(urls: string[]): Promise<Record<string, unknown> | undefined> {
    for (const u of urls) {
      const v = await this.json(u, { headers: { Accept: "application/json" } }).catch(() => undefined);
      if (v) return v;
    }
    return undefined;
  }

  /** Runs discovery, registration and the grant after a 401 from `mcpUrl`. */
  async authorize(mcpUrl: string, wwwAuthenticate: string): Promise<void> {
    const challenge = parseChallenge(wwwAuthenticate);
    const prmUrls = challenge.resource_metadata ? [challenge.resource_metadata] : wellKnown(mcpUrl, "oauth-protected-resource");
    const prm = await this.firstJson(prmUrls);
    if (!prm) throw new OAuthError(`MCP server ${mcpUrl} answered 401 but has no protected-resource metadata (tried ${prmUrls.join(", ")})`, "oauth_discovery");
    const issuer = Array.isArray(prm.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? prm.authorization_servers[0] : undefined;
    if (!issuer) throw new OAuthError(`protected-resource metadata for ${mcpUrl} names no authorization server`, "oauth_discovery");
    const as = await this.firstJson([...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration"), `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`]);
    if (!as || typeof as.token_endpoint !== "string") throw new OAuthError(`authorization server ${issuer} has no metadata with a token_endpoint`, "oauth_discovery");
    const resource = typeof prm.resource === "string" ? prm.resource : mcpUrl;
    const scope = challenge.scope ?? this.cfg.scope ?? (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === "string").join(" ") : "");
    const grant = this.cfg.grant ?? "authorization_code";
    const redirectUri = this.cfg.redirectUri ?? DEFAULT_REDIRECT;
    const client = this.client ?? (await this.register(as, grant, redirectUri));
    this.client = client;

    const form: Record<string, string> = { client_id: client.id, resource, ...(scope ? { scope } : {}), ...(client.secret ? { client_secret: client.secret } : {}) };
    if (grant === "client_credentials") form.grant_type = "client_credentials";
    else {
      if (typeof as.authorization_endpoint !== "string") throw new OAuthError(`authorization server ${issuer} has no authorization_endpoint`, "oauth_discovery");
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(16));
      const challengeS256 = b64url(createHash("sha256").update(verifier).digest());
      const auth = new URL(as.authorization_endpoint);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: client.id, redirect_uri: redirectUri, state, code_challenge: challengeS256, code_challenge_method: "S256", resource, ...(scope ? { scope } : {}) })) auth.searchParams.set(k, v);
      const code = await this.followToCode(auth.toString(), redirectUri, state);
      Object.assign(form, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    }
    const r = await this.fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form).toString() });
    const body = (await r.json().catch(() => undefined)) as unknown;
    if (!r.ok || !isObj(body) || typeof body.access_token !== "string") {
      const why = isObj(body) && typeof body.error === "string" ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}` : `HTTP ${r.status}`;
      throw new OAuthError(`token request to ${as.token_endpoint} failed (${why})`, "oauth_token");
    }
    const u = new URL(mcpUrl);
    this.tokens.set(u.origin + u.pathname, body.access_token);
  }

  private async register(as: Record<string, unknown>, grant: string, redirectUri: string): Promise<{ id: string; secret?: string }> {
    if (typeof as.registration_endpoint !== "string") throw new OAuthError("the authorization server has no registration_endpoint; set oauth.clientId on the target", "oauth_client");
    const r = await this.fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: "coding.sh toolevals", redirect_uris: [redirectUri], grant_types: grant === "client_credentials" ? ["client_credentials"] : ["authorization_code"], response_types: grant === "client_credentials" ? [] : ["code"], token_endpoint_auth_method: grant === "client_credentials" ? "client_secret_post" : "none" }),
    });
    const body = (await r.json().catch(() => undefined)) as unknown;
    if (!r.ok || !isObj(body) || typeof body.client_id !== "string") throw new OAuthError(`client registration at ${as.registration_endpoint} failed (HTTP ${r.status})`, "oauth_client");
    return { id: body.client_id, ...(typeof body.client_secret === "string" ? { secret: body.client_secret } : {}) };
  }

  /** Follows the authorization endpoint's redirects to the redirect URI and returns the code. */
  private async followToCode(start: string, redirectUri: string, state: string): Promise<string> {
    let url = start;
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const r = await this.fetch(url, { redirect: "manual" });
      await r.body?.cancel().catch(() => {});
      const loc = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !loc) throw new OAuthError(`the authorization endpoint answered HTTP ${r.status} instead of redirecting back; toolevals can't log in through a page, so use a server that pre-approves the client or grant = "client_credentials"`, "oauth_interactive");
      const next = new URL(loc, url);
      if (next.toString().startsWith(redirectUri)) {
        const err = next.searchParams.get("error");
        if (err) throw new OAuthError(`authorization denied (${err})`, "oauth_denied");
        if (next.searchParams.get("state") !== state) throw new OAuthError("authorization redirect carried the wrong state", "oauth_state");
        const code = next.searchParams.get("code");
        if (!code) throw new OAuthError("authorization redirect carried no code", "oauth_denied");
        return code;
      }
      url = next.toString();
    }
    throw new OAuthError(`more than ${MAX_REDIRECTS} redirects from the authorization endpoint`, "oauth_interactive");
  }
}
