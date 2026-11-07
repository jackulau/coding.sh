// Framework step spans → workflow nodes (docs/WORKFLOWS.md §2.2).
//
// Keyed by instrumentation scope name, with attribute fallbacks for
// exporters that use a generic scope (OpenInference, LangSmith). Each entry
// is marked by how sure we are of the attribute names: "documented" (from the
// framework's docs) or "unverified" (U in the doc: confirm with a recorded
// fixture before relying on it). Only generic spans reach this table; model,
// tool and agent spans are classified by src/otel/map.ts already.
import type { WorkflowFramework, WorkflowNodeKind } from "../types.ts";

export type Attrs = Record<string, unknown>;

export interface FrameworkMatch {
  kind: Extract<WorkflowNodeKind, "step" | "handoff" | "phase" | "workflow">;
  name?: string;
  from?: string;
  to?: string;
  stage?: number;
  item?: number;
}

export interface FrameworkRule {
  framework: WorkflowFramework;
  certainty: "documented" | "unverified";
  /** Instrumentation scope names this rule owns. */
  scope?: RegExp;
  /** Returns a mapping for one generic span, or undefined to fall through. */
  match(name: string, attrs: Attrs): FrameworkMatch | undefined;
}

const str = (a: Attrs, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
};
const num = (a: Attrs, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
};

/** OpenInference/LangSmith put framework metadata in a JSON `metadata` attribute. */
function metadata(a: Attrs): Attrs {
  const m = a.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) return m as Attrs;
  if (typeof m === "string" && m.startsWith("{")) {
    try {
      const v = JSON.parse(m) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Attrs;
    } catch {
      // not JSON
    }
  }
  return {};
}

export const FRAMEWORK_RULES: FrameworkRule[] = [
  {
    framework: "openai-agents",
    certainty: "unverified",
    scope: /openai[._-]?agents|openinference\.instrumentation\.openai_agents/i,
    match(name, a) {
      const from = str(a, "handoff.from_agent", "from_agent", "gen_ai.handoff.from_agent");
      const to = str(a, "handoff.to_agent", "to_agent", "gen_ai.handoff.to_agent");
      if (from || to || /^handoff\b/i.test(name)) {
        const m = /handoff\s*(?:from\s+)?(\S+)?\s*(?:->|to|→)\s*(\S+)/i.exec(name);
        return { kind: "handoff", name: name || "handoff", from: from ?? m?.[1], to: to ?? m?.[2] };
      }
      if (/^guardrail\b/i.test(name) || str(a, "guardrail.name")) return { kind: "step", name };
      return undefined;
    },
  },
  {
    framework: "langgraph",
    certainty: "unverified",
    scope: /langgraph|langchain|langsmith/i,
    match(name, a) {
      const md = metadata(a);
      const node = str(a, "langgraph_node", "langgraph.node", "metadata.langgraph_node") ?? str(md, "langgraph_node");
      if (!node) return undefined;
      if (node === "__start__" || node === "__end__") return undefined;
      return { kind: "step", name: node || name, stage: num(a, "langgraph_step", "langgraph.step", "metadata.langgraph_step") ?? num(md, "langgraph_step") };
    },
  },
  {
    framework: "mastra",
    certainty: "unverified",
    scope: /mastra/i,
    match(name, a) {
      const t = (str(a, "mastra.span.type", "span.type", "mastra.type") ?? "").toLowerCase();
      if (t === "workflow_run" || t === "workflow-run") return { kind: "phase", name: str(a, "mastra.workflow.id", "workflow.id") ?? name };
      if (t === "workflow_step" || t === "workflow-step" || /^workflow step[: ]/i.test(name)) {
        return { kind: "step", name: str(a, "mastra.step.id", "step.id") ?? name.replace(/^workflow step[: ]\s*/i, "") };
      }
      if (t === "workflow_parallel" || t === "workflow_conditional" || t === "workflow_loop") return { kind: "phase", name };
      return undefined;
    },
  },
  {
    framework: "crewai",
    certainty: "unverified",
    scope: /crewai/i,
    match(name, a) {
      if (/\bcrew\b/i.test(name) && !/task/i.test(name)) return { kind: "phase", name };
      if (/task/i.test(name) || str(a, "crewai.task.name", "task.name", "task_key")) {
        return { kind: "step", name: str(a, "crewai.task.name", "task.name") ?? name };
      }
      return undefined;
    },
  },
];

/** Framework of a scope name, when one rule owns it. */
export function frameworkOfScope(scope: string | undefined): WorkflowFramework | undefined {
  if (!scope) return undefined;
  return FRAMEWORK_RULES.find((r) => r.scope?.test(scope))?.framework;
}

/** Maps one generic span: rules owning its scope first, then every rule by attributes. */
export function matchFrameworkSpan(scope: string | undefined, name: string, attrs: Attrs): (FrameworkMatch & { framework: WorkflowFramework }) | undefined {
  const owned = scope ? FRAMEWORK_RULES.filter((r) => r.scope?.test(scope)) : [];
  for (const r of [...owned, ...FRAMEWORK_RULES.filter((x) => !owned.includes(x))]) {
    const m = r.match(name, attrs);
    if (m) return { ...m, framework: r.framework };
  }
  return undefined;
}
