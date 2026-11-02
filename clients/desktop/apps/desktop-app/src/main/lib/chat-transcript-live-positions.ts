import { Buffer } from 'node:buffer';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { MAX_TRANSCRIPT_ROW_BYTES } from './chat-transcript-prefix-replace';

/**
 * Stable position metadata for one active transcript row.
 *
 * Anchors are scoped to one chat; message IDs are not globally unique. Every
 * ID field is limited to 512 UTF-16 code units so a persisted position remains
 * bounded independently of the transcript message body.
 * `runId` is the owning run generation's delegated-agent card message ID, not
 * the delegation ID. The anchor belongs to the sidecar record, not its message.
 * `after` names the preceding logical row (or `null` for the start of the
 * transcript). `tie` orders rows sharing that gap: smaller signed safe
 * integers are closer to the predecessor. Ties are global across delegation
 * runs and generations, not scoped to `runId`.
 * An absent anchor is a legacy row whose ordinary sidecar order still applies;
 * present-but-invalid metadata must never fall back to that legacy behavior.
 */
export interface ActiveRowAnchor {
  version: 1;
  runId: string;
  after: string | null;
  tie: number;
}

/** Minimal logical transcript information needed to calculate row positions. */
export interface LogicalPositionRow {
  id: string;
  parentBlockId?: string;
  run?: { delegationId: string; generation: number };
}

/** Logical placement of live rows around an externally ordered committed body. */
export interface LogicalPlacement<T extends { id: string }> {
  /** Live rows grouped after their committed predecessor, including descendants. */
  afterCommitted: Map<string, T[]>;
  /** Rows anchored at the start of the body, including descendants. */
  start: T[];
  /** Ordinary active tail rows and any followers, in logical order. */
  tail: T[];
}

/** A half-open interval in the merged body-rank space. */
export interface BodyRankRange {
  start: number;
  endExclusive: number;
}

/** Sparse rank helpers for a logical placement over a committed transcript. */
export interface LogicalPlacementRanks {
  /** Zero-based ranks for all active rows; ordinary tail rows follow the body. */
  activeRankById: Map<string, number>;
  /** Number of committed and start/after-committed rows, excluding the ordinary tail. */
  bodyCount: number;
  /** Returns the zero-based merged-body rank for a committed ordinal. */
  committedRankByOrdinal: (ordinal: number) => number;
  /** Returns a committed ordinal for a committed body rank, or undefined for active rows. */
  committedOrdinalByBodyRank: (bodyRank: number) => number | undefined;
  /** Returns the committed row and its follower subtree as a merged-body interval. */
  bodyRankRangeByCommittedOrdinal: (ordinal: number) => BodyRankRange;
}

/** Result when reading optional anchor metadata from a persisted record. */
export type ParseActiveRowAnchorResult =
  | { status: 'absent' }
  | { status: 'valid'; anchor: ActiveRowAnchor }
  | { status: 'invalid'; reason: string };

/** Result when decoding the JSON-safe tuple representation of anchors. */
export type DecodeActiveRowAnchorsResult =
  | { status: 'valid'; anchors: Map<string, ActiveRowAnchor> }
  | { status: 'invalid'; reason: string };

/**
 * Active sidecar row shape. `finalizing` is a write-side marker; the encoded
 * message and optional position remain part of the complete JSON record.
 */
export interface ActiveSidecarMessageRecord {
  version: 2;
  kind: 'message';
  message: PersistedChatMessage;
  anchor?: ActiveRowAnchor;
  finalizing?: true;
}

const MAX_ID_UTF16_LENGTH = 512;
const READER_ROW_PADDING_BYTES = 1024;
const ANCHOR_KEYS: readonly string[] = ['version', 'runId', 'after', 'tie'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_UTF16_LENGTH
  );
}

function assertId(value: unknown, label: string): asserts value is string {
  if (!isValidId(value))
    throw new Error(
      `${label} must be a nonempty ID of at most 512 UTF-16 code units`,
    );
}

function isActiveRowAnchor(value: unknown): value is ActiveRowAnchor {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, ANCHOR_KEYS))
    return false;
  return (
    value.version === 1 &&
    isValidId(value.runId) &&
    (value.after === null || isValidId(value.after)) &&
    typeof value.tie === 'number' &&
    Number.isSafeInteger(value.tie)
  );
}

