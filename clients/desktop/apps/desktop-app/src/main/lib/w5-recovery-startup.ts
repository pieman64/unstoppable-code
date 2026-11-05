import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isErrnoException } from './type-guards';

/** Ordinary startup pays one lstat; SQLite and native recovery UI stay cold. */
export async function runRequestedW5Recovery(
  dataRoot: string,
): Promise<boolean> {
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
