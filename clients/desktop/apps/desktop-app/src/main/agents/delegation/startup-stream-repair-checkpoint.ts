import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '../../lib/paths';
import { writeFileAtomically } from '../../lib/atomic-file';

// A full successful pass covers everything observed before it began. Keep a
// margin for filesystem timestamp granularity and writes concurrent with reads.
const CHECKPOINT_SAFETY_MARGIN_MS = 60_000;
const CHECKPOINT_MAX_BYTES = 256;

function checkpointPath(): string {
  return join(getDataDir(), 'delegation-startup-stream-repair.json');
}

/** Unusable checkpoints force a full audit; observing never creates anything. */
export async function readStartupStreamRepairCutoff(
  now: number,
): Promise<number | undefined> {
  try {
    const file = await open(
      checkpointPath(),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > CHECKPOINT_MAX_BYTES ||
        info.nlink !== 1
      )
        return undefined;
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        value.version !== 1 ||
        !('cutoff' in value) ||
        typeof value.cutoff !== 'number' ||
        !Number.isSafeInteger(value.cutoff) ||
        value.cutoff < 0 ||
        value.cutoff > now ||
        Object.keys(value).length !== 2
      )
        return undefined;
      return value.cutoff;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Called only after every scope completed; failures must retain the old file. */
export function writeStartupStreamRepairCheckpoint(
  passStartedAt: number,
): Promise<void> {
  if (!Number.isSafeInteger(passStartedAt) || passStartedAt < 0)
    return Promise.reject(new Error('Invalid stream repair checkpoint time'));
  return writeFileAtomically(
    checkpointPath(),
    JSON.stringify({
      version: 1,
      cutoff: Math.max(0, passStartedAt - CHECKPOINT_SAFETY_MARGIN_MS),
    }),
    { encoding: 'utf8', mode: 0o600, durable: true },
  );
}

interface StreamRepairAuditRecord {
  readonly state: { readonly delegationId: string };
  readonly readMetadata: { readonly lastActivityAt: number };
}

/**
 * Record-local repair flags bypass this audit gate in the broker. A restored
 * or imported old record has a new file mtime even when its activity is old.
 */
export async function shouldAuditTerminalStreamRecord(
  record: StreamRepairAuditRecord,
  directory: string,
  cutoff: number | undefined,
): Promise<boolean> {
  if (cutoff === undefined || record.readMetadata.lastActivityAt >= cutoff)
    return true;
  try {
    const info = await stat(
      join(directory, `${record.state.delegationId}.json`),
    );
    return (
      !info.isFile() || !Number.isFinite(info.mtimeMs) || info.mtimeMs >= cutoff
    );
  } catch {
    // Missing/unreadable metadata is never evidence of convergence.
    return true;
  }
}
