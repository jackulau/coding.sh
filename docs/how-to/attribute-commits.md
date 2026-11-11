# See which agent session wrote each commit

Match each commit's added lines to the AI agent session that wrote them, see who wrote each line of
a file, and export the result as Agent Trace records.

`coding.sh attribution` shows which captured agent session wrote the lines each commit added. Use
it to see how much of a branch any AI agent wrote, or which session to open for a line. It only
reads git (`log`, `diff`, `blame`, notes) and never writes refs, notes, the index or objects in your
repository.

## Before you start

- coding.sh has captured sessions in this repository ([Quickstart](https://coding.sh/docs/quickstart)).
- Those sessions' changes are committed. A session is credited for commits from its start to 21
  days later.

## 1. List commits and the sessions that wrote them

Run it inside the repository:

```sh
coding.sh attribution
```

```text
4 commits since Nov 4 18:40: 13 of 46 added lines by 3 sessions (28%)

COMMIT    DATE          AGENT LINES  SESSIONS              SUBJECT
336aa247  Nov 11 04:26  8/20         9887c95d claude-code  fix(store): apply each SQLite migration once when two proce…
a3609380  Nov 11 03:41  1/9          ses_b32e opencode     fix(adapters): Antigravity sessions take their title from t…
8fe8c7ee  Nov 11 02:51  4/16         8411007a claude-code  ci: skip the site deploy when CLOUDFLARE_API_TOKEN is unset

  See which lines of a file each session wrote:
    coding.sh blame <path>
```

Four commits were read; the one with no agent lines is left out unless you pass `--all`.

| Option | What it does |
|---|---|
| `--since 7d` | Only commits after this time. Default: the first captured session in the repo. |
| `--rev main` | Walk back from this branch or commit. Default: HEAD. |
| `--all` | Also list commits with no agent lines. |
| `--json` | Totals, sessions and each commit's attributions as one document. |

All options: [coding.sh attribution](https://coding.sh/docs/cli/attribution).

## 2. See who wrote each line of a file

```sh
coding.sh blame src/store/sqlite.ts:2-8
```

```text
src/store/sqlite.ts at 336aa247: 3 of 7 lines by 1 agent session

2  336aa247  -                       migrate(): void {
3  336aa247  9887c95d claude-code      const applied = this.db.prepare("SELECT 1 FROM migrations WHERE version = ?");
4  336aa247  -                         for (const m of MIGRATIONS) {
5  336aa247  -                           this.tx(() => {
6  336aa247  9887c95d claude-code          // Another process may have applied this version between the read above and taking the write lock.
7  336aa247  9887c95d claude-code          if (applied.get(m.version)) return;
8  336aa247  -                             this.db.exec(m.sql);

SESSION                               AGENT        MODEL            LINES
9887c95d-2739-4dae-8222-4471386def67  claude-code  claude-opus-4-8  3
```

Each line shows the commit that last changed it, as `git blame` does, and the session that wrote
it. `-` means no captured session wrote it. Leave out `:2-8` for the whole file.

## 3. Open the session

```sh
coding.sh show 9887c95d-2739-4dae-8222-4471386def67
coding.sh replay 9887c95d-2739-4dae-8222-4471386def67 --step 10
```

`show` prints the session's turns and tool calls. `replay --step` shows the edit that wrote the
lines ([Replay a session](https://coding.sh/docs/use-cases/replay-agent-session)).

## 4. Export Agent Trace records

```sh
coding.sh attribution export > agent-trace.jsonl
coding.sh attribution export --since 30d --out trace.jsonl
coding.sh attribution export --viewer-url https://coding.example.com
```

It prints one [Agent Trace](https://agent-trace.dev) record per commit with agent lines, as JSON
lines, so other tools can read them. Each record is checked against the RFC 0.1.0 schema before it
is written. `--json` prints `{version, records}` as one document instead.

| Field | Holds |
|---|---|
| `vcs.revision` | The commit. Line numbers are the commit's own, so they match `git blame`. |
| conversations | One per session: contributor `ai`, a `model_id` such as `anthropic/claude-sonnet-4-6`, and a viewer `url`. |
| ranges | A `content_hash` of the lines (`sha256:` plus 16 hex digits). The lines themselves are not exported. |
| `id`, `timestamp` | Derived from the commit, so exporting again gives the same records. |
| `version` | `"0.1"`, the major.minor the RFC's schema requires. |
| `metadata` | `confidence` (the commit's mean) and `sh.coding`: subject, line counts, each session's lines and method. |

Session links point at `http://127.0.0.1:4319/#/s/<id>` unless you pass `--viewer-url`.

## Read the result

| Column | Means |
|---|---|
| `AGENT LINES` | Lines credited to a session, out of lines the commit added. |
| `SESSIONS` | Each session credited, by id prefix and agent. |
| `-` in `blame` | No captured session wrote the line: a person wrote or rewrote it, or an agent coding.sh did not capture. |
| `confidence` | 1 from a pre-agent snapshot, 0.9 from HEAD at the session's start, 0.8 from edit tool calls, lowered for looser matches. |

:::more How matching works
For each session, coding.sh takes the lines it added: the diff from its start state to its end
snapshot. It keeps a file of that diff only when the session's tools named the file, or the session
ran a shell or subagent call, which can write files nothing names. A session with neither is
credited nothing. A named file takes the lines its edit steps added.

For a named file the diff does not hold, it uses the session's own edit tool calls. That is every
such file when there is no end snapshot, and a file whose change had left the tree by then.

Then it walks each commit, oldest first, in passes over the files the commit changed:

| Method | Matches when | Confidence |
|---|---|---|
| Patch id | The file's change equals what one session did to it. A rebased commit still matches. | as the source |
| Line hash | A session added the same line to the same file. | as the source |
| Moved line | After same-file matches, a line of 24+ characters still unmatched matches one the session wrote in another file. | 0.8x |
| Trivial line | Braces, blank lines and `else` follow the nearest matched line in their block. | 0.95x |
| git-ai | [git-ai](https://github.com/git-ai-project/git-ai) notes (`refs/notes/ai`) credit lines no session matched, to that agent with no session link. | 0.9 |

A file the session's tools never named gives 0.85x; only a shell or subagent call allows one.

- A session's line is credited once. A person who types the same line in a later commit, or copies
  it into another file of the same commit, owns that copy.
- An edit tool call counts for the lines it added itself, less the ones a later call of the session
  removed. Lines someone else added between two calls are not the session's.
- A session is credited for commits from its start (10 minutes of clock skew allowed) to 21 days
  later.
- When two sessions added the same line, the one that started later wins.

Sessions are found by repo root, including its other worktrees. Lines are stored as hashes, never
as code text.
:::

## If something goes wrong

| Symptom | Check |
|---|---|
| No commits listed | No captured session in this repo, or no agent lines since `--since`. Run `coding.sh sessions --repo .`, then try `--all`. |
| A commit you know an agent wrote shows `0/N` | Redaction changed the stored content, or the session had neither an end snapshot nor edit tool calls. Live capture takes the end snapshot when ingest runs soon after the turn ends. |
| A line is credited twice | Commits before `--since` are not read, so a line one of them used can be credited again. Leave `--since` at its default. |
| A merge commit shows no lines | A merge commit's own changes (conflict resolutions) are not attributed. |
| A file a person wrote is credited | A session that ran a shell or subagent call can be credited a file written by hand before its end snapshot, at lower confidence. |
| A file an MCP tool wrote is not credited | Tools coding.sh does not read as edits are not credited, unless the session also ran a shell or subagent call. |

## Next steps

- [Find and read runs](https://coding.sh/docs/explore): read the session that wrote a commit.
- [coding.sh blame](https://coding.sh/docs/cli/blame): every option.
- [Track cost and tokens](https://coding.sh/docs/cost): what each session cost.
