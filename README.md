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
```

Then:

- **Instructor:** sign in at `http://localhost:3000/login.html` (demo account
  `instructor@example.com` / `demo-password-123`, or register your own), create an
  assignment, and add students by email to mint each student's per-assignment link.
- **Student:** open the per-assignment link (the server prints a demo one at startup,
  e.g. `http://localhost:3000/?token=…`). Typing is captured live; the replay is at
  `…/replay.html?token=…`.

### Local (no database — in-memory, for trying the slice)

```bash
pnpm install
pnpm build:client
pnpm start          # prints the editor + replay URLs
```

**Windows (PowerShell)** — one command does install + build + run:

```powershell
./scripts/windows/dev.ps1                 # in-memory (no DB)
./scripts/windows/dev.ps1 -Docker         # full stack via Docker
./scripts/windows/dev.ps1 -Postgres "postgres://scriptorium:scriptorium@localhost:5432/scriptorium"
./scripts/windows/dev.ps1 -Test           # typecheck + tests, then exit
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
pnpm lti keygen|register|list  # LTI 1.3 tool key + platform registration (needs DB)
```

## Identity model (M2)

- **Instructors** are real password accounts (bcrypt-hashed), with an httpOnly
  server-side session cookie. They create assignments and enroll students by email.
- **Students** authenticate by a **per-assignment capability link** (`/?token=…`). The
  token is the credential: opening it establishes the `writing_session` unforgeably
  bound to (student, assignment), and the student sends it as a bearer token on every
  request. No student passwords — lowest friction, and each token grants access to
  exactly one (student, assignment) session.
- Authorization is **deny-by-default**: the bound student may read and write their own
  session; the owning instructor may read it (never write); nobody else sees it.

The instructor **dashboard** (`/dashboard.html`) lists assignments and, per assignment,
each enrolled student with their link and live submission stats (version, edit count,
chain-intact status, and a link to the replay).

### LTI 1.3 (the strong identity path)

Scriptorium can also be launched from an LMS (Canvas, Moodle, …) as an **LTI 1.3
Advantage** tool. Here identity is even stronger: a **platform-signed launch JWT** vouches
for who the user is, their role, and which course/assignment they opened — verified
against the platform's JWKS, never asserted by the client. A student who launches is
provisioned and signed in automatically, with their session bound to their LMS identity;
instructors land on the dashboard. **NRPS roster sync** pulls the course roster via the
LTI Advantage client-credentials flow. The tool exposes `/lti/login`, `/lti/launch`, and
`/lti/jwks`; register a platform with `pnpm lti register …`. Full setup and the security
model are in **[docs/LTI.md](docs/LTI.md)**. LTI coexists with local accounts — a
deployment can use either or both.

## Status against the milestones

- **M0 Scaffold** — monorepo, shared schema, Docker Compose, migrations, CI, health check. ✅
- **M1 Vertical slice** (the first hard deliverable) — eager collab capture, server authority, hash-chained append-only log, replay. ✅
- **M2 Identity & assignments** — real instructor accounts + roles, per-student/per-assignment capability links, unforgeably-bound writing sessions, instructor dashboard. ✅
- **LTI 1.3 Advantage** (originally a v1 non-goal; built on request) — OIDC login, signed-launch identity/role/context provisioning, tool JWKS, NRPS roster sync, deny-by-default coexistence with local accounts. ✅
- **M3 Evidence & replay UX** — polished replay: play/pause walkthrough, dual scrubbing (by version and by receipt time), an interactive timeline (server-derived large-insertion markers, clearly-labeled untrusted paste annotations, working-session bands), in-context highlighting of what each step changed, and a per-session active-time breakdown. Nowhere does the UI assert a judgment, score, or flag. ✅
- **M4 Integrity & privacy** — verification endpoint + CLI, tamper test (incl. DB-level), append-only DB trigger, retention + hard-delete, self-verifying export bundle, deploy docs. ✅

Every constraint in the Definition of Done that these milestones cover is enforced by a
test in `packages/core/test` and `apps/server/test`, and the full editor → dashboard →
replay flow is exercised in a real browser.