function assertActiveRowAnchor(
  value: unknown,
  label: string,
): asserts value is ActiveRowAnchor {
  if (!isActiveRowAnchor(value))
    throw new Error(
      `${label} must be a version-1 active-row anchor with exactly version, runId, after, and tie`,
    );
}

function copyAnchor(anchor: ActiveRowAnchor): ActiveRowAnchor {
  return {
    version: 1,
    runId: anchor.runId,
    after: anchor.after,
    tie: anchor.tie,
  };
}

function validateLogicalRows(
  logicalRows: readonly LogicalPositionRow[],
): Map<string, number> {
  const indexById = new Map<string, number>();
  logicalRows.forEach((row, index) => {
    assertId(row.id, `Logical row ${index} ID`);
    if (indexById.has(row.id))
      throw new Error(`Duplicate logical row ID: ${row.id}`);
    if (row.parentBlockId !== undefined)
      assertId(row.parentBlockId, `Logical row ${row.id} parentBlockId`);
    if (row.run !== undefined) {
      assertId(row.run.delegationId, `Logical row ${row.id} delegationId`);
      if (!Number.isSafeInteger(row.run.generation) || row.run.generation < 1)
        throw new Error(`Logical row ${row.id} has an invalid run generation`);
    }
    indexById.set(row.id, index);
  });
  return indexById;
}

function anchorRows(
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): Array<[string, ActiveRowAnchor]> {
  const rows: Array<[string, ActiveRowAnchor]> = [];
  for (const [id, anchor] of Array.from(anchors)) {
    assertId(id, 'Active row message ID');
    assertActiveRowAnchor(anchor, `Active row anchor for ${id}`);
    rows.push([id, anchor]);
  }
  return rows;
}

function predecessorAt(
  logicalRows: readonly LogicalPositionRow[],
  insertionIndex: number,
): string | null {
  return insertionIndex > 0
    ? (logicalRows[insertionIndex - 1]?.id ?? null)
    : null;
}

/**
 * Finds the predecessor for inserting/updating `messageId` in the supplied
 * current order. The row is removed from that order before the position is
 * calculated. An omitted hint appends; explicit `null` inserts at the start;
 * an explicit ID must exist and inserts after its contiguous direct children
 * (`parentBlockId === hint`), matching backend message-upsert grouping.
 * Self, duplicate, malformed, or dangling IDs are rejected rather than
 * silently falling back to the tail.
 */
export function effectiveActiveRowPredecessor(
  logicalRows: readonly LogicalPositionRow[],
  messageId: string,
  afterMessageId?: string | null,
): string | null {
  assertId(messageId, 'Message ID');
  const indexById = validateLogicalRows(logicalRows);
  const rows = logicalRows.filter((row) => row.id !== messageId);

  if (afterMessageId === undefined)
    return rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null;
  if (afterMessageId === null) return null;
  assertId(afterMessageId, 'afterMessageId');
  if (afterMessageId === messageId)
    throw new Error('A message cannot be positioned after itself');
  if (!indexById.has(afterMessageId))
    throw new Error(`Unknown afterMessageId: ${afterMessageId}`);

  const anchorIndex = rows.findIndex((row) => row.id === afterMessageId);
  if (anchorIndex < 0)
    throw new Error(
      `Unknown afterMessageId after removing message: ${afterMessageId}`,
    );
  let insertAt = anchorIndex + 1;
  while (rows[insertAt]?.parentBlockId === afterMessageId) insertAt += 1;
  return predecessorAt(rows, insertAt);
}

/**
 * Computes the predecessor for the first appearance of a delegation card.
 * The caller must already have selected the originating tool/turn parent.
 * Insertion starts immediately after that parent (or at chat start), then
 * goes before the first same-delegation card with a higher generation, or
 * after the contiguous children of lower-generation cards without moving
 * before the parent insertion point. A higher-generation card takes precedence
 * over that parent point, including recovery where the parent is later in the
 * transcript. Calling this for an existing
 * `cardId` is an error; updates keep their frozen anchor instead.
 */
