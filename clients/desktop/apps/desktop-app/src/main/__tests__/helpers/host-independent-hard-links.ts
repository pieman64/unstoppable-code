import type * as FsPromises from 'node:fs/promises';

type HardLinkOps = Pick<typeof FsPromises, 'copyFile' | 'link'>;

// Hard-link and copy results differ by host: Darwin link(2) follows a
// symbolic-link source while Linux links the symbolic link itself, and copying
// a directory fails with ENOTSUP on Darwin but EISDIR on Linux. Keep real disk
// I/O, but give every host Darwin's results, which the win32 goldens pin.
export function hostIndependentHardLinkOps(
  actual: HardLinkOps & Pick<typeof FsPromises, 'realpath' | 'stat'>,
): HardLinkOps {
  return {
    link: async (existingPath, newPath) =>
      actual.link(await actual.realpath(existingPath), newPath),
    copyFile: async (source, destination, mode): Promise<void> => {
      if ((await actual.stat(source)).isDirectory())
        throw Object.assign(
          new Error(
            `ENOTSUP: operation not supported on socket, copyfile '${String(source)}' -> '${String(destination)}'`,
          ),
          {
            code: 'ENOTSUP',
            syscall: 'copyfile',
            path: String(source),
            dest: String(destination),
          },
        );
      await actual.copyFile(source, destination, mode);
    },
  };
}
