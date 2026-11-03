import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import { canopyDaemonRefusalError } from '@canopy/core-client/node';
import { W5CommitLogError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  isW5CommitLogHostShutDown,
  runningW5CommitLogWorkers,
  shutdownW5CommitLogHost,
} from '../w5-commit-log/commit-log-host';
import { writeFileAtomically } from './atomic-file';
import { getW5FlipBackupMarkerPath } from './paths';
import { isErrnoException, isRecord } from './type-guards';
import {
  captureW5Backup,
  desktopW5BackupContext,
  requireVerifiedW5Backup,
  W5BackupRefusedError,
  type W5BackupContext,
} from './w5-backup';
import type { W5HandoffFailure } from './w5-handoff-store';

/*
 * TRANSITIONAL (CAN-5543, GB12): the flip launch's pre-spawn step. It runs
 * under the startup claim on every spawn of a flip build, so a launch that
 * skipped releases still walks backup, in-process shutdown, then spawn; only
 * the backup is once per data root, recorded by the marker. Remove at W15.
 */

/** `<data>/w5/flip-backup.json`. A support artifact, never a restore point. */
export type W5FlipBackupMarker =
  | {
      readonly version: 1;
      readonly state: 'captured';
      /** `w5/backups/<id>`, or `empty-root` for a root with nothing to keep. */
      readonly backup: string;
      readonly commitId: number;
      readonly capturedAt: string;
      readonly buildVersion: string;
      /** `captured-after-flip`: a daemon may have committed first (Q1(a)). */
      readonly capture: 'before-flip' | 'captured-after-flip';
    }
  | {
      /** A daemon already served W5 here before this build could capture. */
      readonly version: 1;
      readonly state: 'deferred';
      readonly deferredAt: string;
      readonly buildVersion: string;
    };

const BACKUP_PATH = /^w5\/backups\/[a-z0-9-]+$/;

function isMarker(value: unknown): value is W5FlipBackupMarker {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.buildVersion !== 'string') return false;
  if (value.state === 'deferred') return typeof value.deferredAt === 'string';
  return (
    value.state === 'captured' &&
    typeof value.backup === 'string' &&
    (value.backup === 'empty-root' || BACKUP_PATH.test(value.backup)) &&
    typeof value.commitId === 'number' &&
    Number.isSafeInteger(value.commitId) &&
    value.commitId >= 0 &&
    typeof value.capturedAt === 'string' &&
    (value.capture === 'before-flip' || value.capture === 'captured-after-flip')
  );
}

/**
 * `null` when absent. An unreadable or invalid marker reads as deferred: its
 * history is unknown, so the next capture is labeled after the flip.
 */
export async function readW5FlipBackupMarker(): Promise<W5FlipBackupMarker | null> {
  let raw: string;
  try {
    raw = await readFile(getW5FlipBackupMarkerPath(), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    return unknownHistory();
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isMarker(value) ? value : unknownHistory();
  } catch {
    return unknownHistory();
  }
}

function unknownHistory(): W5FlipBackupMarker {
  return {
    version: 1,
    state: 'deferred',
    deferredAt: new Date(0).toISOString(),
    buildVersion: 'unknown',
  };
}

// `<data>/w5` exists by now: the capture or the daemon's commit log made it.
async function writeMarker(marker: W5FlipBackupMarker): Promise<void> {
  await writeFileAtomically(
    getW5FlipBackupMarkerPath(),
    `${JSON.stringify(marker, null, 2)}\n`,
    { durable: true, mode: 0o600 },
  );
}

/** Failures the step reports through the launch, in `details.w5Handoff`. */
const STEP_FAILURES = [
  'backup_refused',
  'in_process_host_running',
] as const satisfies readonly W5HandoffFailure[];
type StepFailure = (typeof STEP_FAILURES)[number];

function stepError(
  failure: StepFailure,
  message: string,
  detail?: string,
): CanopyClientError {
  return new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
    details: { w5Handoff: failure, ...(detail !== undefined && { detail }) },
  });
}

/** The step failure a launch error carries, or `null`. */
export function w5FlipStepFailure(
  error: unknown,
): { readonly failure: StepFailure; readonly detail?: string } | null {
  const { details } = toCanopyClientError(error).payload;
  if (!isRecord(details)) return null;
  const failure = STEP_FAILURES.find((f) => f === details.w5Handoff);
  if (!failure) return null;
  return typeof details.detail === 'string'
    ? { failure, detail: details.detail }
    : { failure };
}

