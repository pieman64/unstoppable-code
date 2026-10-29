import { readFileSync as realReadFileSync } from 'node:fs';
import {
  CURSOR_RUNTIME_VERSION,
  getCursorRuntimeArtifact,
  getCursorRuntimeTargetForHost,
} from '../runtime-metadata';
import type * as RuntimeMetadataModule from '../runtime-metadata';

/** The mock `jest.fn(readFileSync)` returns. */
type ReadFileSyncMock = jest.Mock<
  ReturnType<typeof realReadFileSync>,
  Parameters<typeof realReadFileSync>
>;

describe('Cursor runtime artifact selection', () => {
  it.each([
    ['darwin', 'arm64', 'darwin/arm64', 'tar.gz'],
    ['darwin', 'x64', 'darwin/x64', 'tar.gz'],
    ['win32', 'x64', 'windows/x64', 'zip'],
    ['win32', 'arm64', 'windows/arm64', 'zip'],
  ])(
    'resolves the pinned artifact for %s/%s',
    (platform, arch, segment, ext) => {
      const artifact = getCursorRuntimeArtifact(platform, arch);
      expect(artifact?.version).toBe(CURSOR_RUNTIME_VERSION);
      expect(artifact?.url).toBe(
        `https://downloads.cursor.com/lab/${CURSOR_RUNTIME_VERSION}/${segment}/agent-cli-package.${ext}`,
      );
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact?.filesSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact?.archiveBytes).toBeGreaterThan(0);
    },
  );

  it('exposes the matching target so callers know the archive and launcher shape', () => {
    expect(getCursorRuntimeTargetForHost('darwin', 'arm64')?.launch).toEqual([
      'cursor-agent',
    ]);
    expect(getCursorRuntimeTargetForHost('win32', 'x64')?.launch).toEqual([
      'node.exe',
      'index.js',
    ]);
  });

  it('refuses platforms with no inspected artifact', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['darwin', 'ia32'],
      ['win32', 'ia32'],
    ]) {
      expect(getCursorRuntimeArtifact(platform, arch)).toBeUndefined();
      expect(getCursorRuntimeTargetForHost(platform, arch)).toBeUndefined();
    }
  });
});

describe('Cursor runtime manifest source', () => {
  function loadRuntimeMetadataFresh(
    readFileSyncMock: ReadFileSyncMock,
  ): typeof RuntimeMetadataModule {
    let loaded: typeof RuntimeMetadataModule | undefined;
    jest.isolateModules((): void => {
      jest.doMock('node:fs', () => ({ readFileSync: readFileSyncMock }));
      loaded = jest.requireActual<typeof RuntimeMetadataModule>(
        '../runtime-metadata',
      );
    });
    if (!loaded) {
      throw new Error('Failed to load runtime-metadata module');
    }
    return loaded;
  }

  it('does not read the root package.json when __CANOPY_CURSOR_CLI__ is defined', () => {
    // The bare ambient identifier keeps the define's declared type.
    const knownVersion = __CANOPY_CURSOR_CLI__?.version;
    const readFileSyncMock = jest.fn(realReadFileSync);

    const loaded = loadRuntimeMetadataFresh(readFileSyncMock);

    expect(loaded.CURSOR_RUNTIME_VERSION).toBe(knownVersion);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to the root package.json cursor-cli entry when __CANOPY_CURSOR_CLI__ is undefined', () => {
    const original = __CANOPY_CURSOR_CLI__;
    const readFileSyncMock = jest.fn(realReadFileSync);
    // An ambient `const` (`build-constants.d.ts`), so it is removed and
    // restored as a property of the global object.
    Reflect.deleteProperty(globalThis, '__CANOPY_CURSOR_CLI__');

    try {
      const loaded = loadRuntimeMetadataFresh(readFileSyncMock);

      expect(readFileSyncMock).toHaveBeenCalledTimes(1);
      expect(loaded.CURSOR_RUNTIME_VERSION).toBe(original?.version);
      expect(loaded.getCursorRuntimeArtifact('darwin', 'arm64')?.version).toBe(
        original?.version,
      );
    } finally {
      Reflect.set(globalThis, '__CANOPY_CURSOR_CLI__', original);
    }
  });
});
