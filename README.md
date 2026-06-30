# Scriptorium

**A self-hostable writing tool where the server — never the student's machine — is the authoritative record of how a document was built.**

Students compose written work in the browser. As they type, every edit is sent to
the server, which orders it, stamps the time it was *received*, and can reconstruct
the document from those edits alone. The result is a tamper-evident provenance
record that makes claims like "this is how the document was composed" and "this much
active time was spent" defensible under scrutiny.

Scriptorium **presents uninterpreted evidence. It never scores, classifies, or
accuses.** Its most important output is often *exculpatory*: positive evidence of how
an honest student actually wrote, for someone wrongly flagged by an external AI
detector.

---

## The one invariant

> **The client is never trusted for time or for final document state.**

Everything defensible flows from this. The server orders edits, timestamps their
receipt, and reconstructs the document itself. There is no "submit a file" path — the
only document that exists is the one the server rebuilds from the edits it received
live.

## What it resists (and what it doesn't)

**Resisted:** post-hoc document fabrication (no upload path); forged timestamps
(timing is server receipt time); tampering with the stored record (a hash-chained,
append-only log — altering any entry invalidates that entry and every entry after
it); paste-as-typing (large insertions are surfaced server-side from the edit stream).

**Not resisted, and we say so plainly:** the *retype attack*. A determined student can
hand-retype text produced elsewhere. Scriptorium does **not** classify this. Its value
is that authentic composition has a recognizable *shape* — recursive, mid-paragraph
insertions, deletions, returns to earlier sections — whereas retyping a finished text
tends to be linear and low-revision. **The replay surfaces the shape; a human reads
it. The tool asserts nothing.**

---

## How it works

```
 Browser (ProseMirror + prosemirror-collab)
   │  submits { version, clientID, steps }  ── eager, small batches ──►
   ▼
 Server authority (Node + TypeScript, the SAME ProseMirror schema & transform libs)
   │  validates version → applies steps → assigns versions
   │  stamps server_received_at (authoritative)
   │  appends confirmed steps to the hash-chained, append-only edit_log
   ▼
 PostgreSQL  (edit_log: append-only, UPDATE blocked by trigger)
```

The **ProseMirror schema lives in one shared package** (`packages/schema`) imported by
the editor, the server applier, and the replay viewer — one source of schema truth.
Step semantics are never reimplemented: steps are applied and documents reconstructed
only via `prosemirror-transform` and that shared schema.

### The hash chain

Each confirmed batch is one `edit_log` entry. Per session:

```
prev_hash[0] = SHA256( canonical_json({ assignment_id, author_id, session_id, server_session_start }) )
entry_hash[i] = SHA256( prev_hash[i] + "\n" + canonical_json({ version, steps_json, server_received_at, prev_hash }) )
prev_hash[i+1] = entry_hash[i]
```

`canonical_json` is deterministic (sorted keys, no insignificant whitespace), used
identically on write and verify. Verification recomputes forward from genesis and
reports the **first divergence** — so altering one row fails at that entry and every
entry after it, and nowhere before.

---

## Quick start

### Docker (self-host, persistent)

```bash
docker compose up --build
# Editor:  http://localhost:3000/?session=00000000-0000-0000-0000-000000000001
# Replay:  http://localhost:3000/replay.html?session=00000000-0000-0000-0000-000000000001
```

### Local (no database — in-memory, for trying the slice)

```bash
pnpm install
pnpm build:client
pnpm start          # prints the editor + replay URLs
```

Without `DATABASE_URL` the server uses an in-memory store: the integrity model is
identical, only durability differs (data is lost on restart). Set `DATABASE_URL` to
persist to Postgres, which is the authoritative deployment.

See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** for the full guide (env vars,
backup/restore, retention, hard-delete) and **[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)**
for the security model and trust audits.

---

## Layout

| Path | What |
| --- | --- |
| `packages/schema` | The single shared ProseMirror schema. |
| `packages/core` | Integrity engine: canonical JSON, hash chain, collab authority, reconstruction, evidence, export bundle, in-memory store. Heavily tested. |
| `apps/server` | Express app (collab + evidence + verify + bundle endpoints), Postgres store, migrations, browser client (editor + replay), and the verify/retention CLIs. |

## Commands

```bash
pnpm typecheck                 # tsc --noEmit across the monorepo (also `pnpm lint`)
pnpm build:client              # bundle the browser editor + replay
pnpm test                      # integrity engine + HTTP slice (no DB needed)
pnpm start                     # run the server
pnpm migrate                   # apply DB migrations (needs DATABASE_URL)
pnpm verify --bundle f.json    # re-verify an exported evidence bundle OFFLINE
pnpm verify --session <id>     # verify a live session from the DB
pnpm retention [--apply]       # purge sessions past their retention window
```

## Status against the milestones

- **M0 Scaffold** — monorepo, shared schema, Docker Compose, migrations, CI, health check. ✅
- **M1 Vertical slice** (the first hard deliverable) — eager collab capture, server authority, hash-chained append-only log, replay. ✅
- **M3 (server-side evidence)** — large-insertion timeline (server-derived + clearly-labeled client-asserted) and receipt-based active time. ✅
- **M4 Integrity & privacy** — verification endpoint + CLI, tamper test (incl. DB-level), append-only DB trigger, retention + hard-delete, self-verifying export bundle, deploy docs. ✅
- **M2 Identity** (real accounts, per-student links, dashboard) — schema + seam in place; full auth UI is the next milestone. ◻️ (intentionally deferred — see docs/THREAT_MODEL.md)

Every constraint in the Definition of Done that this slice covers is enforced by a
test in `packages/core/test` and `apps/server/test`.
