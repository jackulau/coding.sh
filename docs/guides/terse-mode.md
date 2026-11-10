# Does a terse mode save money on your tasks?

A terse mode asks the agent to write less: a "be concise" line in AGENTS.md, a rule, a skill, or a
plugin that adds a style guide to every session. The idea is that fewer output tokens cost less.
Two things pull in opposite directions:

- **Output goes down**, if the agent follows the instruction. Most of a coding agent's output is
  tool calls and code, and a style instruction is mostly about prose, so the drop can be smaller
  than the replies suggest.
- **Input goes up.** The instruction is sent with every request and written to the prompt cache.
  A one-line rule adds a few tokens. A plugin that injects a style guide at session start and a
  reminder on each prompt can add thousands.

Which one wins depends on your tasks, your model and how long your sessions are. This guide runs
your tasks with and without the terse mode and reports pass rate, cost, output tokens and input
overhead for each arm.

## What we found

We ran this A/B on a popular terse-output Claude Code plugin. Setup: Claude Code 2.1.319 on
`claude-opus-5-5`, 10 tasks, 6 runs per task and arm, paired by task and attempt. Intervals are
95%, from a paired bootstrap that resamples tasks.

| | Without | With | Change |
|---|---|---|---|
| Tasks passed (30 runs per arm) | 30/30 | 30/30 | none |
| Output tokens per run | 1,941 | 1,789 | −7.9% [−11.4%, −3.1%] |
| Cache-write tokens per run | 7,707 | 9,512 | +23.4% [+20.9%, +26.0%] |
| Cost per run (API-equivalent) | $0.111 | $0.123 | **+10.9%** [+7.1%, +15.2%] |
| Words in the final reply | 330 | 275 | −16.9% [−20.8%, −11.7%] |
| Clarity of the final reply (blind judge, 0–1) | 0.874 | 0.876 | +0.002 [−0.013, +0.017] |

The replies got 17% shorter and a judge rated them just as clear, so there was no clarity gain.
Output fell 8%, and the shorter output saved $0.0031 per run. The plugin's text added about 1,800
cache-write tokens per run, which cost $0.0144, and cache reads added $0.0006. Net, each run cost
$0.012 more.

