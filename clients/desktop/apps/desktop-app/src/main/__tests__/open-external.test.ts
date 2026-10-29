const mockOpenExternal = jest.fn<Promise<void>, [string]>();
const mockIsE2eBuild = jest.fn<boolean, []>();
const mockGetE2eExternalOpenCaptureUrl = jest.fn<string | null, []>();
const mockReadPreferencesFile = jest.fn();
const mockExecFile = jest.fn();
const mockSpawn = jest.fn();
const mockOpenPath = jest.fn<Promise<string>, [string]>();
const mockGetApplicationInfoForProtocol = jest.fn<
  Promise<{ path: string; name: string }>,
  [string]
>();
const mockIsDefaultProtocolClient = jest.fn<boolean, [string]>();
const mockLogMainProcessError = jest.fn<void, [string, unknown]>();

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]): unknown => mockExecFile(...args),
  spawn: (...args: unknown[]): unknown => mockSpawn(...args),
}));

jest.mock('electron', () => ({
  app: {
    getApplicationInfoForProtocol: (
      url: string,
    ): Promise<{ path: string; name: string }> =>
      mockGetApplicationInfoForProtocol(url),
    isDefaultProtocolClient: (protocol: string): boolean =>
      mockIsDefaultProtocolClient(protocol),
  },
  shell: {
    openExternal: (url: string): Promise<void> => mockOpenExternal(url),
    openPath: (path: string): Promise<string> => mockOpenPath(path),
  },
}));

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  getE2eExternalOpenCaptureUrl: (): string | null =>
    mockGetE2eExternalOpenCaptureUrl(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: (message: string, error: unknown): void =>
    mockLogMainProcessError(message, error),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): unknown => mockReadPreferencesFile(),
}));

// Keep the CAN-4692 settings hand-off out of these cases; it has its own
// suite in app-link-settings-routing.test.ts.
jest.mock('../services/hosted-settings-feature-flag', () => ({
  isHostedSettingsEnabled: (): boolean => false,
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => {
    throw new Error('Canopy cloud base URL is not configured in this suite');
  },
}));

import { EventEmitter } from 'node:events';
import {
  consumeExternalOpenLoopGuard,
  openExternalGuarded,
  openFileInDefaultWebBrowser,
} from '../lib/open-external';
import {
  openLinkInBuiltInBrowser,
  resetAppLinkRouterForTests,
  resolveAppLinkRequest,
  routeAppLink,
  routeSafeNavigation,
} from '../browser/app-link-router';

