import { LEDGER_ACTOR_COLUMNS, LEDGER_SCOPE_COLUMNS } from './records';

/** Columns selected for every read of a scope's sync bookkeeping. */
const LEDGER_SCOPE_SYNC_COLUMNS =
  'acknowledged_sequence, mirror_audience_json, audience_confirmed_at, repair_reason';

/**
 * Static SQL for the repository. Every value is a bound parameter; the only
 * interpolated text is the fixed column lists above.
 */
export const LEDGER_SQL = {
  selectScope: `SELECT ${LEDGER_SCOPE_COLUMNS} FROM ledger_scopes WHERE ledger_id = ?`,
  selectScopeByContainer: `SELECT ${LEDGER_SCOPE_COLUMNS} FROM ledger_scopes
    WHERE container_kind = ? AND container_parent_id = ? AND container_item_id = ?
      AND container_created_at = ?`,
  // Scopes are listed in the order they were minted.
  listScopes: `SELECT ${LEDGER_SCOPE_COLUMNS} FROM ledger_scopes ORDER BY rowid`,
  listContainerScopes: `SELECT ${LEDGER_SCOPE_COLUMNS} FROM ledger_scopes
    WHERE container_kind = ? AND container_parent_id = ? AND container_item_id = ?
    ORDER BY rowid`,
  insertScope: `INSERT INTO ledger_scopes (ledger_id, authority_id, container_kind,
      container_parent_id, container_item_id, container_created_at, account_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  updateScopeLifecycle:
    'UPDATE ledger_scopes SET lifecycle_state = ? WHERE ledger_id = ?',
  // A rebind never changes the container kind.
  rebindScope: `UPDATE ledger_scopes SET container_parent_id = ?, container_item_id = ?,
      container_created_at = ?, lifecycle_state = ?
    WHERE ledger_id = ?`,
  advanceSequence:
    'UPDATE ledger_scopes SET sequence = sequence + 1 WHERE ledger_id = ? RETURNING sequence',
  selectActorByOriginKey: `SELECT ${LEDGER_ACTOR_COLUMNS} FROM ledger_actors
    WHERE ledger_id = ? AND origin_key = ?`,
  selectActorIdentity:
    'SELECT kind, authority_id FROM ledger_actors WHERE ledger_id = ? AND actor_id = ?',
  listActors: `SELECT ${LEDGER_ACTOR_COLUMNS} FROM ledger_actors WHERE ledger_id = ? ORDER BY rowid`,
  insertActor: `INSERT INTO ledger_actors (actor_id, ledger_id, kind, authority_id,
      origin_key, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  selectReceipt: `SELECT request_hash, response_json FROM ledger_command_receipts
    WHERE ledger_id = ? AND actor_id = ? AND operation = ? AND idempotency_key = ?`,
  // Bound to one JSON array of keys, so the statement text stays static.
  selectReceiptKeys: `SELECT DISTINCT idempotency_key FROM ledger_command_receipts
    WHERE ledger_id = ? AND operation = ?
      AND idempotency_key IN (SELECT value FROM json_each(?))`,
  insertReceipt: `INSERT INTO ledger_command_receipts (ledger_id, actor_id, operation,
      idempotency_key, request_hash, entry_id, mutation_id, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertPendingTitle: `INSERT INTO ledger_pending_titles
      (entry_id, created_at, attempts, last_attempt_at)
    VALUES (?, ?, 0, NULL)`,
  selectPendingTitle: `SELECT pending.entry_id, entry.ledger_id, pending.created_at,
      pending.attempts, pending.last_attempt_at
    FROM ledger_pending_titles AS pending
    JOIN ledger_entries AS entry ON entry.entry_id = pending.entry_id
    WHERE pending.entry_id = ?`,
  listPendingTitles: `SELECT pending.entry_id, entry.ledger_id, pending.created_at,
      pending.attempts, pending.last_attempt_at
    FROM ledger_pending_titles AS pending
    JOIN ledger_entries AS entry ON entry.entry_id = pending.entry_id
    ORDER BY pending.created_at, pending.entry_id`,
  updatePendingTitleAttempt: `UPDATE ledger_pending_titles
    SET attempts = attempts + 1, last_attempt_at = ? WHERE entry_id = ?`,
  deletePendingTitle: 'DELETE FROM ledger_pending_titles WHERE entry_id = ?',
  selectPendingTitleEntryIds: `SELECT entry_id FROM ledger_pending_titles
    WHERE entry_id IN (SELECT value FROM json_each(?))`,
  selectFirstPendingTitleSequence: `SELECT MIN(version.scope_sequence) AS scope_sequence
    FROM ledger_pending_titles AS pending
    JOIN ledger_entry_versions AS version
      ON version.entry_id = pending.entry_id AND version.revision = 1
    WHERE version.ledger_id = ?`,
  selectEntry:
    'SELECT entry_rowid, scope_sequence, projection_json FROM ledger_entries WHERE ledger_id = ? AND entry_id = ?',
  selectEntryFirstSequence: `SELECT MIN(scope_sequence) AS scope_sequence
    FROM ledger_entry_versions WHERE ledger_id = ? AND entry_id = ?`,
  updateEntryProjection:
    'UPDATE ledger_entries SET projection_json = ? WHERE entry_rowid = ?',
  selectEntryVersionProjections: `SELECT version_rowid, projection_json
    FROM ledger_entry_versions WHERE ledger_id = ? AND entry_id = ? ORDER BY revision`,
  updateEntryVersionProjection:
    'UPDATE ledger_entry_versions SET projection_json = ? WHERE version_rowid = ?',
  updateSearchTitle: 'UPDATE ledger_search SET title = ? WHERE rowid = ?',
  selectEntryOutboxPayloads: `SELECT outbox_rowid, payload_json FROM ledger_outbox
    WHERE ledger_id = ? AND entry_id = ? AND kind = 'entry_revision'
    ORDER BY scope_sequence`,
  updateOutboxPayload: `UPDATE ledger_outbox SET payload_json = ?, payload_hash = ?
    WHERE outbox_rowid = ?`,
  selectVersionSequence:
    'SELECT scope_sequence FROM ledger_entry_versions WHERE ledger_id = ? AND entry_id = ? AND revision = ?',
  insertEntry: `INSERT INTO ledger_entries (entry_id, ledger_id, revision, scope_sequence,
      type, status, author_actor_id, owner_actor_id, attribution_kind, created_at,
      updated_at, supersedes_entry_id, projection_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING entry_rowid`,
  updateEntry: `UPDATE ledger_entries SET revision = ?, scope_sequence = ?, status = ?,
      owner_actor_id = ?, updated_at = ?, projection_json = ?
    WHERE entry_rowid = ? AND revision = ?`,
  insertVersion: `INSERT INTO ledger_entry_versions (entry_rowid, entry_id, ledger_id,
      revision, scope_sequence, mutation_id, type, status, author_actor_id,
      owner_actor_id, attribution_kind, created_at, updated_at, projection_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertMutation: `INSERT INTO ledger_mutations (mutation_id, entry_rowid, ledger_id, kind,
      revision, previous_revision, scope_sequence, effective_actor_id,
      recorded_by_actor_id, occurred_at, mutation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertSearch:
    'INSERT INTO ledger_search (rowid, title, content, highlights) VALUES (?, ?, ?, ?)',
  insertOutbox: `INSERT INTO ledger_outbox (event_id, ledger_id, scope_sequence, kind,
      entry_id, entry_revision, occurred_at, payload_json, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  selectHistory: `SELECT mutation_json FROM ledger_mutations
    WHERE entry_rowid = ? AND revision > ? ORDER BY revision ASC LIMIT ?`,
  selectChanges: `SELECT scope_sequence, entry_id, revision FROM ledger_entry_versions
    WHERE ledger_id = ? AND scope_sequence > ? ORDER BY scope_sequence ASC LIMIT ?`,
  selectScopeSync: `SELECT ${LEDGER_SCOPE_SYNC_COLUMNS} FROM ledger_scope_sync
    WHERE ledger_id = ?`,
  listScopeSync: `SELECT ledger_id, ${LEDGER_SCOPE_SYNC_COLUMNS} FROM ledger_scope_sync`,
  // An acknowledgment never moves backwards.
  acknowledgeScope: `INSERT INTO ledger_scope_sync (ledger_id, acknowledged_sequence, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (ledger_id) DO UPDATE SET
      acknowledged_sequence = MAX(acknowledged_sequence, excluded.acknowledged_sequence),
      updated_at = excluded.updated_at`,
  deleteAcknowledgedOutbox: `DELETE FROM ledger_outbox
    WHERE ledger_id = ? AND scope_sequence <= (
      SELECT acknowledged_sequence FROM ledger_scope_sync WHERE ledger_id = ?
    )`,
  recordMirrorAudience: `INSERT INTO ledger_scope_sync (ledger_id, mirror_audience_json,
      audience_confirmed_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (ledger_id) DO UPDATE SET
      mirror_audience_json = excluded.mirror_audience_json,
      audience_confirmed_at = excluded.audience_confirmed_at,
      updated_at = excluded.updated_at`,
  setScopeRepair: `INSERT INTO ledger_scope_sync (ledger_id, repair_reason, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (ledger_id) DO UPDATE SET
      repair_reason = excluded.repair_reason,
      updated_at = excluded.updated_at`,
  selectOutbox: `SELECT event_id, scope_sequence, kind, entry_id, entry_revision,
      occurred_at, payload_json, payload_hash
    FROM ledger_outbox
    WHERE ledger_id = ? AND scope_sequence > ?
    ORDER BY scope_sequence ASC LIMIT ?`,
  rebindAccount: 'UPDATE ledger_scopes SET account_id = ? WHERE account_id = ?',
} as const;

/**
 * Removes every row of one scope, children before parents, so no foreign key
 * check ever finds a referencing row. Each statement takes the ledger ID and
 * reaches its rows through an index, as do the foreign key checks the deletes
 * trigger (schema version 2 adds the mutation indexes they need), so a purge
 * costs the size of its scope, not of the database.
 */
export const LEDGER_PURGE_SCOPE_SQL: readonly string[] = [
  'DELETE FROM ledger_search WHERE rowid IN (SELECT entry_rowid FROM ledger_entries WHERE ledger_id = ?)',
  'DELETE FROM ledger_entry_versions WHERE ledger_id = ?',
  'DELETE FROM ledger_mutations WHERE ledger_id = ?',
  'DELETE FROM ledger_command_receipts WHERE ledger_id = ?',
  'DELETE FROM ledger_pending_titles WHERE entry_id IN (SELECT entry_id FROM ledger_entries WHERE ledger_id = ?)',
  'DELETE FROM ledger_entries WHERE ledger_id = ?',
  'DELETE FROM ledger_outbox WHERE ledger_id = ?',
  'DELETE FROM ledger_scope_sync WHERE ledger_id = ?',
  'DELETE FROM ledger_actors WHERE ledger_id = ?',
  'DELETE FROM ledger_scopes WHERE ledger_id = ?',
];

/** Tables counted by the content-free storage diagnostics. */
export type LedgerCountedTable =
  | 'ledger_scopes'
  | 'ledger_actors'
  | 'ledger_entries'
  | 'ledger_entry_versions'
  | 'ledger_mutations'
  | 'ledger_command_receipts'
  | 'ledger_outbox'
  | 'ledger_search';
