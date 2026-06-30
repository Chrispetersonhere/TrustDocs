-- M2 identity (build spec §9, §10): instructor login sessions.
--
-- Instructors authenticate with email + password and receive an opaque
-- server-side session token (httpOnly cookie). Students do NOT use this table:
-- their per-assignment link token (assignment_tokens) is itself the capability
-- credential that binds a writing_session to (student, assignment).

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
