// Projects partition serve's data: the ingest key decides an event's project,
// and every project other than "default" gets its session ids namespaced as
// `<project>/<sessionId>`, so two apps that both use conversation id `chat-1`
// stay apart while IndexStore keys stay plain strings.
import type { AgentEvent } from "../schema/index.ts";
import { hashParts } from "../core/ids.ts";

export const DEFAULT_PROJECT = "default";
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isProjectId = (s: string): boolean => PROJECT_RE.test(s);

/** `<project>/<id>` for non-default projects (idempotent: an already-prefixed id is kept). */
export function scopeSessionId(id: string, project: string): string {
  if (project === DEFAULT_PROJECT) return id;
  const prefix = `${project}/`;
  return id.startsWith(prefix) ? id : prefix + id;
}

const scopeField = (payload: Record<string, unknown>, key: string, project: string): void => {
  const v = payload[key];
  if (typeof v === "string" && v) payload[key] = scopeSessionId(v, project);
};

/**
 * Sets `project` on every event and namespaces session ids (sessionId,
 * payload.parentSessionId, payload.childSessionId). Returns copies.
 */
export function scopeEvents(events: AgentEvent[], project: string): AgentEvent[] {
  return events.map((e) => {
    const out: AgentEvent = { ...e, sessionId: scopeSessionId(e.sessionId, project) };
    if (project === DEFAULT_PROJECT) delete out.project;
    else out.project = project;
    if (project !== DEFAULT_PROJECT && e.payload && (typeof e.payload.parentSessionId === "string" || typeof e.payload.childSessionId === "string")) {
      out.payload = { ...e.payload };
      scopeField(out.payload, "parentSessionId", project);
      scopeField(out.payload, "childSessionId", project);
    }
    return out;
  });
}

/** Stored id of a native-ingest event: projects cannot collide and a retry maps to the same id. */
export const sdkEventId = (project: string, clientId: string): string => hashParts("sdk", project, clientId);