describe('openExternalGuarded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(null);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
  });

  it('opens the URL in the system browser for production builds', async () => {
    // The echo fallback is platform-specific; pin one with a fallback so the
    // assertion does not depend on the host OS running the suite.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);

    try {
      await openExternalGuarded('https://example.com');

      expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com');
      await expect(
        consumeExternalOpenLoopGuard('https://example.com'),
      ).resolves.toBe(true);
      await expect(
        consumeExternalOpenLoopGuard('https://example.com'),
      ).resolves.toBeNull();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('does not retain loop guards for non-web external protocols', async () => {
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);

    await openExternalGuarded('mailto:hello@example.com');

    expect(mockOpenExternal).toHaveBeenCalledWith('mailto:hello@example.com');
    await expect(
      consumeExternalOpenLoopGuard('mailto:hello@example.com'),
    ).resolves.toBeNull();
  });

  it('rolls back the loop guard when the OS open fails', async () => {
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockRejectedValue(new Error('no browser available'));

    await expect(
      openExternalGuarded('https://example.com/retry-after-failure'),
    ).rejects.toThrow('no browser available');
    await expect(
      consumeExternalOpenLoopGuard('https://example.com/retry-after-failure'),
    ).resolves.toBeNull();
  });

  it('hands a guarded macOS echo to Safari instead of silently consuming it', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(null),
    );

    try {
      await openExternalGuarded('https://example.com/sign-in');

      await expect(
        consumeExternalOpenLoopGuard('https://example.com/sign-in'),
      ).resolves.toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/open',
        ['-b', 'com.apple.Safari', 'https://example.com/sign-in'],
        expect.any(Function),
      );
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('matches a guarded OS echo after equivalent URL canonicalization', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);

    try {
      await openExternalGuarded('https://EXAMPLE.com:443');

      await expect(
        consumeExternalOpenLoopGuard('https://example.com/'),
      ).resolves.toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/open',
        ['-b', 'com.apple.Safari', 'https://example.com/'],
        expect.any(Function),
      );
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('retains a guarded echo until the non-recursive fallback succeeds', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(new Error('Safari unavailable')),
    );

    try {
      await openExternalGuarded('https://example.com/retry-external');
      await expect(
        consumeExternalOpenLoopGuard('https://example.com/retry-external'),
      ).resolves.toBe(false);

      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          callback: (error: Error | null) => void,
        ) => callback(null),
      );
      await expect(
        consumeExternalOpenLoopGuard('https://example.com/retry-external'),
      ).resolves.toBe(true);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('hands a guarded Windows echo to the protected Edge protocol', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);

    try {
      await openExternalGuarded('https://example.com/sign-in');
      await expect(
        consumeExternalOpenLoopGuard('https://example.com/sign-in'),
      ).resolves.toBe(true);
      expect(mockOpenExternal.mock.calls).toEqual([
        ['https://example.com/sign-in'],
        ['microsoft-edge:https://example.com/sign-in'],
      ]);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('does not report a guarded Linux echo as externally delivered', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);

    try {
      await openExternalGuarded('https://example.com/sign-in');
      await expect(
        consumeExternalOpenLoopGuard('https://example.com/sign-in'),
      ).resolves.toBe(false);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('is a no-op under the E2E build', async () => {
    mockIsE2eBuild.mockReturnValue(true);

    await openExternalGuarded('https://example.com');

    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('posts the external URL to the E2E capture endpoint when configured', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(
      'http://127.0.0.1:43210/external-open',
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await openExternalGuarded('https://example.com/authorize?state=abc');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:43210/external-open',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/authorize?state=abc',
          }),
        },
      );
      expect(mockOpenExternal).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('contains E2E capture endpoint HTTP failures', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(
      'http://127.0.0.1:43210/external-open',
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }));

    try {
      await expect(
        openExternalGuarded('https://example.com/authorize?state=abc'),
      ).resolves.toBeUndefined();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('contains E2E capture endpoint network failures', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(
      'http://127.0.0.1:43210/external-open',
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('capture endpoint unavailable'));

    try {
      await expect(
        openExternalGuarded('https://example.com/authorize?state=abc'),
      ).resolves.toBeUndefined();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('openFileInDefaultWebBrowser', () => {
  const NO_BROWSER = "Couldn't find a default web browser to open this file.";
  const MAC_FILE_URL = 'file:///Users/me/site/index.html';
  const WINDOWS_FILE_URL = 'file:///C:/Users/me/site/index.html?x=1#top';
  const MAC_CANOPY_EXEC = '/Applications/Canopy.app/Contents/MacOS/Canopy';
  const WINDOWS_CANOPY_EXEC = 'C:\\Program Files\\Canopy\\Canopy.exe';
  const CHROME_APP = '/Applications/Google Chrome.app';
  const CHROME_EXE =
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const EDGE_EXE =
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  type SpawnedChild = EventEmitter & { unref: jest.Mock<void, []> };
  let spawnedChildren: SpawnedChild[];
  let spawnOutcome: 'spawn' | 'error';

  async function withHost(
    platform: NodeJS.Platform,
    execPath: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const execPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'execPath',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform,
    });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      writable: true,
      value: execPath,
    });
    try {
      await run();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (execPathDescriptor) {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
    }
  }

  function defaultHandler(path: string, edgePath = EDGE_EXE): void {
    mockGetApplicationInfoForProtocol.mockImplementation((url: string) =>
      Promise.resolve({
        path:
          url === 'microsoft-edge://canopy-default-check.invalid'
            ? edgePath
            : path,
        name: 'Browser',
      }),
    );
  }

  function expectNoShellOpen(): void {
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockOpenPath).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsE2eBuild.mockReturnValue(false);
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(null);
    mockIsDefaultProtocolClient.mockReturnValue(false);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
    spawnedChildren = [];
    spawnOutcome = 'spawn';
    mockSpawn.mockImplementation(() => {
      const child: SpawnedChild = Object.assign(new EventEmitter(), {
        unref: jest.fn<void, []>(),
      });
      spawnedChildren.push(child);
      const outcome = spawnOutcome;
      process.nextTick(() => {
        if (outcome === 'spawn') child.emit('spawn');
        else child.emit('error', new Error('spawn ENOENT'));
      });
      return child;
    });
  });

  it('opens a macOS file page in the default browser application', async () => {
    defaultHandler(CHROME_APP);

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(MAC_FILE_URL);
    });

    expect(mockGetApplicationInfoForProtocol).toHaveBeenCalledWith(
      'https://canopy-default-check.invalid',
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', CHROME_APP, '/Users/me/site/index.html'],
      expect.any(Function),
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('rejects when macOS open reports a failure', async () => {
    defaultHandler(CHROME_APP);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(new Error('Command failed with exit code 1')),
    );

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await expect(openFileInDefaultWebBrowser(MAC_FILE_URL)).rejects.toThrow(
        NO_BROWSER,
      );
    });
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'Command failed with exit code 1' }),
    );
    expectNoShellOpen();
  });

  it('spawns the Windows default browser with the file URL', async () => {
    defaultHandler(CHROME_EXE);

    await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(WINDOWS_FILE_URL);
    });

    // No `windowsHide`: it starts the GUI browser with SW_HIDE.
    expect(mockSpawn).toHaveBeenCalledWith(CHROME_EXE, [WINDOWS_FILE_URL], {
      detached: true,
      stdio: 'ignore',
    });
    expect(spawnedChildren[0]?.unref).toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('rejects when the Windows browser cannot be spawned', async () => {
    defaultHandler(CHROME_EXE);
    spawnOutcome = 'error';

    await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
      await expect(
        openFileInDefaultWebBrowser(WINDOWS_FILE_URL),
      ).rejects.toThrow(NO_BROWSER);
    });
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'spawn ENOENT' }),
    );
    expectNoShellOpen();
  });

  it('falls back to Safari when the macOS default browser bundle is this app', async () => {
    defaultHandler('/Applications/Canopy.app/');

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(MAC_FILE_URL);
    });

    expect(mockExecFile.mock.calls).toEqual([
      [
        '/usr/bin/open',
        ['-b', 'com.apple.Safari', '/Users/me/site/index.html'],
        expect.any(Function),
      ],
    ]);
    expectNoShellOpen();
  });

  it('falls back to Safari when this app is the default https client', async () => {
    defaultHandler('/Applications/Some Other.app');
    mockIsDefaultProtocolClient.mockReturnValue(true);

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(MAC_FILE_URL);
    });

    expect(mockIsDefaultProtocolClient).toHaveBeenCalledWith('https');
    expect(mockExecFile.mock.calls).toEqual([
      [
        '/usr/bin/open',
        ['-b', 'com.apple.Safari', '/Users/me/site/index.html'],
        expect.any(Function),
      ],
    ]);
    expectNoShellOpen();
  });

  it('does not treat a sibling bundle with a shared name prefix as this app', async () => {
    defaultHandler('/Applications/Can');

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(MAC_FILE_URL);
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', '/Applications/Can', '/Users/me/site/index.html'],
      expect.any(Function),
    );
  });

  it('falls back to Edge when the Windows default browser is this app', async () => {
    defaultHandler('c:\\program files\\canopy\\CANOPY.EXE');

    await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
      await openFileInDefaultWebBrowser(WINDOWS_FILE_URL);
    });

    expect(mockGetApplicationInfoForProtocol).toHaveBeenCalledWith(
      'microsoft-edge://canopy-default-check.invalid',
    );
    expect(mockSpawn.mock.calls).toEqual([
      [EDGE_EXE, [WINDOWS_FILE_URL], { detached: true, stdio: 'ignore' }],
    ]);
    expectNoShellOpen();
  });

  it('rejects when the Windows Edge fallback also resolves to this app', async () => {
    defaultHandler(WINDOWS_CANOPY_EXEC, WINDOWS_CANOPY_EXEC);

    await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
      await expect(
        openFileInDefaultWebBrowser(WINDOWS_FILE_URL),
      ).rejects.toThrow(NO_BROWSER);
    });
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('rejects when the Windows Edge lookup fails', async () => {
    mockGetApplicationInfoForProtocol.mockImplementation((url: string) =>
      url === 'microsoft-edge://canopy-default-check.invalid'
        ? Promise.reject(new Error('No application registered'))
        : Promise.resolve({ path: WINDOWS_CANOPY_EXEC, name: 'Canopy' }),
    );

    await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
      await expect(
        openFileInDefaultWebBrowser(WINDOWS_FILE_URL),
      ).rejects.toThrow(NO_BROWSER);
    });
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('rejects when the default browser lookup fails', async () => {
    mockGetApplicationInfoForProtocol.mockRejectedValue(
      new Error('No application registered'),
    );

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await expect(openFileInDefaultWebBrowser(MAC_FILE_URL)).rejects.toThrow(
        NO_BROWSER,
      );
    });
    expect(mockExecFile).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it.each(['', '   '])(
    'rejects when the default browser path is %j',
    async (path) => {
      defaultHandler(path);

      await withHost('darwin', MAC_CANOPY_EXEC, async () => {
        await expect(openFileInDefaultWebBrowser(MAC_FILE_URL)).rejects.toThrow(
          NO_BROWSER,
        );
      });
      await withHost('win32', WINDOWS_CANOPY_EXEC, async () => {
        await expect(
          openFileInDefaultWebBrowser(WINDOWS_FILE_URL),
        ).rejects.toThrow(NO_BROWSER);
      });
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expectNoShellOpen();
    },
  );

  it('rejects on Linux without looking up or launching anything', async () => {
    defaultHandler('/usr/bin/firefox');

    await withHost('linux', '/opt/canopy/canopy', async () => {
      await expect(openFileInDefaultWebBrowser(MAC_FILE_URL)).rejects.toThrow(
        NO_BROWSER,
      );
    });
    expect(mockGetApplicationInfoForProtocol).not.toHaveBeenCalled();
    expect(mockIsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('rejects non-file input without looking up or launching anything', async () => {
    defaultHandler(CHROME_APP);

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await expect(
        openFileInDefaultWebBrowser('https://example.com/index.html'),
      ).rejects.toThrow(NO_BROWSER);
    });
    expect(mockGetApplicationInfoForProtocol).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('posts the file URL to the E2E capture endpoint without launching', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    mockGetE2eExternalOpenCaptureUrl.mockReturnValue(
      'http://127.0.0.1:43210/external-open',
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await withHost('darwin', MAC_CANOPY_EXEC, async () => {
        await openFileInDefaultWebBrowser(MAC_FILE_URL);
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:43210/external-open',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: MAC_FILE_URL }),
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
    expect(mockGetApplicationInfoForProtocol).not.toHaveBeenCalled();
    expect(mockIsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });

  it('is a no-op under the E2E build without a capture endpoint', async () => {
    mockIsE2eBuild.mockReturnValue(true);

    await withHost('darwin', MAC_CANOPY_EXEC, async () => {
      await expect(
        openFileInDefaultWebBrowser(MAC_FILE_URL),
      ).resolves.toBeUndefined();
    });
    expect(mockGetApplicationInfoForProtocol).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expectNoShellOpen();
  });
});

describe('routeAppLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: true,
      inAppBrowserLocalServersOnly: false,
    });
  });

  function makeSender(): {
    id: number;
    isDestroyed: jest.Mock<boolean, []>;
    send: jest.Mock<void, [string, unknown]>;
  } {
    return {
      id: 42,
      isDestroyed: jest.fn(() => false),
      send: jest.fn<void, [string, unknown]>(),
    };
  }

  it('rejects non-web targets before reading preferences or opening the OS handler', async () => {
    await expect(
      routeAppLink({
        url: 'file:///tmp/not-web-content',
        sender: makeSender(),
        source: 'app-link',
      }),
    ).rejects.toThrow('Invalid url: must be an http or https URL');
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('keeps safe non-web navigation on the always-external path', async () => {
    await expect(
      routeSafeNavigation({
        url: 'mailto:hello@example.com',
        sender: makeSender(),
        source: 'app-link',
      }),
    ).resolves.toBe('external');

    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith('mailto:hello@example.com');
  });

  it('delegates first and does not open externally when accepted', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: 'https://example.com/in-app',
      sender,
      source: 'app-link',
    });
    await Promise.resolve();
    const event = sender.send.mock.calls[0]?.[1] as {
      requestId: string;
    };

    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'acknowledge',
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe('in-app');
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('keeps a system-default link pending through reservation until completion', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: 'https://example.com/from-os',
      sender,
      source: 'system-default',
    });
    await Promise.resolve();
    const event = sender.send.mock.calls[0]?.[1] as {
      requestId: string;
    };

    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'acknowledge',
      } as never),
    ).toBe(true);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'reserve',
      } as never),
    ).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();

    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'complete',
      } as never),
    ).toBe(true);
    await expect(pending).resolves.toBe('in-app');
  });

  it('falls back when a reserved system-default delivery never completes', async () => {
    jest.useFakeTimers();
    try {
      const sender = makeSender();
      const pending = routeAppLink({
        url: 'https://example.com/renderer-torn-down',
        sender,
        source: 'system-default',
      });
      await Promise.resolve();
      const event = sender.send.mock.calls[0]?.[1] as { requestId: string };

      expect(
        resolveAppLinkRequest(sender, {
          requestId: event.requestId,
          handled: true,
          phase: 'acknowledge',
        } as never),
      ).toBe(true);
      expect(
        resolveAppLinkRequest(sender, {
          requestId: event.requestId,
          handled: true,
          phase: 'reserve',
        } as never),
      ).toBe(true);

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe('external');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'https://example.com/renderer-torn-down',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back when a reserved system-default delivery reports failure', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: 'https://example.com/placement-failed',
      sender,
      source: 'system-default',
    });
    await Promise.resolve();
    const event = sender.send.mock.calls[0]?.[1] as { requestId: string };

    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'acknowledge',
      }),
    ).toBe(true);
    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'reserve',
      }),
    ).toBe(true);
    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: false,
        phase: 'complete',
      }),
    ).toBe(true);

    await expect(pending).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/placement-failed',
    );
  });

  it('rejects late renderer completion after system-default fallback wins', async () => {
    jest.useFakeTimers();
    try {
      const sender = makeSender();
      const pending = routeAppLink({
        url: 'https://example.com/late-from-os',
        sender,
        source: 'system-default',
      });
      await Promise.resolve();
      const event = sender.send.mock.calls[0]?.[1] as {
        requestId: string;
      };

      expect(
        resolveAppLinkRequest(sender, {
          requestId: event.requestId,
          handled: true,
          phase: 'acknowledge',
        }),
      ).toBe(true);
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe('external');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'https://example.com/late-from-os',
      );
      expect(
        resolveAppLinkRequest(sender, {
          requestId: event.requestId,
          handled: true,
          phase: 'reserve',
        }),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back externally when the renderer declines', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: 'https://example.com/no-worktree',
      sender,
      source: 'app-link',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = sender.send.mock.calls[0]?.[1] as {
      requestId: string;
    };
    resolveAppLinkRequest(sender, {
      requestId: event.requestId,
      handled: false,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/no-worktree',
    );
  });

  it('falls back externally when renderer request delivery throws', async () => {
    const sender = makeSender();
    sender.send.mockImplementation(() => {
      throw new Error('render frame disposed');
    });

    try {
      await expect(
        routeAppLink({
          url: 'https://example.com/reloading-renderer',
          sender,
          source: 'app-link',
        }),
      ).resolves.toBe('external');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'https://example.com/reloading-renderer',
      );
    } finally {
      resetAppLinkRouterForTests();
    }
  });

  it('opens externally and emits the local-only conflict outcome', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: true,
      inAppBrowserLocalServersOnly: true,
    });
    const sender = makeSender();

    const pending = routeAppLink({
      url: 'https://example.com/blocked',
      sender,
      source: 'app-link',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = sender.send.mock.calls[0]?.[1] as {
      requestId: string;
    };
    resolveAppLinkRequest(sender, {
      requestId: event.requestId,
      handled: true,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('external-blocked-by-local-only');

    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/blocked',
    );
    expect(sender.send).toHaveBeenCalledWith(
      'browser:event',
      expect.objectContaining({
        type: 'app-link-local-only-conflict',
        url: 'https://example.com/blocked',
      }),
    );
  });

  it('checks renderer worktree context before reporting a local-only conflict', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: true,
      inAppBrowserLocalServersOnly: true,
    });
    const sender = makeSender();

    const pending = routeAppLink({
      url: 'https://example.com/no-worktree',
      sender,
      source: 'app-link',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = sender.send.mock.calls[0]?.[1] as {
      type: string;
      requestId: string;
      openInApp: boolean;
    };

    expect(event).toMatchObject({
      type: 'app-link-open-requested',
      openInApp: false,
    });
    resolveAppLinkRequest(sender, {
      requestId: event.requestId,
      handled: false,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/no-worktree',
    );
    expect(sender.send).not.toHaveBeenCalledWith(
      'browser:event',
      expect.objectContaining({ type: 'app-link-local-only-conflict' }),
    );
  });

  it('does not fail an external open when the conflict notification throws', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: true,
      inAppBrowserLocalServersOnly: true,
    });
    const sender = makeSender();
    sender.send
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('render frame disposed');
      });

    const pending = routeAppLink({
      url: 'https://example.com/conflict-during-reload',
      sender,
      source: 'system-default',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = sender.send.mock.calls[0]?.[1] as {
      requestId: string;
    };
    resolveAppLinkRequest(sender, {
      requestId: event.requestId,
      handled: true,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('external-blocked-by-local-only');
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/conflict-during-reload',
    );
  });

  it('keeps the disabled preference on the existing external path', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      inAppBrowserLocalServersOnly: false,
    });
    const sender = makeSender();

    await expect(
      routeAppLink({
        url: 'https://example.com/external',
        sender,
        source: 'app-link',
      }),
    ).resolves.toBe('external');

    expect(sender.send).not.toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/external',
    );
  });

  it('routes links from other apps in-app when the app is the default browser', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      useAsSystemDefaultBrowser: true,
      inAppBrowserLocalServersOnly: false,
    });
    const sender = makeSender();

    const pending = routeAppLink({
      url: 'https://example.com/from-mail',
      sender,
      source: 'system-default',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.send).toHaveBeenCalledWith(
      'browser:event',
      expect.objectContaining({
        type: 'app-link-open-requested',
        url: 'https://example.com/from-mail',
        openInApp: true,
      }),
    );
    resetAppLinkRouterForTests();
    await pending;
  });

  it('keeps in-app links external when only the default-browser setting is on', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      useAsSystemDefaultBrowser: true,
      inAppBrowserLocalServersOnly: false,
    });
    const sender = makeSender();

    await expect(
      routeAppLink({
        url: 'https://example.com/chat-link',
        sender,
        source: 'app-link',
      }),
    ).resolves.toBe('external');

    expect(sender.send).not.toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://example.com/chat-link',
    );
  });

  it('uses one canonical HTTP URL after admitting schemeless input', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      inAppBrowserLocalServersOnly: false,
    });

    await expect(
      routeAppLink({
        url: 'localhost:3000',
        sender: makeSender(),
        source: 'app-link',
      }),
    ).resolves.toBe('external');

    expect(mockOpenExternal).toHaveBeenCalledWith('http://localhost:3000/');
  });
});

