import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isErrnoException } from './type-guards';
import { admitDesktopDeletionPresence } from './w5-host-admission';

/** Presence precedes recovery; ordinary startup keeps the native recovery UI cold. */
export async function runRequestedW5Recovery(
  dataRoot: string,
): Promise<boolean> {
  await admitDesktopDeletionPresence(dataRoot);
  try {
    await lstat(join(dataRoot, 'runtime/w5-recovery-request.json'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return true;
    // A request may exist but be unreadable. The recovery host diagnoses that.
  }
  try {
    const { runDesktopW5RecoveryLaunch } =
      await import('./w5-recovery-desktop');
    return await runDesktopW5RecoveryLaunch(dataRoot);
  } catch {
    return false;
  }
}
