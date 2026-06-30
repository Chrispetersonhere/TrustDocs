-- Scriptorium initial schema (build spec §7, §9).
--
-- edit_log is append-only and hash-chained. There is NO UPDATE path and the only
-- DELETE is the sanctioned hard-delete in §9. A trigger enforces this at the DB
-- level so a stray UPDATE cannot silently rewrite history.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('instructor', 'student')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retention policy (§9). NULL = keep indefinitely; otherwise purge sessions
  -- older than this many days.
  retention_days INTEGER
);

-- Per-student, per-assignment access token (§9). Opening the link establishes a
-- writing_session unforgeably bound to (student, assignment).
CREATE TABLE IF NOT EXISTS assignment_tokens (
  token         TEXT PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS writing_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id        UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  author_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_session_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  UNIQUE (assignment_id, author_id)
);

CREATE TABLE IF NOT EXISTS edit_log (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         UUID NOT NULL REFERENCES writing_sessions(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  steps_json         JSONB NOT NULL,
  server_received_at TIMESTAMPTZ NOT NULL,
  client_meta        JSONB,
  prev_hash          TEXT NOT NULL,
  entry_hash         TEXT NOT NULL,
  UNIQUE (session_id, version)
);

CREATE INDEX IF NOT EXISTS edit_log_session_idx ON edit_log (session_id, id);

-- Enforce append-only at the database level. UPDATE is forbidden outright.
-- DELETE is allowed (the §9 hard-delete and ON DELETE CASCADE rely on it).
CREATE OR REPLACE FUNCTION edit_log_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'edit_log is append-only; UPDATE is not permitted (build spec §7)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS edit_log_no_update_trg ON edit_log;
CREATE TRIGGER edit_log_no_update_trg
  BEFORE UPDATE ON edit_log
  FOR EACH ROW EXECUTE FUNCTION edit_log_no_update();
