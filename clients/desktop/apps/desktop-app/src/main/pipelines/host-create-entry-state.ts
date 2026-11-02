/**
 * The main-owned attempt journal of a `create-project-entry` or
 * `create-bot-entry` host step.
 *
 * The task ID is chosen and journaled before creation is dispatched, so a
 * replay after a crash can tell whether the task exists and return the same
 * result instead of creating a second one. Stored at
 * `<artifactsDir>/attempt.json`, written atomically and durably through an
 * in-process chain per file. A record owned by another attempt's idempotency
 * key reads as `absent`; unknown versions and corrupt records read as
 * `corrupt`, which the adapter fails closed on.
 *
 * Titles and group names are user text: only the request fingerprint and
 * the group outputs (IDs and flags) are stored.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../lib/atomic-file';
import { isRecord } from '../lib/type-guards';
import { canonicalJson, hostResultSchema } from './host-create-worktree-state';

export const ENTRY_ATTEMPT_JOURNAL_FILE = 'attempt.json';

/**
 * - `creating`: written with the chosen task ID before dispatch; dispatch
 *   may have started.
 * - `created`: the task and its founding chat exist; never dispatched again.
 * - `finalized`: the terminal result is recorded.
 */
export const ENTRY_ATTEMPT_PHASES = [
  'creating',
  'created',
  'finalized',
] as const;

export type EntryAttemptPhase = (typeof ENTRY_ATTEMPT_PHASES)[number];

const entryAttemptRecordSchema = z.object({
  version: z.literal(1),
  /** The attempt that owns this record; another key reads as `absent`. */
  idempotencyKey: z.string(),
  fingerprint: z.string(),
  phase: z.enum(ENTRY_ATTEMPT_PHASES),
  taskId: z.string(),
  chatId: z.string().optional(),
  /** The group outputs, once assignment ran; never assigned again on replay. */
  group: z.record(z.string(), z.string()).optional(),
  result: hostResultSchema.optional(),
});

export type EntryAttemptRecord = z.infer<typeof entryAttemptRecordSchema>;

export type EntryAttemptRead =
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'present'; record: EntryAttemptRecord };

/** The request's action and canonical inputs; key order never matters. */
export function createEntryFingerprint(request: {
  action: string;
  inputs: unknown;
}): string {
  return createHash('sha256')
    .update(canonicalJson({ action: request.action, inputs: request.inputs }))
    .digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export async function readEntryAttempt(
  artifactsDir: string,
  idempotencyKey: string,
): Promise<EntryAttemptRead> {
  let text: string;
  try {
    text = await readFile(
      path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE),
      'utf8',
    );
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
  const record = entryAttemptRecordSchema.safeParse(parsed);
  if (!record.success) return { kind: 'corrupt' };
  // A job retry is a new attempt and acts again, even in a shared directory.
  return record.data.idempotencyKey === idempotencyKey
    ? { kind: 'present', record: record.data }
    : { kind: 'absent' };
}

const writeChains = new Map<string, Promise<void>>();

/**
 * Writes the whole record atomically, serialized per file in this process.
 * Resolves once the record is on disk; a failed write rejects.
 */
export function writeEntryAttempt(
  artifactsDir: string,
  record: EntryAttemptRecord,
): Promise<void> {
  const filePath = path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE);
  const snapshot = structuredClone(record);
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
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
