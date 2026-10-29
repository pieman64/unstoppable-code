import { join } from 'node:path';

interface FakeStats {
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
}

const mockPatchedFs = jest.fn((): never => {
  throw new Error('The asar-patched fs must not be used.');
});
const mockOriginalReaddir = jest.fn<Promise<{ name: string }[]>, [string]>();
const mockOriginalLstat = jest.fn<Promise<FakeStats>, [string]>();
const mockOriginalRm = jest.fn<Promise<void>, [string]>();

jest.mock(
  'node:fs/promises',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('node:fs/promises'),
    lstat: () => mockPatchedFs(),
    readdir: () => mockPatchedFs(),
    rm: () => mockPatchedFs(),
  }),
);

jest.mock(
  'node:module',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('node:module'),
    createRequire: () => (id: string) => {
      if (id !== 'original-fs') throw new Error(`Unexpected module ${id}`);
      return {
        promises: {
          lstat: (path: string) => mockOriginalLstat(path),
          readdir: (path: string) => mockOriginalReaddir(path),
          rm: (path: string) => mockOriginalRm(path),
        },
      };
    },
  }),
);

const originalVersions = process.versions;
const originalPlatform = process.platform;

function stats(kind: 'file' | 'directory' | 'link'): FakeStats {
  return {
    isSymbolicLink: () => kind === 'link',
    isDirectory: () => kind === 'directory',
  };
}

describe('removeWindowsWorktreeReparsePoints under Electron', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPatchedFs.mockClear();
    mockOriginalReaddir.mockReset();
    mockOriginalLstat.mockReset();
    mockOriginalRm.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions, electron: '42.3.0' },
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('scans with original-fs so asar files stay plain files', async () => {
    const root = join('/repo', 'worktree');
    const asar = join(root, 'default_app.asar');
    const link = join(root, 'junction');
    const nested = join(root, 'nested');
    const nestedLink = join(nested, 'inner-junction');
    mockOriginalReaddir.mockImplementation((path) =>
      Promise.resolve(
        path === root
          ? [
              { name: 'default_app.asar' },
              { name: 'junction' },
              { name: 'nested' },
            ]
          : [{ name: 'inner-junction' }],
      ),
    );
    mockOriginalLstat.mockImplementation((path) => {
      if (path === asar) return Promise.resolve(stats('file'));
      if (path === nested) return Promise.resolve(stats('directory'));
      return Promise.resolve(stats('link'));
    });
    const { removeWindowsWorktreeReparsePoints } =
      await import('../windows-worktree-reparse-points');

    await removeWindowsWorktreeReparsePoints(root);

    // The asar is never entered, and junction cleanup is unchanged.
    expect(mockOriginalReaddir.mock.calls).toEqual([[root], [nested]]);
    expect(mockOriginalRm.mock.calls).toEqual([[link], [nestedLink]]);
    expect(mockPatchedFs).not.toHaveBeenCalled();
  });
});