export function delegationCardInsertionPredecessor(
  logicalRows: readonly LogicalPositionRow[],
  run: { cardId: string; delegationId: string; generation: number },
  parentMessageId: string | null,
): string | null {
  assertId(run.cardId, 'Delegation card ID');
  assertId(run.delegationId, 'Delegation ID');
  if (!Number.isSafeInteger(run.generation) || run.generation < 1)
    throw new Error('Delegation generation must be a positive safe integer');
  const indexById = validateLogicalRows(logicalRows);
  if (indexById.has(run.cardId))
    throw new Error(`Delegation card already exists: ${run.cardId}`);

  let insertionIndex = 0;
  if (parentMessageId !== null) {
    assertId(parentMessageId, 'Parent message ID');
    const parentIndex = indexById.get(parentMessageId);
    if (parentIndex === undefined)
      throw new Error(`Unknown parent message ID: ${parentMessageId}`);
    insertionIndex = parentIndex + 1;
  }

  for (let index = 0; index < logicalRows.length; index += 1) {
    const row = logicalRows[index];
    if (!row?.run || row.run.delegationId !== run.delegationId) continue;
    if (row.run.generation > run.generation) {
      insertionIndex = index;
      break;
    }
    if (row.run.generation < run.generation) {
      let afterChildren = index + 1;
      while (logicalRows[afterChildren]?.parentBlockId === row.id)
        afterChildren += 1;
      insertionIndex = Math.max(insertionIndex, afterChildren);
    }
  }
  return predecessorAt(logicalRows, insertionIndex);
}

/**
 * Gets a row's frozen anchor or creates one for its first appearance. Existing
 * rows ignore the insertion hint and keep the same run and position; changing
 * their run ID is rejected. A new row uses the effective current predecessor
 * and receives the minimum sibling tie minus one, across every run and
 * generation sharing that gap (or tie zero when first). Safe-integer tie
 * exhaustion is rejected; existing rows are never renumbered on update.
 * For a late child, the caller supplies the last existing child of its card
 * (or the card when there are no children) as the insertion hint. The gap is
 * calculated after any direct children of that hint, before allocating a tie;
 * allocating a smaller tie at the raw hint would split its existing group.
 * `logicalPredecessor` supplies an already-resolved, exact gap instead of an
 * insertion hint, and must not be combined with `afterMessageId` for new rows.
 * This is necessary for reducer card insertion: unlike backend hinted upserts,
 * the reducer can insert a card before the originating parent's child group.
 * Pass delegationCardInsertionPredecessor's result through this exact-gap seam
 * without expanding a child group a second time.
 * This module represents positions, not child-sequence reconciliation: the
 * reducer sorts replayed children by sequence, while backend hinted upserts
 * append new children after the current group and freeze existing rows. The
 * caller must select the applicable ordering policy, then derive its gaps.
 */
export function deriveActiveRowAnchor(input: {
  messageId: string;
  runId: string;
  logicalRows: readonly LogicalPositionRow[];
  anchors: ReadonlyMap<string, ActiveRowAnchor>;
  afterMessageId?: string | null;
  logicalPredecessor?: string | null;
}): ActiveRowAnchor {
  const {
    messageId,
    runId,
    logicalRows,
    anchors,
    afterMessageId,
    logicalPredecessor,
  } = input;
  assertId(messageId, 'Message ID');
  assertId(runId, 'Run ID');
  validateLogicalRows(logicalRows);
  const currentAnchors = anchorRows(anchors);
  const existing = anchors.get(messageId);
  if (existing !== undefined) {
    assertActiveRowAnchor(existing, `Active row anchor for ${messageId}`);
    if (existing.runId !== runId)
      throw new Error(`Run ID changed for anchored message ${messageId}`);
    return copyAnchor(existing);
  }

  if (logicalPredecessor !== undefined && afterMessageId !== undefined)
    throw new Error(
      'An exact logical predecessor cannot be combined with an insertion hint',
    );
  let after: string | null;
  if (logicalPredecessor === undefined) {
    after = effectiveActiveRowPredecessor(
      logicalRows,
      messageId,
      afterMessageId,
    );
  } else {
    if (logicalPredecessor !== null) {
      assertId(logicalPredecessor, 'Logical predecessor');
      if (!logicalRows.some((row) => row.id === logicalPredecessor))
        throw new Error(`Unknown logical predecessor: ${logicalPredecessor}`);
    }
    after = logicalPredecessor;
  }
  if (after === messageId)
    throw new Error('A message cannot be positioned after itself');
  let minimumTie: number | undefined;
  for (const [, anchor] of currentAnchors) {
    if (anchor.after !== after) continue;
    minimumTie =
      minimumTie === undefined ? anchor.tie : Math.min(minimumTie, anchor.tie);
  }
  if (minimumTie === Number.MIN_SAFE_INTEGER)
    throw new Error('Active row sibling tie has exhausted safe integers');
  const tie = minimumTie === undefined ? 0 : minimumTie - 1;
  if (!Number.isSafeInteger(tie))
    throw new Error('Active row sibling tie has exhausted safe integers');
  return { version: 1, runId, after, tie };
}

