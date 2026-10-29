import { open } from 'node:fs/promises';
import { recordChatStorageDirectorySync } from '@canopy/desktop-shared/node/work-counters';

/** Persist rename ordering on POSIX. Node cannot open directories on Windows. */
export async function fsyncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
    // Work counter: a no-op unless the directory belongs to chat storage.
    recordChatStorageDirectorySync(directoryPath);
  } finally {
    await handle.close();
  }
}
