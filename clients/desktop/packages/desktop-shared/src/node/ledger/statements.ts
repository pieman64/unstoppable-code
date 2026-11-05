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
  selectActorById: `SELECT ${LEDGER_ACTOR_COLUMNS} FROM ledger_actors
    WHERE ledger_id = ? AND actor_id = ?`,
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
  selectChildren: `SELECT entry_rowid, scope_sequence, projection_json
    FROM ledger_entries WHERE ledger_id = ? AND parent_entry_id = ?
    ORDER BY entry_id`,
  selectSubtreeRowIds: `WITH RECURSIVE subtree(entry_rowid, entry_id, depth) AS (
      SELECT entry_rowid, entry_id, 0 FROM ledger_entries
      WHERE ledger_id = ? AND entry_id = ?
      UNION ALL
      SELECT child.entry_rowid, child.entry_id, parent.depth + 1
      FROM ledger_entries AS child
      JOIN subtree AS parent ON child.parent_entry_id = parent.entry_id
      WHERE child.ledger_id = ?
    )
    SELECT entry_rowid, entry_id, depth FROM subtree ORDER BY depth DESC, entry_id`,
  selectTaskSubtreeDepth: `WITH RECURSIVE task_subtree(entry_id, depth) AS (
      SELECT entry_id, 0 FROM ledger_entries
      WHERE ledger_id = ? AND entry_id = ? AND type = 'TASK'
      UNION ALL
      SELECT child.entry_id, parent.depth + 1
      FROM ledger_entries AS child
      JOIN task_subtree AS parent ON child.parent_entry_id = parent.entry_id
      WHERE child.ledger_id = ? AND child.type = 'TASK'
    )
    SELECT MAX(depth) AS depth FROM task_subtree`,
  selectCurrentRoot: `SELECT root_entry_id FROM ledger_entry_roots
    WHERE entry_rowid = ? AND to_sequence IS NULL
    ORDER BY from_sequence DESC LIMIT 1`,
  closeCurrentRoot: `UPDATE ledger_entry_roots SET to_sequence = ?
    WHERE entry_rowid = ? AND to_sequence IS NULL`,
  insertRoot: `INSERT INTO ledger_entry_roots
      (entry_rowid, ledger_id, root_entry_id, from_sequence, to_sequence)
    VALUES (?, ?, ?, ?, NULL)`,
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
      updated_at, supersedes_entry_id, parent_entry_id, projection_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING entry_rowid`,
  updateEntry: `UPDATE ledger_entries SET revision = ?, scope_sequence = ?, status = ?,
      owner_actor_id = ?, updated_at = ?, parent_entry_id = ?, projection_json = ?
    WHERE entry_rowid = ? AND revision = ?`,
  insertVersion: `INSERT INTO ledger_entry_versions (entry_rowid, entry_id, ledger_id,
      revision, scope_sequence, mutation_id, type, status, author_actor_id,
      owner_actor_id, attribution_kind, created_at, updated_at, parent_entry_id,
      projection_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  /**
   * The actor set is one bounded JSON relation. Each candidate branch uses an
   * existing (ledger, actor) index; UNION deduplicates entries that match more
   * than one relation, including an ended owner recorded on a leftOpen
   * hand-back mutation. Aggregates and the ten-row page stay in SQLite.
   */
  getWorkSummary: `WITH actor_ids(actor_id) AS MATERIALIZED (
      SELECT value FROM json_each(?) WHERE type = 'text'
    ), candidate_entries(entry_rowid) AS (
      SELECT authored.entry_rowid FROM ledger_entries AS authored
        INDEXED BY ledger_entries_by_author
      WHERE authored.ledger_id = ?
        AND authored.author_actor_id IN (SELECT actor_id FROM actor_ids)
      UNION
      SELECT owned.entry_rowid FROM ledger_entries AS owned
        INDEXED BY ledger_entries_by_owner_status
      WHERE owned.ledger_id = ?
        AND owned.owner_actor_id IN (SELECT actor_id FROM actor_ids)
      UNION
      SELECT mutation.entry_rowid FROM ledger_mutations AS mutation
        INDEXED BY ledger_mutations_by_effective_actor
      WHERE mutation.ledger_id = ?
        AND mutation.effective_actor_id IN (SELECT actor_id FROM actor_ids)
        AND json_extract(mutation.mutation_json, '$.leftOpen') IS NOT NULL
    ), matching_entries AS MATERIALIZED (
      SELECT entry.entry_id, entry.status, entry.updated_at,
        entry.owner_actor_id, owner.kind AS owner_kind,
        owner.authority_id AS owner_authority_id
      FROM candidate_entries AS candidate
      JOIN ledger_entries AS entry ON entry.entry_rowid = candidate.entry_rowid
      JOIN ledger_actors AS owner ON owner.ledger_id = entry.ledger_id
        AND owner.actor_id = entry.owner_actor_id
      WHERE entry.ledger_id = ?
    ), status_counts AS (
      SELECT status, COUNT(*) AS entry_count
      FROM matching_entries GROUP BY status
    ), counts_summary AS (
      SELECT COALESCE(json_group_object(status, entry_count), '{}') AS counts_json
      FROM status_counts
    ), open_total AS (
      SELECT COUNT(*) AS open_total FROM matching_entries
      WHERE status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW')
    ), open_entries AS (
      SELECT entry_id, status, updated_at, owner_actor_id,
        owner_kind, owner_authority_id
      FROM matching_entries
      WHERE status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW')
      ORDER BY updated_at DESC, entry_id DESC LIMIT 10
    )
    SELECT counts_summary.counts_json, open_total.open_total,
      open_entries.entry_id AS open_entry_id,
      open_entries.status AS open_status,
      open_entries.owner_actor_id AS open_owner_actor_id,
      open_entries.owner_kind AS open_owner_kind,
      open_entries.owner_authority_id AS open_owner_authority_id
    FROM counts_summary CROSS JOIN open_total
    LEFT JOIN open_entries ON true
    ORDER BY open_entries.updated_at DESC, open_entries.entry_id DESC`,
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
  selectGlobalScope: `SELECT ${LEDGER_SCOPE_COLUMNS} FROM ledger_scopes
    WHERE ledger_id = (
      SELECT ledger_id FROM ledger_global_bindings WHERE owner_key = ? AND account_key = ?
    )`,
  insertGlobalBinding: `INSERT INTO ledger_global_bindings (owner_key, account_key, ledger_id)
    VALUES (?, ?, ?)`,
  // A guest binding whose owner the destination account already has gives way;
  // the guest's Ledger itself stays. Bound to (from, to).
  deleteRedundantGlobalBindings: `DELETE FROM ledger_global_bindings
    WHERE account_key = ? AND owner_key IN (
      SELECT owner_key FROM ledger_global_bindings WHERE account_key = ?
    )`,
  rebindGlobalBindings:
    'UPDATE ledger_global_bindings SET account_key = ? WHERE account_key = ?',
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
  'DELETE FROM ledger_global_bindings WHERE ledger_id = ?',
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
