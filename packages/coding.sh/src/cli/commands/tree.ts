// coding.sh tree <session|run>: a whole multi-agent run as one tree — the
// top-level agent, the subagents it spawned, their subagents, with per-node
// cost, tokens, duration and tool calls, rolled-up totals and the worst flag
// for the whole loop. A fan-out of separate agent processes that share a run id
// (CODING_SH_RUN_ID) groups into one run; pass that id (or --run).
import { costNote } from "../../core/pricing.ts";
import { buildRunTree, buildSessionTree, worstNode, worstFirst, type Tree, type TreeNode } from "../../core/tree.ts";
import type { Session } from "../../core/types.ts";
import { autoIngest, oneLine, resolveSession, sessionJson, withContext, notFoundWithBacklog, pendingField, readIngest } from "../common.ts";
import { clean, duration, plural, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** A node's own cost/tokens/duration/tools, for one tree line and for --json. */
function nodeSummary(s: Session) {
  const u = s.stats.usage;
  return {
    costUsd: u?.costUsd,
    inputTokens: u?.inputTokens,
    outputTokens: u?.outputTokens,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined,
    toolCalls: s.stats.toolCalls,
    toolErrors: s.stats.toolErrors,
    filesChanged: s.stats.filesChanged,
  };
}

function nodeJson(n: TreeNode): Record<string, unknown> {
  const s = n.session;
  return {
    ...sessionJson(s),
    depth: n.depth,
    role: n.depth === 0 ? "root" : (s.parent?.type ?? "subagent"),
    children: n.children.map(nodeJson),
  };
}

function treeJson(t: Tree) {
  const worst = worstNode(t.roots);
  return {
    ...(t.runId ? { runId: t.runId } : {}),
    totals: {
      sessions: t.totals.sessions,
      usage: t.totals.usage,
      toolCalls: t.totals.toolCalls,
      toolErrors: t.totals.toolErrors,
      filesChanged: t.totals.filesChanged,
      durationMs: t.totals.wallMs ?? null,
      flags: t.totals.flags,
    },
    worst: worst ? { id: worst.session.id, role: worst.depth === 0 ? "root" : (worst.session.parent?.type ?? "subagent"), flags: worstFirst(worst.session.flags) } : null,
    tree: t.roots.map(nodeJson),
  };
}

/** "└ 9f1c2e  reviewer  sonnet  12s  18 tools  $0.03  [premature-completion]  title" */
function printNode(out: Output, n: TreeNode, isRoot: boolean): void {
  const s = n.session;
  const { costUsd, durationMs, toolCalls, toolErrors } = nodeSummary(s);
  const indent = "  ".repeat(n.depth);
  const branch = isRoot ? "" : "└ ";
  const role = isRoot ? s.agent : (s.parent?.type ?? s.agent);
  const parts = [
    s.id,
    out.style(role, "bold"),
    s.model ?? "",
    durationMs !== undefined ? duration(durationMs) : "-",
    `${toolCalls} tools${toolErrors ? ` (${toolErrors} failed)` : ""}`,
    costUsd !== undefined ? usd(costUsd) : "",
  ].filter(Boolean);
  const flags = worstFirst(s.flags);
  const flagText = flags.length ? out.style(`[${flags.join(" ")}]`, "yellow") : "";
  const title = oneLine(clean(s.title ?? ""), 48);
  out.print(`${indent}${branch}${parts.join("  ")}${flagText ? `  ${flagText}` : ""}${title ? `  ${out.style(title, "faint")}` : ""}`);
  for (const c of n.children) printNode(out, c, false);
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const arg = c.positionals[0]!;
  const forceRun = c.flags.run === true;
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));

    let tree: Tree | undefined;
    let label: string;
    if (!forceRun) {
      // Try the argument as a session first; fall back to a run id.
      try {
        const s = await resolveSession(ctx, arg);
        tree = await buildSessionTree(ctx.index, s.id);
        label = tree && tree.roots[0] ? treeLabel(tree.roots[0]!.session) : s.id;
      } catch (e) {
        tree = await buildRunTree(ctx.index, arg);
        if (!tree) throw notFoundWithBacklog(e, backlog); // neither a session nor a run: surface the session error
        label = `run ${arg}`;
      }
    } else {
      tree = await buildRunTree(ctx.index, arg);
      label = `run ${arg}`;
      if (!tree) {
        out.note(`No sessions in run ${arg}`);
        out.next("List runs by setting CODING_SH_RUN_ID on your fan-out, then", "coding.sh sessions");
        return 0;
      }
    }
    if (!tree) {
      out.note(`No tree for ${arg}`);
      return 0;
    }

    if (out.json) {
      out.data({ ...treeJson(tree), ...pendingField(backlog) });
      return 0;
    }

    const t = tree.totals;
    const subagents = t.sessions - tree.roots.length;
    out.print(out.style(label!, "bold"));
    const headline = [
      tree.runId ? `${plural(tree.roots.length, "agent")}, ${plural(subagents, "subagent")}` : `${plural(subagents, "subagent")}`,
      t.wallMs !== undefined ? duration(t.wallMs) : null,
      `${t.toolCalls} tool calls${t.toolErrors ? ` (${t.toolErrors} failed)` : ""}`,
      t.filesChanged ? `${t.filesChanged} files changed` : null,
      t.usage.costUsd !== undefined ? `${usd(t.usage.costUsd)}${costNote(t.usage)}` : null,
    ].filter(Boolean);
    out.print(`  ${headline.join("  ·  ")}`);
    if (t.usage.inputTokens !== undefined || t.usage.outputTokens !== undefined) {
      out.print(`  ${out.style(`in ${tokens(t.usage.inputTokens)}  out ${tokens(t.usage.outputTokens)}  cache ${tokens(t.usage.cacheReadTokens)}`, "faint")}`);
    }
    if (t.flags.length) out.print(`  ${out.style(`flags across the loop: ${t.flags.join(", ")}`, "yellow")}`);
    out.print();

    for (const r of tree.roots) printNode(out, r, true);

    const worst = worstNode(tree.roots);
    if (worst) {
      out.print();
      const w = worst.session;
      const which = worst.depth === 0 ? "the top-level agent" : `subagent ${w.parent?.type ?? ""}`.trim();
      out.print(out.style("Fix first", "bold"));
      out.print(`  ${which} ${w.id}: ${worstFirst(w.flags).join(", ")}`);
      out.next("Open it", `coding.sh show ${w.id}`);
    }
    return 0;
  });
}

/** A short label for a tree's root: its title, else its id. */
function treeLabel(s: Session): string {
  return s.title ? oneLine(clean(s.title), 70) : s.id;
}
