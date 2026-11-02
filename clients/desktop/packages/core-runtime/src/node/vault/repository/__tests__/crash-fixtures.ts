import { open } from 'node:fs/promises';

import type { PlatformOperatingSystem } from '../../../../platform/platform-services';
import type {
  VaultDeleteRequest,
  VaultPutRequest,
} from '../../../../vault/contracts';
import { FAMILY } from './read-repository-fixtures';
import {
  recordingSecureFiles,
  type RecordingSecureFiles,
} from './store-fixtures';

/* Shared by `crash.test.ts` and the child it kills and restarts. */

export const CRASH_WRITES = ['create', 'replace', 'delete'] as const;
export type VaultCrashWrite = (typeof CRASH_WRITES)[number];

/** Where the child dies, in write order. */
export const CRASH_STAGES = [
  /** Inside the intent's transaction, before its COMMIT. */
  'before-intent',
  /** At the hold point: the intent is durable, the commit not started. */
  'after-intent',
  /** Inside the entry or tombstone transaction, before its COMMIT. */
  'in-commit',
  /** Right after that COMMIT, before the caller sees the outcome. */
  'after-commit',
  /** After the caller saw the outcome and the child reported it. */
  'reported',
] as const;
export type VaultCrashStage = (typeof CRASH_STAGES)[number];

export const CRASH_SCENARIOS = [
  ...CRASH_WRITES,
  /** #7065 known limits 1 and 2: a lost delete intent whose rewrite fails. */
  'lost-delete-intent',
  /** #7065 known limit 3: a delete after an uncertain tombstone landed. */
  'uncertain-tombstone',
  /** A put and a delete reported `superseded`, before their deletes commit. */
  'superseded',
  /** A put and a delete whose uncertain commits `reconcile` promoted. */
  'reconciled',
] as const;
export type VaultCrashScenario = (typeof CRASH_SCENARIOS)[number];

/** The key slot a restart finds. `wrong_key` holds another key's bytes. */
export const CRASH_SLOTS = [
  'present',
  'locked',
  'missing',
  'corrupt',
  'wrong_key',
] as const;
export type VaultCrashSlot = (typeof CRASH_SLOTS)[number];

const host = process.platform;

/**
 * The real platform, so macOS runs `fullfsync`, Linux does not, and Windows
 * flushes folders read-write.
 */
export const CRASH_OS: PlatformOperatingSystem =
  host === 'darwin' || host === 'win32' ? host : 'linux';

/**
 * What a Windows folder flush, and so a Windows crash restart, proves (CAN-5151
 * D1). Copies `@canopy/core-platform`'s `WINDOWS_DIRECTORY_FLUSH_LABEL`,
 * which core-runtime may not import; tests in both packages check it against
 * the `secureFiles.syncDirectory` contract.
 */
export const WINDOWS_FLUSH_LABEL =
  'API-level flush; namespace ordering undocumented; power-loss unverified';

type FlushFlags = 'r' | 'r+';

/** The shipped flush's open flags: Windows refuses a read-only flush. */
export function folderFlushFlags(os: PlatformOperatingSystem): FlushFlags {
  return os === 'win32' ? 'r+' : 'r';
}

/** One folder sync; `refused` is `<stage>:<code>` when it rejected. */
export interface VaultFolderFlush {
  readonly path: string;
  readonly flags: FlushFlags;
  readonly refused: string | null;
}

export interface FlushingSecureFiles extends RecordingSecureFiles {
  readonly flushes: VaultFolderFlush[];
}

