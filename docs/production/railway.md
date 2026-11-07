# Railway

`deploy/railway.json` builds the repo's Dockerfile and checks `/healthz`. The store is a Railway
Postgres database in the same project.

## 3 steps

1. **Create the project.** New project, then *Deploy from GitHub repo* (your fork of coding.sh). Add a
   database with *+ New → Database → PostgreSQL*.
2. **Configure the service.** In the coding.sh service:
   - *Settings → Config-as-code*: set the path to `/deploy/railway.json`.
   - *Variables*:

     ```
     CODING_SH_STORE_URL=${{Postgres.DATABASE_URL}}
     CODING_SH_INGEST_KEYS=myapp:csh_ik_…
     CODING_SH_READ_KEYS=*:csh_rk_…
     CODING_SH_TRUST_PROXY=1
     ```

   - *Settings → Networking*: generate a public domain.
3. **Deploy**, then check `https://<your-domain>/readyz` for `{"ok":true,"store":"postgres",…}`.

Send traces with `CODING_SH_URL=https://<your-domain>` and open `https://<your-domain>/?t=csh_rk_…`.

## Notes

- **Variables live in the dashboard.** `railway.json` cannot hold environment variables, so the store
  URL is the `${{Postgres.DATABASE_URL}}` reference above. Blobs go to the same database.
- **Port.** Railway sets `PORT`; serve listens on it.
- **Why `/healthz`.** Railway starts the new deployment and waits for its healthcheck while the old one
  still runs. The old one holds the single-writer lock, so the new one reports `/readyz` 503 (standby)
  until the old one stops, and a `/readyz` check would never pass. With `/healthz`, Railway switches
  over, sends SIGTERM to the old deployment (`drainingSeconds: 30` covers the 25 s queue drain), and
  the new one takes the lock within 5 s. Clients retry the 503s in between.
- **One replica.** Keep the service at one replica. Only one replica ingests; more add nothing.
- **Volumes are optional.** Everything lives in Postgres. SQLite on a Railway volume also works: mount
  it at `/data` and leave `CODING_SH_STORE_URL` unset.
