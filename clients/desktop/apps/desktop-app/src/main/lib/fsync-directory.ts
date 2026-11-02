import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { recordChatStorageDirectorySync } from '@canopy/desktop-shared/node/work-counters';

/**
 * Persist entries created, renamed or removed in a folder. Windows uses the
 * D1 API-level flush (`WINDOWS_DIRECTORY_FLUSH_LABEL`); any failure rejects
 * with a typed `DirectoryFlushError`.
 */
export async function fsyncDirectory(directoryPath: string): Promise<void> {
  await flushDirectory(directoryPath);
  // Work counter: a no-op unless the directory belongs to chat storage.
  recordChatStorageDirectorySync(directoryPath);
}
