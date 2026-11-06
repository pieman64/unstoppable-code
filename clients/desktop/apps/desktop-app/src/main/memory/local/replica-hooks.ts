import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEMORY_SYNC_LIMITS,
  MEMORY_SYNC_STATE_FILENAME,
} from '@canopy/protocol/memory-sync';
import { isNodeError } from './memory-files';

/*
 * How local note writes reach the memory sync outbox. The sync engine
 * installs these hooks; without them (every build until sync is on, and every
 * device-local scope) a note write is only a file write. They run inside the
 * writer's scope lock, before the file changes, so the queued operation and
 * the file can never disagree after a crash (design §10.2, §10.3).
 */

export interface LocalMemoryNoteOrigin {
  projectId?: string;
  organizationId?: string;
}

export type LocalMemoryNoteChange =
  /** A new note: `content` is the file about to be written. */
  | { kind: 'put'; fileKey: string; content: string }
  /** An edited note: `content` replaces `previousContent` at `fileKey`. */
  | {
      kind: 'replace';
      fileKey: string;
      previousContent: string;
      content: string;
    }
  /** A deleted note: `content` is the file about to be removed. */
  | { kind: 'tombstone'; fileKey: string; content: string };

/**
 * A writer found its folder no longer a synced replica (its account signed
 * out or sync turned off) after it decided to queue a change there, so it
 * writes nothing rather than a change the outbox never sends.
 */
export class LocalMemoryReplicaUnavailableError extends Error {
  constructor() {
    super('Memory changed since you opened it. Refresh and try again.');
    this.name = 'LocalMemoryReplicaUnavailableError';
  }
}

/** Why sync cannot carry a note as edited. */
export type LocalMemoryNoteUnsyncableReason = 'too_large' | 'empty' | 'invalid';

const UNSYNCABLE_NOTE_MESSAGES: Record<
  LocalMemoryNoteUnsyncableReason,
  string
> = {
  too_large: `This note is too large to sync. Shorten it to ${MEMORY_SYNC_LIMITS.noteBodyMaxBytes / 1024} KiB or less and try again.`,
  empty: "This note can't sync without any text. Add text, or delete the note.",
  invalid: "This note can't sync as edited. Change it and try again.",
};

/**
 * An edit of a synced note that sync cannot carry, refused before anything
 * changes: accepting it would leave the edit on this device and the note it
 * replaced in the cloud.
 */
export class LocalMemoryNoteUnsyncableError extends Error {
  constructor(readonly reason: LocalMemoryNoteUnsyncableReason) {
    super(UNSYNCABLE_NOTE_MESSAGES[reason]);
    this.name = 'LocalMemoryNoteUnsyncableError';
  }
}

export interface LocalMemoryReplicaHooks {
  /**
   * Front matter a note saved into `scopeDir` carries (its device), or null
   * when the folder is not a synced replica.
   */
  noteFields(scopeDir: string): Readonly<Record<string, string>> | null;
  /**
   * The account whose synced replica `scopeDir` is now, or null when the
   * folder is not one (signed out, sync off or never a replica).
   */
  replicaAccountId(scopeDir: string): string | null;
  /**
   * Queues the change; the caller holds the scope's write lock. Rejects with
   * {@link LocalMemoryReplicaUnavailableError} when `scopeDir` is no longer
   * a synced replica, and with {@link LocalMemoryNoteUnsyncableError}, before
   * writing anything, for an edit of a synced note that sync cannot carry.
   */
  queueNoteChange(
    scopeDir: string,
    change: LocalMemoryNoteChange,
  ): Promise<void>;
  /**
   * Finishes the deletes and edits a crash or failure cut short in
   * `scopeDir`; the caller holds the scope's write lock, and calls it before
   * reading a note it changes, so no change builds on a note whose last
   * change is not on disk yet.
   */
  settleNoteChanges(scopeDir: string): Promise<void>;
  /** Drops a queued new note whose file could not be written. */
  dropNoteChange(scopeDir: string, noteId: string): Promise<void>;
  /** After the write and its lock: the engine pushes soon. */
  noteChanged(scopeDir: string): void;
}

let hooks: LocalMemoryReplicaHooks | null = null;

export function setLocalMemoryReplicaHooks(
  next: LocalMemoryReplicaHooks | null,
): void {
  hooks = next;
}

export function localMemoryReplicaHooks(): LocalMemoryReplicaHooks | null {
  return hooks;
}

/**
 * Whether `scopeDir` is an account replica: one the sync engine keeps in step
 * now, or one with a sync state while no engine runs for its account (signed
 * out, another account signed in, sync off). Only cloud commits change a
 * replica's documents, so a caller that resolved the folder earlier never
 * consolidates it locally once its engine has stopped.
 */
export async function isSyncedMemoryReplica(
  scopeDir: string,
): Promise<boolean> {
  if (hooks?.noteFields(scopeDir) != null) return true;
  try {
    await lstat(join(scopeDir, MEMORY_SYNC_STATE_FILENAME));
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}
