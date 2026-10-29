import fs from 'node:fs/promises';

// Windows FlushFileBuffers rejects read-only regular-file handles. Keep real
// disk I/O and directory flushing, but enforce that contract on every host.
export function enforceWindowsFileSync(): string[] {
  const open = fs.open;
  const syncedFiles: string[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    const sync = handle.sync.bind(handle);
    handle.sync = async (): Promise<void> => {
      if ((await handle.stat()).isFile()) {
        if (flags === 'r') {
          throw Object.assign(
            new Error('EPERM: operation not permitted, fsync'),
            {
              code: 'EPERM',
              syscall: 'fsync',
            },
          );
        }
        syncedFiles.push(String(path));
      }
      await sync();
    };
    return handle;
  });
  return syncedFiles;
}
