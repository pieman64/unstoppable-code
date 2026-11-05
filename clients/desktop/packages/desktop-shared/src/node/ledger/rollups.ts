import type { StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import {
  LEDGER_LIMITS,
  LEDGER_STATUSES,
  LedgerRollupItemSchema,
  LedgerRollupsListResultSchema,
  LedgerUuidSchema,
  type LedgerRollupItem,
  type LedgerRollupScope,
  type LedgerRollupsListResult,
} from '@canopy/protocol/canopy-core';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  isLedgerCursorFresh,
} from './cursor';
import { LedgerStoreError } from './errors';
import { parseLedgerInput } from './records';
import {
  parseStoredJson,
  rowInteger,
  rowLeftOpen,
  rowNullableText,
  rowText,
  type LedgerSqlRow,
} from './rows';

export interface LedgerRollupsScopeRequest {
  readonly ledgerId: string;
  /**
   * Resolved by the host for this scope; never taken from agent input. Null
   * when the person has no actor in the scope yet, so nothing there is theirs.
   */
  readonly callerActorId: string | null;
}

export interface LedgerRollupsInput {
  readonly scopes: readonly LedgerRollupsScopeRequest[];
  readonly cursor?: string;
}

export interface LedgerRollupsQueryContext {
  /** Repository-owned prepare callback, which caches each SQL statement. */
  readonly prepare: (sql: string) => StatementSync;
  readonly cursorSecret: Buffer;
  readonly schemaVersion: number;
  readonly now: () => Date;
}

interface RollupsScopeWatermark {
  readonly ledgerId: string;
  readonly watermark: string;
}

interface RollupsPosition {
  readonly watermarks: readonly RollupsScopeWatermark[] | null;
  readonly filterHash: string;
  readonly after: {
    readonly openRank: number;
    readonly activityAt: string;
    readonly scopeOrder: number;
    readonly ledgerId: string;
    readonly entryId: string;
  } | null;
}

