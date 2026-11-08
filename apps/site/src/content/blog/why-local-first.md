---
title: Why coding.sh is local-first
description: Agent sessions hold your prompts, your code and sometimes your keys, so coding.sh keeps them on your machine unless you choose to send them.
date: 2026-11-07
---

An agent session is a record of your work. It holds your prompts, the model's replies, every tool
call with its input and output, and the files that changed. Sometimes it also holds a key that
ended up in a shell command. coding.sh records all of that, so where the record lives matters.

## One folder on your machine

Everything coding.sh captures goes into `~/.coding.sh`. Set `CODING_SH_HOME` to put it somewhere
else. Sessions and events go into a SQLite index, `index.db`, through Node's built-in
`node:sqlite`. Large prompts and tool output go into `blobs/`, compressed with zstd.

The viewer runs from the same CLI. It binds to 127.0.0.1 and asks for the token in the URL it
prints.

## Nothing is sent unless you ask

With no sinks configured, no session data leaves your machine. The one default network request is
a daily update check: a GET to `api.github.com`, falling back to `registry.npmjs.org`. Set
`CODING_SH_NO_UPDATE_CHECK=1` or `[update] check = false` to turn it off.

The hook that agents run writes the raw payload to `~/.coding.sh/spool` with mode 600 and exits.
It does no network work.

To send events somewhere else, add a sink. A sink sends metadata unless you set `mode = "full"`:
ids, timestamps, kinds, durations, token counts and short labels. Prompts, code and tool output
stay on your machine.

```toml
# ~/.coding.sh/config.toml
[[sinks]]
kind = "otlp"                      # or "http"
endpoint = "http://localhost:4318"
mode = "metadata"                  # default; "full" sends content
```

## Secrets are redacted before they are written

Redaction runs at ingest, before anything reaches the index, the blobs or a sink. The built-in
rules catch private keys, vendor API keys and tokens, JWTs, and bearer and basic auth.

Redaction keeps a secret out of the store, but the agent and its model provider still saw it. So a
session that held a vendor token gets the `secret:exposed` tag, and this lists the sessions whose
credentials to rotate:

```sh
coding.sh sessions --flag secret:exposed
```

If a value got past redaction, `coding.sh purge --literal leaked.txt` replaces every stored copy
with `[redacted:purged]`.

## A cloned repo cannot widen it

A `.coding.sh/config.toml` inside a repository can add redaction rules or switch capture to
metadata mode. It cannot add sinks or move the store. Opening a repository you cloned does not
send your sessions anywhere.

## Read more

- [Storage, sinks and privacy](https://github.com/jackulau/coding.sh/blob/main/docs/guides/privacy.md) lists everything that is captured and every setting that changes it.
- [Concepts](https://coding.sh/docs/concepts) defines the words coding.sh uses: sessions, events, flags and the rest.