/**
 * Rebuilds surviving anchored rows as a predecessor chain after an explicit
 * structural removal. The complete surviving logical order is authoritative,
 * including committed and ordinary rows; every anchored row gets tie zero and
 * points at the immediately preceding logical row. Removed anchor entries are
 * dropped. The order must include every surviving anchored row. Callers must
 * retain an owning delegation card or remove the whole run when removing a
 * card, so no surviving anchor points at a deleted run card.
 */
export function retargetActiveRowAnchorsAfterRemoval(
  logicalRows: readonly LogicalPositionRow[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  removedIds: ReadonlySet<string>,
): Map<string, ActiveRowAnchor> {
  const indexById = validateLogicalRows(logicalRows);
  const currentAnchors = anchorRows(anchors);
  for (const id of Array.from(removedIds)) assertId(id, 'Removed message ID');

  for (const [id] of currentAnchors) {
    if (!removedIds.has(id) && !indexById.has(id))
      throw new Error(
        `Incomplete logical order: anchored message ${id} is missing`,
      );
  }

  const survivingRows = logicalRows.filter((row) => !removedIds.has(row.id));
  const retargeted = new Map<string, ActiveRowAnchor>();
  for (let index = 0; index < survivingRows.length; index += 1) {
    const row = survivingRows[index];
    if (!row || removedIds.has(row.id)) continue;
    const original = anchors.get(row.id);
    if (original === undefined) continue;
    assertActiveRowAnchor(original, `Active row anchor for ${row.id}`);
    if (removedIds.has(original.runId))
      throw new Error(
        `Cannot retain anchored message ${row.id} after removing its run card ${original.runId}`,
      );
    retargeted.set(row.id, {
      version: 1,
      runId: original.runId,
      after: index > 0 ? (survivingRows[index - 1]?.id ?? null) : null,
      tie: 0,
    });
  }
  return retargeted;
}

/**
 * Reads optional `anchor` metadata from a record. Only a record with no own
 * `anchor` key is absent; explicit `undefined`/`null`, malformed containers,
 * and anchors with missing or extra fields are invalid. Valid anchors are
 * returned as fresh plain objects.
 */
export function parseActiveRowAnchor(
  record: unknown,
): ParseActiveRowAnchorResult {
  if (!isPlainRecord(record))
    return { status: 'invalid', reason: 'Record must be a plain object' };
  if (!Object.prototype.hasOwnProperty.call(record, 'anchor'))
    return { status: 'absent' };
  const value = record.anchor;
  if (!isActiveRowAnchor(value))
    return {
      status: 'invalid',
      reason:
        'Anchor must have exactly version, runId, after, and tie with valid values',
    };
  return { status: 'valid', anchor: copyAnchor(value) };
}

/**
 * Encodes anchors for JSON persistence as fresh `[messageId, anchor]` tuples.
 * The returned array, tuples, and anchor records are all fresh plain values;
 * a `Map` must never be handed directly to JSON serialization.
 */
export function encodeActiveRowAnchors(
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): [string, ActiveRowAnchor][] {
  return anchorRows(anchors).map(([id, anchor]) => [id, copyAnchor(anchor)]);
}

/**
 * Decodes the strict JSON-safe tuple representation. It rejects malformed
 * tuple lengths, invalid IDs/anchor shapes, duplicate message IDs, and extra
 * tuple properties, returning fresh anchor objects in a fresh `Map`.
 */
export function decodeActiveRowAnchors(
  value: unknown,
): DecodeActiveRowAnchorsResult {
  if (!Array.isArray(value))
    return { status: 'invalid', reason: 'Anchors must be an array of tuples' };
  const anchors = new Map<string, ActiveRowAnchor>();
  for (let index = 0; index < value.length; index += 1) {
    const tuple: unknown = value[index];
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      Reflect.ownKeys(tuple).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(tuple, '0') ||
      !Object.prototype.hasOwnProperty.call(tuple, '1')
    )
      return {
        status: 'invalid',
        reason: `Anchor tuple ${index} must contain exactly two values`,
      };
    const id: unknown = tuple[0];
    const anchor: unknown = tuple[1];
    if (!isValidId(id))
      return {
        status: 'invalid',
        reason: `Anchor tuple ${index} has an invalid message ID`,
      };
    if (anchors.has(id))
      return {
        status: 'invalid',
        reason: `Duplicate active row message ID: ${id}`,
      };
    if (!isActiveRowAnchor(anchor))
      return {
        status: 'invalid',
        reason: `Anchor tuple ${index} has an invalid anchor`,
      };
    anchors.set(id, copyAnchor(anchor));
  }
  return { status: 'valid', anchors };
}

