# Render

`render.yaml` at the repo root is a Blueprint: a Docker web service plus a Render Postgres database
whose connection string becomes the store URL. Blobs go to the same database.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jackulau/coding.sh)

## 3 steps

1. **Make keys** (see [README.md](README.md#point-it-at-a-database-in-3-steps)). Render services
   have no volume here, so serve cannot keep first-start keys across deploys.
2. **Create the Blueprint.** Click the button above (it uses this repo), open
   `https://render.com/deploy?repo=<your fork's URL>`, or pick *New → Blueprint* in the dashboard.
   Render asks once for `CODING_SH_INGEST_KEYS` (`myapp:csh_ik_…`) and `CODING_SH_READ_KEYS`
   (`*:csh_rk_…`).
3. **Check it.** `https://<service>.onrender.com/readyz` returns `{"ok":true,"store":"postgres",…}`.

Send traces with `CODING_SH_URL=https://<service>.onrender.com` and open
`https://<service>.onrender.com/?t=csh_rk_…`.

## Notes

- **Plans.** The Blueprint uses `0.5c-512mb` for the service and `0.1c-256mb` for the database. The
  free web plan sleeps when idle and would drop exporter batches, so do not use it for ingest.
- **Why `/healthz`.** Render starts the new instance and waits for its health check while the old one
  still runs and holds the single-writer lock. The new one is in standby (`/readyz` 503) until the old
  one stops, so the Blueprint checks `/healthz`. Clients retry the 503s during the handover.
- **Port.** Render sets `PORT`; serve listens on it.
- **One instance.** Keep the service at one instance; only one ingests.
- **Retention.** A small database fills up. Add `CODING_SH_RETENTION_DAYS=30` (or your number) to the
  service environment.
