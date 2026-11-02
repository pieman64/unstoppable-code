import type * as Recovery from '../lib/worktree-watch-recovery';

jest.mock('node:fs', () => ({ watch: jest.fn() }));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

it.each(['linux', 'darwin', 'win32'] as const)(
  'shares one session warning between watcher families on %s',
  async (platform) => {
    await jest.isolateModulesAsync(async () => {
      const electron = await import('electron');
      const warning = jest
        .spyOn(electron.dialog, 'showMessageBox')
        .mockResolvedValue({ response: 0, checkboxChecked: false });
      const fs = await import('node:fs');
      jest
        .mocked(fs.watch)
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        })
        .mockImplementation(() => {
          throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
        });
      const host = await import('@canopy/core-platform/host-platform');
      jest.mocked(host.hostOperatingSystem).mockReturnValue(platform);
      const { createWorktreeWatch } =
        await import('../lib/worktree-watch-recovery');
      const options = {
        path: '/repo',
        onChange: jest.fn(),
        poll: jest.fn(() => Promise.resolve()),
        onFatal: jest.fn(),
      };
      const branch = createWorktreeWatch({ ...options, label: 'branch:ws/wt' });
      const list = createWorktreeWatch({ ...options, label: 'worktrees:ws' });
      await jest.advanceTimersByTimeAsync(90_000);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(fs.watch).toHaveBeenCalledTimes(8);
      const shown: unknown = warning.mock.calls[0]?.[0];
      expect(shown).toHaveProperty('type', 'warning');
      if (typeof shown !== 'object' || shown === null || !('detail' in shown)) {
        throw new Error('Expected a warning with detail');
      }
      expect(shown.detail).toContain('automatically');
      if (platform === 'linux') {
        expect(shown.detail).toContain(
          'sudo sysctl fs.inotify.max_user_watches=524288',
        );
        expect(shown.detail).toContain('fs.inotify.max_user_instances');
        expect(shown.detail).toContain('/etc/sysctl.d');
      } else {
        expect(shown.detail).not.toContain('sysctl');
      }
      branch.close();
      list.close();
      expect(jest.getTimerCount()).toBe(0);
      warning.mockRestore();
    });
  },
);

const LINUX_GUIDANCE =
  'On Linux, check fs.inotify.max_user_watches and fs.inotify.max_user_instances. To raise these limits, run sudo sysctl fs.inotify.max_user_watches=524288 and sudo sysctl fs.inotify.max_user_instances=1024. To persist them, add fs.inotify.max_user_watches=524288 and fs.inotify.max_user_instances=1024 to a .conf file in /etc/sysctl.d, then run sudo sysctl --system. Raising limits does not fix permission errors.';

async function shownDetail(
  run: (module: typeof Recovery) => void,
): Promise<unknown[]> {
  let details: unknown[] = [];
  await jest.isolateModulesAsync(async () => {
    const electron = await import('electron');
    const warning = jest
      .spyOn(electron.dialog, 'showMessageBox')
      .mockResolvedValue({ response: 0, checkboxChecked: false });
    const host = await import('@canopy/core-platform/host-platform');
    jest.mocked(host.hostOperatingSystem).mockReturnValue('linux');
    run(await import('../lib/worktree-watch-recovery'));
    details = warning.mock.calls.map(([options]) => options.detail);
    warning.mockRestore();
  });
  return details;
}

it.each([
  [
    'EACCES',
    'Check that your account can access the workspace and its Git directory.',
  ],
  [
    'ENOSPC',
    'The system has reached a file-watching or open-file limit. Close other applications that watch many files.',
  ],
])("keeps the worktree observers' %s text unchanged", async (code, reason) => {
  const details = await shownDetail(({ warnWatchUnavailableOnce }) => {
    warnWatchUnavailableOnce(
      Object.assign(new Error(code), { code }),
      'worktree',
    );
  });
  expect(details).toEqual([
    [
      'Worktree changes are being checked every few seconds. Native file watching will resume automatically when available.',
      reason,
      LINUX_GUIDANCE,
    ].join('\n\n'),
  ]);
});

it.each([
  ['EACCES', "Check that your account can access the project's folders."],
  [
    'ENOSPC',
    'The system has reached a file-watching or open-file limit. Close other applications that watch many files.',
  ],
])('names the file explorer for a %s failure', async (code, reason) => {
  const details = await shownDetail(({ warnWatchUnavailableOnce }) => {
    warnWatchUnavailableOnce(
      Object.assign(new Error(code), { code }),
      'file-tree',
    );
  });
  expect(details).toEqual([
    [
      'The file explorer may not show file changes until file watching resumes. Watching resumes automatically, and the explorer then updates.',
      reason,
      LINUX_GUIDANCE,
    ].join('\n\n'),
  ]);
});

it('classifies only the CAN-3190 fallback codes', async () => {
  await jest.isolateModulesAsync(async () => {
    const { isWatchFallbackError } =
      await import('../lib/worktree-watch-recovery');
    for (const code of ['ENOSPC', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'])
      expect(
        isWatchFallbackError(Object.assign(new Error(code), { code })),
      ).toBe(true);
    expect(
      isWatchFallbackError(
        Object.assign(new Error('gone'), { code: 'ENOENT' }),
      ),
    ).toBe(false);
    expect(isWatchFallbackError({ code: 'ENOSPC' })).toBe(false);
    expect(isWatchFallbackError('ENOSPC')).toBe(false);
  });
});

it('keeps one session warning when the file explorer fails first', async () => {
  await jest.isolateModulesAsync(async () => {
    const electron = await import('electron');
    const warning = jest
      .spyOn(electron.dialog, 'showMessageBox')
      .mockResolvedValue({ response: 0, checkboxChecked: false });
    const fs = await import('node:fs');
    jest.mocked(fs.watch).mockImplementation(() => {
      throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
    });
    const host = await import('@canopy/core-platform/host-platform');
    jest.mocked(host.hostOperatingSystem).mockReturnValue('linux');
    const { createWorktreeWatch, warnWatchUnavailableOnce } =
      await import('../lib/worktree-watch-recovery');
    warnWatchUnavailableOnce(
      Object.assign(new Error('limit'), { code: 'ENOSPC' }),
      'file-tree',
    );
    const poll = jest.fn(() => Promise.resolve());
    const branch = createWorktreeWatch({
      path: '/repo',
      label: 'branch:ws/wt',
      onChange: jest.fn(),
      poll,
      onFatal: jest.fn(),
    });
    await jest.advanceTimersByTimeAsync(5_000);
    // The observer still falls back to polling; only the dialog is shared.
    expect(poll).toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0].detail).toEqual(
      expect.stringContaining('The file explorer may not show file changes'),
    );
    branch.close();
    expect(jest.getTimerCount()).toBe(0);
    warning.mockRestore();
  });
});