describe('openLinkInBuiltInBrowser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsE2eBuild.mockReturnValue(false);
    mockOpenExternal.mockResolvedValue(undefined);
    // Both settings would keep an ordinary app link out of the Browser panel.
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      inAppBrowserLocalServersOnly: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetAppLinkRouterForTests();
  });

  function makeSender(destroyed = false): {
    id: number;
    isDestroyed: jest.Mock<boolean, []>;
    send: jest.Mock<void, [string, unknown]>;
  } {
    return {
      id: 42,
      isDestroyed: jest.fn(() => destroyed),
      send: jest.fn<void, [string, unknown]>(),
    };
  }

  function sentEvent(sender: ReturnType<typeof makeSender>): {
    type: string;
    requestId: string;
    url: string;
    source: string;
    awaitCompletion: boolean;
    openInApp: boolean;
  } {
    const event = sender.send.mock.calls[0]?.[1];
    if (event === undefined) throw new Error('no event was sent');
    return event as ReturnType<typeof sentEvent>;
  }

  it('asks the renderer to open in-app, ignoring the link preferences', async () => {
    const sender = makeSender();
    const pending = openLinkInBuiltInBrowser({
      url: 'https://example.com/docs?x=1#frag',
      sender,
    });
    const event = sentEvent(sender);

    expect(event).toEqual(
      expect.objectContaining({
        type: 'app-link-open-requested',
        url: 'https://example.com/docs?x=1#frag',
        source: 'link-context-menu',
        awaitCompletion: false,
        openInApp: true,
      }),
    );
    expect(
      resolveAppLinkRequest(sender, {
        requestId: event.requestId,
        handled: true,
        phase: 'acknowledge',
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('returns false without an external fallback when the renderer declines', async () => {
    const sender = makeSender();
    const pending = openLinkInBuiltInBrowser({
      url: 'https://example.com/',
      sender,
    });
    resolveAppLinkRequest(sender, {
      requestId: sentEvent(sender).requestId,
      handled: false,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('returns false when the renderer never answers', async () => {
    jest.useFakeTimers();
    const sender = makeSender();
    const pending = openLinkInBuiltInBrowser({
      url: 'https://example.com/',
      sender,
    });
    jest.advanceTimersByTime(1_500);

    await expect(pending).resolves.toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['no sender', null],
    ['a destroyed sender', makeSender(true)],
  ])('returns false with %s', async (_name, sender) => {
    await expect(
      openLinkInBuiltInBrowser({ url: 'https://example.com/', sender }),
    ).resolves.toBe(false);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/hosts', 'javascript:alert(1)', 'mailto:a@b.co'])(
    'returns false for %s without contacting the renderer',
    async (url) => {
      const sender = makeSender();
      await expect(openLinkInBuiltInBrowser({ url, sender })).resolves.toBe(
        false,
      );
      expect(sender.send).not.toHaveBeenCalled();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    },
  );
});
