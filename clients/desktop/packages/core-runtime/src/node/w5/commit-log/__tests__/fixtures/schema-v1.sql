-- The CAN-3805 schema, before CAN-4029. Kept independent of the current schema.
CREATE TABLE w5_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
CREATE TABLE w5_revisions (
    resource TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1)
  ) STRICT;
CREATE TABLE w5_commits (
    commit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('committed', 'applied', 'recovery-required')),
    diagnostics_json TEXT,
    committed_at TEXT NOT NULL
  ) STRICT;
CREATE INDEX w5_commits_by_state ON w5_commits (state, commit_id);
CREATE TABLE w5_commit_files (
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    path TEXT NOT NULL,
    previous_fingerprint TEXT,
    contents TEXT,
    PRIMARY KEY (commit_id, path)
  ) STRICT;
CREATE INDEX w5_commit_files_by_path ON w5_commit_files (path, commit_id);
CREATE TABLE w5_receipts (
    caller TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    PRIMARY KEY (caller, operation, idempotency_key)
  ) STRICT;
CREATE TABLE w5_reservations (
    reservation_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    caller TEXT,
    idempotency_key TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'recovery-required')),
    diagnostics_json TEXT NOT NULL,
    reserved_at TEXT NOT NULL
  ) STRICT;
CREATE UNIQUE INDEX w5_reservations_by_key
    ON w5_reservations (caller, operation, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
INSERT INTO w5_meta (key, value) VALUES ('schema_version', '1');
