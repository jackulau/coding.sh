# Install, update and uninstall

coding.sh needs Node 22.15 or newer.

## Installer

```sh
curl -fsSL https://coding.sh/install | sh
```

It installs the latest GitHub release, runs `coding.sh init`, then opens the viewer.

## npm

Once `coding.sh` is on npm:

```sh
npm install -g coding.sh   # or run any command with npx coding.sh
coding.sh init             # finds your agents, shows one plan, asks once (Y/n)
coding.sh                  # opens the viewer
```

`npx coding.sh init` also works. The hook is copied to a stable path, but the MCP entry points at
the npx cache copy of the CLI. Install globally if you want the MCP server to survive
`npm cache clean`.

## From source

```sh
git clone https://github.com/jackulau/coding.sh && cd coding.sh
npm install && npm run build -w coding.sh
npm install -g ./packages/coding.sh   # puts `coding.sh` on PATH (a symlink to this checkout)
coding.sh init
coding.sh
```

Or skip the global install and run `node packages/coding.sh/dist/cli.mjs <command>` directly.

## What `init` changes

`init` points each detected agent's hooks at `~/.coding.sh/bin/hook.mjs` and registers the
coding.sh MCP server with the agents that support MCP. Every config file it edits is backed up to
`~/.coding.sh/backups` first. `coding.sh init --dry-run` prints the plan (each agent, the files it
would change, anything that blocks capture) and writes nothing; `--diff` adds the exact edits.

After that, use your agents as usual. Sessions show up in the viewer, in `coding.sh sessions` and
over MCP. There is no ingest step: read commands, the viewer and the MCP server pick up new events
on their own.

Check your setup with `coding.sh doctor`.

## Updates

Commands print one dim line on stderr when a newer release is out. The check runs in the
background at most once a day, and commands never wait on it. `coding.sh update` installs the new
release.

The check is off when `CI` is set, or with `NO_UPDATE_NOTIFIER=1`, `CODING_SH_NO_UPDATE_CHECK=1`
or `[update] check = false` in `~/.coding.sh/config.toml`.

## Uninstall

```sh
coding.sh uninstall --dry-run   # show what would change
coding.sh uninstall --yes       # remove hooks and MCP entries from every agent
npm uninstall -g coding.sh
rm -rf ~/.coding.sh             # optional: delete captured data
```

`uninstall` restores each agent config file byte for byte if nothing else has edited it since
`init`. Otherwise it removes only the coding.sh entries.
