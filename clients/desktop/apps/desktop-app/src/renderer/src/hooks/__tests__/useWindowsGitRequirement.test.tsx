/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitExecutableInstallProgress,
  GitExecutableStatus,
} from '@canopy/desktop-shared/types';
import {
  resolveStartupGateView,
  useWindowsGitRequirement,
  type WindowsGitGateState,
  type WindowsGitRequirement,
} from '../useWindowsGitRequirement';

function makeStatus(
  overrides: Partial<GitExecutableStatus> = {},
): GitExecutableStatus {
  return {
    platform: 'win32',
    required: true,
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    wingetAvailable: true,
    checkedAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveStartupGateView', () => {
  it('blocks on the loading screen until the app is ready', () => {
    expect(resolveStartupGateView(false, { kind: 'not-required' })).toBe(
      'loading',
    );
    expect(
      resolveStartupGateView(false, { kind: 'required', status: makeStatus() }),
    ).toBe('loading');
  });

  it('keeps blocking while the Windows Git probe is in flight', () => {
    expect(resolveStartupGateView(true, { kind: 'checking' })).toBe('loading');
  });

  it('falls through to the app when Git is not required', () => {
    expect(resolveStartupGateView(true, { kind: 'not-required' })).toBe('app');
  });

  it('renders the gate for every active gate state', () => {
    const states: WindowsGitGateState[] = [
      { kind: 'required', status: makeStatus() },
      {
        kind: 'installing',
        status: null,
        progress: { phase: 'running', message: 'x' },
      },
      { kind: 'detected', status: makeStatus({ ready: true, path: 'g' }) },
      { kind: 'error', status: null, message: 'boom' },
    ];
    for (const state of states) {
      expect(resolveStartupGateView(true, state)).toBe('git-gate');
    }
  });

  it('shows the Git gate before onboarding and normal app usage', () => {
    const gate: WindowsGitGateState = {
      kind: 'required',
      status: makeStatus(),
    };

    expect(resolveStartupGateView(true, gate)).toBe('git-gate');
  });
});

