# Does a terse mode save money on your tasks?

Run your tasks with and without a be-concise rule, skill or plugin, and compare pass rate, cost,
output tokens and the input it adds.

A terse mode asks the agent to write less: a line in AGENTS.md, a rule, a skill, or a plugin that
adds a style guide to every session. Output can go down, but the instruction is sent with every
request and written to the prompt cache, so input goes up. This recipe measures which one wins on
your tasks.

## Before you start

- coding.sh records your agent's sessions (`coding.sh init`). The steps use Claude Code; any agent
  that `compare` drives works the same way.
- A repo under git, and a model key or a logged-in subscription.

:::more What we measured on one plugin
coding.sh ran this A/B on a terse-output Claude Code plugin, with the ten tasks in its own
`examples/plugin-ab` folder: six code tasks and four explain tasks. Claude Code 2.1.319 on
`claude-opus-5-5`, 6 runs per task and arm, paired by task and attempt. Intervals are 95%, from a
paired bootstrap over tasks.

| | Without | With | Change |
|---|---|---|---|
| Tasks passed (30 runs per arm) | 30/30 | 30/30 | none |
| Output tokens per run | 1,941 | 1,789 | −7.9% [−11.4%, −3.1%] |
| Cache-write tokens per run | 7,707 | 9,512 | +23.4% [+20.9%, +26.0%] |
| Cost per run (API-equivalent) | $0.111 | $0.123 | +10.9% [+7.1%, +15.2%] |
| Words in the final reply | 330 | 275 | −16.9% [−20.8%, −11.7%] |
| Clarity of the final reply (blind judge, 0–1) | 0.874 | 0.876 | +0.002 [−0.013, +0.017] |

Replies got 17% shorter and a judge rated them just as clear. The shorter output saved $0.0031 per
run; the plugin's text added about 1,800 cache-write tokens, which cost $0.0144. Net, each run cost
$0.012 more.

The pass rate counts only the second of two batches, because the first batch's verifiers looked in
the wrong directory; the other rows use all 60 runs per arm. This is one plugin, on short tasks, with
one model. A one-line rule adds far less input than a plugin.
:::

## 1. See what a terse mode adds today

If you already use a terse plugin, its hooks' text is stored with each session:

```sh
coding.sh sessions --where hook:plugin:<name>
coding.sh sessions --facets hook
coding.sh usage --cache
```

`coding.sh show <session>` has a `Hook context` row with the estimated tokens per source. These
numbers show what the plugin costs, not whether it saves anything. [Does this plugin help
me?](../how-to/does-this-plugin-help.md) covers this step in more detail.

## 2. Get tasks

A terse mode changes prose most, so include tasks whose answer is prose (review a diff, explain a
crash) as well as code tasks. Draft tasks from your own failed sessions:

```sh
coding.sh eval init terse --sessions
```

They get the tag `suite:terse`. Or, from a clone of the coding.sh repository, import the ten tasks
measured above: `coding.sh eval import examples/plugin-ab/tasks/*/` (tagged `plugin-ab`).

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

```sh
coding.sh harness snapshot --file terse-ab/base.toml
coding.sh harness snapshot --file terse-ab/concise.toml
```

`dir = ".."` reads your repo's AGENTS.md, `.claude/`, `.mcp.json` and the other usual harness files.
Files in your home are read only when both TOMLs list them in `include = [...]`.

| Terse mode | What to put in `concise.toml` |
|---|---|
| A rule | `".claude/rules/concise.md" = "concise.md"` under `[files]`, as above. The report adds the one-item gate. |
| A line in AGENTS.md | A copy of AGENTS.md with the line, as `"AGENTS.md" = "AGENTS.md"` under `[files]`. |
| A skill | `".claude/skills/terse/SKILL.md" = "terse-skill.md"`, with a `name` and `description` in its frontmatter. |
| A plugin | No second TOML. `compare` adds the plugin itself (step 4). |

## 4. Run both arms

```sh
coding.sh compare base concise --tag suite:terse --k 3 --dry-run
coding.sh compare base concise --tag suite:terse --k 3 --gate --promote --max-cost 20 --yes
```

For a plugin, B is A plus the plugin, by name or directory:

```sh
coding.sh compare base --with plugin:<name> --tag suite:terse --k 3 --gate --promote --yes
```

| Flag | Default | What it does |
|---|---|---|
| `--k` | 1 | Runs per task and arm, each from a fresh copy with its own config directory. |
| `--gate` | off | Ship, hold or don't ship on pass rate, naming the tasks B broke. |
| `--promote` | off | Exits 0 when B is credibly cheaper within `--eps-q` (0.1) of A's pass rate, or credibly better. |
| `--max-cost` | none | Starts no new run once finished runs cost this much. |
| `--dry-run` | off | Prints how many runs each arm would make, and runs nothing. |

## 5. Read the result

| Line | What it says |
|---|---|
| verdict | B − A in pass rate, with a paired bootstrap interval over tasks. |
| `gate` | Ship it, Hold or Don't ship, with the tasks B broke. |
| `pareto:` | B's cost change and quality change against A, each with a 95% interval, in USD when 80% of runs report a cost, else tokens. |
| `tokens / run` | Input, output, cache reads and cache writes together. |
| `cost / solved` | Each arm's cost divided by the tasks it solved. |

On a Claude subscription, costs are API-equivalent: list prices applied to the tokens each run used.

## 6. Split output from input overhead

The token row is one total. To see where the cost went, read each arm's mean tokens by type from the
store. This reads the latest comparison:

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

A terse mode saves money only when the drop in `output` is worth more than the rise in `cache_write`
and `input`. On Opus 5.5 an output token costs $20 per million and a cache-write token $5 (5-minute
cache) or $8 (1-hour cache). These are means, without intervals.

## A faster check on recorded calls

With the [proxy](../how-to/capture-with-proxy.md) capturing your sessions, send recorded model calls
again with a changed system prompt, and compare output tokens and cost per call:

```sh
coding.sh show latest#-1 --all
coding.sh exp replay --session latest --limit 10 --vary system=@terse-system.md --n 3 --dry-run
```

`--vary system=@file` replaces the whole system prompt in arm B, so start from the recorded one that
`show <call> --all` prints, plus your line. A replay measures single calls, so it does not show
whether the task still gets done.

## If something goes wrong

| Symptom | Check |
|---|---|
| The power line says only a large change can show | Add tasks, or raise `--k`. |
| Long sessions come out differently | On short tasks the instruction is a large share of each run. A reminder on every prompt adds up, and so can the output saved. |

A pass rate does not measure whether you prefer shorter replies. That is a fine reason to keep a
terse mode, just not a cost reason.

## Next steps

- [Does this plugin help me?](../how-to/does-this-plugin-help.md): what a plugin's hooks add to your
  sessions.
- [Compare two agents on your repo](../how-to/compare-agents.md): other setups `compare` can test.
- [Cost](https://coding.sh/docs/cost): where your sessions' spend goes.
