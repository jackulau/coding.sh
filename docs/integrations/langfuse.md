# Langfuse SDKs

An app that sends traces with a Langfuse SDK, or with any OpenTelemetry exporter set up for
Langfuse, can send them to coding.sh instead. Change the host and keep the keys.

## Send traces

`coding.sh serve` and `coding.sh collector` take OTLP traces at `/api/public/otel/v1/traces`, the
path Langfuse uses. It is the same receiver as `/v1/traces`.

1. Make an ingest key on the server and list it in `CODING_SH_INGEST_KEYS` (see
   [Production](../PRODUCTION.md)).
2. Set the app's Langfuse public key or secret key to that ingest key. The other one can stay as it
   is.
3. Point the SDK's host setting at the server, for example `LANGFUSE_HOST=https://obs.example.com`
   (newer SDKs read `LANGFUSE_BASE_URL`).

A Langfuse SDK sends the two keys as Basic auth: `public key:secret key`. On
`/api/public/otel/v1/traces` only, coding.sh accepts Basic auth when the username or the password is
an ingest key, and stores the traces under that key's project. A Bearer ingest key works there too.
When the server has ingest keys, any other key answers 401.

A plain OpenTelemetry exporter works the same way:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://obs.example.com/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic $(printf 'pk-lf-app:%s' "$INGEST_KEY" | base64)"
```

The local `coding.sh collector` takes the same path with no key.

## What coding.sh reads

| Attribute | Becomes |
|---|---|
| `langfuse.session.id` (or `session.id`, `gen_ai.conversation.id`) | the session id: spans with the same value join one session |
| `langfuse.user.id`, `user.id` or `enduser.id` | `user` on the session's start event |
| `langfuse.environment`, `deployment.environment.name` or `deployment.environment` | `environment` on the session's start event |
| `langfuse.release` or `service.version` | `release` on the session's start event |
| `langfuse.trace.tags` | `tags` on the session's start event, and a `tag:<name>` flag for each |

When several names are set, the first one in the table wins. A span's attribute wins over the
same attribute on the resource, so set them on the root span or on the resource. Each value is
trimmed, cut at 200 characters and redacted like the rest of the event.

`langfuse.trace.tags` is an array of strings, or a string that holds a JSON array of strings; any
other string is one tag. Each tag is trimmed and cut at 64 characters, and empty tags and repeats
are dropped. A span keeps at most 20 tags, and a session keeps at most 20 across its traces.

Model calls, tools and tokens come from the `gen_ai.*` attributes the SDK writes, as for any
OpenTelemetry app ([agents guide](../guides/agents.md)).

## Filter by user, environment and release

The values become three `--where` keys ([query reference](../reference/query.md#tool-and-event-keys)):

```sh
coding.sh sessions --where 'user:alice env:production'
coding.sh sessions --where 'release:v1.4.* ok:false' --json
```

They read the session's start event, so beside other event keys they match on their own:
`user:alice tool:Bash` is a session of alice's that ran Bash.

## Filter by tag

Each trace tag is a session flag, `tag:<name>`, so `flag:` finds it:

```sh
coding.sh sessions --where 'flag:tag:checkout'
coding.sh sessions --flag tag:prod
```

## Limits

- Traces only. There is no `/api/public/otel/v1/logs`, and Langfuse's own ingestion API
  (`/api/public/ingestion`) is not served.
- Basic auth works on `/api/public/otel/v1/traces` only. The other ingest routes take a Bearer key.
