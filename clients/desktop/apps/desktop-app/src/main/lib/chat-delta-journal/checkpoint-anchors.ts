/**
 * Checkpoint-local durable copies of active sidecar anchors.
 *
 * These captures belong to the checkpoint protocol, not to format-3 effects:
 * they let a rewrite resume after `ChatTranscriptLog.replace` has removed the
 * old sidecar but before its mutable suffix has been written.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DeltaJournalCommitRecord,
  DeltaJournalTranscriptEffect,
} from './format';

/** A capture names its record by revision span, in either journal version. */
type CapturedRecord = Pick<
  DeltaJournalCommitRecord,
  'fromRevision' | 'toRevision'
>;
import {
  decodeActiveRowAnchors,
  encodeActiveRowAnchors,
  type ActiveRowAnchor,
} from '../chat-transcript-live-positions';
import { ChatDeltaJournalIntegrityError } from './format';
import { isErrnoException, isRecord } from '../type-guards';

export interface CheckpointAnchorCaptureIdentity {
  checkpointFromRevision: number;
  checkpointTargetRevision: number;
  record: CapturedRecord;
  effectIndex: number;
  effect: DeltaJournalTranscriptEffect;
}

function captureStem(
  record: CapturedRecord,
  effectIndex: number,
  chatId: string,
): string {
  return createHash('sha256')
    .update(
      `${record.fromRevision}:${record.toRevision}:${effectIndex}:${chatId}`,
    )
    .digest('hex');
}

export function checkpointAnchorCapturePath(
  workDirectory: string,
  record: CapturedRecord,
  effectIndex: number,
  chatId: string,
): string {
  return join(
    workDirectory,
    `${captureStem(record, effectIndex, chatId)}.anchors.json`,
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

function matchesIdentity(
  value: unknown,
  identity: CheckpointAnchorCaptureIdentity,
): value is Record<string, unknown> {
  return (
    isExactRecord(value, [
      'v',
      'checkpointFromRevision',
      'checkpointTargetRevision',
      'recordFromRevision',
      'recordToRevision',
      'effectIndex',
      'chatId',
      'anchors',
    ]) &&
    value.v === 1 &&
    value.checkpointFromRevision === identity.checkpointFromRevision &&
    value.checkpointTargetRevision === identity.checkpointTargetRevision &&
    value.recordFromRevision === identity.record.fromRevision &&
    value.recordToRevision === identity.record.toRevision &&
    value.effectIndex === identity.effectIndex &&
    value.chatId === identity.effect.chatId
  );
}

export function encodeCheckpointAnchorCapture(
  identity: CheckpointAnchorCaptureIdentity,
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): {
  v: 1;
  checkpointFromRevision: number;
  checkpointTargetRevision: number;
  recordFromRevision: number;
  recordToRevision: number;
  effectIndex: number;
  chatId: string;
  anchors: [string, ActiveRowAnchor][];
} {
  return {
    v: 1,
    checkpointFromRevision: identity.checkpointFromRevision,
    checkpointTargetRevision: identity.checkpointTargetRevision,
    recordFromRevision: identity.record.fromRevision,
    recordToRevision: identity.record.toRevision,
    effectIndex: identity.effectIndex,
    chatId: identity.effect.chatId,
    anchors: encodeActiveRowAnchors(anchors),
  };
}

/**
 * Read a capture if a checkpoint already made one durable. Missing is safe:
 * the checkpoint writes the capture before the rewrite, so the sidecar is
 * still authoritative when no capture exists yet.
 */
export async function readCheckpointAnchorCapture(
  workDirectory: string,
  identity: CheckpointAnchorCaptureIdentity,
): Promise<Map<string, ActiveRowAnchor> | undefined> {
  const path = checkpointAnchorCapturePath(
    workDirectory,
    identity.record,
    identity.effectIndex,
    identity.effect.chatId,
  );
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ChatDeltaJournalIntegrityError(
      'Checkpoint active-anchor capture is not valid JSON',
      { cause: error },
    );
  }
  if (!matchesIdentity(value, identity))
    throw new ChatDeltaJournalIntegrityError(
      'Checkpoint active-anchor capture does not match its transcript rewrite',
    );
  const decoded = decodeActiveRowAnchors(value.anchors);
  if (decoded.status !== 'valid')
    throw new ChatDeltaJournalIntegrityError(
      `Checkpoint active-anchor capture is invalid: ${decoded.reason}`,
    );
  return decoded.anchors;
}
