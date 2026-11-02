import fs from 'node:fs/promises';

// Windows FlushFileBuffers rejects read-only handles, for regular files and
// for directories (CAN-5151 D1). Keep real disk I/O and directory flushing,
// but enforce that contract on every host. While `process.platform` is faked
// as win32 on POSIX, a read-write directory open (`r+`, which POSIX refuses
// with EISDIR) uses the POSIX read-only open; its flush is recorded in
// `syncedDirectories`.
export function enforceWindowsFileSync(
  syncedDirectories: string[] = [],
): string[] {
  const open = fs.open;
  const host = process.platform;
  const syncedFiles: string[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const posixDirectory =
      host !== 'win32' &&
      flags === 'r+' &&
      (await fs.stat(path).then(
        (stats) => stats.isDirectory(),
        () => false,
      ));
    const handle = await open(path, posixDirectory ? 'r' : flags, mode);
    const sync = handle.sync.bind(handle);
    handle.sync = async (): Promise<void> => {
      const isFile = (await handle.stat()).isFile();
      if (flags === 'r' && (isFile || process.platform === 'win32')) {
        throw Object.assign(
          new Error('EPERM: operation not permitted, fsync'),
          {
            code: 'EPERM',
            syscall: 'fsync',
          },
        );
      }
      (isFile ? syncedFiles : syncedDirectories).push(String(path));
      await sync();
    };
    return handle;
  });
  return syncedFiles;
}