const ROLLUPS_QUERY = `
WITH requested AS (
  SELECT CAST(json_extract(value, '$.ordinal') AS INTEGER) AS scope_order,
    json_extract(value, '$.ledgerId') AS ledger_id,
    json_extract(value, '$.callerActorId') AS caller_actor_id
  FROM json_each(?)
),
requested_watermarks AS (
  SELECT json_extract(value, '$.ledgerId') AS ledger_id,
    CAST(json_extract(value, '$.watermark') AS INTEGER) AS watermark
  FROM json_each(?)
),
-- Evaluate the small JSON request relation once, not inside every scope scan.
scope_snapshot AS MATERIALIZED (
  SELECT requested.scope_order, requested.ledger_id,
    requested.caller_actor_id,
    COALESCE(requested_watermarks.watermark, ledger_scopes.sequence, 0) AS watermark,
    ledger_scopes.ledger_id IS NOT NULL AS scope_exists
  FROM requested
  LEFT JOIN ledger_scopes ON ledger_scopes.ledger_id = requested.ledger_id
  LEFT JOIN requested_watermarks
    ON requested_watermarks.ledger_id = requested.ledger_id
),
snapshot_sequences AS (
  SELECT entry.ledger_id, entry.entry_rowid, MAX(version.scope_sequence) AS scope_sequence,
    scope_snapshot.scope_order, scope_snapshot.caller_actor_id, scope_snapshot.watermark
  FROM scope_snapshot
  -- Drive the existing (entry_rowid, scope_sequence) covering index instead
  -- of visiting the wide version table just to discover snapshot sequences.
  CROSS JOIN ledger_entries AS entry ON entry.ledger_id = scope_snapshot.ledger_id
  CROSS JOIN ledger_entry_versions AS version ON version.entry_rowid = entry.entry_rowid
  WHERE scope_snapshot.scope_exists = 1
    AND version.scope_sequence <= scope_snapshot.watermark
  GROUP BY entry.ledger_id, entry.entry_rowid
),
-- Only scalar columns and the immutable version rowid enter scope-sized
-- temporary tables/indexes. Read projection JSON after the page is selected.
snapshot_entries AS MATERIALIZED (
  SELECT entry.entry_rowid, version.ledger_id, version.entry_id,
    version.type, version.status, version.owner_actor_id,
    version.updated_at, version.parent_entry_id, version.version_rowid,
    snapshot.scope_order, snapshot.caller_actor_id, snapshot.watermark
  FROM snapshot_sequences AS snapshot
  JOIN ledger_entry_versions AS version
    ON version.ledger_id = snapshot.ledger_id
    AND version.entry_rowid = snapshot.entry_rowid
    AND version.scope_sequence = snapshot.scope_sequence
  JOIN ledger_entries AS entry ON entry.entry_rowid = version.entry_rowid
),
-- Standalone non-work entries affect scope badges/activity, but cannot
-- contribute to any rollup. Do not carry them through member aggregation.
work_roots AS MATERIALIZED (
  SELECT ledger_id, entry_id FROM snapshot_entries
  WHERE parent_entry_id IS NULL AND type IN ('OPERATION', 'TASK')
),
members AS MATERIALIZED (
  SELECT snapshot_entries.*, roots.root_entry_id
  FROM snapshot_entries
  JOIN ledger_entry_roots AS roots
    ON roots.entry_rowid = snapshot_entries.entry_rowid
    AND roots.ledger_id = snapshot_entries.ledger_id
  JOIN work_roots AS root
    ON root.ledger_id = roots.ledger_id AND root.entry_id = roots.root_entry_id
  WHERE roots.from_sequence <= snapshot_entries.watermark
    AND (roots.to_sequence IS NULL OR roots.to_sequence > snapshot_entries.watermark)
),
scope_aggregates AS (
  SELECT scope_snapshot.scope_order, scope_snapshot.ledger_id,
    scope_snapshot.watermark,
    MAX(snapshot_entries.updated_at) AS last_activity_at,
    SUM(CASE WHEN snapshot_entries.status = 'NEEDS_REVIEW'
      AND snapshot_entries.owner_actor_id = scope_snapshot.caller_actor_id
      THEN 1 ELSE 0 END) AS open_needs_review,
    SUM(CASE WHEN snapshot_entries.status = 'BLOCKED'
      AND snapshot_entries.owner_actor_id = scope_snapshot.caller_actor_id
      THEN 1 ELSE 0 END) AS open_blocked
  FROM scope_snapshot
  LEFT JOIN snapshot_entries
    ON snapshot_entries.ledger_id = scope_snapshot.ledger_id
  GROUP BY scope_snapshot.scope_order, scope_snapshot.ledger_id, scope_snapshot.watermark
),
-- These scope-wide metrics need one grouped pass. Everything else can wait
-- until page_roots has applied the unchanged snapshot cursor and ordering.
member_metrics AS (
  SELECT member.ledger_id, member.root_entry_id,
    MAX(member.updated_at) AS last_activity_at,
    MAX(CASE WHEN member.type = 'TASK'
      AND member.parent_entry_id = member.root_entry_id THEN 1 ELSE 0 END) AS has_child_tasks,
    SUM(CASE WHEN member.status = 'NEEDS_REVIEW'
      AND member.owner_actor_id = member.caller_actor_id THEN 1 ELSE 0 END) AS open_needs_review,
    SUM(CASE WHEN member.entry_id <> member.root_entry_id
      AND member.status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW')
      THEN 1 ELSE 0 END) AS open_descendants
  FROM members AS member
  GROUP BY member.ledger_id, member.root_entry_id
),
sortable_roots AS (
  SELECT member.*,
    owner.kind AS entry_owner_kind, owner.authority_id AS entry_owner_authority_id,
    COALESCE(metrics.last_activity_at, member.updated_at) AS last_activity_at,
    metrics.has_child_tasks, metrics.open_needs_review,
    COALESCE(metrics.open_descendants, 0) AS open_descendants,
    CASE WHEN member.status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW')
      THEN 0 ELSE 1 END AS open_rank
  FROM members AS member
  JOIN ledger_actors AS owner
    ON owner.ledger_id = member.ledger_id AND owner.actor_id = member.owner_actor_id
  LEFT JOIN member_metrics AS metrics
    ON metrics.ledger_id = member.ledger_id AND metrics.root_entry_id = member.entry_id
  WHERE member.entry_id = member.root_entry_id
    AND member.parent_entry_id IS NULL
    AND member.type IN ('OPERATION', 'TASK')
),
-- Keep the LIMIT as an optimization fence: leaf windows and JSON below only
-- visit the selected roots (including the one-row cursor lookahead).
page_roots AS MATERIALIZED (
  SELECT * FROM sortable_roots
  WHERE (? IS NULL
    OR open_rank > ?
    OR (open_rank = ? AND last_activity_at < ?)
    OR (open_rank = ? AND last_activity_at = ? AND scope_order > ?)
    OR (open_rank = ? AND last_activity_at = ? AND scope_order = ? AND ledger_id > ?)
    OR (open_rank = ? AND last_activity_at = ? AND scope_order = ? AND ledger_id = ? AND entry_id > ?))
  ORDER BY open_rank ASC, last_activity_at DESC,
    scope_order ASC, ledger_id ASC, entry_id ASC
  LIMIT ?
),
page_members AS MATERIALIZED (
  SELECT member.* FROM members AS member
  JOIN page_roots AS root
    ON root.ledger_id = member.ledger_id AND root.entry_id = member.root_entry_id
),
task_parents AS (
  SELECT ledger_id, root_entry_id, parent_entry_id
  FROM page_members
  WHERE type = 'TASK' AND parent_entry_id IS NOT NULL
  GROUP BY ledger_id, root_entry_id, parent_entry_id
),
leaves AS (
  SELECT member.ledger_id, member.root_entry_id, member.entry_rowid,
    member.entry_id, member.status, member.owner_actor_id, member.updated_at,
    member.version_rowid,
    COALESCE(parent.entry_id, member.entry_id) AS tree_parent_order,
    member.entry_id AS tree_entry_order,
    member.status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW') AS is_open
  FROM page_members AS member
  LEFT JOIN snapshot_entries AS parent
    ON parent.ledger_id = member.ledger_id
    AND parent.entry_id = member.parent_entry_id AND parent.type = 'TASK'
  LEFT JOIN task_parents AS children
    ON children.ledger_id = member.ledger_id
    AND children.root_entry_id = member.root_entry_id
    AND children.parent_entry_id = member.entry_id
  WHERE member.type = 'TASK' AND children.parent_entry_id IS NULL
),
ordered_leaves AS (
  SELECT leaves.*,
    ROW_NUMBER() OVER (PARTITION BY ledger_id, root_entry_id
      ORDER BY tree_parent_order, tree_entry_order) AS tree_rank
  FROM leaves
),
leaf_metrics AS (
  SELECT ledger_id, root_entry_id,
    SUM(status = 'TODO') AS todo,
    SUM(status = 'IN_PROGRESS') AS in_progress,
    SUM(status = 'COMPLETED') AS completed,
    SUM(status = 'FAILED') AS failed,
    SUM(status = 'BLOCKED') AS blocked,
    SUM(status = 'NEEDS_REVIEW') AS needs_review,
    SUM(status = 'INFO') AS info,
    COUNT(DISTINCT CASE WHEN is_open THEN owner_actor_id END) AS open_leaf_owner_count,
    json_group_array(status ORDER BY tree_parent_order, tree_entry_order)
      FILTER (WHERE tree_rank <= 24) AS leaf_statuses_json
  FROM ordered_leaves
  GROUP BY ledger_id, root_entry_id
),
-- The item's own tasks, one level down: an operation's top-level tasks or a
-- task's subtasks. Its progress dots show these, in tree order.
direct_children AS (
  SELECT ledger_id, root_entry_id, status,
    ROW_NUMBER() OVER (PARTITION BY ledger_id, root_entry_id
      ORDER BY entry_id) AS child_rank
  FROM page_members
  WHERE type = 'TASK' AND parent_entry_id = root_entry_id
),
child_metrics AS (
  SELECT ledger_id, root_entry_id,
    SUM(status = 'TODO') AS todo,
    SUM(status = 'IN_PROGRESS') AS in_progress,
    SUM(status = 'COMPLETED') AS completed,
    SUM(status = 'FAILED') AS failed,
    SUM(status = 'BLOCKED') AS blocked,
    SUM(status = 'NEEDS_REVIEW') AS needs_review,
    SUM(status = 'INFO') AS info,
    json_group_array(status ORDER BY child_rank)
      FILTER (WHERE child_rank <= 24) AS child_statuses_json
  FROM direct_children
  GROUP BY ledger_id, root_entry_id
),
ranked_refs AS (
  SELECT leaf.*,
    actor.actor_id, actor.kind, actor.authority_id,
    json_object(
      'entryId', leaf.entry_id,
      'title', json_extract(leaf_version.projection_json, '$.title'),
      'owner', json_object('actorId', actor.actor_id, 'kind', actor.kind,
        'authorityId', actor.authority_id)
    ) AS leaf_json,
    ROW_NUMBER() OVER (PARTITION BY leaf.ledger_id, leaf.root_entry_id, leaf.status
      ORDER BY leaf.tree_parent_order, leaf.tree_entry_order) AS status_rank,
    ROW_NUMBER() OVER (PARTITION BY leaf.ledger_id, leaf.root_entry_id, leaf.status
      ORDER BY leaf.updated_at DESC, leaf.entry_rowid ASC) AS activity_rank,
    ROW_NUMBER() OVER (PARTITION BY leaf.ledger_id, leaf.root_entry_id, leaf.is_open
      ORDER BY leaf.tree_parent_order, leaf.tree_entry_order) AS open_rank
  FROM leaves AS leaf
  CROSS JOIN ledger_entry_versions AS leaf_version ON leaf_version.version_rowid = leaf.version_rowid
  JOIN ledger_actors AS actor
    ON actor.ledger_id = leaf.ledger_id AND actor.actor_id = leaf.owner_actor_id
),
leaf_refs AS (
  SELECT ledger_id, root_entry_id,
    MAX(CASE WHEN status = 'IN_PROGRESS' AND activity_rank = 1 THEN leaf_json END) AS current_leaf_json,
    MAX(CASE WHEN status = 'BLOCKED' AND status_rank = 1 THEN leaf_json END) AS first_blocked_leaf_json,
    MAX(CASE WHEN status = 'FAILED' AND status_rank = 1 THEN leaf_json END) AS first_failed_leaf_json,
    MAX(CASE WHEN is_open AND open_rank = 1 THEN leaf_json END) AS next_open_leaf_json,
    MAX(CASE WHEN status = 'NEEDS_REVIEW' AND status_rank = 1 THEN leaf_json END) AS first_review_leaf_json,
    json_group_array(json(leaf_json) ORDER BY tree_parent_order, tree_entry_order)
      FILTER (WHERE status = 'IN_PROGRESS'
        AND status_rank <= ${LEDGER_LIMITS.rollupInProgressLeavesMax}) AS in_progress_leaves_json
  FROM ranked_refs
  GROUP BY ledger_id, root_entry_id
),
owner_groups AS (
  SELECT ledger_id, root_entry_id, actor_id, kind, authority_id,
    MAX(status = 'IN_PROGRESS') AS has_in_progress,
    MIN(tree_parent_order) AS first_parent_order,
    MIN(tree_entry_order) AS first_entry_order
  FROM ranked_refs WHERE is_open
  GROUP BY ledger_id, root_entry_id, actor_id, kind, authority_id
),
ranked_owners AS (
  SELECT owner_groups.*,
    ROW_NUMBER() OVER (PARTITION BY ledger_id, root_entry_id
      ORDER BY first_parent_order, first_entry_order, actor_id) AS owner_rank
  FROM owner_groups
),
leaf_owners AS (
  SELECT ledger_id, root_entry_id,
    json_group_array(json_object(
      'owner', json_object('actorId', actor_id, 'kind', kind, 'authorityId', authority_id),
      'hasInProgress', json(CASE WHEN has_in_progress <> 0 THEN 'true' ELSE 'false' END)
    ) ORDER BY owner_rank) AS open_leaf_owners_json
  FROM ranked_owners WHERE owner_rank <= ${LEDGER_LIMITS.rollupOpenLeafOwnersMax}
  GROUP BY ledger_id, root_entry_id
),
page_items AS (
  SELECT root.scope_order, root.ledger_id, root.entry_id,
    root.type AS entry_type,
    json_extract(root_version.projection_json, '$.title') AS entry_title,
    json_extract(root_mutation.mutation_json, '$.leftOpen') AS left_open_reason,
    -- The chat whose line of agents added the item, itself or by a delegate.
    CASE json_extract(root_version.projection_json, '$.origin.kind')
      WHEN 'chat' THEN json_extract(root_version.projection_json, '$.origin.chatId')
      WHEN 'managed_delegation' THEN CASE
        WHEN json_extract(root_version.projection_json, '$.origin.root.kind') = 'chat'
        THEN json_extract(root_version.projection_json, '$.origin.root.chatId')
      END
    END AS origin_chat_id,
    json_extract(root_version.projection_json, '$.origin.kind') = 'managed_delegation'
      AS origin_via_delegate,
    root_mutation.occurred_at AS left_open_at,
    root.status AS entry_status, root.owner_actor_id AS entry_owner_actor_id,
    root.entry_owner_kind, root.entry_owner_authority_id,
    root.last_activity_at, root.open_rank,
    json_object(
      'TODO', COALESCE(counts.todo, 0),
      'IN_PROGRESS', COALESCE(counts.in_progress, 0),
      'COMPLETED', COALESCE(counts.completed, 0),
      'FAILED', COALESCE(counts.failed, 0),
      'BLOCKED', COALESCE(counts.blocked, 0),
      'NEEDS_REVIEW', COALESCE(counts.needs_review, 0),
      'INFO', COALESCE(counts.info, 0)
    ) AS leaf_counts_json,
    COALESCE(counts.leaf_statuses_json, '[]') AS leaf_statuses_json,
    json_object(
      'TODO', COALESCE(children.todo, 0),
      'IN_PROGRESS', COALESCE(children.in_progress, 0),
      'COMPLETED', COALESCE(children.completed, 0),
      'FAILED', COALESCE(children.failed, 0),
      'BLOCKED', COALESCE(children.blocked, 0),
      'NEEDS_REVIEW', COALESCE(children.needs_review, 0),
      'INFO', COALESCE(children.info, 0)
    ) AS child_counts_json,
    COALESCE(children.child_statuses_json, '[]') AS child_statuses_json,
    refs.current_leaf_json, refs.first_blocked_leaf_json, refs.first_failed_leaf_json,
    refs.next_open_leaf_json, refs.first_review_leaf_json,
    COALESCE(refs.in_progress_leaves_json, '[]') AS in_progress_leaves_json,
    root.has_child_tasks, COALESCE(counts.open_leaf_owner_count, 0) AS open_leaf_owner_count,
    COALESCE(owners.open_leaf_owners_json, '[]') AS open_leaf_owners_json,
    root.open_needs_review, root.open_descendants
  FROM page_roots AS root
  CROSS JOIN ledger_entry_versions AS root_version ON root_version.version_rowid = root.version_rowid
  -- Read mutation details only for selected roots, at their snapshot revision.
  LEFT JOIN ledger_mutations AS root_mutation
    ON root_mutation.entry_rowid = root.entry_rowid
    AND root_mutation.revision = root_version.revision
  LEFT JOIN leaf_metrics AS counts
    ON counts.ledger_id = root.ledger_id AND counts.root_entry_id = root.entry_id
  LEFT JOIN child_metrics AS children
    ON children.ledger_id = root.ledger_id AND children.root_entry_id = root.entry_id
  LEFT JOIN leaf_refs AS refs
    ON refs.ledger_id = root.ledger_id AND refs.root_entry_id = root.entry_id
  LEFT JOIN leaf_owners AS owners
    ON owners.ledger_id = root.ledger_id AND owners.root_entry_id = root.entry_id
)
SELECT 'scope' AS row_kind, scope_aggregates.scope_order, scope_aggregates.ledger_id,
  scope_aggregates.watermark AS scope_watermark,
  scope_aggregates.last_activity_at AS scope_last_activity_at,
  scope_aggregates.open_needs_review AS scope_open_needs_review,
  scope_aggregates.open_blocked AS scope_open_blocked,
  NULL AS entry_id, NULL AS entry_type, NULL AS entry_title, NULL AS entry_status,
  NULL AS entry_owner_actor_id, NULL AS entry_owner_kind, NULL AS entry_owner_authority_id,
  NULL AS last_activity_at, NULL AS open_rank, NULL AS leaf_counts_json,
  NULL AS leaf_statuses_json, NULL AS child_counts_json,
  NULL AS child_statuses_json, NULL AS current_leaf_json,
  NULL AS first_blocked_leaf_json, NULL AS first_failed_leaf_json,
  NULL AS next_open_leaf_json, NULL AS first_review_leaf_json,
  NULL AS in_progress_leaves_json, NULL AS has_child_tasks,
  NULL AS open_leaf_owner_count, NULL AS open_leaf_owners_json,
  NULL AS open_needs_review, NULL AS left_open_reason, NULL AS left_open_at,
  NULL AS origin_chat_id, NULL AS origin_via_delegate, NULL AS open_descendants
FROM scope_aggregates
UNION ALL
SELECT 'item' AS row_kind, page_items.scope_order, page_items.ledger_id,
  NULL AS scope_watermark, NULL AS scope_last_activity_at,
  NULL AS scope_open_needs_review, NULL AS scope_open_blocked,
  page_items.entry_id, page_items.entry_type, page_items.entry_title, page_items.entry_status,
  page_items.entry_owner_actor_id, page_items.entry_owner_kind,
  page_items.entry_owner_authority_id, page_items.last_activity_at, page_items.open_rank,
  page_items.leaf_counts_json, page_items.leaf_statuses_json,
  page_items.child_counts_json, page_items.child_statuses_json,
  page_items.current_leaf_json, page_items.first_blocked_leaf_json,
  page_items.first_failed_leaf_json, page_items.next_open_leaf_json,
  page_items.first_review_leaf_json, page_items.in_progress_leaves_json,
  page_items.has_child_tasks, page_items.open_leaf_owner_count,
  page_items.open_leaf_owners_json, page_items.open_needs_review,
  page_items.left_open_reason, page_items.left_open_at,
  page_items.origin_chat_id, page_items.origin_via_delegate,
  page_items.open_descendants
FROM page_items
ORDER BY row_kind DESC, open_rank ASC, last_activity_at DESC,
  scope_order ASC, ledger_id ASC, entry_id ASC`;

