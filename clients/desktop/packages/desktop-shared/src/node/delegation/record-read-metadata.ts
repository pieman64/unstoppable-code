import type { StoredDelegation } from './broker';
import type { DelegationTranscriptTarget } from './transcript-port';

/** Where one generation's transcript and outcome are read from. */
export interface DelegationGenerationReadSource {
  readonly store: 'legacy' | 'stream';
  readonly target: DelegationTranscriptTarget;
}

/**
 * Bounded read metadata for a delegation record whose bodies may live outside
 * it. Phase 11c persists this shape in version 3 records; until then nothing
 * in production supplies it, so every reader takes its legacy path.
 */
export interface DelegationRecordReadMetadata {
  /** Immutable delegate origin; replaces `history[0].createdAt` for ordering. */
  readonly originAt: number;
  /**
   * Monotonic maximum over the legacy prefix, settled generations and
   * evicted controls; never the current generation's time alone.
   */
  readonly lastActivityAt: number;
  readonly current: DelegationGenerationReadSource;
  /** Reserved for 11c's settling intent (P11): read as settling, never guessed. */
  readonly settling?: { readonly runGeneration: number };
}

/** The record identity read metadata is validated against. */
export interface DelegationRecordIdentity {
  readonly parent: { readonly chatId: string };
  readonly state: {
    readonly delegationId: string;
    readonly runGeneration: number;
  };
}

/** Supplies a record's read metadata. Undefined selects the legacy path. */
export type DelegationReadMetadataSource = (
  record: StoredDelegation,
) => DelegationRecordReadMetadata | undefined;

/** The production default: no record is stream-backed. */
export const noDelegationReadMetadata: DelegationReadMetadataSource = () =>
  undefined;

export class DelegationReadMetadataError extends Error {
  public readonly code = 'corruption';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/**
 * Validate supplied metadata against its record. Invalid metadata fails
 * closed: it never falls back to the legacy path.
 */
export function validateDelegationRecordReadMetadata(
  record: DelegationRecordIdentity,
  value: unknown,
): DelegationRecordReadMetadata {
  const fail = (reason: string): never => {
    throw new DelegationReadMetadataError(
      `Invalid delegation read metadata: ${reason}`,
    );
  };
  if (
    !isRecord(value) ||
    !exactKeys(value, ['originAt', 'lastActivityAt', 'current'], ['settling'])
  )
    return fail('shape');
  if (!isTimestamp(value.originAt) || !isTimestamp(value.lastActivityAt))
    return fail('timestamps');
  if (value.originAt > value.lastActivityAt) return fail('timestamp order');
  const current = value.current;
  if (!isRecord(current) || !exactKeys(current, ['store', 'target']))
    return fail('current source');
  if (current.store !== 'legacy' && current.store !== 'stream')
    return fail('store');
  const target = current.target;
  if (
    !isRecord(target) ||
    !exactKeys(target, ['kind', 'chatId', 'delegationId', 'runGeneration']) ||
    target.kind !== 'delegation' ||
    target.chatId !== record.parent.chatId ||
    target.delegationId !== record.state.delegationId ||
    target.runGeneration !== record.state.runGeneration
  )
    return fail('target');
  let settling: { readonly runGeneration: number } | undefined;
  if (value.settling !== undefined) {
    const candidate = value.settling;
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ['runGeneration']) ||
      candidate.runGeneration !== record.state.runGeneration
    )
      return fail('settling');
    settling = { runGeneration: record.state.runGeneration };
  }
  return {
    originAt: value.originAt,
    lastActivityAt: value.lastActivityAt,
    current: {
      store: current.store,
      target: {
        kind: 'delegation',
        chatId: record.parent.chatId,
        delegationId: record.state.delegationId,
        runGeneration: record.state.runGeneration,
      },
    },
    ...(settling ? { settling } : {}),
  };
}

/** Read a record's metadata through a source, validating what it returns. */
export function readDelegationRecordMetadata(
  source: DelegationReadMetadataSource,
  record: StoredDelegation,
): DelegationRecordReadMetadata | undefined {
  const value = source(record);
  return value === undefined
    ? undefined
    : validateDelegationRecordReadMetadata(record, value);
}