The pass rate counts only the second of two batches: the first batch's verifiers looked for the code
in the wrong directory. Tokens, cost, words and clarity use all 60 runs per arm. The tasks, the arm
builder, the judge and the analysis are in
[`examples/plugin-ab`](https://github.com/jackulau/coding.sh/tree/main/examples/plugin-ab). It runs
any plugin directory and ships a small demo plugin that asks for short replies.

This result is for one plugin, on short tasks, with one model. Your sessions may be longer, your
model may write more by default, and a one-line rule adds far less input than a plugin. Run it on
your own tasks.

## 1. See what a terse mode adds today

If you already use a terse plugin, its hooks' text is stored with each session. List the sessions it
reached and count sessions per source:

```sh
coding.sh sessions --where hook:plugin:<name>
coding.sh sessions --facets hook
```

`coding.sh show <session>` has a `Hook context` row with the estimated tokens per source
(characters divided by 4). `coding.sh usage --cache` shows cache reads and writes across your
sessions. These numbers show what the plugin costs, not whether it saves anything. For that, run the
same tasks both ways. [Does this plugin help me?](../how-to/does-this-plugin-help.md) covers this
step in more detail.

## 2. Get tasks

A terse mode changes prose most, so include tasks whose answer is prose (review a diff, explain a
crash) as well as code tasks. Draft tasks from your own failed sessions:

```sh
coding.sh eval init terse --sessions
```

They are stored with the tag `suite:terse`. Or start from the ten tasks we used, six code tasks and
four explain tasks, from a clone of the coding.sh repo:

```sh
coding.sh eval import examples/plugin-ab/tasks/*/
```

Those are tagged `plugin-ab`, with `suite:code` and `suite:explain`.

## 3. Build the two arms

Build both arms from harness TOML files, so they read the same files and differ only by the terse
instruction. Make a folder `terse-ab/` in your repo and put three files in it.

`terse-ab/base.toml`:

```toml
name = "base"
agent = "claude-code"
dir = ".."
```

`terse-ab/concise.toml`:

```toml
name = "concise"
agent = "claude-code"
dir = ".."

[files]
".claude/rules/concise.md" = "concise.md"
```

`terse-ab/concise.md`:

```markdown
Be concise. Give the answer and the evidence for it. Don't restate the task or summarize what you did.
```

`dir = ".."` reads your repo's AGENTS.md, `.claude/`, `.mcp.json` and the other usual
harness files, relative to the TOML file. Your user-level files, such as Claude Code's user-level instructions file and skills in `~/.claude`,
are read only when you list them: write the same `include = [...]` in both TOMLs, for example
`include = ["AGENTS.md", ".claude/**", ".mcp.json", "~/.claude/skills/**"]`. `[files]` adds one
file on top. Snapshot both:

```sh
coding.sh harness snapshot --file terse-ab/base.toml
coding.sh harness snapshot --file terse-ab/concise.toml
```

B adds one always-on rule and changes nothing else, so the report adds the one-item gate (see
below). Other terse modes:

- **A line in AGENTS.md.** Copy your AGENTS.md to `terse-ab/AGENTS.md`, add the line, and write
  `"AGENTS.md" = "AGENTS.md"` under `[files]` instead. B then changes a file rather than adding
  one, so the one-item gate does not apply.
- **A terse-mode skill.** Write `".claude/skills/terse/SKILL.md" = "terse-skill.md"` under
  `[files]`, with a `name` and `description` in the skill's frontmatter. Claude Code lists the
  skill's name and description in every session and reads the body only when the agent opens it.
- **A plugin.** Skip the second TOML. `compare` adds the plugin to arm A itself (step 4).

## 4. Run both arms

See how many runs it takes, then run:

```sh
coding.sh compare base concise --tag suite:terse --k 3 --dry-run
coding.sh compare base concise --tag suite:terse --k 3 --gate --promote --max-cost 20 --yes
```

`--k 3` runs each task three times per arm. Each run starts from a fresh copy of the task in its
own config directory, so your `~/.claude` is not changed. `--max-cost 20` stops starting new runs
once the finished ones cost $20. With the example tasks, pass `--tag plugin-ab --by suite:` to also
gate the code and explain suites one at a time.

For a plugin, B is A plus the plugin:

```sh
coding.sh compare base --with plugin:<name> --tag suite:terse --k 3 --gate --promote --yes
```

`<name>` is an installed plugin's name or a plugin directory. See
[Claude Code plugins](evals.md#claude-code-plugins).

## 5. Read the report

- **Pass rate.** Each arm's pass rate has a Wilson interval, and the verdict line gives B − A with a
  paired bootstrap interval over tasks. `--gate` says ship, hold or don't ship, and names the tasks
  B broke.
- **Cost.** The `pareto:` line from `--promote` gives B's cost change against A with a 95% interval,
  and the quality change with its interval:
  `pareto: support <S> < 0.70 → hold (cost <change> [<low>, <high>], quality <change> [<low>, <high>])`.
  It uses USD when at least 80% of each arm's runs report a cost, else tokens. "Promote" means B is
  credibly cheaper while giving up at most `--eps-q` of pass rate (default 0.1), or credibly better
  with a cost rise within `--eps-c` (default: no limit).
- **Tokens.** The `tokens / run` row counts input, output, cache reads and cache writes together.
  `cost / solved` divides each arm's cost by the tasks it solved.
- **The one-item gate.** For the rule-file arm, the report adds a line that reads KEEP, RECHECK,
  KILL or RERUN, from the tasks where the rule reached the agent's context. See
  [Harness A/B](evals.md#harness-ab).

On a Claude subscription, costs are API-equivalent: list prices applied to the tokens each run
used. The token counts are the same either way.

## 6. Split output from input overhead

The report's token row is one total. To see where the cost went, read each arm's mean tokens per
run by type from the store. This reads the latest comparison:

```sh
coding.sh sql "select b.name as arm, count(*) as runs, sum(r.pass) as passed,
  round(avg(json_extract(r.doc, '$.agent.usage.outputTokens'))) as output,
  round(avg(json_extract(r.doc, '$.agent.usage.inputTokens'))) as input,
  round(avg(json_extract(r.doc, '$.agent.usage.cacheWriteTokens'))) as cache_write,
  round(avg(json_extract(r.doc, '$.agent.usage.cacheReadTokens'))) as cache_read,
  round(avg(json_extract(r.doc, '$.agent.usage.costUsd')), 4) as cost
from runs r join bundles b on b.id = r.bundle_id
where r.experiment_id = (select experiment_id from runs where experiment_id is not null order by started_at desc limit 1)
  and json_extract(r.doc, '$.superseded') is null and json_extract(r.doc, '$.cancelled') is null
  and json_extract(r.doc, '$.infra') is null
group by b.name order by b.name"
```

To read another comparison, put its experiment id (`experimentId` in `compare --json`) in place of
the subquery.

A terse mode saves money only when the drop in `output` is worth more than the rise in `cache_write`
and `input`. On Opus 5.5 an output token costs $20 per million, and a cache-write token $5 (5-minute
cache) or $8 (1-hour cache). An output token costs more, but the instruction is written to the cache
in every session. In our run, 1,800 more cache-write tokens cost $0.0144 per run and 150 fewer
output tokens saved $0.0031.

These are means, without intervals. `examples/plugin-ab` prints a 95% interval for each token type,
from a bootstrap over tasks, but it runs a plugin arm only.

## 7. A faster check on recorded calls

With the [proxy](../how-to/capture-with-proxy.md) capturing your sessions, you can send recorded
model calls again with a changed system prompt and compare output tokens and cost per call, without
running whole tasks:

```sh
coding.sh show latest#-1 --all
coding.sh exp replay --session latest --limit 10 --vary system=@terse-system.md --n 3 --dry-run
coding.sh exp replay --session latest --limit 10 --vary system=@terse-system.md --n 3
```

`--vary system=@file` replaces the whole system prompt in arm B, so start from the recorded one:
`show <call> --all` prints it, and `terse-system.md` is that text plus your line. The report gives
each arm's cost per call and output tokens per call, and whether each reply takes the same first
action the agent took. A replay measures single calls, not whole runs: it does not show whether the
task still gets done. See [Replay a model call](evals.md#replay-a-model-call).

## What this does not tell you

- A comparison on a handful of tasks shows only large effects. The report's `power` line gives the
  smallest difference it could detect.
- On short tasks, what the instruction adds at session start is a large share of each run. Long
  sessions can come out differently in either direction: a reminder on each prompt adds up, and so
  can the output saved.
- A pass rate does not measure whether you prefer the shorter replies. That is a fine reason to keep
  a terse mode, just not a cost reason.