/**
 * Validates an anchor set against the current committed/active transcript.
 * Anchored messages must be active, their predecessor must be committed or
 * active and not self, chains must be acyclic, run ownership must exactly
 * match, each owner must be a known committed/active run card, and ties must
 * be unique for each shared gap across all runs and generations.
 */
export function validateActiveRowAnchors(
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  context: {
    isCommittedMessage: (id: string) => boolean;
    activeIds: ReadonlySet<string>;
    runIdForMessage: (id: string) => string | undefined;
    knownRunCardIds: ReadonlySet<string>;
  },
): { valid: true } | { valid: false; reason: string } {
  const tiesByAfter = new Map<string | null, Set<number>>();
  for (const [id, anchor] of Array.from(anchors)) {
    if (!isValidId(id))
      return { valid: false, reason: 'Anchored message ID is invalid' };
    if (!isActiveRowAnchor(anchor))
      return {
        valid: false,
        reason: `Invalid active row anchor for ${id}`,
      };
    if (!context.activeIds.has(id))
      return {
        valid: false,
        reason: `Anchored message is not active: ${id}`,
      };
    if (context.runIdForMessage(id) !== anchor.runId)
      return {
        valid: false,
        reason: `Run ID does not match message ownership for ${id}`,
      };
    if (!context.knownRunCardIds.has(anchor.runId))
      return {
        valid: false,
        reason: `Unknown run card for anchored message ${id}`,
      };
    if (
      !context.isCommittedMessage(anchor.runId) &&
      !context.activeIds.has(anchor.runId)
    )
      return {
        valid: false,
        reason: `Run card is neither committed nor active: ${anchor.runId}`,
      };
    if (anchor.after === id)
      return {
        valid: false,
        reason: `Anchored message cannot follow itself: ${id}`,
      };
    if (
      anchor.after !== null &&
      !context.activeIds.has(anchor.after) &&
      !context.isCommittedMessage(anchor.after)
    )
      return {
        valid: false,
        reason: `Dangling predecessor ${anchor.after} for ${id}`,
      };
    const ties = tiesByAfter.get(anchor.after) ?? new Set<number>();
    if (ties.has(anchor.tie))
      return {
        valid: false,
        reason: `Duplicate sibling tie ${anchor.tie} after ${String(anchor.after)}`,
      };
    ties.add(anchor.tie);
    tiesByAfter.set(anchor.after, ties);
  }

  const resolved = new Set<string>();
  for (const startId of Array.from(anchors.keys())) {
    const path: string[] = [];
    const pathIds = new Set<string>();
    let currentId: string | undefined = startId;
    while (currentId !== undefined && anchors.has(currentId)) {
      if (resolved.has(currentId)) break;
      if (pathIds.has(currentId))
        return {
          valid: false,
          reason: `Active row anchor cycle includes ${currentId}`,
        };
      pathIds.add(currentId);
      path.push(currentId);
      const currentAnchor = anchors.get(currentId);
      currentId = currentAnchor?.after ?? undefined;
    }
    for (const id of path) resolved.add(id);
  }
  return { valid: true };
}

