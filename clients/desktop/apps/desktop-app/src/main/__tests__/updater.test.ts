/* eslint-disable @typescript-eslint/no-require-imports */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import type * as UpdaterModule from '../updater';

type LinuxArchitecture = 'x64' | 'arm64';
const mockLinuxDebInstalled = jest.fn(() => Promise.resolve(true));
const mockLinuxArchitecture = jest.fn<Promise<LinuxArchitecture | null>, []>(
  () => Promise.resolve('x64'),
);
jest.mock('../updater/linux-manual-update', () => ({
  isInstalledLinuxDeb: (): Promise<boolean> => mockLinuxDebInstalled(),
  installedLinuxPackageArchitecture: (): Promise<LinuxArchitecture | null> =>
    mockLinuxArchitecture(),
}));
const LINUX_COPY = linuxUpdateCopy(BRAND);

const mockSetFeedURL = jest.fn<void, [unknown]>();
const mockDefaultWindowsVerifier = jest.fn();
let mockUpdaterCachePath = '';
jest.mock('electron-updater/out/ElectronAppAdapter', () => ({
  ElectronAppAdapter: class {
    get baseCachePath(): string {
      return mockUpdaterCachePath;
    }
  },
}));
const mockAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  allowDowngrade: false,
  disableDifferentialDownload: false,
  verifyUpdateCodeSignature: mockDefaultWindowsVerifier,
  configOnDisk: {
    value: Promise.resolve({ updaterCacheDirName: 'can-4188-updater' }),
  },
  setFeedURL: mockSetFeedURL,
  checkForUpdates: jest.fn(),
  downloadUpdate: jest.fn(),
  quitAndInstall: jest.fn(),
});

const mockGetAutoUpdater = jest.fn(() => mockAutoUpdater);

const mockElectronApp: {
  getVersion: jest.Mock<string, []>;
  isPackaged: boolean;
} = {
  getVersion: jest.fn(() => '9999.0.0-internal.126'),
  isPackaged: true,
};
const originalFetch = globalThis.fetch;
const originalPlatform = process.platform;
const originalArch = process.arch;
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const mockChatSessionActivityListeners = new Set<() => void>();
const mockHasActiveChatWork = jest.fn(() => false);

jest.mock('electron-updater', () => ({
  __esModule: true,
  default: {
    get autoUpdater(): typeof mockAutoUpdater {
      return mockGetAutoUpdater();
    },
  },
}));