function cursorExpired(field: string): LedgerStoreError {
  return new LedgerStoreError('CURSOR_EXPIRED', { field });
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInput(
  input: LedgerRollupsInput,
): readonly LedgerRollupsScopeRequest[] {
  const rawInput: unknown = input;
  if (!isRecord(rawInput)) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'scopes' });
  }
  const rawScopes = rawInput.scopes;
  if (
    !isUnknownArray(rawScopes) ||
    rawScopes.length < 1 ||
    rawScopes.length > LEDGER_LIMITS.rollupsLedgerIdsMax
  ) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'scopes' });
  }

  const seenLedgerIds = new Set<string>();
  return rawScopes.map((scope, index): LedgerRollupsScopeRequest => {
    if (!isRecord(scope)) {
      throw new LedgerStoreError('INVALID_INPUT', {
        field: `scopes.${index}`,
      });
    }
    const ledgerId = parseLedgerInput(
      LedgerUuidSchema,
      scope.ledgerId,
      `scopes.${index}.ledgerId`,
    );
    const callerActorId =
      scope.callerActorId === null
        ? null
        : parseLedgerInput(
            LedgerUuidSchema,
            scope.callerActorId,
            `scopes.${index}.callerActorId`,
          );
    if (seenLedgerIds.has(ledgerId)) {
      throw new LedgerStoreError('INVALID_INPUT', {
        field: `scopes.${index}.ledgerId`,
      });
    }
    seenLedgerIds.add(ledgerId);
    return { ledgerId, callerActorId };
  });
}

