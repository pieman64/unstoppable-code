import type { RmOptions } from 'node:fs';

const mockNodeRm = jest.fn<Promise<void>, [string, RmOptions | undefined]>();
const mockOriginalRm = jest.fn<
  Promise<void>,
  [string, RmOptions | undefined]
>();
const mockOriginalFs = jest.fn((): unknown => ({
  promises: { lstat: jest.fn(), readdir: jest.fn(), rm: mockOriginalRm },
}));
const mockModuleRequire = jest.fn((id: string) => {
  if (id !== 'original-fs') throw new Error(`Unexpected module ${id}`);
  return mockOriginalFs();
});
const mockCreateRequire = jest.fn<typeof mockModuleRequire, [string]>(
  () => mockModuleRequire,
);

jest.mock(
  'node:fs/promises',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('node:fs/promises'),
    rm: (path: string, options?: RmOptions) => mockNodeRm(path, options),
  }),
);

jest.mock(
  'node:module',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('node:module'),
    createRequire: (from: string) => mockCreateRequire(from),
  }),
);

const originalVersions = process.versions;
const originalNoAsar = process.noAsar;

function setElectronVersion(electron: string | undefined): void {
  const versions: NodeJS.ProcessVersions = { ...originalVersions };
  if (electron === undefined) {
    Reflect.deleteProperty(versions, 'electron');
  } else {
    Reflect.set(versions, 'electron', electron);
  }
  Object.defineProperty(process, 'versions', {
    value: versions,
    configurable: true,
  });
}

describe('removeTreeWithoutAsar', () => {
  beforeEach(() => {
    jest.resetModules();
    mockNodeRm.mockReset().mockResolvedValue(undefined);
    mockOriginalRm.mockReset().mockResolvedValue(undefined);
    mockOriginalFs.mockClear();
    mockModuleRequire.mockClear();
    mockCreateRequire.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
    process.noAsar = originalNoAsar;
  });

  it('removes through original-fs under Electron so asar files are unlinked', async () => {
    setElectronVersion('38.0.0');
    const { removeTreeWithoutAsar } =
      await import('../remove-tree-without-asar');
    const options = {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    };

    await removeTreeWithoutAsar('/tmp/quarantine', options);

    expect(mockCreateRequire).toHaveBeenCalledTimes(1);
    expect(mockModuleRequire).toHaveBeenCalledWith('original-fs');
    expect(mockOriginalRm).toHaveBeenCalledWith('/tmp/quarantine', options);
    expect(mockNodeRm).not.toHaveBeenCalled();
  });

  it('falls back to node:fs/promises outside Electron', async () => {
    setElectronVersion(undefined);
    const { removeTreeWithoutAsar } =
      await import('../remove-tree-without-asar');
    const options = { recursive: true, force: true };

    await removeTreeWithoutAsar('/tmp/quarantine', options);

    expect(mockNodeRm).toHaveBeenCalledWith('/tmp/quarantine', options);
    expect(mockCreateRequire).not.toHaveBeenCalled();
    expect(mockOriginalRm).not.toHaveBeenCalled();
  });

  it('loads original-fs once and reuses it', async () => {
    setElectronVersion('38.0.0');
    const { removeTreeWithoutAsar } =
      await import('../remove-tree-without-asar');

    await removeTreeWithoutAsar('/tmp/first');
    await removeTreeWithoutAsar('/tmp/second');

    expect(mockModuleRequire).toHaveBeenCalledTimes(1);
    expect(mockOriginalRm).toHaveBeenCalledTimes(2);
  });

  it('uses the regular fs when the process already disabled asar redirection', async () => {
    setElectronVersion('38.0.0');
    process.noAsar = true;
    const { removeTreeWithoutAsar } =
      await import('../remove-tree-without-asar');

    await removeTreeWithoutAsar('/tmp/quarantine');

    expect(mockNodeRm).toHaveBeenCalledWith('/tmp/quarantine', undefined);
    expect(mockCreateRequire).not.toHaveBeenCalled();
  });

  it('fails instead of falling back to the patched fs when original-fs is unusable', async () => {
    setElectronVersion('38.0.0');
    mockOriginalFs.mockReturnValueOnce({ promises: { rm: mockOriginalRm } });
    const { removeTreeWithoutAsar } =
      await import('../remove-tree-without-asar');

    await expect(removeTreeWithoutAsar('/tmp/quarantine')).rejects.toThrow(
      'Electron original-fs is unavailable.',
    );
    expect(mockNodeRm).not.toHaveBeenCalled();
  });
});