/**
 * Resolves anchored active rows around an externally ordered committed body.
 * Committed duplicates in `activeRows` are omitted from the placement, while
 * the full active-ID set is used for anchor validation to match the sidecar
 * validator's semantics. Followers use depth-first traversal with ascending
 * sibling ties. Unanchored active rows retain their sidecar order at the tail.
 */
export function resolveLogicalPlacement<T extends { id: string }>(input: {
  activeRows: readonly T[];
  anchors: ReadonlyMap<string, ActiveRowAnchor>;
  isCommittedMessage: (id: string) => boolean;
  knownRunCardIds: ReadonlySet<string>;
  runIdForMessage: (id: string) => string | undefined;
}): LogicalPlacement<T> {
  const activeIds = new Set<string>();
  for (let index = 0; index < input.activeRows.length; index += 1) {
    const row = input.activeRows[index];
    if (!row) throw new Error(`Missing active row at index ${index}`);
    assertId(row.id, `Active row ${index} ID`);
    if (activeIds.has(row.id))
      throw new Error(`Duplicate active row ID: ${row.id}`);
    activeIds.add(row.id);
  }

  const validation = validateActiveRowAnchors(input.anchors, {
    isCommittedMessage: input.isCommittedMessage,
    activeIds,
    runIdForMessage: input.runIdForMessage,
    knownRunCardIds: input.knownRunCardIds,
  });
  if (!validation.valid) throw new Error(validation.reason);

  const placementRows: T[] = [];
  const activeRowById = new Map<string, T>();
  for (const row of input.activeRows) {
    if (input.isCommittedMessage(row.id)) continue;
    placementRows.push(row);
    activeRowById.set(row.id, row);
  }

  interface Follower {
    id: string;
    row: T;
    tie: number;
  }
  const followersByAfter = new Map<string | null, Follower[]>();
  const followerGroups: Follower[][] = [];
  const committedRootIds: string[] = [];
  for (const [id, rowAnchor] of Array.from(input.anchors)) {
    const row = activeRowById.get(id);
    if (!row) continue;
    let followers = followersByAfter.get(rowAnchor.after);
    if (!followers) {
      followers = [];
      followersByAfter.set(rowAnchor.after, followers);
      followerGroups.push(followers);
      if (rowAnchor.after !== null && input.isCommittedMessage(rowAnchor.after))
        committedRootIds.push(rowAnchor.after);
    }
    followers.push({ id, row, tie: rowAnchor.tie });
  }
  for (const followers of followerGroups)
    followers.sort((left, right) => left.tie - right.tie);

  const emittedAnchoredIds = new Set<string>();
  const emitFollowers = (
    predecessorId: string | null,
    destination: T[],
  ): void => {
    const roots = followersByAfter.get(predecessorId) ?? [];
    const pending: Follower[] = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const follower = roots[index];
      if (follower) pending.push(follower);
    }
    while (pending.length > 0) {
      const follower = pending.pop();
      if (!follower) continue;
      if (emittedAnchoredIds.has(follower.id))
        throw new Error(
          `Active row anchor graph emitted a row twice: ${follower.id}`,
        );
      emittedAnchoredIds.add(follower.id);
      destination.push(follower.row);

      const children = followersByAfter.get(follower.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) pending.push(child);
      }
    }
  };

  const start: T[] = [];
  emitFollowers(null, start);

  const afterCommitted = new Map<string, T[]>();
  for (const committedRootId of committedRootIds) {
    const followers: T[] = [];
    emitFollowers(committedRootId, followers);
    afterCommitted.set(committedRootId, followers);
  }

  const tail: T[] = [];
  for (const row of placementRows) {
    if (input.anchors.has(row.id)) continue;
    tail.push(row);
    emitFollowers(row.id, tail);
  }

  for (const row of placementRows) {
    if (input.anchors.has(row.id) && !emittedAnchoredIds.has(row.id))
      throw new Error(`Unreachable active row anchor for ${row.id}`);
  }

  return { afterCommitted, start, tail };
}