function hashScopeRequests(
  scopes: readonly LedgerRollupsScopeRequest[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(scopes), 'utf8')
    .digest('hex');
}

function resolvePosition(
  input: LedgerRollupsInput,
  scopes: readonly LedgerRollupsScopeRequest[],
  context: LedgerRollupsQueryContext,
): RollupsPosition {
  const filterHash = hashScopeRequests(scopes);
  if (input.cursor === undefined) {
    return { watermarks: null, filterHash, after: null };
  }
  const state = decodeLedgerCursor(input.cursor, context.cursorSecret);
  if (
    state === null ||
    state.kind !== 'rollups' ||
    state.filterHash !== filterHash ||
    state.ledgerId !== scopes[0]?.ledgerId ||
    state.schemaVersion !== context.schemaVersion ||
    !isLedgerCursorFresh(state.issuedAtMs, context.now().getTime()) ||
    state.watermarks.length !== scopes.length ||
    state.lastScopeOrder >= scopes.length
  ) {
    throw cursorExpired('cursor');
  }
  return {
    watermarks: state.watermarks.map(
      (watermark, index): RollupsScopeWatermark => ({
        ledgerId: scopes[index]?.ledgerId ?? state.ledgerId,
        watermark,
      }),
    ),
    filterHash,
    after: {
      openRank: state.lastOpenRank,
      activityAt: state.lastActivityAt,
      scopeOrder: state.lastScopeOrder,
      ledgerId: scopes[state.lastScopeOrder]?.ledgerId ?? '',
      entryId: state.lastEntryId,
    },
  };
}

