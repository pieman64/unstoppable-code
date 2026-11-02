import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  clearWorktreesSelfWriteTracking,
  isWorktreesSelfWriteContent,
  parseWorktreesFileReconciliationSnapshot,
  wasRecentWorktreesSelfWrite,
} from '../lib/workspace-persistence';
import { sendToWindow } from '../lib/window-send';
import {
  stopWorktreesFileWatchers,
  syncWorktreesFileWatchers,
} from '../lib/worktrees-file-watcher';

interface MockWatcher {
  close: jest.Mock<void, []>;
  emitChange: (filename?: string | Buffer) => void;
  emitError: (error: Error) => void;
  on: jest.Mock<MockWatcher, [string, (...args: unknown[]) => void]>;
}

const watchers: MockWatcher[] = [];

jest.mock('node:fs', () => ({
  watch: jest.fn(
    (
      _path: string,
      _options: unknown,
      listener: (_event: string, filename: string | Buffer | null) => void,
    ) => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const watcher: MockWatcher = {
        close: jest.fn<void, []>(),
        emitChange(filename = 'worktrees.json'): void {
          listener('change', filename);
        },
        emitError(error): void {
          handlers.get('error')?.(error);
        },
        on: jest.fn((event, handler) => {
          handlers.set(event, handler);
          return watcher;
        }),
      };
      watchers.push(watcher);
      return watcher;
    },
  ),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees.json`,
  ),
}));

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  clearWorktreesSelfWriteTracking: jest.fn(),
  isWorktreesSelfWriteContent: jest.fn(),
  parseWorktreesFileReconciliationSnapshot: jest.fn(() => []),
  wasRecentWorktreesSelfWrite: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockedWatch = jest.mocked(watch);
const mockedReadFile = jest.mocked(readFile);
const mockedClearSelfWriteTracking = jest.mocked(
  clearWorktreesSelfWriteTracking,
);
const mockedIsSelfWriteContent = jest.mocked(isWorktreesSelfWriteContent);
const mockedParseSnapshot = jest.mocked(
  parseWorktreesFileReconciliationSnapshot,
);
const mockedWasRecentSelfWrite = jest.mocked(wasRecentWorktreesSelfWrite);
const mockedSendToWindow = jest.mocked(sendToWindow);
const getWindow = jest.fn(() => null);

function workspace(id: string): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#123456',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function cowork(id: string): SidebarItem {
  return {
    type: 'cowork',
    id,
    name: id,
    color: '#123456',
    collapsed: false,
    order: 0,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  watchers.length = 0;
  stopWorktreesFileWatchers();
  mockedWasRecentSelfWrite.mockReturnValue(false);
  mockedIsSelfWriteContent.mockReturnValue(false);
  mockedReadFile.mockResolvedValue('{"version":1,"worktrees":[]}');
  mockedParseSnapshot.mockReturnValue([]);
});

afterEach(() => {
  stopWorktreesFileWatchers();
  jest.useRealTimers();
});

it('delivers valid external snapshots before renderer notification', async () => {
  const onExternalSnapshot = jest.fn();
  const worktrees = [
    {
      id: 'wt-1',
      branchName: 'feature-1',
      createdAt: '2026-07-30T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    },
  ];
  mockedParseSnapshot.mockReturnValue(worktrees);
  syncWorktreesFileWatchers(
    [workspace('ws-1')],
    getWindow,
    new Set(),
    onExternalSnapshot,
  );

  watchers[0]?.emitChange();
  await jest.advanceTimersByTimeAsync(500);

  expect(onExternalSnapshot).toHaveBeenCalledWith('ws-1', worktrees);
  expect(onExternalSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
    mockedSendToWindow.mock.invocationCallOrder[0] ?? 0,
  );
});

it('does not reconcile invalid content but still refreshes the renderer', async () => {
  const onExternalSnapshot = jest.fn();
  mockedParseSnapshot.mockReturnValue(null);
  syncWorktreesFileWatchers(
    [workspace('ws-1')],
    getWindow,
    new Set(),
    onExternalSnapshot,
  );

  watchers[0]?.emitChange();
  await jest.advanceTimersByTimeAsync(500);

  expect(onExternalSnapshot).not.toHaveBeenCalled();
  expect(mockedSendToWindow).toHaveBeenCalledWith(
    null,
    IPC_CHANNELS.worktreesFileChanged,
    { workspaceId: 'ws-1' },
  );
});

describe('worktrees file watchers', () => {
  it('registers once per non-cowork project and dedupes on resync', () => {
    syncWorktreesFileWatchers(
      [workspace('ws-1'), workspace('ws-1'), cowork('cowork-1')],
      getWindow,
    );
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    expect(mockedWatch).toHaveBeenCalledTimes(1);
    expect(mockedWatch).toHaveBeenCalledWith(
      '/mock/workspaces/ws-1',
      { persistent: false },
      expect.any(Function),
    );
  });

  it('closes watchers for removed projects and prunes self-write tracking', () => {
    syncWorktreesFileWatchers(
      [workspace('ws-1'), workspace('ws-2')],
      getWindow,
    );
    syncWorktreesFileWatchers([workspace('ws-2')], getWindow);

    expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
    expect(watchers[1]?.close).not.toHaveBeenCalled();
    expect(mockedClearSelfWriteTracking).toHaveBeenCalledWith('ws-1');
    expect(mockedClearSelfWriteTracking).not.toHaveBeenCalledWith('ws-2');
  });

  it('retains watchers for projects preserved after a partial load', () => {
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    syncWorktreesFileWatchers([], getWindow, new Set(['ws-1']));

    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(mockedClearSelfWriteTracking).not.toHaveBeenCalledWith('ws-1');
  });

  it('filters filenames and debounces changes into a typed IPC event', async () => {
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange('workspace.json');
    watchers[0]?.emitChange('worktrees.json');
    watchers[0]?.emitChange(Buffer.from('worktrees.json'));
    await jest.advanceTimersByTimeAsync(499);
    expect(mockedSendToWindow).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreesFileChanged,
      { workspaceId: 'ws-1' },
    );
  });

  it('suppresses changes in the desktop self-write window, then emits once it lapses', async () => {
    mockedWasRecentSelfWrite.mockReturnValue(true);
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);

    // Inside the window nothing is sent, but the check re-arms (non-lossy):
    // an external write landing during a desktop save must not be dropped.
    expect(mockedSendToWindow).not.toHaveBeenCalled();

    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
  });

  it('drops pure self-write echoes whose on-disk content matches the last desktop write', async () => {
    // The echo arrives inside the self-write window (it was caused by the
    // desktop's own write), so it is never attributed as external.
    mockedWasRecentSelfWrite.mockReturnValue(true);
    mockedIsSelfWriteContent.mockReturnValue(true);
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);
    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    // The file is exactly what the desktop last wrote (e.g. the GitHub poller
    // persisting lastKnownPrStatus): no refresh event, no reload churn, and
    // the fingerprint is kept for further echoes of the same write.
    expect(mockedIsSelfWriteContent).toHaveBeenCalledWith(
      'ws-1',
      '{"version":1,"worktrees":[]}',
    );
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedClearSelfWriteTracking).not.toHaveBeenCalled();

    // A later genuinely-external write still emits, and invalidates the
    // now-stale fingerprint so a byte-exact external revert to the old
    // desktop payload (desktop A → CLI B → CLI A) is never dropped.
    mockedIsSelfWriteContent.mockReturnValue(false);
    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedClearSelfWriteTracking).toHaveBeenCalledWith('ws-1');
  });

  it('emits when an external change is absorbed into a later self-write (coalesced batch)', async () => {
    // CLI appends a worktree with no recent desktop write: the event is
    // attributed external at arrival time.
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
    watchers[0]?.emitChange();

    // The GitHub poller then read-modify-writes the file before the debounce
    // fires: the window re-arms and the final content is byte-identical to
    // the desktop's own write.
    mockedWasRecentSelfWrite.mockReturnValue(true);
    mockedIsSelfWriteContent.mockReturnValue(true);
    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);
    expect(mockedSendToWindow).not.toHaveBeenCalled();

    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    // The batch contained a definitely-external event, so it must emit even
    // though the content compare would classify it as a self-write echo.
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedClearSelfWriteTracking).toHaveBeenCalledWith('ws-1');
  });

  it('drops the echo of a write still being applied by the commit log', async () => {
    // The worker renames the file before it answers, so the echo arrives
    // while the write is in flight and may outlast several debounces.
    mockedWasRecentSelfWrite.mockReturnValue(true);
    mockedIsSelfWriteContent.mockReturnValue(true);
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(1_500);
    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('emits for an external edit that lands while a desktop write is in flight', async () => {
    mockedWasRecentSelfWrite.mockReturnValue(true);
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);
    mockedWasRecentSelfWrite.mockReturnValue(false);
    mockedIsSelfWriteContent.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedClearSelfWriteTracking).toHaveBeenCalledWith('ws-1');
  });

  it('emits when the worktrees file cannot be read back (fail open)', async () => {
    // Echo arrives inside the self-write window (not attributed external), so
    // the content-compare path runs — and the read failing must fail open.
    mockedWasRecentSelfWrite.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(new Error('gone'));
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);

    watchers[0]?.emitChange();
    await jest.advanceTimersByTimeAsync(500);
    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);

    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
  });

  it('stop closes every watcher and cancels pending emissions', () => {
    syncWorktreesFileWatchers(
      [workspace('ws-1'), workspace('ws-2')],
      getWindow,
    );
    watchers[0]?.emitChange();

    stopWorktreesFileWatchers();
    jest.advanceTimersByTime(500);

    expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
    expect(watchers[1]?.close).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
});

describe('worktrees file watch recovery', () => {
  const codes = ['ENOSPC', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'];
  it.each(codes)(
    'polls actual changes after synchronous %s without resync loops',
    async (code) => {
      mockedWatch.mockImplementationOnce(() => {
        throw Object.assign(new Error(code), { code });
      });
      const reconcile = jest.fn();
      syncWorktreesFileWatchers(
        [workspace('ws-1')],
        getWindow,
        new Set(),
        reconcile,
      );
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++)
        syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
      expect(mockedWatch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(mockedSendToWindow).not.toHaveBeenCalled();
      mockedReadFile.mockResolvedValue('external');
      await jest.advanceTimersByTimeAsync(2_500);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    },
  );

  it.each(codes)(
    'recovers from emitted %s and ignores late callbacks',
    async (code) => {
      syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
      await jest.advanceTimersByTimeAsync(0);
      watchers[0]?.emitError(Object.assign(new Error(code), { code }));
      watchers[0]?.emitChange();
      mockedReadFile.mockResolvedValue('external');
      await jest.advanceTimersByTimeAsync(2_500);
      expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(27_500);
      expect(mockedWatch).toHaveBeenCalledTimes(2);
      const reads = mockedReadFile.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(mockedReadFile).toHaveBeenCalledTimes(reads);
      stopWorktreesFileWatchers();
      watchers[1]?.emitChange();
      watchers[0]?.emitError(Object.assign(new Error(code), { code }));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(mockedWatch).toHaveBeenCalledTimes(2);
      expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    },
  );

  it('suppresses polled self-writes but reconciles an external edit in the write window', async () => {
    mockedWatch.mockImplementationOnce(() => {
      throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
    });
    const reconcile = jest.fn();
    syncWorktreesFileWatchers(
      [workspace('ws-1')],
      getWindow,
      new Set(),
      reconcile,
    );
    await jest.advanceTimersByTimeAsync(0);
    mockedReadFile.mockResolvedValue('self');
    mockedIsSelfWriteContent.mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(2_500);
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    mockedReadFile.mockResolvedValue('external');
    mockedIsSelfWriteContent.mockReturnValue(false);
    mockedWasRecentSelfWrite.mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(2_500);
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    mockedWasRecentSelfWrite.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(500);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
  });

  it('does not overlap polling reads or notify after removal during a read', async () => {
    mockedWatch.mockImplementationOnce(() => {
      throw Object.assign(new Error('limit'), { code: 'EMFILE' });
    });
    syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
    await jest.advanceTimersByTimeAsync(0);
    let finish: (content: string) => void = () => undefined;
    mockedReadFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const reads = mockedReadFile.mock.calls.length;
    await jest.advanceTimersByTimeAsync(8_000);
    expect(mockedReadFile).toHaveBeenCalledTimes(reads + 1);
    syncWorktreesFileWatchers([], getWindow);
    finish('external');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedWatch).toHaveBeenCalledTimes(1);
  });
});

it('warns once for worktrees-file exhaustion across retries and restarts', async () => {
  await jest.isolateModulesAsync(async () => {
    const { dialog } = await import('electron');
    const warning = jest
      .spyOn(dialog, 'showMessageBox')
      .mockResolvedValue({ response: 0, checkboxChecked: false });
    const fs = await import('node:fs');
    const originalWatch = jest.mocked(fs.watch).getMockImplementation();
    jest.mocked(fs.watch).mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const { readFile } = await import('node:fs/promises');
    jest.mocked(readFile).mockResolvedValue('stable');
    const watcher = await import('../lib/worktrees-file-watcher');
    watcher.syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(fs.watch).toHaveBeenCalledTimes(4);
    watcher.stopWorktreesFileWatchers();
    watcher.syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
    expect(warning).toHaveBeenCalledTimes(1);
    watcher.stopWorktreesFileWatchers();
    if (originalWatch) jest.mocked(fs.watch).mockImplementation(originalWatch);
    warning.mockRestore();
  });
});

it('catches an external list change after native recovery during an in-flight poll', async () => {
  mockedWatch.mockImplementationOnce(() => {
    throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
  });
  syncWorktreesFileWatchers([workspace('ws-1')], getWindow);
  await jest.advanceTimersByTimeAsync(0);
  let finish: (content: string) => void = () => undefined;
  mockedReadFile
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue('latest');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(mockedWatch).toHaveBeenCalledTimes(2);
  finish('{"version":1,"worktrees":[]}');
  await jest.advanceTimersByTimeAsync(500);
  expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
});

it('reads fresh content for a native event during an older recovery read', async () => {
  mockedWatch.mockImplementationOnce(() => {
    throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
  });
  const reconcile = jest.fn();
  syncWorktreesFileWatchers(
    [workspace('ws-1')],
    getWindow,
    new Set(),
    reconcile,
  );
  await jest.advanceTimersByTimeAsync(28_000);
  let finish: (content: string) => void = () => undefined;
  mockedReadFile
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue('latest');
  await jest.advanceTimersByTimeAsync(2_000);
  watchers[0]?.emitChange();
  await jest.advanceTimersByTimeAsync(500);
  finish('{"version":1,"worktrees":[]}');
  await jest.advanceTimersByTimeAsync(0);
  expect(mockedParseSnapshot).toHaveBeenLastCalledWith('latest');
  expect(reconcile).toHaveBeenCalledTimes(1);
});