function assertCommittedOrdinal(ordinal: number, committedCount: number): void {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= committedCount
  )
    throw new Error(`Committed ordinal is out of range: ${ordinal}`);
}

/**
 * Ranks active rows around the body without materializing the committed
 * transcript. `bodyCount` excludes the ordinary tail; tail rows receive ranks
 * starting at `bodyCount`. `committedOrdinalById` only needs entries for the
 * predecessor IDs in `placement.afterCommitted`; sparse insertion groups are
 * indexed by ordinal and rank conversion helpers use binary search over them.
 */
export function rankLogicalPlacement<T extends { id: string }>(
  placement: LogicalPlacement<T>,
  committedCount: number,
  committedOrdinalById: ReadonlyMap<string, number>,
): LogicalPlacementRanks {
  if (!Number.isSafeInteger(committedCount) || committedCount < 0)
    throw new Error(
      `Committed count must be a nonnegative safe integer: ${committedCount}`,
    );

  interface SparseInsertion {
    ordinal: number;
    rows: readonly T[];
    insertedBefore: number;
    bodyStart: number;
    bodyEndExclusive: number;
  }
  const insertions: SparseInsertion[] = [];
  const predecessorByOrdinal = new Map<number, string>();
  const insertionEntries: Array<{
    predecessorId: string;
    rows: readonly T[];
  }> = [];
  placement.afterCommitted.forEach((rows: T[], predecessorId: string): void => {
    insertionEntries.push({ predecessorId, rows });
  });
  for (const { predecessorId, rows } of insertionEntries) {
    assertId(predecessorId, 'Committed predecessor ID');
    const ordinal = committedOrdinalById.get(predecessorId);
    if (ordinal === undefined)
      throw new Error(
        `Missing committed ordinal for predecessor ${predecessorId}`,
      );
    assertCommittedOrdinal(ordinal, committedCount);
    const existingPredecessor = predecessorByOrdinal.get(ordinal);
    if (existingPredecessor !== undefined)
      throw new Error(
        `Duplicate committed ordinal ${ordinal} for predecessors ${existingPredecessor} and ${predecessorId}`,
      );
    predecessorByOrdinal.set(ordinal, predecessorId);
    insertions.push({
      ordinal,
      rows,
      insertedBefore: 0,
      bodyStart: 0,
      bodyEndExclusive: 0,
    });
  }
  insertions.sort((left, right) => left.ordinal - right.ordinal);

  const startCount = placement.start.length;
  let insertedRowsTotal = 0;
  for (const insertion of insertions)
    insertedRowsTotal += insertion.rows.length;
  const bodyCount = startCount + committedCount + insertedRowsTotal;
  const totalCount = bodyCount + placement.tail.length;
  if (!Number.isSafeInteger(bodyCount) || !Number.isSafeInteger(totalCount))
    throw new Error('Logical body count exceeds the safe integer range');

  let insertedRowsBefore = 0;
  for (const insertion of insertions) {
    insertion.insertedBefore = insertedRowsBefore;
    insertion.bodyStart =
      startCount + insertion.ordinal + insertedRowsBefore + 1;
    insertion.bodyEndExclusive = insertion.bodyStart + insertion.rows.length;
    insertedRowsBefore += insertion.rows.length;
  }

  const activeRankById = new Map<string, number>();
  const setActiveRank = (row: T, rank: number): void => {
    assertId(row.id, 'Active placement row ID');
    if (activeRankById.has(row.id))
      throw new Error(`Duplicate active placement row ID: ${row.id}`);
    activeRankById.set(row.id, rank);
  };
  for (let index = 0; index < placement.start.length; index += 1) {
    const row = placement.start[index];
    if (!row) throw new Error(`Missing start row at index ${index}`);
    setActiveRank(row, index);
  }
  for (const insertion of insertions) {
    for (let index = 0; index < insertion.rows.length; index += 1) {
      const row = insertion.rows[index];
      if (!row) throw new Error(`Missing committed follower at index ${index}`);
      setActiveRank(row, insertion.bodyStart + index);
    }
  }

  const tailStart = bodyCount;
  for (let index = 0; index < placement.tail.length; index += 1) {
    const row = placement.tail[index];
    if (!row) throw new Error(`Missing tail row at index ${index}`);
    setActiveRank(row, tailStart + index);
  }

  const countInsertedBeforeOrdinal = (ordinal: number): number => {
    let low = 0;
    let high = insertions.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const insertion = insertions[middle];
      if (!insertion)
        throw new Error('Missing sparse committed insertion during search');
      if (insertion.ordinal < ordinal) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    const previous = insertions[low - 1];
    if (!previous)
      throw new Error('Missing sparse committed insertion before ordinal');
    return previous.insertedBefore + previous.rows.length;
  };

  const findInsertionByOrdinal = (
    ordinal: number,
  ): SparseInsertion | undefined => {
    let low = 0;
    let high = insertions.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const insertion = insertions[middle];
      if (!insertion)
        throw new Error('Missing sparse committed insertion during search');
      if (insertion.ordinal < ordinal) low = middle + 1;
      else high = middle;
    }
    const insertion = insertions[low];
    return insertion?.ordinal === ordinal ? insertion : undefined;
  };

  const committedRankByOrdinal = (ordinal: number): number => {
    assertCommittedOrdinal(ordinal, committedCount);
    return startCount + ordinal + countInsertedBeforeOrdinal(ordinal);
  };

  const committedOrdinalByBodyRank = (bodyRank: number): number | undefined => {
    if (
      !Number.isSafeInteger(bodyRank) ||
      bodyRank < startCount ||
      bodyRank >= bodyCount
    )
      return undefined;

    let low = 0;
    let high = insertions.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const insertion = insertions[middle];
      if (!insertion)
        throw new Error('Missing sparse committed insertion during search');
      if (insertion.bodyEndExclusive <= bodyRank) low = middle + 1;
      else high = middle;
    }

    const nextInsertion = insertions[low];
    if (nextInsertion && bodyRank >= nextInsertion.bodyStart) return undefined;
    const insertedBefore = nextInsertion
      ? nextInsertion.insertedBefore
      : insertedRowsTotal;
    const ordinal = bodyRank - startCount - insertedBefore;
    return ordinal >= 0 && ordinal < committedCount ? ordinal : undefined;
  };

  const bodyRankRangeByCommittedOrdinal = (ordinal: number): BodyRankRange => {
    const start = committedRankByOrdinal(ordinal);
    const followers = findInsertionByOrdinal(ordinal)?.rows.length ?? 0;
    return { start, endExclusive: start + 1 + followers };
  };

  return {
    activeRankById,
    bodyCount,
    committedRankByOrdinal,
    committedOrdinalByBodyRank,
    bodyRankRangeByCommittedOrdinal,
  };
}

