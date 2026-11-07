# Vercel, Sep–Nov 6 2026: use cases for coding.sh

Compiled 2026-11-06 from the Vercel changelog atom feed (<https://vercel.com/atom>, 232 entries since 2026-09-01), blog posts and docs. Nothing in this note has been implemented.

**Use-case codes:** (a) integrate, (b) use as infrastructure, (c) evaluate, (d) nothing useful. **Effort:** S/M/L. **Value:** high/med/low.

## Ranked use cases

| # | Product | What it is | Use | Effort | Value |
|---|---|---|---|---|---|
| 1 | Agent Runs + durable-harness OTel | Agent Runs is Vercel's trace view for eve and durable-harness sessions (Claude Code, Codex, OpenCode, Pi, fx). `agentRuns({spanProcessors})` can tee the same spans to a second OTel destination. [changelog](https://vercel.com/changelog/eve-agent-observability), [harness obs](https://vercel.com/docs/agent-harnesses/observability), [blog](https://vercel.com/blog/making-every-harness-durable) | (a) Document a tee to the coding.sh OTLP receiver. Check that durable-harness spans (`invoke_agent` → `agent.step` → model/tool) pass through `enrichFromEve`. | S–M | high |
| 2 | Sandbox (Drives GA, forks, universal image) | Firecracker microVMs. Pro allows 10k concurrent sandboxes for up to 24h. The `universal` image ships with coding agents preinstalled. Drives can be forked into identical writable copies. [docs](https://vercel.com/docs/sandbox), [pricing](https://vercel.com/docs/sandbox/pricing) | (b) Add a remote runner backend for `coding.sh exp` and harness compare. Every arm starts from a forked Drive, and concurrency goes far past the local `min(4, cpus/2)` (runner/experiment.ts:78-79). | M–L | high |
| 3 | eve attributes (rc.6) | eve 1.0.0-rc.6 (npm latest, 2026-11-05) emits memory, schedule, principal, approver, cost-split, affinity and redaction attributes. Local docs: `examples/eve-agent/node_modules/eve/docs`. | (a) Map the unmapped attributes (see the eve gaps section). | S | med-high |
| 4 | `vercel agent-runs` CLI | `vercel agent-runs list\|inspect\|trace <runId> --json`, paginated. Retention is 30 days in beta, and the JSON shape is undocumented. [cli](https://vercel.com/docs/cli/agent-runs), [changelog](https://vercel.com/changelog/agent-runs-vercel-mcp-cli) | (a) Add an `importAgentRuns` that archives runs past Vercel's retention. Capture a real fixture first. | M | med |
| 5 | eve evals `EvalReporter` | eve's reporter interface (`onRunStart`, `onEvalComplete`, ...). It ships Braintrust, Datadog and JUnit reporters. Source: `eve/evals/reporters`. | (c) Add a `codingShReporter` that writes eve eval runs into coding.sh datasets and experiments. | S | med |
| 6 | AI Gateway session affinity and Virtual Models | Gateway logs gained a Sessions view. Session id precedence ends with `x-claude-code-session-id` (sent automatically) and the id comes back as `routing.clientSessionId`. `vmc/<slug>` virtual models report the resolved model in `virtualModelConfig.modelId`. [affinity](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity), [changelog](https://vercel.com/changelog/ai-gateway-logs-now-show-session-affinity), [vmc](https://vercel.com/blog/ai-gateway-virtual-models) | (a/c) **Gateway owner only.** Join drained requests to agent sessions on the client session id instead of per-UTC-day buckets (gateway/otel.ts:48-49). Record the resolved model per call so `vmc/` arms stay honest. | S | med |
| 7 | Security Review (beta) + Vercel Agent | Agent-driven vulnerability review on every push. Findings include commit and severity. CLI: `vercel security vulnerabilities list --json`. Free until 11-10, then inference + $0.25/M tokens. [changelog](https://vercel.com/changelog/vercel-security-review-public-beta), [docs](https://vercel.com/docs/agent/security-review), [cli](https://vercel.com/docs/cli/security) | (c) Join findings to agent sessions by commit and use them as an outcome metric for exp arms ("did arm B introduce vulns?"). | M | med |
| 8 | Production mode on Vercel (Container runtime, Queues, Daemons) | Container runtime deploys a plain Dockerfile on Functions (beta). Queues are durable topics with poll mode from anywhere. Daemons are long-running containers with no inbound HTTP. [container](https://vercel.com/changelog/deploy-a-container-from-a-plain-dockerfile), [queues](https://vercel.com/docs/queues), [daemons](https://vercel.com/docs/daemons) | (b) Run ingest and viewer as Container Functions that write to a Queue topic, with one Daemon as the single writer into Postgres. This satisfies the single-writer constraint in PRODUCTION.md §5.1 (lines 501-519). Add it as a fifth deploy target. | L | med |
| 9 | durable-harness World store | Logs intent and outcome for every call to a World (local files, Postgres, Redis, ...). It mirrors Claude Code transcripts, Codex rollouts and OpenCode events. npm 0.0.2, published 2026-11-06. [blog](https://vercel.com/blog/making-every-harness-durable) | (a) Import from a World store, reusing the existing CC/Codex/OpenCode parsers. Wait for it to stabilize (0.0.x). | M | med |
| 10 | AI SDK HarnessAgent | One API that drives Claude Code, Codex, Cursor, OpenCode, Pi, fx, Copilot and others, with `@ai-sdk/sandbox-vercel`. `session.readHistory()` returns raw harness records. [docs](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent) | (c) Use it as the driver for harness-compare arms instead of per-agent CLI shims. | M | med |
| 11 | Vercel Tracing GA | KQL trace search with 14-day retention on Pro. `vercel traces search --json` emits JSONL spans. [changelog](https://vercel.com/changelog/vercel-tracing-is-now-generally-available), [cli](https://vercel.com/docs/cli/traces) | (a) Import function spans around agent calls. | S–M | low-med |
| 12 | Workflow SDK atomic starts | `start()` claims its hook token atomically. A duplicate start throws `HookConflictError` with `conflictingRunId`. Runs can be viewed with `npx workflow inspect runs`. [changelog](https://vercel.com/changelog/atomic-start-hooks-in-the-workflow-sdk), [obs](https://workflow-sdk.dev/docs/observability) | (a) Import workflow runs. The run JSON is undocumented, and eve already covers the agent part. | M | low |
| 13 | Custom metrics | `metric(name, value, attrs)` from Functions only, at $1.20 per 1M events. No OTLP metrics ingest. [docs](https://vercel.com/docs/observability/custom-metrics) | (a) Optionally have the SDK emit metrics when it runs on Vercel. | S | low |
| 14 | `vercel doctor` | Setup diagnostics. `--json` returns `checks[].{id,status,message,next}` plus a summary, always exits 0, and never prompts. [changelog](https://vercel.com/changelog/vercel-cli-now-diagnoses-setup-problems-with-vercel-doctor), [docs](https://vercel.com/docs/cli/doctor) | (c) Adopt the `{status, next}` shape for `coding.sh doctor --json` (cli/commands/doctor.ts:115), and use it as a tool-eval target. | S | low |
| 15 | Schedules (beta) | Successor to Cron. It can target Functions or Queue topics. 2026-11-05. | (b) Schedule nightly `exp` runs if hosted on Vercel. | S | low |
| 16 | Connect / Passport | Connect is GA with 1000+ OAuth connectors. Passport is Enterprise IdP protection for deployments (GA 07-31) and is **not** part of the Agent Stack. [connect](https://vercel.com/docs/connect), [passport](https://vercel.com/docs/passport) | (d) for now. `serve` does not run on Vercel, and Passport is Enterprise only. | – | low |
| 17 | Device Bound Session Credentials | No Vercel product found. DBSC appears once, as a standard listed in [this post](https://vercel.com/blog/death-to-long-lived-static-credentials) about OIDC. | (d) | – | – |

## Notes

- **Agent Stack** consists of AI SDK, AI Gateway, Workflow SDK, Sandbox, Connect, Chat SDK and eve ([blog](https://vercel.com/blog/agent-stack); [Ship 2026 recap](https://vercel.com/blog/vercel-ship-2026-recap), 10-15).
- **Gateway trace drains** ([docs](https://vercel.com/docs/ai-gateway/observability-and-spend/trace-drains)) list no session-id attribute, which is why #6 needs the client session id from response metadata or headers.
- **Sandbox cost check (Pro):** $0.128 per Active CPU hour, $0.0212 per GB-hour, $0.60 per 1M creations. A 100-task × 2-arm exp at about 10 CPU-minutes per task costs roughly $4–5. Hobby is capped at 10 concurrent sandboxes and 45 minutes, which is too small for real experiments.
- **Ecosystem signal:** Harbor/Terminal-Bench `--env vercel` (09-17) and Scale AgentEnv (10-26) already run on Sandbox. A Sandbox runner (#2) puts coding.sh exp on the same infrastructure as those benchmarks.
- Also shipped, no direct use found: Chat SDK updates, DeepSeek/Browserbase gateway tools, confidence-based fallbacks, Token Pass, custom monitors (alerts on Gateway cost and Workflow failures), and eve persistent memory (09-09, relevant only to the attributes in #3).

## eve gaps

**Version: the integration is current.** `examples/eve-agent` pins eve 1.0.0-rc.6, which is npm latest. The trace schema is still v4 (attrs.ts:2, attrs.ts:25) and the stream is still v27 (stream.ts:1). `otelIntegration` in docs/integrations/eve.md:92 is still the valid rc.6 API.

Gaps (paths under `packages/coding.sh/src/integrations/eve/`):

1. **No Agent Runs import.** import.ts:11-15 deliberately skips `vercel agent-runs trace --json` because the format is unverified. It reads only `.eve/traces/v1/.../segments/*.otlp.json` and `eve traces show --json`. Capture a real response before building this.
2. **Unmapped attributes.** The attribute map at attrs.ts:27-77 and the span kinds at map.ts:114-117 have no handling for:
   - memory spans: `agent.memory.phase`, `agent.memory.slot`, `gen_ai.memory.store.id`, `gen_ai.memory.record.count`
   - `agent.schedule.id`
   - principals: `agent.principal.current.{id,type}`, `agent.principal.initiator.{id,type}`
   - approvers: `agent.approval.responder.{id,type}`, `agent.tool.approver.{id,type}`
   - `agent.invocation.role`
   - `agent.link.type` (span links)
   - redaction flags: `agent.input.messages.omitted`, `agent.trace.content.input/output`. Without these, redacted content looks like empty content.
   - `agent.channel.request.id`
   - `gen_ai.generation.id`
   - `vercel.session_id`
3. **Cost split dropped.** `gen_ai.usage.gateway_cost`, `input_cost` and `output_cost` are ignored. Only `gen_ai.usage.cost` is read (otel/map.ts).
4. **Affinity incomplete.** map.ts:288 reads only `vercel.ai_gateway.affinity.outcome`. It misses `affinity.pinned_provider`, `affinity.displaced_provider`, `vercel.ai_gateway.client_session_id` and `client_session_id_source`. The client session id is the key for joining gateway sessions (#6).
5. **Handover events lost.** map.ts:99 drops Workflow infra spans, and with them the `eve.session.handover.*` events (`forwarding_started`, `part_submitted`, `final_submitted`, `inbox_unblocked`, plus `eve.handoff.destination_run_id`). The session does not split, because the session id is stable across compaction, but the timeline loses its handoff markers.
6. **durable-harness spans unverified.** These spans come from `durable-harness/instrumentation/otel` and share eve's topology, but nothing tests them against `enrichFromEve` (map.ts, session key `agent.run.id` at lines 103-107). They may use a different run-id attribute.
