# Explore sessions: CLI, viewer and MCP

## CLI

```sh
coding.sh sessions                 # recent sessions (--agent, --repo, --since, --subagents)
coding.sh show latest              # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"      # full-text search over prompts, replies and tool calls
coding.sh usage --by model         # tokens, turns and cache hits by agent, model, day or repo
coding.sh ui                       # local viewer on 127.0.0.1 (token-protected URL)
```

Every command takes `--json` and `--help`. `coding.sh` with no command runs `init` until capture
is set up, then opens the viewer.

## Viewer

`coding.sh ui` serves the viewer on 127.0.0.1 and opens it in your browser. It needs the
per-process token in the URL it prints.

## MCP

`coding.sh mcp` serves your captured data to agents over stdio, with the tools `sessions_list`,
`session_get`, `session_current`, `search`, `failures`, `latency`, `usage`, `subagents`,
`eval_from_session`, `experiments_list`, `experiment_compare`, `benchmarks` and `status`.

`coding.sh init` registers it with Claude Code, Codex, Cursor and OpenCode (`--no-mcp` skips
this). `coding.sh mcp config` prints the snippet for any other client.