/**
 * Returns the complete active sidecar record's UTF-8 JSON byte length,
 * excluding its newline delimiter. This measures escaped IDs and the whole
 * persisted message, not just the anchor metadata. Since JSON escaping can
 * expand even bounded 512-code-unit IDs beyond the 1024-byte reader padding,
 * callers must check the complete record independently.
 */
export function activeSidecarMessageRecordBytes(
  record: ActiveSidecarMessageRecord,
): number {
  const serialized = JSON.stringify(record);
  if (serialized === undefined)
    throw new Error('Active sidecar message record is not JSON serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Checks the complete sidecar JSON row against the transcript writer's byte
 * ceiling plus the reader's current literal 1024-byte line-padding allowance.
 * The newline delimiter is excluded from both the measured row and budget;
 * bounded, escaped ID fields may use more than that 1024-byte allowance.
 * The message itself must separately satisfy MAX_TRANSCRIPT_ROW_BYTES in the
 * existing writer; this check is not a replacement for that message limit.
 * The message constant is imported; the reader's currently unexported padding
 * is mirrored here. A caller may provide a different complete-record ceiling.
 */
export function checkActiveSidecarMessageRecordBudget(
  record: ActiveSidecarMessageRecord,
  ceiling = MAX_TRANSCRIPT_ROW_BYTES + READER_ROW_PADDING_BYTES,
): { bytes: number; ceiling: number; withinLimit: boolean } {
  const bytes = activeSidecarMessageRecordBytes(record);
  return { bytes, ceiling, withinLimit: bytes <= ceiling };
}