function decodeJsonArray(json: string, field: string): readonly unknown[] {
  const value = parseStoredJson(json);
  if (!Array.isArray(value)) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
      field,
    });
  }
  return value;
}

function leafRef(json: string | null, field: string): unknown {
  if (json === null) return undefined;
  const value = parseStoredJson(json);
  if (!LedgerRollupItemSchema.shape.currentLeaf.safeParse(value).success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
      field,
    });
  }
  return value;
}

/** Counts by status, with every status present. */
function statusCounts(
  json: string,
  field: 'leafCounts' | 'childCounts',
): LedgerRollupItem['leafCounts'] {
  const counts = LedgerRollupItemSchema.shape[field].safeParse(
    parseStoredJson(json),
  );
  if (!counts.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
      field,
    });
  }
  for (const status of LEDGER_STATUSES) {
    if (counts.data[status] === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'malformed_rollup',
        field: `${field}.${status}`,
      });
    }
  }
  return counts.data;
}

function buildItem(row: LedgerSqlRow): LedgerRollupItem {
  const leafCounts = statusCounts(
    rowText(row, 'leaf_counts_json'),
    'leafCounts',
  );
  const leafStatuses = decodeJsonArray(
    rowText(row, 'leaf_statuses_json'),
    'leafStatuses',
  );
  const childCounts = statusCounts(
    rowText(row, 'child_counts_json'),
    'childCounts',
  );
  const childStatuses = decodeJsonArray(
    rowText(row, 'child_statuses_json'),
    'childStatuses',
  );
  const owners = decodeJsonArray(
    rowText(row, 'open_leaf_owners_json'),
    'openLeafOwners',
  );
  const inProgressLeafValues = decodeJsonArray(
    rowText(row, 'in_progress_leaves_json'),
    'inProgressLeaves',
  );
  const inProgressLeaves =
    LedgerRollupItemSchema.shape.inProgressLeaves.safeParse(
      inProgressLeafValues,
    );
  if (!inProgressLeaves.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
      field: 'inProgressLeaves',
    });
  }
  const openLeafOwners =
    LedgerRollupItemSchema.shape.openLeafOwners.safeParse(owners);
  if (!openLeafOwners.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
      field: 'openLeafOwners',
    });
  }
  const currentLeaf = leafRef(
    rowNullableText(row, 'current_leaf_json'),
    'currentLeaf',
  );
  const firstBlockedLeaf = leafRef(
    rowNullableText(row, 'first_blocked_leaf_json'),
    'firstBlockedLeaf',
  );
  const firstFailedLeaf = leafRef(
    rowNullableText(row, 'first_failed_leaf_json'),
    'firstFailedLeaf',
  );
  const nextOpenLeaf = leafRef(
    rowNullableText(row, 'next_open_leaf_json'),
    'nextOpenLeaf',
  );
  const firstReviewLeaf = leafRef(
    rowNullableText(row, 'first_review_leaf_json'),
    'firstReviewLeaf',
  );
  const leftOpen = rowLeftOpen(row);
  const originChatId = rowNullableText(row, 'origin_chat_id');
  const item = LedgerRollupItemSchema.safeParse({
    entryId: rowText(row, 'entry_id'),
    type: rowText(row, 'entry_type'),
    title: rowText(row, 'entry_title'),
    status: rowText(row, 'entry_status'),
    owner: {
      actorId: rowText(row, 'entry_owner_actor_id'),
      kind: rowText(row, 'entry_owner_kind'),
      authorityId: rowText(row, 'entry_owner_authority_id'),
    },
    lastActivityAt: rowText(row, 'last_activity_at'),
    ...(leftOpen === undefined ? {} : { leftOpen }),
    ...(originChatId === null
      ? {}
      : {
          originChat: {
            chatId: originChatId,
            viaDelegate: rowInteger(row, 'origin_via_delegate') === 1,
          },
        }),
    leafCounts,
    leafStatuses,
    childCounts,
    childStatuses,
    ...(currentLeaf === undefined ? {} : { currentLeaf }),
    ...(firstBlockedLeaf === undefined ? {} : { firstBlockedLeaf }),
    ...(firstFailedLeaf === undefined ? {} : { firstFailedLeaf }),
    ...(nextOpenLeaf === undefined ? {} : { nextOpenLeaf }),
    ...(firstReviewLeaf === undefined ? {} : { firstReviewLeaf }),
    inProgressLeaves: inProgressLeaves.data,
    hasChildTasks: rowInteger(row, 'has_child_tasks') > 0,
    openDescendantCount: rowInteger(row, 'open_descendants'),
    openLeafOwnerCount: rowInteger(row, 'open_leaf_owner_count'),
    openLeafOwners: openLeafOwners.data,
    openNeedsReviewOwnedByCaller: rowInteger(row, 'open_needs_review'),
  });
  if (!item.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
    });
  }
  return item.data;
}