jest.mock('../lib/github-auth', () => ({
  resolveGitHubToken: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('electron', () => ({
  app: mockElectronApp,
}));

jest.mock('../agents/session-manager', () => ({
  hasActiveChatWork: (): boolean => mockHasActiveChatWork(),
  subscribeChatSessionActivity: (listener: () => void): (() => void) => {
    mockChatSessionActivityListeners.add(listener);
    return (): void => {
      mockChatSessionActivityListeners.delete(listener);
    };
  },
}));

import { resolveGitHubToken } from '../lib/github-auth';
import { readPreferencesFile } from '../lib/preferences-store';

const mockedResolveGitHubToken = jest.mocked(resolveGitHubToken);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

type BrandOverride = {
  id: string;
  displayName: string;
  release: {
    artifactPrefix: string;
  };
};

type BrandCurrentModule = {
  __esModule: true;
  BRAND: DesktopBrandRuntime;
};
type TestBrowserWindow = NonNullable<
  ReturnType<Parameters<typeof UpdaterModule.startUpdater>[0]>
>;

function isFeedOptions(value: unknown): value is {
  channel?: unknown;
  releaseFlavor?: unknown;
  owner?: unknown;
  private?: unknown;
  provider?: unknown;
  repo?: unknown;
  targetReleaseTag?: unknown;
  token?: unknown;
  updateProvider?: unknown;
} {
  return Boolean(value) && typeof value === 'object';
}

function getLastFeedOptions(): unknown {
  const calls = mockSetFeedURL.mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall?.[0];
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockJsonResponse(body: unknown, link: string | null = null): Response {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (link) {
    headers.set('link', link);
  }
  return new Response(JSON.stringify(body), { headers, status: 200 });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function mockFetchResponse(
  implementation: (...args: Parameters<typeof fetch>) => Response,
): void {
  mockFetch.mockImplementation((...args) =>
    Promise.resolve(implementation(...args)),
  );
}

function linuxReleaseFixture(
  tag = 'v1.2.0',
  architectures: LinuxArchitecture[] = ['x64'],
): {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; digest: string; browser_download_url: string }>;
} {
  const internal = tag.startsWith('internal-');
  const version = internal ? `9999.0.0-internal.${tag.slice(9)}` : tag.slice(1);
  return {
    tag_name: tag,
    draft: false,
    prerelease: internal || tag.includes('-rc.'),
    assets: architectures.map((architecture) => {
      const debArch = architecture === 'x64' ? 'amd64' : 'arm64';
      const name = internal
        ? `canopy-internal-linux-${debArch}.deb`
        : `canopy-${version}-linux-${debArch}.deb`;
      return {
        name,
        digest: `sha256:${(architecture === 'x64' ? 'a' : 'b').repeat(64)}`,
        browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/${tag}/${name}`,
      };
    }),
  };
}

// Canonical base64 SHA-512 values: the validator round-trips the encoding.
const LINUX_STABLE_SHA512: Record<LinuxArchitecture, string> = {
  x64: `${'A'.repeat(86)}==`,
  arm64: Buffer.alloc(64, 1).toString('base64'),
};

function linuxStableMetadata(
  version: string,
  architectures: LinuxArchitecture[] = ['x64'],
): string {
  const files = architectures.map(
    (architecture) =>
      ` - url: canopy-${version}-linux-${architecture === 'x64' ? 'amd64' : 'arm64'}.deb\n   sha512: ${LINUX_STABLE_SHA512[architecture]}\n`,
  );
  return `version: ${version}\nfiles:\n${files.join('')}`;
}

function defaultBrandMetadataAssets(): Array<{ name: string; url: string }> {
  return [
    { name: 'latest-mac.yml', url: 'asset-mac' },
    { name: 'latest.yml', url: 'asset-win' },
    { name: 'latest-linux.yml', url: 'asset-linux' },
  ];
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createWindow(isDestroyed = false): TestBrowserWindow {
  const webContentsIsCrashed: jest.MockedFunction<() => boolean> = jest.fn(
    () => false,
  );
  const webContentsIsDestroyed: jest.MockedFunction<() => boolean> = jest.fn(
    () => false,
  );
  const isLoading: jest.MockedFunction<() => boolean> = jest.fn(() => false);
  const mainFrameIsDestroyed: jest.MockedFunction<() => boolean> = jest.fn(
    () => false,
  );
  const once: jest.MockedFunction<
    (event: string, callback: () => void) => void
  > = jest.fn();
  const send: jest.MockedFunction<(channel: string, payload: unknown) => void> =
    jest.fn();

  return {
    isDestroyed: () => isDestroyed,
    webContents: {
      isCrashed: webContentsIsCrashed,
      isDestroyed: webContentsIsDestroyed,
      isLoading,
      mainFrame: {
        detached: false,
        isDestroyed: mainFrameIsDestroyed,
      },
      once,
      send,
    },
  };
}

function emitChatSessionActivity(): void {
  for (const listener of Array.from(mockChatSessionActivityListeners)) {
    listener();
  }
}

async function importFreshUpdater(
  brandOverride?: BrandOverride,
  releaseFlavor: 'stable' | 'rc' | 'internal' = 'stable',
  updateBaseUrl = 'https://releases.unstoppable.ai',
  sourceBuild = false,
): Promise<typeof UpdaterModule> {
  return new Promise((resolve) => {
    jest.isolateModules(() => {
      Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', releaseFlavor);
      Reflect.set(globalThis, '__CANOPY_UPDATE_BASE_URL__', updateBaseUrl);
      Reflect.set(globalThis, '__CANOPY_SOURCE_BUILD__', sourceBuild);
      if (brandOverride) {
        jest.doMock('@canopy/brand/current', (): BrandCurrentModule => {
          const actual = jest.requireActual<{ BRAND: DesktopBrandRuntime }>(
            '@canopy/brand/current',
          );
          return {
            __esModule: true,
            BRAND: {
              ...actual.BRAND,
              ...brandOverride,
              release: {
                ...actual.BRAND.release,
                ...brandOverride.release,
              },
            },
          };
        });
      }
      const mod = require('../updater') as typeof UpdaterModule;
      if (brandOverride) {
        jest.dontMock('@canopy/brand/current');
      }
      resolve(mod);
    });
  });
}
describe('updater service', () => {
  beforeEach(() => {
    // Installer scenarios below exercise the macOS auto-updater regardless of
    // the Jest host; the Linux block overrides this for manual-only coverage.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockAutoUpdater.removeAllListeners();
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = false;
    mockAutoUpdater.allowPrerelease = false;
    mockAutoUpdater.allowDowngrade = false;
    mockAutoUpdater.disableDifferentialDownload = false;
    mockAutoUpdater.verifyUpdateCodeSignature = mockDefaultWindowsVerifier;
    mockChatSessionActivityListeners.clear();
    mockHasActiveChatWork.mockReturnValue(false);
    Reflect.set(globalThis, '__CANOPY_INTERNAL_RELEASE_INDICATOR__', '');
    jest.dontMock('@canopy/brand/current');
    mockedResolveGitHubToken.mockResolvedValue('ghp_test_token_123');
    // Default to manual downloads so existing assertions about the download
    // call count are not perturbed by the auto-download path. Tests that need
    // the auto-download flow override this explicitly.
    mockedReadPreferencesFile.mockResolvedValue({
      autoDownloadUpdates: false,
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    mockElectronApp.isPackaged = true;
    mockElectronApp.getVersion.mockReturnValue('9999.0.0-internal.126');
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  describe('Windows update recovery', () => {
    beforeEach(async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockUpdaterCachePath = await mkdtemp(join(tmpdir(), 'can-4188-updater-'));
    });

    afterEach(async () => {
      await rm(mockUpdaterCachePath, { recursive: true, force: true });
    });

    it('replaces the short default verifier and avoids differential downloads', async () => {
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      expect(mockAutoUpdater.verifyUpdateCodeSignature).not.toBe(
        mockDefaultWindowsVerifier,
      );
      expect(mockAutoUpdater.disableDifferentialDownload).toBe(true);
      updater.stopUpdater();
    });

    it('removes only stale temporary installers before a retry starts', async () => {
      const pending = join(mockUpdaterCachePath, 'can-4188-updater', 'pending');
      await mkdir(pending, { recursive: true });
      await writeFile(join(pending, 'temp-canopy-1.2.0.exe'), 'partial');
      await writeFile(join(pending, '0-temp-canopy-1.2.0.exe'), 'partial');
      await writeFile(join(pending, 'canopy-1.2.0.exe'), 'verified');
      await writeFile(join(pending, 'update-info.json'), '{}');
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      mockAutoUpdater.emit('update-available', { version: '1.2.0' });
      mockAutoUpdater.downloadUpdate.mockImplementationOnce(async () => {
        await expect(
          readFile(join(pending, 'temp-canopy-1.2.0.exe')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          readFile(join(pending, '0-temp-canopy-1.2.0.exe')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(pending, 'canopy-1.2.0.exe'), 'utf8')).toBe(
          'verified',
        );
        expect(await readFile(join(pending, 'update-info.json'), 'utf8')).toBe(
          '{}',
        );
      });
      await updater.downloadUpdate();
      updater.stopUpdater();
    });

    it('cleans an interrupted installer before another download is admitted', async () => {
      const pending = join(mockUpdaterCachePath, 'can-4188-updater', 'pending');
      await mkdir(pending, { recursive: true });
      const partial = join(pending, 'temp-canopy-1.2.0.exe');
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      mockAutoUpdater.emit('update-available', { version: '1.2.0' });
      mockAutoUpdater.downloadUpdate.mockImplementationOnce(async () => {
        await writeFile(partial, 'interrupted');
        throw new Error('connection interrupted');
      });
      await expect(updater.downloadUpdate()).rejects.toThrow(
        'connection interrupted',
      );
      await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' });
      updater.stopUpdater();
    });

    it('keeps a signature timeout actionable on stable builds', async () => {
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      const message =
        'Update signature verification timed out. Try downloading the update again.';
      mockAutoUpdater.emit(
        'error',
        Object.assign(new Error(message), {
          code: 'ERR_UPDATER_SIGNATURE_TIMEOUT',
        }),
      );
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'error',
        message,
      });
      updater.stopUpdater();
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    jest.useRealTimers();
  });

  describe('Linux manual .deb updates', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      mockLinuxDebInstalled.mockResolvedValue(true);
      mockLinuxArchitecture.mockResolvedValue('x64');
      mockElectronApp.getVersion.mockReturnValue('1.0.0');
    });

    it.each(['stable', 'rc', 'internal'] as const)(
      'threads %s policy into Linux installer refusal',
      async (flavor) => {
        const updater = await importFreshUpdater(
          {
            id: 'unstoppable-code',
            displayName: 'Example',
            release: { artifactPrefix: 'unstoppable-code' },
          },
          flavor,
        );
        await expect(updater.downloadUpdate()).rejects.toThrow(
          flavor === 'stable'
            ? /sudo apt update && sudo apt upgrade/
            : /manually/,
        );
        expect(mockGetAutoUpdater).not.toHaveBeenCalled();
      },
    );

    it('checks metadata without constructing or invoking an installer', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          `version: 1.2.0\nfiles:\n - url: canopy-1.2.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
        ),
      );
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      await updater.checkForUpdates();
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'available',
        info: { version: '1.2.0' },
      });
      expect(mockFetch).toHaveBeenCalled();
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
      expect(mockGetAutoUpdater).not.toHaveBeenCalled();
      expect(mockedResolveGitHubToken).not.toHaveBeenCalled();
      updater.stopUpdater();
    });

    it.each(['downloadUpdate', 'installUpdate', 'scheduleUpdate'] as const)(
      'refuses %s without installation or elevation',
      async (action) => {
        const updater = await importFreshUpdater();
        updater.startUpdater(() => createWindow());
        await expect(
          Promise.resolve().then(() => updater[action]()),
        ).rejects.toThrow(/Linux.*manually/i);
        expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
        expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
        updater.stopUpdater();
      },
    );

    it('fails closed for a wrong package or architecture', async () => {
      mockLinuxDebInstalled.mockResolvedValue(false);
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      await expect(updater.checkForUpdates()).rejects.toThrow(
        LINUX_COPY.unsupported,
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLinuxArchitecture).not.toHaveBeenCalled();
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      updater.stopUpdater();
    });

    it('refuses an unsupported installed architecture even when an ownership record exists', async () => {
      mockLinuxArchitecture.mockResolvedValue(null);
      const updater = await importFreshUpdater();
      await expect(updater.checkForUpdates()).rejects.toThrow(
        LINUX_COPY.unsupported,
      );
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'error',
        message: LINUX_COPY.unsupported,
      });
      expect(mockFetch).not.toHaveBeenCalled();
      await expect(
        (
          await importFreshUpdater(undefined, 'internal')
        ).listTargetUpdateVersions(),
      ).rejects.toThrow(LINUX_COPY.unsupported);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    describe.each(['x64', 'arm64'] as const)(
      'on an installed %s package',
      (host) => {
        const other: LinuxArchitecture = host === 'x64' ? 'arm64' : 'x64';
        const feedFile =
          host === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml';
        const debName = (version: string): string =>
          `canopy-${version}-linux-${host === 'x64' ? 'amd64' : 'arm64'}.deb`;

        beforeEach(() => {
          // The process architecture must never override the installed package.
          Object.defineProperty(process, 'arch', { value: other });
          mockLinuxArchitecture.mockResolvedValue(host);
        });

        it('offers APT only with an architecture-matched verified reinstall fallback for the published stable brand', async () => {
          mockFetch.mockResolvedValue(
            new Response(
              linuxStableMetadata('1.2.0', ['x64', 'arm64']).replaceAll(
                'canopy-',
                'unstoppable-code-',
              ),
            ),
          );
          const updater = await importFreshUpdater({
            id: 'unstoppable-code',
            displayName: 'Example',
            release: { artifactPrefix: 'unstoppable-code' },
          });
          await updater.checkForUpdates();
          const download = updater.getUpdateState().info?.manualDownload;
          expect(download?.url).toContain(
            `unstoppable-code-1.2.0-linux-${host === 'x64' ? 'amd64' : 'arm64'}.deb`,
          );
          expect(download?.guidance).toContain('reinstall fallback');
          expect(download?.guidance).not.toContain('apt update');
          expect(download?.checksum.value).toBe(
            Buffer.from(LINUX_STABLE_SHA512[host], 'base64').toString('hex'),
          );
          expect(mockGetAutoUpdater).not.toHaveBeenCalled();
        });

        it(`fetches ${feedFile} and offers only the ${host} stable package when both are published`, async () => {
          mockFetch.mockResolvedValue(
            new Response(linuxStableMetadata('1.2.0', ['x64', 'arm64'])),
          );
          const updater = await importFreshUpdater();
          await updater.checkForUpdates();
          expect(mockFetch).toHaveBeenCalledWith(
            `https://releases.unstoppable.ai/desktop/canopy/${feedFile}`,
            expect.anything(),
          );
          expect(updater.getUpdateState()).toMatchObject({
            phase: 'available',
            info: {
              version: '1.2.0',
              manualDownload: {
                url: `https://releases.unstoppable.ai/desktop/canopy/1.2.0/${debName('1.2.0')}`,
                checksum: {
                  algorithm: 'SHA-512',
                  value: Buffer.from(
                    LINUX_STABLE_SHA512[host],
                    'base64',
                  ).toString('hex'),
                },
              },
            },
          });
        });

        it(`offers the ${host} stable package from a ${host}-only feed`, async () => {
          mockFetch.mockResolvedValue(
            new Response(linuxStableMetadata('1.2.0', [host])),
          );
          const updater = await importFreshUpdater();
          await updater.checkForUpdates();
          const state = updater.getUpdateState();
          expect(state.phase).toBe('available');
          expect(state.info?.manualDownload?.url).toContain(debName('1.2.0'));
        });

        it.each([
          { shape: `${other}-only`, architectures: [other] },
          { shape: 'neither', architectures: [] },
        ])(
          'reports a truthful unavailable state for a $shape stable feed',
          async ({ architectures }) => {
            mockFetch.mockResolvedValue(
              new Response(linuxStableMetadata('1.2.0', architectures)),
            );
            const updater = await importFreshUpdater();
            await expect(updater.checkForUpdates()).rejects.toThrow(
              LINUX_COPY.unavailable,
            );
            expect(updater.getUpdateState()).toMatchObject({
              phase: 'error',
              message: LINUX_COPY.unavailable,
            });
            expect(mockFetch).toHaveBeenCalledWith(
              `https://releases.unstoppable.ai/desktop/canopy/${feedFile}`,
              expect.anything(),
            );
          },
        );

        describe.each([
          {
            flavor: 'internal' as const,
            current: '9999.0.0-internal.126',
            tag: 'internal-130',
            version: 'internal-130',
          },
          {
            flavor: 'rc' as const,
            current: '1.2.0-rc.1',
            tag: 'v1.2.0-rc.3',
            version: '1.2.0-rc.3',
          },
        ])('$flavor releases', ({ flavor, current, tag, version }) => {
          beforeEach(() => {
            mockElectronApp.getVersion.mockReturnValue(current);
          });

          function serve(architectures: LinuxArchitecture[]): void {
            mockFetchResponse((url) =>
              mockJsonResponse(
                requestUrl(url).includes('/tags/')
                  ? linuxReleaseFixture(tag, architectures)
                  : [linuxReleaseFixture(tag, architectures)],
              ),
            );
          }

          const architectureCases: Array<{
            shape: string;
            architectures: LinuxArchitecture[];
          }> = [
            { shape: 'both', architectures: ['x64', 'arm64'] },
            { shape: `${host}-only`, architectures: [host] },
          ];

          it.each(architectureCases)(
            `lists, selects and targets only the ${host} package from a $shape release`,
            async ({ architectures }) => {
              serve(architectures);
              const updater = await importFreshUpdater(undefined, flavor);
              await expect(
                updater.listTargetUpdateVersions(),
              ).resolves.toMatchObject({ items: [{ tag }] });
              await updater.checkForUpdates();
              const expected = {
                phase: 'available',
                info: {
                  version,
                  manualDownload: {
                    url: `https://github.com/unstoppabledomains/canopy/releases/tag/${tag}`,
                    checksum: {
                      algorithm: 'SHA-256',
                      value: (host === 'x64' ? 'a' : 'b').repeat(64),
                    },
                  },
                },
              };
              expect(updater.getUpdateState()).toMatchObject(expected);
              await updater.checkForVersion({ tag });
              expect(updater.getUpdateState()).toMatchObject({
                ...expected,
                target: { tag },
              });
              expect(mockGetAutoUpdater).not.toHaveBeenCalled();
            },
          );

          it.each([
            { shape: `${other}-only`, architectures: [other] },
            { shape: 'neither', architectures: [] },
          ])(
            `never lists, selects or targets a $shape release for ${host}`,
            async ({ architectures }) => {
              serve(architectures);
              const updater = await importFreshUpdater(undefined, flavor);
              await expect(
                updater.listTargetUpdateVersions(),
              ).resolves.toMatchObject({ items: [] });
              await expect(updater.checkForUpdates()).rejects.toThrow(
                LINUX_COPY.unavailable,
              );
              expect(updater.getUpdateState()).toMatchObject({
                phase: 'error',
                message: LINUX_COPY.unavailable,
              });
              await expect(updater.checkForVersion({ tag })).rejects.toThrow(
                LINUX_COPY.unavailable,
              );
              expect(updater.getUpdateState()).toMatchObject({
                phase: 'error',
                message: LINUX_COPY.unavailable,
              });
              expect(mockGetAutoUpdater).not.toHaveBeenCalled();
            },
          );
        });
      },
    );

    it('resolves the installed architecture once per check and threads it through', async () => {
      mockElectronApp.getVersion.mockReturnValue('9999.0.0-internal.126');
      mockFetchResponse((url) =>
        mockJsonResponse(
          requestUrl(url).includes('/tags/')
            ? linuxReleaseFixture('internal-130', ['x64', 'arm64'])
            : [linuxReleaseFixture('internal-130', ['x64', 'arm64'])],
        ),
      );
      const updater = await importFreshUpdater(undefined, 'internal');
      await updater.checkForUpdates();
      expect(mockLinuxArchitecture).toHaveBeenCalledTimes(1);
      await updater.checkForVersion({ tag: 'internal-130' });
      expect(mockLinuxArchitecture).toHaveBeenCalledTimes(2);
    });

    it.each([
      'version: nope\nfiles: []',
      'version: 1.2.0\nfiles:\n - url: other-1.2.0-linux-amd64.deb\n   sha512: checksum',
      'version: 1.2.0\nfiles:\n - url: canopy-1.2.0.AppImage\n   sha512: checksum',
    ])('fails closed on incompatible release metadata: %s', async (body) => {
      mockFetch.mockResolvedValue(new Response(body));
      const updater = await importFreshUpdater();
      await expect(updater.checkForUpdates()).rejects.toThrow(/Linux/);
      expect(updater.getUpdateState().phase).toBe('error');
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('retains internal channel selection with real x64 .deb release names', async () => {
      mockElectronApp.getVersion.mockReturnValue('9999.0.0-internal.126');
      const updater = await importFreshUpdater(undefined, 'internal');
      mockFetch.mockImplementation((url) =>
        Promise.resolve(
          mockJsonResponse(
            (typeof url === 'string'
              ? url
              : url instanceof URL
                ? url.href
                : url.url
            ).includes('/tags/')
              ? linuxReleaseFixture('internal-999')
              : [
                  linuxReleaseFixture('internal-999'),
                  { ...linuxReleaseFixture('internal-998'), assets: [] },
                ],
          ),
        ),
      );
      const result = await updater.listTargetUpdateVersions();
      expect(result.items.map((item) => item.tag)).toEqual(['internal-999']);
      await updater.checkForUpdates();
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'available',
        info: {
          version: 'internal-999',
          manualDownload: {
            url: 'https://github.com/unstoppabledomains/canopy/releases/tag/internal-999',
          },
        },
      });
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('reads realistic release-list pages larger than 1 MiB without losing pagination', async () => {
      const page = (start: number): ReturnType<typeof linuxReleaseFixture>[] =>
        Array.from({ length: 100 }, (_, index) => {
          const release = linuxReleaseFixture(`internal-${start + index}`);
          const artifacts = [
            ['desktop', 'darwin-arm64', 'dmg'],
            ['desktop', 'darwin-arm64', 'zip'],
            ['desktop', 'darwin-arm64', 'zip.blockmap'],
            ['desktop', 'darwin-x64', 'dmg'],
            ['desktop', 'darwin-x64', 'zip'],
            ['desktop', 'darwin-x64', 'zip.blockmap'],
            ['desktop', 'win32-x64', 'exe'],
            ['desktop', 'win32-x64', 'exe.blockmap'],
            ['cli', 'darwin-arm64', 'tar.gz'],
            ['cli', 'darwin-x64', 'tar.gz'],
            ['cli', 'win32-x64', 'zip'],
            ['cli', 'linux-x64', 'tar.gz'],
          ];
          const names = ['canopy', 'unstoppable-code'].flatMap((brand) =>
            artifacts.map(
              ([component, platform, extension]) =>
                `${component}--${brand}--9999.0.0-internal.${start + index}--internal--${platform}--${'b'.repeat(40)}.${extension}`,
            ),
          );
          return {
            ...release,
            name: release.tag_name,
            published_at: '2026-10-14T00:00:00Z',
            body: '## Changes\n- Improve workspace discovery and release validation.\n'.repeat(
              80,
            ),
            assets: [
              ...release.assets,
              ...names.map((name, asset) => ({
                id: 123456 + asset,
                name,
                size: 200_000_000,
                state: 'uploaded',
                content_type: 'application/octet-stream',
                created_at: '2026-10-14T00:00:00Z',
                updated_at: '2026-10-14T00:01:00Z',
                download_count: 20,
                digest: `sha256:${'b'.repeat(64)}`,
                url: `https://api.github.com/repos/unstoppabledomains/canopy/releases/assets/${123456 + asset}`,
                browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/${release.tag_name}/${name}`,
              })),
            ],
          };
        });
      const pages = [page(1000), page(2000)];
      for (const releases of pages) {
        const bytes = Buffer.byteLength(JSON.stringify(releases));
        expect(bytes).toBeGreaterThan(1024 * 1024);
        expect(bytes).toBeLessThan(16 * 1024 * 1024);
      }
      mockFetch
        .mockResolvedValueOnce(
          mockJsonResponse(
            pages[0],
            '<https://api.github.com/repos/unstoppabledomains/canopy/releases?per_page=100&page=2>; rel="next"',
          ),
        )
        .mockResolvedValueOnce(mockJsonResponse(pages[1]));
      const updater = await importFreshUpdater(undefined, 'internal');
      await expect(
        updater.listTargetUpdateVersions({ query: 'internal-2099', limit: 1 }),
      ).resolves.toMatchObject({
        items: [{ tag: 'internal-2099' }],
        nextCursor: null,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        'https://api.github.com/repos/unstoppabledomains/canopy/releases?per_page=100&page=1',
        'https://api.github.com/repos/unstoppabledomains/canopy/releases?per_page=100&page=2',
      ]);
    });

    it('rejects release-list pages above 16 MiB', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            ...linuxReleaseFixture('internal-999'),
            body: 'a'.repeat(16 * 1024 * 1024),
          },
        ]),
      );
      const updater = await importFreshUpdater(undefined, 'internal');
      await expect(updater.listTargetUpdateVersions()).rejects.toThrow(/Linux/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the 1 MiB single-release JSON cap', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ...linuxReleaseFixture('v1.2.0-rc.3'),
          body: 'a'.repeat(1024 * 1024),
        }),
      );
      const updater = await importFreshUpdater(undefined, 'rc');
      await expect(
        updater.checkForVersion({ tag: 'v1.2.0-rc.3' }),
      ).rejects.toThrow(/Linux/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(updater.getUpdateState().phase).toBe('error');
    });

    it('keeps the 1 MiB stable YAML cap', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          `version: 1.2.0\nfiles:\n - url: canopy-1.2.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n#${'a'.repeat(1024 * 1024)}`,
        ),
      );
      const updater = await importFreshUpdater();
      await expect(updater.checkForUpdates()).rejects.toThrow(/Linux/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(updater.getUpdateState().phase).toBe('error');
    });

    it('re-resolves credentials after a cached Linux token expires', async () => {
      mockElectronApp.getVersion.mockReturnValue('9999.0.0-internal.126');
      mockedResolveGitHubToken
        .mockResolvedValueOnce('old-token')
        .mockResolvedValue('new-token');
      let expired = false;
      mockFetchResponse((url, options) => {
        if (
          expired &&
          new Headers(options?.headers).get('authorization') ===
            'token old-token'
        ) {
          return new Response('expired', { status: 401 });
        }
        return mockJsonResponse(
          requestUrl(url).includes('/tags/')
            ? linuxReleaseFixture('internal-999')
            : [linuxReleaseFixture('internal-999')],
        );
      });
      const updater = await importFreshUpdater(undefined, 'internal');
      await updater.checkForUpdates();
      expect(mockedResolveGitHubToken).toHaveBeenCalledTimes(1);
      expired = true;
      await expect(updater.checkForUpdates()).rejects.toThrow(/Linux/);
      expect(updater.getUpdateState().phase).toBe('error');
      await updater.checkForUpdates();
      expect(mockedResolveGitHubToken).toHaveBeenCalledTimes(2);
      expect(
        new Headers(mockFetch.mock.calls.at(-1)?.[1]?.headers).get(
          'authorization',
        ),
      ).toBe('token new-token');
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'available',
        info: { version: 'internal-999' },
      });
    });

    it.each([
      {
        flavor: 'internal' as const,
        current: '9999.0.0-internal.126',
        tags: ['internal-125', 'internal-130', 'internal-128'],
        selected: 'internal-130',
      },
      {
        flavor: 'rc' as const,
        current: '2.9.9-rc.9',
        tags: ['v2.9.9-rc.10', 'v2.10.0-rc.2', 'v2.10.0-rc.10', 'v2.10.0-rc.9'],
        selected: 'v2.10.0-rc.10',
      },
    ])(
      'selects the highest compatible $flavor release from unordered results',
      async ({ flavor, current, tags, selected }) => {
        mockElectronApp.getVersion.mockReturnValue(current);
        mockFetchResponse((url) =>
          mockJsonResponse(
            requestUrl(url).includes('/tags/')
              ? linuxReleaseFixture(requestUrl(url).split('/tags/')[1])
              : tags.map((tag) => linuxReleaseFixture(tag)),
          ),
        );
        const updater = await importFreshUpdater(undefined, flavor);
        await updater.checkForUpdates();
        expect(updater.getUpdateState()).toMatchObject({
          phase: 'available',
          info: { version: selected.replace(/^v/, '') },
        });
        expect(mockFetch).toHaveBeenLastCalledWith(
          expect.stringContaining(`/tags/${selected}`),
          expect.anything(),
        );
      },
    );

    it.each([
      {
        flavor: 'internal' as const,
        current: '9999.0.0-internal.126',
        older: 'internal-127',
        newest: 'internal-130',
        incompatible: 'internal-999',
        otherChannel: 'v9.0.0-rc.1',
      },
      {
        flavor: 'rc' as const,
        current: '1.2.0-rc.1',
        older: 'v1.2.0-rc.2',
        newest: 'v1.3.0-rc.1',
        incompatible: 'v9.0.0-rc.1',
        otherChannel: 'internal-999',
      },
    ])(
      'finds the newest compatible $flavor candidate on a later page',
      async ({
        flavor,
        current,
        older,
        newest,
        incompatible,
        otherChannel,
      }) => {
        mockElectronApp.getVersion.mockReturnValue(current);
        mockFetchResponse((url) => {
          if (requestUrl(url).includes('/tags/'))
            return mockJsonResponse(
              linuxReleaseFixture(requestUrl(url).split('/tags/')[1]),
            );
          if (requestUrl(url).includes('page=2'))
            return mockJsonResponse([
              { ...linuxReleaseFixture(incompatible), assets: [] },
              linuxReleaseFixture(otherChannel),
              { ...linuxReleaseFixture(incompatible), draft: true },
              linuxReleaseFixture(newest),
              linuxReleaseFixture(older),
            ]);
          return mockJsonResponse(
            [linuxReleaseFixture(older)],
            '<https://api.github.com/repos/unstoppabledomains/canopy/releases?per_page=100&page=2>; rel="next"',
          );
        });
        const updater = await importFreshUpdater(undefined, flavor);
        await updater.checkForUpdates();
        expect(updater.getUpdateState()).toMatchObject({
          phase: 'available',
          info: { version: newest.replace(/^v/, '') },
        });
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFetch).toHaveBeenLastCalledWith(
          expect.stringContaining(`/tags/${newest}`),
          expect.anything(),
        );
      },
    );

    it('fails closed rather than claiming the newest release after ten incomplete pages', async () => {
      mockElectronApp.getVersion.mockReturnValue('9999.0.0-internal.126');
      mockFetchResponse((url) => {
        if (requestUrl(url).includes('/tags/'))
          return mockJsonResponse(linuxReleaseFixture('internal-999'));
        const page = Number(new URL(requestUrl(url)).searchParams.get('page'));
        return mockJsonResponse(
          [linuxReleaseFixture('internal-999')],
          `<https://api.github.com/repos/unstoppabledomains/canopy/releases?per_page=100&page=${page + 1}>; rel="next"`,
        );
      });
      const updater = await importFreshUpdater(undefined, 'internal');
      await expect(updater.checkForUpdates()).rejects.toThrow(/Linux/);
      expect(mockFetch).toHaveBeenCalledTimes(10);
      expect(
        mockFetch.mock.calls.every(
          ([url]) => !requestUrl(url).includes('/tags/'),
        ),
      ).toBe(true);
      expect(updater.getUpdateState().phase).toBe('error');
    });

    it.each([
      {
        flavor: 'internal' as const,
        current: '9999.0.0-internal.126',
        selected: 'internal-125',
      },
      {
        flavor: 'internal' as const,
        current: '9999.0.0-internal.126',
        selected: 'internal-126',
      },
      { flavor: 'rc' as const, current: '1.2.0-rc.3', selected: 'v1.2.0-rc.2' },
      { flavor: 'rc' as const, current: '1.2.0-rc.3', selected: 'v1.2.0-rc.3' },
    ])(
      'does not automatically downgrade or reoffer $selected',
      async ({ flavor, current, selected }) => {
        mockElectronApp.getVersion.mockReturnValue(current);
        mockFetchResponse((url) =>
          mockJsonResponse(
            requestUrl(url).includes('/tags/')
              ? linuxReleaseFixture(selected)
              : [linuxReleaseFixture(selected)],
          ),
        );
        const updater = await importFreshUpdater(undefined, flavor);
        await updater.checkForUpdates();
        expect(updater.getUpdateState().phase).toBe('not-available');
      },
    );

    it.each([
      {
        flavor: 'internal' as const,
        current: '9999.0.0-internal.126',
        selected: 'internal-125',
      },
      { flavor: 'rc' as const, current: '1.2.0-rc.3', selected: 'v1.2.0-rc.2' },
    ])(
      'preserves an explicit $flavor downgrade without list traversal',
      async ({ flavor, current, selected }) => {
        mockElectronApp.getVersion.mockReturnValue(current);
        mockFetchResponse(() =>
          mockJsonResponse(linuxReleaseFixture(selected)),
        );
        const updater = await importFreshUpdater(undefined, flavor);
        await updater.checkForVersion({ tag: selected });
        expect(updater.getUpdateState()).toMatchObject({
          phase: 'available',
          target: { tag: selected, relation: 'downgrade' },
        });
        expect(
          mockFetch.mock.calls.every(([url]) =>
            requestUrl(url).includes(`/tags/${selected}`),
          ),
        ).toBe(true);
        expect(mockGetAutoUpdater).not.toHaveBeenCalled();
      },
    );

    it('uses Linux recovery copy for offline checks, never macOS copy', async () => {
      mockFetch.mockRejectedValue(
        new Error('Cannot update while running on a read-only volume'),
      );
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      await expect(updater.checkForUpdates()).rejects.toThrow();
      expect(updater.getUpdateState().message).toMatch(/Linux/);
      expect(updater.getUpdateState().message).not.toMatch(
        /macOS|Applications|DMG/,
      );
      updater.stopUpdater();
    });

    it('does not publish an old in-flight check after stop/restart', async () => {
      let resolveResponse: (value: Response) => void = () => undefined;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
      );
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      const check = updater.checkForUpdates();
      await flushMicrotasks();
      updater.stopUpdater();
      updater.startUpdater(() => createWindow());
      resolveResponse(
        new Response(
          `version: 1.2.0\nfiles:\n - url: canopy-1.2.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
        ),
      );
      await check;
      expect(updater.getUpdateState()).toEqual({ phase: 'idle' });
      updater.stopUpdater();
    });

    it('ignores stale installer events and never queues an install', async () => {
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      for (const event of [
        'update-downloaded',
        'download-progress',
        'update-available',
      ])
        mockAutoUpdater.emit(event, { version: '1.2.0', percent: 100 });
      updater.reportRendererBusyState(false);
      jest.advanceTimersByTime(1_000);
      expect(updater.getUpdateState()).toEqual({ phase: 'idle' });
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(mockGetAutoUpdater).not.toHaveBeenCalled();
      updater.stopUpdater();
    });

    it.each(['1.0.0', '0.9.0'])(
      'does not offer a stable downgrade or current release %s',
      async (version) => {
        mockFetch.mockResolvedValue(
          new Response(
            `version: ${version}\nfiles:\n - url: canopy-${version}-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
          ),
        );
        const updater = await importFreshUpdater();
        await updater.checkForUpdates();
        expect(updater.getUpdateState().phase).toBe('not-available');
      },
    );

    it('checks an explicit RC target without activating its installer', async () => {
      mockElectronApp.getVersion.mockReturnValue('1.2.0-rc.1');
      mockFetch.mockImplementation(() =>
        Promise.resolve(mockJsonResponse(linuxReleaseFixture('v1.2.0-rc.3'))),
      );
      const updater = await importFreshUpdater(undefined, 'rc');
      await updater.checkForVersion({ tag: 'v1.2.0-rc.3' });
      expect(updater.getUpdateState()).toMatchObject({
        phase: 'available',
        target: { tag: 'v1.2.0-rc.3' },
        info: { version: '1.2.0-rc.3' },
      });
      expect(mockGetAutoUpdater).not.toHaveBeenCalled();
    });

    it('replaces a prior targeted error with the current Linux failure', async () => {
      const updater = await importFreshUpdater(undefined, 'rc');
      mockLinuxDebInstalled.mockResolvedValue(false);
      await expect(
        updater.checkForVersion({ tag: 'v1.2.0-rc.3' }),
      ).rejects.toThrow(LINUX_COPY.unsupported);
      mockLinuxDebInstalled.mockResolvedValue(true);
      mockedResolveGitHubToken.mockResolvedValue('');
      await expect(
        updater.checkForVersion({ tag: 'v1.2.0-rc.3' }),
      ).rejects.toThrow(/Connect GitHub/);
      expect(updater.getUpdateState().message).toMatch(/Connect GitHub/);
      expect(updater.getUpdateState().message).not.toMatch(
        /require an installed/,
      );
    });
  });

  it('tracks updater events in UpdateState and forwards renderer events', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();

    updater.startUpdater(() => window);

    mockAutoUpdater.emit('checking-for-update');
    expect(updater.getUpdateState().phase).toBe('checking');
    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.updateEvent,
      { type: 'checking' },
    );

    mockAutoUpdater.emit('update-available', {
      version: '1.2.0',
      releaseDate: '2026-03-10T00:00:00.000Z',
      releaseNotes: 'Bug fixes',
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'available',
      info: {
        version: '1.2.0',
        releaseDate: '2026-03-10T00:00:00.000Z',
        releaseNotes: 'Bug fixes',
      },
    });

    mockAutoUpdater.emit('download-progress', {
      percent: 42,
      bytesPerSecond: 1200,
      transferred: 420,
      total: 1000,
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloading',
      progress: {
        percent: 42,
        bytesPerSecond: 1200,
        transferred: 420,
        total: 1000,
      },
    });

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.2.0',
      releaseDate: '2026-03-10T00:00:00.000Z',
      releaseNotes: 'Bug fixes',
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      info: { version: '1.2.0' },
    });

    mockAutoUpdater.emit('error', new Error('boom'));
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'error',
      message:
        'Canopy updates are temporarily unavailable. Please try again later.',
    });
  });

  it('adds recovery guidance for macOS updater code signature validation errors', async () => {
    const updater = await importFreshUpdater({
      id: 'unstoppable-code',
      displayName: 'Unstoppable Code',
      release: { artifactPrefix: 'unstoppable-code' },
    });
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit(
      'error',
      new Error(
        'Code signature at URL file:///Users/nick/Library/Caches/com.unstoppable.code.ui.ShipIt/update.95tnEHx/Unstoppable%20Code.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
      ),
    );

    const state = updater.getUpdateState();
    expect(state.phase).toBe('error');
    expect(state.message).toContain(
      'Download and install the latest Unstoppable Code DMG manually once',
    );
  });

  it('shows internal release indicators for counter-based updater versions', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    const window = createWindow();

    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-available', {
      version: '9999.0.0-internal.124',
      releaseDate: '2026-03-10T00:00:00.000Z',
      releaseNotes: null,
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'available',
      info: {
        version: 'internal-124',
      },
    });

    mockAutoUpdater.emit('update-downloaded', {
      version: '0.25.2-internal.126+sha.abc1234',
      releaseDate: '2026-03-10T00:00:00.000Z',
      releaseNotes: null,
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      info: {
        version: 'internal-126',
      },
    });
  });

  it('adds recovery guidance for macOS updater read-only volume errors', async () => {
    const updater = await importFreshUpdater({
      id: 'unstoppable-code',
      displayName: 'Unstoppable Code',
      release: { artifactPrefix: 'unstoppable-code' },
    });
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit(
      'error',
      new Error(
        "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again. If you're on macOS Sierra or later, you'll need to move the application out of the Downloads directory. See https://github.com/Squirrel/Squirrel.Mac/issues/182 for more information.",
      ),
    );

    const state = updater.getUpdateState();
    expect(state.phase).toBe('error');
    expect(state.message).toContain(
      'Unstoppable Code cannot auto-update from its current location',
    );
    expect(state.message).toContain('drag it to the Applications folder');
  });

  it('surfaces a clear auth error when no GitHub token is available', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    mockedResolveGitHubToken.mockResolvedValue('');

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'Authenticate with `gh auth login` or save a PAT',
    );

    expect(updater.getUpdateState().phase).toBe('error');
    expect(updater.getUpdateState().message).toContain('gh auth login');
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('configures stable updates to read the generic CDN feed without GitHub auth', async () => {
    const updater = await importFreshUpdater();
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();

    expect(mockedResolveGitHubToken).not.toHaveBeenCalled();
    expect(getLastFeedOptions()).toEqual({
      provider: 'generic',
      channel: 'latest',
      url: 'https://releases.unstoppable.ai/desktop/canopy',
    });
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it('keeps stable local setup errors actionable', async () => {
    const updater = await importFreshUpdater();
    mockElectronApp.isPackaged = false;

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'App updates are only available in packaged Canopy builds.',
    );

    expect(updater.getUpdateState()).toMatchObject({
      phase: 'error',
      message: 'App updates are only available in packaged Canopy builds.',
    });
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('keeps stable update feed configuration errors actionable', async () => {
    const updater = await importFreshUpdater(undefined, 'stable', '');

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'Canopy updates are not configured for this build.',
    );

    expect(updater.getUpdateState()).toMatchObject({
      phase: 'error',
      message: 'Canopy updates are not configured for this build.',
    });
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('masks stable backend errors reported by electron-updater', async () => {
    const updater = await importFreshUpdater();
    mockAutoUpdater.checkForUpdates.mockRejectedValue(
      new Error('provider returned 503'),
    );

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'provider returned 503',
    );

    expect(updater.getUpdateState()).toMatchObject({
      phase: 'error',
      message:
        'Canopy updates are temporarily unavailable. Please try again later.',
    });
  });

  it('masks stable backend errors with the active brand name', async () => {
    const updater = await importFreshUpdater({
      id: 'unstoppable-code',
      displayName: 'Unstoppable Code',
      release: { artifactPrefix: 'unstoppable-code' },
    });
    mockAutoUpdater.checkForUpdates.mockRejectedValue(
      new Error('provider returned 503'),
    );

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'provider returned 503',
    );

    const state = updater.getUpdateState();
    expect(state.phase).toBe('error');
    expect(state.message).toBe(
      'Unstoppable Code updates are temporarily unavailable. Please try again later.',
    );
    expect(state.message).not.toContain('Canopy');
  });

  it('reports stable feed configuration errors with the active brand name', async () => {
    const updater = await importFreshUpdater(
      {
        id: 'unstoppable-code',
        displayName: 'Unstoppable Code',
        release: { artifactPrefix: 'unstoppable-code' },
      },
      'stable',
      '',
    );

    await expect(updater.checkForUpdates()).rejects.toThrow(
      'Unstoppable Code updates are not configured for this build.',
    );

    const state = updater.getUpdateState();
    expect(state.phase).toBe('error');
    expect(state.message).toBe(
      'Unstoppable Code updates are not configured for this build.',
    );
    expect(state.message).not.toContain('CANOPY_');
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('configures stable branded updates to read branded CDN metadata channels', async () => {
    const updater = await importFreshUpdater({
      id: 'somebrand',
      displayName: 'SomeBrand',
      release: { artifactPrefix: 'somebrand' },
    });
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();

    expect(mockedResolveGitHubToken).not.toHaveBeenCalled();
    expect(getLastFeedOptions()).toEqual({
      provider: 'generic',
      channel: 'somebrand',
      url: 'https://releases.unstoppable.ai/desktop/somebrand',
    });
  });

  it('configures internal updates to read the default brand release channel', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    updater.startUpdater(() => null);
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();

    const feedOptions = getLastFeedOptions();
    expect(feedOptions).toEqual(
      expect.objectContaining({
        provider: 'custom',
        owner: 'unstoppabledomains',
        repo: 'canopy',
        private: true,
        token: 'ghp_test_token_123',
        channel: 'latest',
      }),
    );
    if (!isFeedOptions(feedOptions)) {
      throw new Error('Expected feed options object');
    }
    expect(typeof feedOptions.updateProvider).toBe('function');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('configures internal branded updates to read branded release channels', async () => {
    const updater = await importFreshUpdater(
      {
        id: 'somebrand',
        displayName: 'SomeBrand',
        release: { artifactPrefix: 'somebrand' },
      },
      'internal',
    );
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();

    const feedOptions = getLastFeedOptions();
    expect(feedOptions).toEqual(
      expect.objectContaining({
        provider: 'custom',
        channel: 'somebrand',
      }),
    );
    if (!isFeedOptions(feedOptions)) {
      throw new Error('Expected feed options object');
    }
    expect(typeof feedOptions.updateProvider).toBe('function');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('configures rc branded updates to read rc GitHub prereleases', async () => {
    const updater = await importFreshUpdater(
      {
        id: 'somebrand',
        displayName: 'SomeBrand',
        release: { artifactPrefix: 'somebrand' },
      },
      'rc',
    );
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();

    const feedOptions = getLastFeedOptions();
    expect(feedOptions).toEqual(
      expect.objectContaining({
        provider: 'custom',
        channel: 'somebrand',
        releaseFlavor: 'rc',
      }),
    );
    if (!isFeedOptions(feedOptions)) {
      throw new Error('Expected feed options object');
    }
    expect(typeof feedOptions.updateProvider).toBe('function');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('rejects targeted update checks in stable builds before GitHub requests', async () => {
    const updater = await importFreshUpdater(undefined, 'stable');

    await expect(
      updater.checkForVersion({ tag: 'internal-124' }),
    ).rejects.toThrow('Targeted updates are not available in stable builds.');
    await expect(updater.listTargetUpdateVersions()).rejects.toThrow(
      'Targeted updates are not available in stable builds.',
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it('configures targeted internal updates with an exact tag and downgrade support', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        tag_name: 'internal-124',
        name: 'internal-124',
        prerelease: true,
        draft: false,
        published_at: '2026-05-01T00:00:00.000Z',
        assets: defaultBrandMetadataAssets(),
      }),
    );

    await updater.checkForVersion({ tag: 'internal-124' });

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://api.github.com/repos/unstoppabledomains/canopy/releases/tags/internal-124',
    );
    expect(fetchCall?.[1]).toMatchObject({
      headers: {
        authorization: 'token ghp_test_token_123',
      },
    });
    expect(getLastFeedOptions()).toEqual(
      expect.objectContaining({
        provider: 'custom',
        releaseFlavor: 'internal',
        targetReleaseTag: 'internal-124',
      }),
    );
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
    expect(mockAutoUpdater.allowDowngrade).toBe(true);

    mockAutoUpdater.checkForUpdates.mockClear();
    await updater.checkForUpdates();
    expect(mockAutoUpdater.allowDowngrade).toBe(false);
    const latestFeedOptions = getLastFeedOptions();
    expect(isFeedOptions(latestFeedOptions)).toBe(true);
    if (!isFeedOptions(latestFeedOptions)) {
      throw new Error('Expected feed options after update check.');
    }
    expect(latestFeedOptions.targetReleaseTag).toBeUndefined();
  });

  it('rejects targeted update checks while another check is in progress', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    const checkDeferred = createDeferred();
    mockAutoUpdater.checkForUpdates.mockReturnValueOnce(checkDeferred.promise);

    const checkPromise = updater.checkForUpdates();

    await expect(
      updater.checkForVersion({ tag: 'internal-124' }),
    ).rejects.toThrow('An update check is already in progress.');

    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/unstoppabledomains/canopy/releases/tags/internal-124',
      expect.anything(),
    );

    checkDeferred.resolve();
    await checkPromise;
  });

  it('lists only strict internal release targets with the expected metadata asset', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        {
          tag_name: 'internal-124',
          name: 'internal-124',
          prerelease: true,
          draft: false,
          published_at: '2026-05-01T00:00:00.000Z',
          assets: defaultBrandMetadataAssets(),
        },
        {
          tag_name: 'internal-v0.25.2-123-deadbee',
          name: 'internal-v0.25.2-123-deadbee',
          prerelease: true,
          draft: false,
          assets: defaultBrandMetadataAssets(),
        },
        {
          tag_name: 'internal-125',
          name: 'internal-125',
          prerelease: true,
          draft: false,
          assets: [{ name: 'other.yml', url: 'asset' }],
        },
      ]),
    );

    const result = await updater.listTargetUpdateVersions();

    expect(result).toEqual({
      items: [
        {
          tag: 'internal-124',
          version: 'internal-124',
          name: 'internal-124',
          releaseDate: '2026-05-01T00:00:00.000Z',
          relation: 'downgrade',
        },
      ],
      nextCursor: null,
    });
  });

  it.each(['darwin', 'win32', 'linux'])(
    'never activates official updates in a packaged source build on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const oldSourceBuild = process.env.CANOPY_SOURCE_BUILD;
      process.env.CANOPY_SOURCE_BUILD = 'false';
      try {
        const updater = await importFreshUpdater(
          undefined,
          'stable',
          'https://releases.unstoppable.ai',
          true,
        );
        const window = createWindow();
        updater.startUpdater(() => window);
        await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000 + 6_000);
        for (const event of ['update-available', 'update-downloaded']) {
          mockAutoUpdater.emit(event, { version: '1.2.0' });
        }
        await expect(updater.checkForUpdates()).rejects.toThrow('source-built');
        await expect(
          updater.checkForVersion({ tag: 'v1.2.0-rc.1' }),
        ).rejects.toThrow('source-built');
        await expect(updater.listTargetUpdateVersions()).rejects.toThrow(
          'source-built',
        );
        await expect(updater.downloadUpdate()).rejects.toThrow('source-built');
        await expect(updater.installUpdate()).rejects.toThrow('source-built');
        expect(() => updater.scheduleUpdate()).toThrow('source-built');
        const state = updater.getUpdateState();
        expect(state.phase).toBe('error');
        expect(state.message).toContain('source-built');
        expect(window.webContents.send).toHaveBeenCalledWith(
          IPC_CHANNELS.updateEvent,
          expect.objectContaining({
            type: 'error',
            message: `App updates are disabled in source-built ${BRAND.displayName}. Rebuild from source to update.`,
          }),
        );
        updater.reportRendererBusyState(false);
        emitChatSessionActivity();
        await jest.advanceTimersByTimeAsync(6_000);
        updater.stopUpdater();

        expect(mockGetAutoUpdater).not.toHaveBeenCalled();
        expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
        expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
        expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockedResolveGitHubToken).not.toHaveBeenCalled();
        expect(mockChatSessionActivityListeners.size).toBe(0);
      } finally {
        if (oldSourceBuild === undefined)
          delete process.env.CANOPY_SOURCE_BUILD;
        else process.env.CANOPY_SOURCE_BUILD = oldSourceBuild;
      }
    },
  );

  it('keeps official updates enabled regardless of the runtime source-build variable', async () => {
    const oldSourceBuild = process.env.CANOPY_SOURCE_BUILD;
    process.env.CANOPY_SOURCE_BUILD = 'true';
    try {
      const updater = await importFreshUpdater();
      updater.startUpdater(() => createWindow());
      await jest.advanceTimersByTimeAsync(6_000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
      mockAutoUpdater.emit('update-downloaded', { version: '1.2.0' });
      await updater.installUpdate();
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      updater.stopUpdater();
    } finally {
      if (oldSourceBuild === undefined) delete process.env.CANOPY_SOURCE_BUILD;
      else process.env.CANOPY_SOURCE_BUILD = oldSourceBuild;
    }
  });

  it('skips automatic startup checks in unpackaged builds', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    mockElectronApp.isPackaged = false;

    updater.startUpdater(() => window);
    await jest.advanceTimersByTimeAsync(6_000);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent check and download requests', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    const checkDeferred = createDeferred();
    const downloadDeferred = createDeferred();

    mockAutoUpdater.checkForUpdates.mockReturnValueOnce(checkDeferred.promise);
    mockAutoUpdater.downloadUpdate.mockReturnValueOnce(
      downloadDeferred.promise,
    );

    const firstCheck = updater.checkForUpdates();
    const secondCheck = updater.checkForUpdates();

    checkDeferred.resolve();
    await Promise.all([firstCheck, secondCheck]);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    mockAutoUpdater.emit('update-available', {
      version: '1.2.0',
      releaseDate: '2026-03-10T00:00:00.000Z',
      releaseNotes: null,
    });

    const firstDownload = updater.downloadUpdate();
    const secondDownload = updater.downloadUpdate();

    downloadDeferred.resolve();
    await Promise.all([firstDownload, secondDownload]);
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers install until renderer stays idle when "install when idle" is requested', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    // Renderer reports busy first.
    updater.reportRendererBusyState(true);
    updater.scheduleUpdate();

    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      installPending: true,
    });
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.updateEvent,
      { type: 'install-pending', pending: true },
    );

    // A momentary idle report does not restart the app immediately.
    updater.reportRendererBusyState(false);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    // If work resumes during the debounce, the pending restart is cancelled.
    updater.reportRendererBusyState(true);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    // Once renderer stays idle for the full debounce, the install fires.
    updater.reportRendererBusyState(false);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('installs after the idle debounce when "install when idle" is requested while already idle', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    updater.reportRendererBusyState(false);
    updater.scheduleUpdate();

    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('waits for live provider background work and reevaluates on its terminal activity', async () => {
    const updater = await importFreshUpdater();
    updater.startUpdater(() => createWindow());
    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });
    // The foreground/renderer is idle; the main busy predicate includes a live Agent.
    mockHasActiveChatWork.mockReturnValue(true);
    updater.reportRendererBusyState(false);
    updater.scheduleUpdate();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    mockHasActiveChatWork.mockReturnValue(false);
    emitChatSessionActivity();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not install while main still has active chat work after renderer reports idle', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    mockHasActiveChatWork.mockReturnValue(true);
    updater.reportRendererBusyState(false);
    updater.scheduleUpdate();

    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    mockHasActiveChatWork.mockReturnValue(false);
    emitChatSessionActivity();
    await jest.advanceTimersByTimeAsync(4_999);

    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('waits for install cleanup before restart-now install', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    const cleanupDeferred = createDeferred();
    const beforeInstall = jest.fn(() => cleanupDeferred.promise);
    updater.startUpdater(() => window, beforeInstall);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    const installPromise = updater.installUpdate();
    await Promise.resolve();

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    cleanupDeferred.resolve();
    await installPromise;

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('waits for install cleanup before deferred idle install', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    const cleanupDeferred = createDeferred();
    const beforeInstall = jest.fn(() => cleanupDeferred.promise);
    updater.startUpdater(() => window, beforeInstall);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    updater.reportRendererBusyState(true);
    updater.scheduleUpdate();
    updater.reportRendererBusyState(false);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    cleanupDeferred.resolve();
    await Promise.resolve();

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('cancelScheduledUpdate clears the pending flag and does not install on idle', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    updater.reportRendererBusyState(true);
    updater.scheduleUpdate();
    updater.cancelScheduledUpdate();

    expect(updater.getUpdateState().installPending).toBe(false);
    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.updateEvent,
      { type: 'install-pending', pending: false },
    );

    updater.reportRendererBusyState(false);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('rejects "install when idle" when no update is downloaded', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    expect(() => updater.scheduleUpdate()).toThrow(
      'No downloaded update is ready to install.',
    );
    expect(updater.getUpdateState().phase).toBe('idle');
  });

  it('does not throw when renderer windows are missing or destroyed', async () => {
    const updater = await importFreshUpdater();

    updater.startUpdater(() => null);
    expect(() => {
      mockAutoUpdater.emit('update-available', {
        version: '1.2.0',
        releaseDate: '2026-03-10T00:00:00.000Z',
        releaseNotes: null,
      });
    }).not.toThrow();

    const destroyedWindow = createWindow(true);
    updater.stopUpdater();
    updater.startUpdater(() => destroyedWindow);

    expect(() => {
      mockAutoUpdater.emit('error', new Error('still safe'));
    }).not.toThrow();
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('automatically starts a background download when autoDownloadUpdates is on', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      autoDownloadUpdates: true,
    } as Awaited<ReturnType<typeof readPreferencesFile>>);

    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.downloadUpdate.mockResolvedValueOnce(undefined);

    mockAutoUpdater.emit('update-available', {
      version: '1.4.0',
      releaseDate: '2026-05-01T00:00:00.000Z',
      releaseNotes: null,
    });

    await flushMicrotasks();

    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not start a background download when autoDownloadUpdates is off', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      autoDownloadUpdates: false,
    } as Awaited<ReturnType<typeof readPreferencesFile>>);

    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-available', {
      version: '1.4.0',
      releaseDate: '2026-05-01T00:00:00.000Z',
      releaseNotes: null,
    });

    await flushMicrotasks();

    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('reuses the resolved GitHub token across subsequent updater calls', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);
    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

    await updater.checkForUpdates();
    mockAutoUpdater.emit('update-available', {
      version: '1.4.0',
      releaseDate: '2026-05-01T00:00:00.000Z',
      releaseNotes: null,
    });
    await updater.downloadUpdate();
    await updater.checkForUpdates();

    expect(mockedResolveGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the GitHub token after an updater error', async () => {
    const updater = await importFreshUpdater(undefined, 'internal');
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    await updater.checkForUpdates();
    expect(mockedResolveGitHubToken).toHaveBeenCalledTimes(1);

    mockAutoUpdater.emit('error', new Error('feed unreachable'));

    await updater.checkForUpdates();
    expect(mockedResolveGitHubToken).toHaveBeenCalledTimes(2);
  });

  it('ignores late renderer busy updates after the updater stops', async () => {
    const updater = await importFreshUpdater();
    const window = createWindow();
    updater.startUpdater(() => window);

    mockAutoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseDate: '2026-04-01T00:00:00.000Z',
      releaseNotes: null,
    });

    updater.reportRendererBusyState(true);
    updater.scheduleUpdate();
    updater.stopUpdater();
    updater.reportRendererBusyState(false);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      installPending: false,
    });
  });
});
