# Flags and derails

A flag is a failure pattern coding.sh found in a session. A derail is the step where a long run went
wrong. A name with a colon, such as `skill:pdf`, is a tag and not a failure.

## Flags

| Flag | Set when the session |
|---|---|
| `premature-completion` | Stopped while the last test run was failing, and the agent's last words did not say so. |
| `repeated-tool-failure` | Had the same tool fail three times in a row with similar input. |
| `no-verification` | Changed files, but no test, type check, lint or build ran. |
| `compaction` | Had its context compacted. |
| `test-tamper` | Edited a test or test config to hide failures. |
| `duplicate-fetch` | Repeated three or more read-only calls in one context with the same result and no edit in between. |
| `skill-copy-conflict` | Used two copies of one skill, such as the project's and a personal one. |
| `refusal` | Had a model call stop on a refusal. |
| `text-tool-call` | Had the model write a tool call out as text, so it never ran. |
| `unapproved-action` | Ran a destructive or paid command that the user's turn did not approve. |
| `step-retried`, `resumed` | Is a durable workflow run that retried a step, or continued after a crash. |

A session's `flags` also lists the name of each derail below.

## Derails

| Derail | Set when |
|---|---|
| `looping` | The same tool call returns the same result again and again, with no edit in between. |
| `failure-streak` | Tool calls fail one after another. |
| `churn` | An edit to a file is undone, then undone again. |
| `no-progress` | A long stretch of calls makes no edit and no better test result while the context grows. |
| `stalled` | A tool call sat with nothing else happening, then failed or never finished. |
| `context-thrash` | Automatic compactions come back to back. |