function isScopeRow(row: LedgerSqlRow): boolean {
  return rowText(row, 'row_kind') === 'scope';
}

function itemCursor(
  item: LedgerSqlRow,
  position: RollupsPosition,
  scopes: readonly LedgerRollupsScopeRequest[],
  watermarks: readonly RollupsScopeWatermark[],
  context: LedgerRollupsQueryContext,
): string {
  const first = scopes[0];
  if (first === undefined) throw new LedgerStoreError('STORAGE_UNAVAILABLE');
  return encodeLedgerCursor(
    {
      kind: 'rollups',
      ledgerId: first.ledgerId,
      schemaVersion: context.schemaVersion,
      issuedAtMs: context.now().getTime(),
      filterHash: position.filterHash,
      watermarks: watermarks.map((scope): string => scope.watermark),
      lastOpenRank: rowInteger(item, 'open_rank'),
      lastActivityAt: rowText(item, 'last_activity_at'),
      lastScopeOrder: rowInteger(item, 'scope_order'),
      lastEntryId: rowText(item, 'entry_id'),
    },
    context.cursorSecret,
  );
}

/**
 * Reads a stable, cross-scope page of operation/top-level task rollups in one
 * cached SQLite statement. Scope watermarks and root memberships keep later
 * pages pinned to the same view while writes continue.
 */
