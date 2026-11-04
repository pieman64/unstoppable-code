/**
 * The main-owned attempt journal of a `send-agent-message` host step.
 *
 * Every ID the send uses (the command, the user message, a created chat's
 * tab, the steer command) is chosen and journaled before the first dispatch,
 * so a replay after a crash sends with the same IDs and the chat answers with
 * the original receipt instead of a second message. Stored at
 * `<artifactsDir>/send.json`, written atomically and durably through an
 * in-process chain per file. A record owned by another attempt's idempotency
 * key reads as `absent`; unknown versions and corrupt records read as
 * `corrupt`, which the adapter fails closed on.
 *
 * Message text, file paths, pipeline names and chat titles are user data:
 * only IDs, flags, the request fingerprint and the terminal result (its
 * outputs and error message) are stored.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { PIPELINE_HOST_FAILURE_REASONS } from '@canopy/desktop-shared/pipelines/host-actions';
import { pipelineChatSendRecordSchema } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import { writeFileAtomically } from '../lib/atomic-file';
import { isRecord } from '../lib/type-guards';
import { canonicalJson } from './host-create-worktree-state';

export const SEND_JOURNAL_FILE = 'send.json';

/**
 * - `creating`: IDs chosen before a chat creation is dispatched.
 * - `sending`: the target chat is known (given, or resolved by a creation);
 *   the message may have been sent.
 * - `steering`: the message was accepted as queued; the steer may have run.
 * - `done`: the terminal result is recorded.
 */
export const SEND_JOURNAL_PHASES = [
  'creating',
  'sending',
  'steering',
  'done',
] as const;

export type SendJournalPhase = (typeof SEND_JOURNAL_PHASES)[number];

const outputsSchema = z.record(z.string(), z.string());

/** A host result with its send record; a malformed record is never journaled. */
export const sendHostResultSchema = z.union([
  z.strictObject({
    status: z.literal('success'),
    outputs: outputsSchema,
    chatSend: pipelineChatSendRecordSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('failure'),
    failureReason: z.enum(PIPELINE_HOST_FAILURE_REASONS),
    error: z.string(),
    outputs: outputsSchema,
    chatSend: pipelineChatSendRecordSchema.optional(),
  }),
]);

const sendJournalRecordSchema = z.strictObject({
  version: z.literal(1),
  /** The attempt that owns this record; another key reads as `absent`. */
  idempotencyKey: z.string(),
  fingerprint: z.string(),
  phase: z.enum(SEND_JOURNAL_PHASES),
  ids: z.strictObject({
    commandId: z.string(),
    userMessageId: z.string(),
    /** A creation's chat: planned before dispatch, then the chat it chose. */
    tabId: z.string().optional(),
    reusedTab: z.literal(true).optional(),
    createTabCommandId: z.string().optional(),
    steerCommandId: z.string(),
  }),
  chatId: z.string().optional(),
  chatCreated: z.boolean().optional(),
  queuedMessageId: z.string().optional(),
  result: sendHostResultSchema.optional(),
});

export type SendJournalRecord = z.infer<typeof sendJournalRecordSchema>;

export type SendJournalRead =
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'present'; record: SendJournalRecord };

/**
 * The executor-raised request plus the run's owner and agent origin; key
 * order never matters. Main-side resolution (references, settings) is not in
 * it, so a referenced file that changed before a replay still replays. The
 * executor reads `text_file` into the request, so a changed `text_file` is a
 * different input.
 */
export function createSendFingerprint(parts: {
  inputs: unknown;
  owner: unknown;
  agentOrigin: unknown;
  /**
   * A converted agent automation's native grant (CAN-5479). Absent, it
   * leaves the fingerprint of every other send as it was.
   */
  nativeGrant?: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        action: 'send-agent-message',
        inputs: parts.inputs,
        owner: parts.owner,
        agentOrigin: parts.agentOrigin ?? null,
        ...(parts.nativeGrant !== undefined
          ? { nativeGrant: parts.nativeGrant }
          : {}),
      }),
    )
    .digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export async function readSendJournal(
  artifactsDir: string,
  idempotencyKey: string,
): Promise<SendJournalRead> {
  let text: string;
  try {
    text = await readFile(path.join(artifactsDir, SEND_JOURNAL_FILE), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'absent' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  const record = sendJournalRecordSchema.safeParse(parsed);
  if (!record.success) return { kind: 'corrupt' };
  // A job retry is a new attempt and sends again, even in a shared directory.
  return record.data.idempotencyKey === idempotencyKey
    ? { kind: 'present', record: record.data }
    : { kind: 'absent' };
}

let beforeSendJournalWrite: ((record: SendJournalRecord) => void) | undefined;

/** Tests: runs before each durable write, so a test can crash between a phase and its effect. */
export function setBeforeSendJournalWriteForTests(
  hook: ((record: SendJournalRecord) => void) | undefined,
): void {
  beforeSendJournalWrite = hook;
}

const writeChains = new Map<string, Promise<void>>();

/**
 * Writes the whole record atomically, serialized per file in this process.
 * Resolves once the record is on disk; a failed write rejects. A record that
 * fails the schema (a malformed send record) is refused before any write.
 */
export function writeSendJournal(
  artifactsDir: string,
  record: SendJournalRecord,
): Promise<void> {
  const filePath = path.join(artifactsDir, SEND_JOURNAL_FILE);
  const checked = sendJournalRecordSchema.safeParse(record);
  if (!checked.success) {
    return Promise.reject(
      new Error('send-agent-message journal record is invalid'),
    );
  }
  const snapshot = structuredClone(checked.data);
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      beforeSendJournalWrite?.(snapshot);
      await mkdir(artifactsDir, { recursive: true });
      // Durable: each phase must survive a crash before its effect runs.
      await writeFileAtomically(
        filePath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { encoding: 'utf8', durable: true },
      );
    });
  writeChains.set(filePath, next);
  void next
    .finally(() => {
      if (writeChains.get(filePath) === next) writeChains.delete(filePath);
    })
    .catch(() => undefined);
  return next;
}
