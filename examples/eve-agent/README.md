# eve agent example

A minimal [eve](https://github.com/vercel/eve) agent, traced and evaluated with coding.sh.

- `agent/tools/get_weather.ts`: one tool. It knows Paris, London, Tokyo and San Francisco, and throws for any other city.
- `agent/subagents/forecaster/`: one subagent, which writes a one-line outlook.
- `agent/instrumentation/`: exports eve's OpenTelemetry spans to coding.sh at `http://127.0.0.1:4318`.

It runs locally with `eve dev`. You don't need a Vercel deploy, an account or an API key. By default both agents use eve's `mockModel`, a deterministic scripted model. With it, every run costs nothing and produces the same trace shape, which suits evals and CI.

## Setup

eve needs Node 24 or later.

```bash
cd examples/eve-agent
npm install
```

### Using a real model (optional)

Set `EVE_EXAMPLE_MODEL` (for example `anthropic/claude-haiku-4.5`) and one credential. Put both in `.env.local`, which is gitignored. Never commit a key.

| Env var | Use |
| --- | --- |
| `EVE_EXAMPLE_MODEL` | Model id. Leave it unset to use the free mock model. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway, for `provider/model` ids. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Direct provider access. |
| `CODING_SH_OTLP_URL` | Where spans go. Default `http://127.0.0.1:4318/v1/traces`. |
| `EVE_TELEMETRY_DISABLED=1` | Turns off eve's anonymous CLI usage telemetry. This is unrelated to tracing. |

See `.env.example`.

## 1. Live traces with the coding.sh collector

```bash
# terminal 1: OTLP receiver on 127.0.0.1:4318, with eve enrichment
coding.sh collector              # eve enrichment is on by default
node scripts/collector.ts        # same receiver, run from source

# terminal 2: the agent
npm run serve                    # eve dev --no-ui on http://127.0.0.1:2000

# terminal 3: talk to it
echo '"What is the weather in Paris?"' | npm run --silent ask
echo '{"messages":["What is the weather in Paris?","And the weather in London?"]}' | npm run --silent ask
echo '"What is the weather in Atlantis?"' | npm run --silent ask   # tool error
```

The collector prints one line per session as spans arrive. A run looks like this:

```
wrun_01M6S8SB2P…  eve turns=2 tools=6 errors=0
wrun_01M6S8SBBT…  eve turns=1 tools=0 errors=0 parent=wrun_01M6S8SB2P…
wrun_01M6S8SC83…  eve turns=1 tools=1 errors=1
```

Each eve session becomes one coding.sh session. Each forecaster call becomes a child session whose parent is the caller.

`node scripts/collector.ts` writes to your coding.sh store (`~/.coding.sh`). Run it as `STORE=memory node scripts/collector.ts` to print sessions without storing anything. `npm run dev` starts the same agent with eve's TUI.

`coding.sh collector` applies eve enrichment by default (`defaultEnricher` in `src/otel/receiver.ts`): workflow infrastructure spans are dropped, and subagent sessions are keyed by eve run.

## 2. Import traces after the fact

`eve dev` also writes every span to `.eve/traces/v1/`. Import them read-only:

```bash
node scripts/import-traces.ts              # dry run: list the sessions it found
node scripts/import-traces.ts --write      # store them
npx eve traces show <traceId> --json > t.json && node scripts/import-traces.ts t.json
```

The importer produces the same event ids as live collection, so importing a run you already collected adds nothing.

## 3. Evals

Two complementary ways to evaluate the agent:

| | eve evals (`evals/*.eval.ts`) | coding.sh experiments (`evals/coding-sh/`) |
| --- | --- | --- |
| Run | `npm run eval:eve` (`eve eval`) | `npm run serve`, then `npm run eval:coding-sh` |
| Server | eve boots its own | your running agent (any URL) |
| Assertions | `t.calledTool`, `t.calledAgent`, `t.check`, `t.judge` | coding.sh graders: built-in, module, command, LLM judge |
| Output | console, `.eve/evals/<ts>/`, Braintrust/JUnit reporters | pass rate with confidence intervals and per-grader scores, stored and comparable across harness versions |
| Use for | Fast regression gates inside the eve app | A/B testing prompts, models and harnesses. Turning captured sessions into cases. Comparing eve against other agents on one dataset. |

They don't conflict. eve's evals answer "did this change break the agent?" coding.sh answers "which version is better, and by how much?"

### coding.sh experiment

The pieces:
- Dataset: `evals/coding-sh/weather.jsonl`, with 5 cases including a two-turn case and a failing-tool case.
- Graders: `evals/coding-sh/graders.json`.
- Trace graders: `trace-grader.mjs`. These check how the agent got its answer:
  - did `get_weather` run, and did it fail when it should?
  - did it delegate to `forecaster`?
  - how many model calls did it make per turn?

```bash
npm run serve                              # terminal 1
npm run eval:coding-sh                     # in-process HTTP task: eveTask({ url })
npm run eval:coding-sh -- --command        # command task: scripts/ask.mjs (stdin JSON → stdout JSON)
```

```
PASS paris                640ms turn-handled=pass reply=pass tools=pass delegation=pass efficiency=pass
PASS london-follow-up    1138ms turn-handled=pass reply=pass tools=pass delegation=pass efficiency=pass
PASS atlantis             316ms turn-handled=pass reply=pass tools=pass delegation=pass efficiency=pass
5/5 passed (100%, 95% CI 57-100%)
```

There are two tasks:
- `eveTask` from `packages/coding.sh/src/integrations/eve` drives eve's HTTP API. It returns `{reply, replies, sessionId, toolCalls, subagents}` and gives graders the session's events as `ctx.trace`.
- `scripts/ask.mjs` is the same thing as a standalone command, built on `eve/client`. Use it from any harness that runs commands.

Case input is `"text"`, `{"message": "..."}` or `{"messages": ["...", "..."]}` (a multi-turn case).

coding.sh is not published yet, so `experiment.ts` and the scripts import it from `../../packages/coding.sh/src`.

## Files

```
agent/
  agent.ts                  root agent (mock model unless EVE_EXAMPLE_MODEL)
  instructions.md
  tools/get_weather.ts
  subagents/forecaster/     agent.ts + instructions.md
  instrumentation/          otel.ts (tracePolicy) + coding-sh.ts (OTLP exporter)
evals/
  evals.config.ts           eve evals
  weather.eval.ts
  coding-sh/                coding.sh dataset, graders, experiment
scripts/
  ask.mjs                   command task (eve/client)
  collector.ts              coding.sh OTLP receiver with eve enrichment
  import-traces.ts          .eve/traces → coding.sh
```