export function listLedgerRollups(
  input: LedgerRollupsInput,
  context: LedgerRollupsQueryContext,
): LedgerRollupsListResult {
  const scopes = normalizeInput(input);
  const position = resolvePosition(input, scopes, context);
  const requestedJson = JSON.stringify(
    scopes.map((scope, ordinal) => ({ ...scope, ordinal })),
  );
  const watermarksJson = JSON.stringify(
    position.watermarks?.map((watermark) => ({
      ledgerId: watermark.ledgerId,
      watermark: watermark.watermark,
    })) ?? [],
  );
  const after = position.after;
  const rows = context
    .prepare(ROLLUPS_QUERY)
    .all(
      requestedJson,
      watermarksJson,
      after?.openRank ?? null,
      after?.openRank ?? null,
      after?.openRank ?? null,
      after?.activityAt ?? null,
      after?.openRank ?? null,
      after?.activityAt ?? null,
      after?.scopeOrder ?? null,
      after?.openRank ?? null,
      after?.activityAt ?? null,
      after?.scopeOrder ?? null,
      after?.ledgerId ?? null,
      after?.openRank ?? null,
      after?.activityAt ?? null,
      after?.scopeOrder ?? null,
      after?.ledgerId ?? null,
      after?.entryId ?? null,
      LEDGER_LIMITS.rollupsPageMax + 1,
    );

  const scopeRows = rows.filter(isScopeRow);
  const itemRows = rows.filter((row) => !isScopeRow(row));
  const page = itemRows.slice(0, LEDGER_LIMITS.rollupsPageMax);
  const hasMore = itemRows.length > LEDGER_LIMITS.rollupsPageMax;
  const scopeByOrder = new Map<number, LedgerRollupScope>();
  const watermarks: RollupsScopeWatermark[] = [];
  for (const row of scopeRows) {
    const scopeOrder = rowInteger(row, 'scope_order');
    const ledgerId = rowText(row, 'ledger_id');
    const watermark = String(rowInteger(row, 'scope_watermark'));
    watermarks.push({ ledgerId, watermark });
    scopeByOrder.set(scopeOrder, {
      ledgerId,
      lastActivityAt: rowNullableText(row, 'scope_last_activity_at'),
      openNeedsReviewOwnedByCaller: rowInteger(row, 'scope_open_needs_review'),
      openBlockedOwnedByCaller: rowInteger(row, 'scope_open_blocked'),
      items: [],
    });
  }
  for (const row of page) {
    const scopeOrder = rowInteger(row, 'scope_order');
    const scope = scopeByOrder.get(scopeOrder);
    if (scope === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'malformed_rollup',
      });
    }
    scope.items.push(buildItem(row));
  }

  const orderedScopes = Array.from(scopeByOrder.entries())
    .sort(([left], [right]) => left - right)
    .map(([, scope]) => scope);
  const last = page[page.length - 1];
  const result: LedgerRollupsListResult = {
    scopes: orderedScopes,
    ...(hasMore && last !== undefined
      ? { nextCursor: itemCursor(last, position, scopes, watermarks, context) }
      : {}),
  };
  const parsed = LedgerRollupsListResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_rollup',
    });
  }
  return parsed.data;
}
