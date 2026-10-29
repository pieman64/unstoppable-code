-- A v2 W5 commit log as written by the base library (CAN-4408 reopen evidence).
-- Base: packages/desktop-shared/src/node/w5-commit-log at 9501d6fdc35bcda4d02a98fadcc12400a1db7dd7.
-- Generated, not edited: from the repository root, run
--   node packages/core-runtime/src/node/w5/commit-log/__tests__/fixtures/generate-schema-v2-base.mjs
-- It extracts the base library with git archive, bundles it with esbuild,
-- writes the scenario in schema-v2-base-scenario.ts, dumps every table with
-- quote(), checks the dump reloads unchanged and that a base open changes no
-- row, and records the base reads in schema-v2-base.observations.json.
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
    committed_at TEXT NOT NULL,
    completed_at TEXT,
    outcome_expired INTEGER NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1))
  ) STRICT;
CREATE INDEX w5_commits_by_state ON w5_commits (state, commit_id);
CREATE INDEX w5_commits_to_compact ON w5_commits (completed_at, commit_id)
    WHERE state = 'applied' AND outcome_expired = 0;
CREATE TABLE w5_commit_files (
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    path TEXT NOT NULL,
    previous_fingerprint TEXT,
    new_fingerprint TEXT,
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
INSERT INTO w5_meta (key, value) VALUES ('schema_version', '2');
INSERT INTO w5_revisions (resource, revision) VALUES ('workspaces', 2);
INSERT INTO w5_revisions (resource, revision) VALUES ('workspace:alpha', 1);
INSERT INTO w5_revisions (resource, revision) VALUES ('workspace:bravo', 1);
INSERT INTO w5_revisions (resource, revision) VALUES ('workspace:charlie', 1);
INSERT INTO w5_commits (commit_id, operation, outcome_json, state, diagnostics_json, committed_at, completed_at, outcome_expired) VALUES (1, 'core.workspace.create', 'null', 'applied', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1);
INSERT INTO w5_commits (commit_id, operation, outcome_json, state, diagnostics_json, committed_at, completed_at, outcome_expired) VALUES (2, 'core.workspace.create', '{"workspaceId":"alpha","name":"Alpha"}', 'applied', NULL, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 0);
INSERT INTO w5_commits (commit_id, operation, outcome_json, state, diagnostics_json, committed_at, completed_at, outcome_expired) VALUES (3, 'core.workspace.create', '{"workspaceId":"bravo"}', 'committed', NULL, '2026-10-02T00:00:00.000Z', NULL, 0);
INSERT INTO w5_commits (commit_id, operation, outcome_json, state, diagnostics_json, committed_at, completed_at, outcome_expired) VALUES (4, 'core.workspace.create', '{"workspaceId":"charlie"}', 'recovery-required', '{"conflicts":[{"path":"/w5-fixture/workspaces/charlie/workspace.json","expected":null,"actual":"a03f2386ae06b21109577020844df367857b72c2fcce384c1896fed98a89c82b"}],"written":[]}', '2026-10-02T00:00:00.000Z', NULL, 0);
INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint, contents) VALUES (1, '/w5-fixture/workspaces.json', NULL, 'c9beacbd16adee3629e3a467fa0eb07ff81945c6c709b0a7106ec07881957a1d', NULL);
INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint, contents) VALUES (2, '/w5-fixture/workspaces/alpha/workspace.json', NULL, '460b2eecaf49e47467660d7973f70e4f1f8d75e63a6a01d7de4d2912e555d568', NULL);
INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint, contents) VALUES (2, '/w5-fixture/workspaces/stale.json', 'a03f2386ae06b21109577020844df367857b72c2fcce384c1896fed98a89c82b', NULL, NULL);
INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint, contents) VALUES (3, '/w5-fixture/workspaces/bravo/workspace.json', NULL, '9424ef61eb3d157f7e685e32d2e3740e202b2a2897f78b3e4a279fe494f22c74', '{"name":"Bravo"}');
INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint, contents) VALUES (4, '/w5-fixture/workspaces/charlie/workspace.json', NULL, '54bad63b644eb64b32f04fc4124b042f3456608d2c6c3af8b4219baf86030107', '{"name":"Charlie"}');
INSERT INTO w5_receipts (caller, operation, idempotency_key, fingerprint, commit_id) VALUES ('portal:1', 'core.workspace.create', 'k-expired', 'fp-expired', 1);
INSERT INTO w5_receipts (caller, operation, idempotency_key, fingerprint, commit_id) VALUES ('portal:1', 'core.workspace.create', 'k-applied', 'fp-applied', 2);
INSERT INTO w5_receipts (caller, operation, idempotency_key, fingerprint, commit_id) VALUES ('portal:1', 'core.workspace.create', 'k-pending', 'fp-pending', 3);
INSERT INTO w5_receipts (caller, operation, idempotency_key, fingerprint, commit_id) VALUES ('portal:1', 'core.workspace.create', 'k-conflicted', 'fp-conflicted', 4);
INSERT INTO w5_reservations (reservation_id, operation, caller, idempotency_key, fingerprint, state, diagnostics_json, reserved_at) VALUES ('r-live', 'core.workspace.create', 'portal:1', 'k-live', 'fp-live', 'reserved', '{"kind":"local-workspace-create","workspaceId":"delta","ownedPaths":["/w5-fixture/wörkspaces/delta"],"phase":"member-import","repositories":[{"id":"source","role":"source","status":"completed","action":"clone","owned":true,"path":"/w5-fixture/wörkspaces/delta/source"},{"id":"member-1","role":"member","status":"started","owned":false}]}', '2026-10-02T00:00:00.000Z');
INSERT INTO w5_reservations (reservation_id, operation, caller, idempotency_key, fingerprint, state, diagnostics_json, reserved_at) VALUES ('r-failed', 'core.workspace.create', 'portal:1', 'k-failed', 'fp-failed', 'recovery-required', '{"operation":"core.workspace.create","errorName":"Error","errorCode":"EACCES"}', '2026-10-02T00:00:00.000Z');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence (name, seq) VALUES ('w5_commits', 4);
