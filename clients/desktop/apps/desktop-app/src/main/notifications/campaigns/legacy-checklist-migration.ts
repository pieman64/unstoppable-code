import { open, type FileHandle } from 'node:fs/promises';
import type { ActivationSignalName } from '@canopy/desktop-shared/types';
import { getLegacyOnboardingChecklistFilePath } from '../../lib/paths';
import {
  mergeLegacyChecklistSignals,
  readActivationJourneyState,
} from './journey-state';

const MAX_LEGACY_BYTES = 64 * 1024;
const LEGACY_SIGNALS = {
  'start-chat': 'first-task-submitted',
  'connect-accounts': 'tool-connected',
  'add-capability': 'capability-installed',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readLegacySignals(): Promise<
  Partial<Record<ActivationSignalName, string>>
> {
  let handle: FileHandle;
  try {
    handle = await open(getLegacyOnboardingChecklistFilePath(), 'r');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_LEGACY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_LEGACY_BYTES)
      throw new Error('Legacy checklist exceeds migration limit.');
    const value: unknown = JSON.parse(
      buffer.subarray(0, length).toString('utf8'),
    );
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.completedItems)
    ) {
      throw new Error('Invalid or unsupported legacy checklist.');
    }
    const signals: Partial<Record<ActivationSignalName, string>> = {};
    for (const [item, signal] of Object.entries(LEGACY_SIGNALS)) {
      const stamp = value.completedItems[item];
      if (typeof stamp !== 'string' || stamp.trim() === '') continue;
      const time = Date.parse(stamp);
      if (Number.isFinite(time)) signals[signal] = new Date(time).toISOString();
    }
    return signals;
  } finally {
    await handle.close();
  }
}

let migration: Promise<void> | null = null;

/** Lazy and read-only. Rejections stay retryable through the existing campaign lifecycle. */
export async function migrateLegacyChecklistSignals(): Promise<void> {
  if (
    (await readActivationJourneyState()).legacyChecklistMigrationVersion === 1
  )
    return;
  migration ??= readLegacySignals()
    .then((signals) => mergeLegacyChecklistSignals(signals))
    .then(() => undefined)
    .finally(() => {
      migration = null;
    });
  await migration;
}
