import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  writeFileAtomically,
  type AtomicFileWriteOptions,
} from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';

/**
 * Installs a store file durably. When the file is installed but its folder
 * flush fails, the write still counts as made: every later read sees it, so
 * a caller that treated it as failed could not undo it. Only its survival
 * across power loss is unconfirmed, which is logged.
 */
export async function writeStoreFileDurably(
  targetPath: string,
  data: string | Uint8Array,
  options: Omit<AtomicFileWriteOptions, 'durable'> = {},
): Promise<void> {
  try {
    await writeFileAtomically(targetPath, data, { ...options, durable: true });
  } catch (error) {
    if (!isStorageOutcomeUnknownError(error)) throw error;
    logMainProcessWarn(
      '[storage] Store file installed, but its folder flush failed',
      error,
    );
  }
}