/** A fresh root: no index, no index backup, no workspace folder, no commit. */
async function isEmptyRoot(context: W5BackupContext): Promise<boolean> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(join(context.dataRoot, 'workspaces'), {
      withFileTypes: true,
    });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') return false;
  }
  if (
    entries.some(
      (entry) =>
        entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name === 'index.json.bak',
    )
  )
    return false;
  return (await context.host.snapshot()).commitId === 0;
}

const writerHeld = (error: unknown): boolean =>
  error instanceof W5CommitLogError && error.code === 'WRITER_UNAVAILABLE';

/** A daemon serving W5 was found or attached in this process. */
let daemonServedHere = false;
/** The pre-spawn step completed in this process. */
let spawnPrepared = false;

async function captureOnce(
  previous: W5FlipBackupMarker | null,
  buildVersion: string,
): Promise<void> {
  let backup: string;
  let commitId: number;
  try {
    const context = await desktopW5BackupContext();
    try {
      backup = await captureW5Backup(context);
      commitId = (await requireVerifiedW5Backup(context, backup, 0)).position
        .commitId;
    } catch (error) {
      if (
        !(error instanceof W5BackupRefusedError) ||
        error.reason !== 'missing-source' ||
        error.resource !== 'index.json' ||
        !(await isEmptyRoot(context))
      )
        throw error;
      backup = 'empty-root';
      commitId = 0;
    }
  } catch (error) {
    // Another writer holds the log, so a daemon spawned now could not open
    // it either. A later launch captures, labeled after the flip (Q1(a)).
    if (writerHeld(error)) {
      if (previous === null) await deferMarker(buildVersion).catch(() => {});
      throw canopyDaemonRefusalError(
        'writer_held',
        'Another app holds the workspace records.',
      );
    }
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      error instanceof W5BackupRefusedError ? error.reason : 'host-unavailable',
    );
  }
  // Written last: a launch that stops earlier captures again.
  try {
    await writeMarker({
      version: 1,
      state: 'captured',
      backup,
      commitId,
      capturedAt: new Date().toISOString(),
      buildVersion,
      capture:
        previous?.state === 'deferred' || daemonServedHere
          ? 'captured-after-flip'
          : 'before-flip',
    });
  } catch {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'marker-unwritable',
    );
  }
}

/**
 * The launcher's pre-spawn step: the verified backup once per data root, then
 * the in-process commit log stops for good, so the daemon can open it.
 */
export async function prepareW5FlipSpawn(buildVersion: string): Promise<void> {
  const marker = await readW5FlipBackupMarker();
  if (marker?.state !== 'captured') {
    if (!isW5CommitLogHostShutDown()) await captureOnce(marker, buildVersion);
    // A respawn after this process stopped its log, as after a daemon crash,
    // cannot capture; it proceeds only where a daemon already served W5, and
    // the next launch captures.
    else if (!daemonServedHere)
      throw stepError(
        'backup_refused',
        'The workspace records backup failed.',
        'host-stopped',
      );
  }
  await stopInProcessW5Host();
  spawnPrepared = true;
}

/**
 * Windows has no startup claim to run the step before a spawn, so every
 * launch there waits until the handoff ran it or found a daemon serving W5;
 * otherwise a later caller could start a W5 daemon with no backup.
 */
export function requireW5FlipSpawnPrepared(): void {
  if (!spawnPrepared && !daemonServedHere)
    throw stepError(
      'backup_refused',
      'The workspace records backup has not run.',
      'spawn-unprepared',
    );
}

/** Fences in-process W5 use; refuses while a worker may still hold the log. */
export async function stopInProcessW5Host(): Promise<void> {
  await shutdownW5CommitLogHost();
  if (runningW5CommitLogWorkers() !== 0)
    throw stepError(
      'in_process_host_running',
      'The in-app workspace records host did not stop.',
    );
}

function deferMarker(buildVersion: string): Promise<void> {
  return writeMarker({
    version: 1,
    state: 'deferred',
    deferredAt: new Date().toISOString(),
    buildVersion,
  });
}

/**
 * A daemon serves W5 here and holds the log, so nothing can be captured now.
 * Records that, so a later capture says it came after the flip.
 */
export async function deferW5FlipBackup(buildVersion: string): Promise<void> {
  daemonServedHere = true;
  if ((await readW5FlipBackupMarker()) !== null) return;
  await deferMarker(buildVersion);
}
