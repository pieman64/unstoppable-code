import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from '../lib/atomic-file';
import { getCopilotRotationAttemptPath } from '../lib/paths';

interface RotationAttempt {
  attemptId: string;
  bootId: string;
  accountEpoch: { host: string; id: string; entryId: string };
  fromDigest: string;
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const operation = queue.then(run, run);
  queue = operation.catch(() => undefined);
  return operation;
}

/** Diagnostic only: no recovery decision may depend on this record. */
export function writeCopilotRotationAttempt(
  attempt: RotationAttempt,
): Promise<void> {
  return serialized(async () => {
    const path = getCopilotRotationAttemptPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomically(
      path,
      JSON.stringify({
        version: 1,
        attemptId: attempt.attemptId,
        bootId: attempt.bootId,
        accountEpoch: {
          host: attempt.accountEpoch.host,
          id: attempt.accountEpoch.id,
          entryId: attempt.accountEpoch.entryId,
        },
        fromDigest: attempt.fromDigest,
      }),
      {
        mode: 0o600,
        durable: true,
      },
    );
  });
}

export function removeCopilotRotationAttempt(attemptId: string): Promise<void> {
  return serialized(async () => {
    // Never let an old epoch's completion remove a newer attempt's record.
    const path = getCopilotRotationAttemptPath();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      'attemptId' in value &&
      value.attemptId === attemptId
    )
      await rm(path, { force: true });
  });
}

export async function probeCopilotRotationAttempt(): Promise<
  'present' | 'absent' | 'unreadable'
> {
  try {
    const value: unknown = JSON.parse(
      await readFile(getCopilotRotationAttemptPath(), 'utf8'),
    );
    return value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1
      ? 'present'
      : 'unreadable';
  } catch (error) {
    return error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
      ? 'absent'
      : 'unreadable';
  }
}
