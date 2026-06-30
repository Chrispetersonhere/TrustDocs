# Self-hosting Scriptorium

This guide stands the tool up with Docker Compose and walks through creating a working
writing session, watching the replay, verifying integrity, and the privacy controls.

## Prerequisites

- Docker + Docker Compose, **or** Node 20+ and pnpm 10 for a local run.

## 1. Bring up the stack

```bash
docker compose up --build
```

This starts Postgres and the app, applies database migrations automatically on
startup, and seeds one demo writing session (the M1 hardcoded author + assignment).

- **Editor:** `http://localhost:3000/?session=00000000-0000-0000-0000-000000000001`
- **Replay:** `http://localhost:3000/replay.html?session=00000000-0000-0000-0000-000000000001`

Type in the editor. The status pill shows "Saved · v<n>" as each batch is confirmed by
the server. Open the replay in another tab and scrub from version 0 to watch the
document being built from the server's log alone.

## 2. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | _(unset)_ | Postgres connection string. **Unset → in-memory store** (non-persistent; for trying the slice only). Set it for any real use. |
| `PORT` | `3000` | HTTP port. |
| `ALLOW_HARD_DELETE` | `false` | When `true`, enables the `DELETE /api/sessions/:id` endpoint (build spec §9). Off by default so the destructive path is opt-in. |

## 3. Running locally without Docker

```bash
pnpm install
pnpm build:client
# In-memory (no DB):
pnpm start
# With Postgres:
export DATABASE_URL=postgres://scriptorium:scriptorium@localhost:5432/scriptorium
pnpm migrate     # optional; the server also migrates on boot
pnpm start
```

## 4. Verifying integrity

Three independent ways to check that a session's record is intact:

**In the replay UI** — a badge shows "Chain intact — all N entries verify from
genesis" or names the first broken entry.

**Against the live database:**

```bash
DATABASE_URL=... pnpm verify --session 00000000-0000-0000-0000-000000000001
```

**Offline, from an exported bundle, with the server down:**

```bash
# Download the self-verifying bundle (also available from the replay page):
curl -s http://localhost:3000/api/sessions/<id>/bundle -o evidence.json
pnpm verify --bundle evidence.json
```

The bundle contains the genesis context and every chained entry. Verification needs no
secret — tamper-evidence comes from the SHA-256 chain itself — so a review board or the
student can re-run `pnpm verify --bundle` independently and also see the reconstructed
document.

## 5. Privacy: retention and deletion (FERPA-minded, build spec §9)

Scriptorium captures granular behavioral data. Two controls ship in v1:

**Retention policy** — set `assignments.retention_days` per assignment. A scheduled job
purges sessions whose start is older than the window:

```bash
DATABASE_URL=... pnpm retention            # dry run — lists what would be purged
DATABASE_URL=... pnpm retention --apply    # permanently purge expired sessions
```

Run it from cron/a scheduled task. Purge is a true hard-delete: `ON DELETE CASCADE`
removes the session's `edit_log` rows with it.

**On-request hard delete** — with `ALLOW_HARD_DELETE=true`:

```bash
curl -X DELETE http://localhost:3000/api/sessions/<id>
```

This is the one sanctioned exception to the append-only rule. The append-only
guarantee for *everything else* is enforced at the database level by a trigger that
rejects `UPDATE` on `edit_log`.

## 6. Backup and restore

The entire authoritative record lives in Postgres.

```bash
# Backup
docker compose exec db pg_dump -U scriptorium scriptorium > backup.sql
# Restore (into a fresh db)
cat backup.sql | docker compose exec -T db psql -U scriptorium scriptorium
```

After a restore, re-run `pnpm verify --session <id>` for any session you want to
re-confirm; an intact chain proves the restore did not alter the record.

## 7. What is intentionally not here yet

Real accounts, per-student/per-assignment links, and the instructor dashboard (M2) are
the next milestone. The database schema (`users`, `assignments`, `assignment_tokens`,
the `(assignment_id, author_id)` binding on `writing_sessions`) is already in place; v1
seeds a single demo identity so the slice is usable end-to-end. See
[THREAT_MODEL.md](THREAT_MODEL.md) for why identity is a deliberate, separable build.