describe('useWindowsGitRequirement', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'platform',
  );

  const getGitExecutableStatus = jest.fn<Promise<GitExecutableStatus>, []>();
  const redetectGitExecutable = jest.fn<Promise<GitExecutableStatus>, []>();
  const browseGitExecutable = jest.fn<Promise<GitExecutableStatus>, []>();
  const installGitWithWinget = jest.fn<Promise<GitExecutableStatus>, []>();
  const installGitWithXcode = jest.fn<Promise<void>, []>();
  const onGitInstallProgress = jest.fn<
    () => void,
    [(event: GitExecutableInstallProgress) => void]
  >();
  let progressListener: ((event: GitExecutableInstallProgress) => void) | null =
    null;
  const unsubscribe = jest.fn();

  let latest: WindowsGitRequirement | null = null;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: platform,
    });
  }

  beforeEach(() => {
    getGitExecutableStatus.mockReset();
    redetectGitExecutable.mockReset();
    browseGitExecutable.mockReset();
    installGitWithWinget.mockReset();
    installGitWithXcode.mockReset();
    onGitInstallProgress.mockReset();
    unsubscribe.mockReset();
    progressListener = null;
    latest = null;
    onGitInstallProgress.mockImplementation((cb) => {
      progressListener = cb;
      return unsubscribe;
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGitExecutableStatus,
        redetectGitExecutable,
        browseGitExecutable,
        installGitWithWinget,
        installGitWithXcode,
        onGitInstallProgress,
      },
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
  });

  function Harness({ enabled = true }: { enabled?: boolean }): null {
    latest = useWindowsGitRequirement({ enabled });
    return null;
  }

  async function mount(options: { enabled?: boolean } = {}): Promise<{
    cleanup: () => void;
    render: (nextOptions?: { enabled?: boolean }) => Promise<void>;
  }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    const render = async (
      nextOptions: { enabled?: boolean } = options,
    ): Promise<void> => {
      await act(async () => {
        root?.render(<Harness enabled={nextOptions.enabled} />);
        await Promise.resolve();
      });
    };
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness enabled={options.enabled} />);
      await Promise.resolve();
    });
    return {
      render,
      cleanup: (): void => {
        act(() => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  it('never gates and performs no IPC on Linux builds', async () => {
    setPlatform('linux');
    const { cleanup } = await mount();
    try {
      expect(latest?.state.kind).toBe('not-required');
      expect(getGitExecutableStatus).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('macOS waits for usable Git, cancels polling, and ignores late results', async () => {
    jest.useFakeTimers();
    setPlatform('darwin');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({ platform: 'darwin' }),
    );
    installGitWithXcode.mockResolvedValue(undefined);
    let finishProbe: (status: GitExecutableStatus) => void = () => {};
    redetectGitExecutable.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    const { cleanup } = await mount();
    try {
      expect(latest?.state.kind).toBe('required');
      await act(async () => {
        await latest?.autoInstall();
      });
      expect(installGitWithXcode).toHaveBeenCalledTimes(1);
      expect(latest?.state.kind).toBe('installing');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
      });
      act(() => {
        latest?.cancelInstall();
      });
      expect(latest?.state.kind).toBe('required');
      await act(async () => {
        finishProbe(makeStatus({ ready: true, path: '/real/git' }));
        await Promise.resolve();
      });
      expect(latest?.state.kind).toBe('required');
      const probes = redetectGitExecutable.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10000);
      });
      expect(redetectGitExecutable).toHaveBeenCalledTimes(probes);
    } finally {
      cleanup();
      jest.useRealTimers();
    }
  });

  it('does not probe on Windows while disabled', async () => {
    setPlatform('win32');
    const { cleanup } = await mount({ enabled: false });
    try {
      expect(latest?.state.kind).toBe('not-required');
      expect(getGitExecutableStatus).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('starts probing on Windows when enabled flips true', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    const { cleanup, render } = await mount({ enabled: false });
    try {
      expect(getGitExecutableStatus).not.toHaveBeenCalled();
      await render({ enabled: true });
      expect(getGitExecutableStatus).toHaveBeenCalledTimes(1);
      expect(latest?.state.kind).toBe('required');
    } finally {
      cleanup();
    }
  });

  it('blocks synchronously when Windows probing becomes enabled', async () => {
    setPlatform('win32');
    let resolveStatus: (status: GitExecutableStatus) => void = () => {};
    getGitExecutableStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const { cleanup, render } = await mount({ enabled: false });
    try {
      expect(latest?.state.kind).toBe('not-required');
      await render({ enabled: true });
      expect(latest?.state.kind).toBe('checking');

      await act(async () => {
        resolveStatus(makeStatus({ ready: true, path: 'C:/git.exe' }));
        await Promise.resolve();
      });
      expect(latest?.state.kind).toBe('not-required');
    } finally {
      cleanup();
    }
  });

  it('requires Git on Windows when the executable is missing', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({ required: true, ready: false }),
    );
    const { cleanup } = await mount();
    try {
      expect(getGitExecutableStatus).toHaveBeenCalledTimes(1);
      expect(latest?.state.kind).toBe('required');
    } finally {
      cleanup();
    }
  });

  it('passes through without a gate when Windows Git is already ready', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({ ready: true, path: 'C:/git.exe', version: '2.45.0' }),
    );
    const { cleanup } = await mount();
    try {
      expect(latest?.state.kind).toBe('not-required');
    } finally {
      cleanup();
    }
  });

  it('surfaces a recoverable error when the startup probe fails', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockRejectedValue(new Error('ipc down'));
    const { cleanup } = await mount();
    try {
      expect(latest?.state.kind).toBe('error');
    } finally {
      cleanup();
    }
  });

  it('advances to the detected state after a successful recheck', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    redetectGitExecutable.mockResolvedValue(
      makeStatus({ ready: true, path: 'C:/git.exe', version: '2.45.0' }),
    );
    const { cleanup } = await mount();
    try {
      await act(async () => {
        await latest?.recheck();
      });
      expect(redetectGitExecutable).toHaveBeenCalledTimes(1);
      expect(latest?.state.kind).toBe('detected');
    } finally {
      cleanup();
    }
  });

  it('advances to the detected state after a successful browse selection', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    browseGitExecutable.mockResolvedValue(
      makeStatus({
        ready: true,
        path: 'C:/Git/bin/git.exe',
        version: '2.45.0',
      }),
    );
    const { cleanup } = await mount();
    try {
      await act(async () => {
        await latest?.browse();
      });
      expect(browseGitExecutable).toHaveBeenCalledTimes(1);
      expect(latest?.state.kind).toBe('detected');
    } finally {
      cleanup();
    }
  });

  it('surfaces a recoverable error when browse selection fails', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    browseGitExecutable.mockRejectedValue(new Error('selection cancelled'));
    const { cleanup } = await mount();
    try {
      await act(async () => {
        await latest?.browse();
      });
      expect(latest?.state.kind).toBe('error');
      if (latest?.state.kind === 'error') {
        expect(latest.state.message).toBe('selection cancelled');
      }
    } finally {
      cleanup();
    }
  });

  it('streams install progress then auto-closes the gate on a verified install', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    let resolveInstall: ((status: GitExecutableStatus) => void) | null = null;
    installGitWithWinget.mockImplementation(
      () =>
        new Promise<GitExecutableStatus>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { cleanup } = await mount();
    try {
      let installPromise: Promise<void> | undefined;
      act(() => {
        installPromise = latest?.autoInstall();
      });
      expect(latest?.state.kind).toBe('installing');
      expect(onGitInstallProgress).toHaveBeenCalledTimes(1);

      act(() => {
        progressListener?.({ phase: 'running', message: 'Downloading…' });
      });
      expect(latest?.state.kind).toBe('installing');
      if (latest?.state.kind === 'installing') {
        expect(latest.state.progress.message).toBe('Downloading…');
      }

      await act(async () => {
        resolveInstall?.(makeStatus({ ready: true, path: 'C:/git.exe' }));
        await installPromise;
      });
      expect(latest?.state.kind).toBe('not-required');
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('reports an error when the install completes without a usable Git', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(makeStatus());
    installGitWithWinget.mockResolvedValue(
      makeStatus({ ready: false, error: 'winget exited 1' }),
    );
    const { cleanup } = await mount();
    try {
      await act(async () => {
        await latest?.autoInstall();
      });
      expect(latest?.state.kind).toBe('error');
      if (latest?.state.kind === 'error') {
        expect(latest.state.message).toBe('winget exited 1');
      }
    } finally {
      cleanup();
    }
  });

  it('preserves winget availability when an auto install rejects', async () => {
    setPlatform('win32');
    getGitExecutableStatus.mockResolvedValue(
      makeStatus({ wingetAvailable: true }),
    );
    installGitWithWinget.mockRejectedValue(new Error('winget exited 1'));
    const { cleanup } = await mount();
    try {
      await act(async () => {
        await latest?.autoInstall();
      });
      expect(latest?.state.kind).toBe('error');
      if (latest?.state.kind === 'error') {
        expect(latest.state.message).toBe('winget exited 1');
        expect(latest.state.status?.wingetAvailable).toBe(true);
      }
    } finally {
      cleanup();
    }
  });
});