function errnoCode(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

/**
 * `recordingSecureFiles` whose folder syncs really flush, as core-platform's
 * `syncDirectory` does: open with `flags`, `sync`, close, and reject on any
 * failure. `synced` lists only the folders that flushed.
 */
export function flushingSecureFiles(
  flags: (path: string) => FlushFlags = () => folderFlushFlags(CRASH_OS),
): FlushingSecureFiles {
  const files = recordingSecureFiles();
  const flushes: VaultFolderFlush[] = [];
  return {
    ...files,
    flushes,
    syncDirectory: async (path): Promise<'flushed'> => {
      const opened = flags(path);
      let stage = 'open';
      try {
        const handle = await open(path, opened);
        stage = 'flush';
        try {
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
        stage = 'close';
        await handle.close();
      } catch (error) {
        flushes.push({
          path,
          flags: opened,
          refused: `${stage}:${errnoCode(error)}`,
        });
        throw error;
      }
      flushes.push({ path, flags: opened, refused: null });
      files.synced.push(path);
      return 'flushed';
    },
  };
}

export const CREATED_SECRET = 's3cr3t';
export const ROTATED_SECRET = 'r0tated';

/** A write, as plain data both processes can rebuild the request from. */
export type VaultWriteSpec =
  | { readonly kind: 'create'; readonly key: string }
  | {
      readonly kind: 'replace' | 'delete';
      readonly entryId: string;
      readonly revision: number;
      readonly key: string;
    };

export function createWrite(key = 'create'): VaultWriteSpec {
  return { kind: 'create', key };
}

export function replaceWrite(
  entryId: string,
  revision: number,
  key = 'replace',
): VaultWriteSpec {
  return { kind: 'replace', entryId, revision, key };
}

export function deleteWrite(
  entryId: string,
  revision: number,
  key = 'delete',
): VaultWriteSpec {
  return { kind: 'delete', entryId, revision, key };
}

const encoder = new TextEncoder();

export type VaultWriteRequest =
  | { readonly kind: 'put'; readonly request: VaultPutRequest }
  | { readonly kind: 'delete'; readonly request: VaultDeleteRequest };

export function writeRequest(
  spec: VaultWriteSpec,
  vaultId: string,
): VaultWriteRequest {
  const idempotencyKey = spec.key;
  if (spec.kind === 'create')
    return {
      kind: 'put',
      request: {
        entryId: null,
        expectedRevision: null,
        family: FAMILY,
        label: 'Token',
        material: encoder.encode(CREATED_SECRET),
        expiresAt: null,
        idempotencyKey,
      },
    };
  const ref = { vaultId, entryId: spec.entryId };
  if (spec.kind === 'delete')
    return {
      kind: 'delete',
      request: { ref, expectedRevision: spec.revision, idempotencyKey },
    };
  return {
    kind: 'put',
    request: {
      ref,
      expectedRevision: spec.revision,
      label: 'Rotated',
      material: encoder.encode(ROTATED_SECRET),
      expiresAt: null,
      idempotencyKey,
    },
  };
}

/** A report line: an outcome the child's caller saw before it died. */
export interface VaultCrashReport {
  readonly write: VaultWriteSpec;
  readonly outcome: unknown;
}

/** Inside a COMMIT, after one, at a hold point, or once the scenario ended. */
export type VaultDeathPoint = 'sync' | 'committed' | 'hold' | 'end';

/**
 * The report's last line: where the child died, and the crashed write's
 * intent as the child's own connection saw it then, uncommitted rows
 * included.
 */
export interface VaultCrashDeath {
  readonly died: VaultDeathPoint;
  readonly intent: 'pending' | 'committed' | null;
}

/** A call the test makes on a restarted vault. */
export type VaultSessionCall =
  | {
      readonly op: 'status' | 'list' | 'unlock' | 'slot' | 'prompts' | 'close';
    }
  | { readonly op: 'get'; readonly entryId: string }
  | {
      readonly op: 'admit';
      readonly entryId: string;
      readonly revision: number;
    }
  | { readonly op: 'write'; readonly write: VaultWriteSpec };

export interface VaultSessionRequest {
  readonly id: number;
  readonly call: VaultSessionCall;
}

export type VaultSessionReply =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string };

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCrashScenario(value: unknown): value is VaultCrashScenario {
  return oneOf(CRASH_SCENARIOS, value);
}

export function isCrashStage(value: unknown): value is VaultCrashStage {
  return oneOf(CRASH_STAGES, value);
}

export function isCrashSlot(value: unknown): value is VaultCrashSlot {
  return oneOf(CRASH_SLOTS, value);
}

export function isWriteSpec(value: unknown): value is VaultWriteSpec {
  if (!isRecord(value) || typeof value.key !== 'string') return false;
  if (value.kind === 'create') return true;
  return (
    (value.kind === 'replace' || value.kind === 'delete') &&
    typeof value.entryId === 'string' &&
    typeof value.revision === 'number'
  );
}

export function isCrashReport(value: unknown): value is VaultCrashReport {
  return isRecord(value) && isWriteSpec(value.write) && 'outcome' in value;
}

export function isCrashDeath(value: unknown): value is VaultCrashDeath {
  return (
    isRecord(value) &&
    oneOf(['sync', 'committed', 'hold', 'end'], value.died) &&
    (value.intent === null || oneOf(['pending', 'committed'], value.intent))
  );
}

function isSessionCall(value: unknown): value is VaultSessionCall {
  if (!isRecord(value)) return false;
  switch (value.op) {
    case 'status':
    case 'list':
    case 'unlock':
    case 'slot':
    case 'prompts':
    case 'close':
      return true;
    case 'get':
      return typeof value.entryId === 'string';
    case 'admit':
      return (
        typeof value.entryId === 'string' && typeof value.revision === 'number'
      );
    case 'write':
      return isWriteSpec(value.write);
    default:
      return false;
  }
}

export function isSessionRequest(value: unknown): value is VaultSessionRequest {
  return (
    isRecord(value) && typeof value.id === 'number' && isSessionCall(value.call)
  );
}

export function isSessionReply(value: unknown): value is VaultSessionReply {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    ('result' in value || typeof value.error === 'string')
  );
}
