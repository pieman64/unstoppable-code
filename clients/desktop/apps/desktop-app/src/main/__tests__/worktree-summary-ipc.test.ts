jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/worktree-summary-persistence', () => ({
  readWorktreeSummary: jest.fn(),
}));

jest.mock('../services/worktree-summary-service', () => ({
  refreshWorktreeSummary: jest.fn(),
}));

import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type WorktreeSummaryData,
  type WorktreeSummaryLoadBatchRequest,
  type WorktreeSummaryLoadRequest,
  type WorktreeSummaryRefreshRequest,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerWorktreeSummaryHandlers } from '../ipc/worktree-summary';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import { refreshWorktreeSummary } from '../services/worktree-summary-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedReadWorktreeSummary = jest.mocked(readWorktreeSummary);
const mockedRefreshWorktreeSummary = jest.mocked(refreshWorktreeSummary);

function getSummaryLoadRequest(): WorktreeSummaryLoadRequest {
  return {
    projectId: 'proj',
    worktreeId: 'worktree',
  };
}

function getSummaryRefreshRequest(): WorktreeSummaryRefreshRequest {
  return {
    projectId: 'proj',
    worktreeId: 'worktree',
  };
}

async function invokeRegisteredHandler(
  channel: string,
  request:
    | WorktreeSummaryLoadRequest
    | WorktreeSummaryLoadBatchRequest
    | WorktreeSummaryRefreshRequest,
): Promise<unknown> {
  const entry = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!entry) {
    throw new Error(`Expected IPC handler for ${channel}`);
  }

  const [, handler] = entry;
  return Promise.resolve(
    Reflect.apply(handler, undefined, [undefined, request]),
  );
}

describe('worktree summary IPC', () => {
  let getWindow: () => BrowserWindow | null;

  beforeEach(() => {
    jest.clearAllMocks();
    getWindow = (): BrowserWindow | null => null;
    registerWorktreeSummaryHandlers(getWindow);
  });

  it('registers load and refresh handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.worktreeSummaryLoad,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.worktreeSummaryLoadBatch,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.worktreeSummaryRefresh,
      expect.any(Function),
    );
  });

  it('loads the persisted summary for valid ids', async () => {
    const summary: WorktreeSummaryData = {
      title: 'Summary title',
      description: 'Summary description',
      highlights: ['First highlight'],
      generatedAt: '2026-03-25T12:00:00.000Z',
      turnCountAtGeneration: 4,
      lastFullRefreshAt: '2026-03-25T12:00:00.000Z',
      lastFullRefreshTurnCount: 4,
    };
    mockedReadWorktreeSummary.mockResolvedValue(summary);

    const result = await invokeRegisteredHandler(
      IPC_CHANNELS.worktreeSummaryLoad,
      getSummaryLoadRequest(),
    );

    expect(mockedReadWorktreeSummary).toHaveBeenCalledWith('proj', 'worktree');
    expect(result).toEqual(summary);
  });

  it('rejects invalid ids for the load handler before reading', async () => {
    await expect(
      invokeRegisteredHandler(IPC_CHANNELS.worktreeSummaryLoad, {
        projectId: 'Proj',
        worktreeId: 'worktree',
      }),
    ).rejects.toThrow(
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    );

    expect(mockedReadWorktreeSummary).not.toHaveBeenCalled();
  });

  it('loads, deduplicates, and keys a summary batch', async () => {
    const summary = {
      title: 'Summary title',
      description: 'Summary description',
      highlights: ['First highlight'],
      generatedAt: '2026-03-25T12:00:00.000Z',
      turnCountAtGeneration: 4,
      lastFullRefreshAt: '2026-03-25T12:00:00.000Z',
      lastFullRefreshTurnCount: 4,
    } satisfies WorktreeSummaryData;
    mockedReadWorktreeSummary.mockImplementation((_projectId, worktreeId) =>
      Promise.resolve(worktreeId === 'worktree-a' ? summary : null),
    );

    const result = await invokeRegisteredHandler(
      IPC_CHANNELS.worktreeSummaryLoadBatch,
      {
        worktrees: [
          { projectId: 'proj', worktreeId: 'worktree-a' },
          { projectId: 'proj', worktreeId: 'worktree-b' },
          { projectId: 'proj', worktreeId: 'worktree-a' },
        ],
      },
    );

    expect(mockedReadWorktreeSummary).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      'proj/worktree-a': summary,
      'proj/worktree-b': null,
    });
  });

  it('rejects an invalid summary batch before reading', async () => {
    await expect(
      invokeRegisteredHandler(IPC_CHANNELS.worktreeSummaryLoadBatch, {
        worktrees: [{ projectId: 'Proj', worktreeId: 'worktree' }],
      }),
    ).rejects.toThrow(
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    );

    expect(mockedReadWorktreeSummary).not.toHaveBeenCalled();
  });

  it('bounds concurrent summary reads within a batch', async () => {
    let active = 0;
    let maxActive = 0;
    mockedReadWorktreeSummary.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      active -= 1;
      return null;
    });

    await invokeRegisteredHandler(IPC_CHANNELS.worktreeSummaryLoadBatch, {
      worktrees: Array.from({ length: 24 }, (_, index) => ({
        projectId: 'proj',
        worktreeId: `worktree-${index}`,
      })),
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it('triggers a manual refresh for valid ids', async () => {
    await expect(
      invokeRegisteredHandler(
        IPC_CHANNELS.worktreeSummaryRefresh,
        getSummaryRefreshRequest(),
      ),
    ).resolves.toBeUndefined();

    expect(mockedRefreshWorktreeSummary).toHaveBeenCalledWith(
      'proj',
      'worktree',
      getWindow,
    );
  });

  it('rejects invalid ids for the refresh handler before scheduling', async () => {
    await expect(
      invokeRegisteredHandler(IPC_CHANNELS.worktreeSummaryRefresh, {
        projectId: 'proj',
        worktreeId: 'Worktree',
      }),
    ).rejects.toThrow(
      'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
    );

    expect(mockedRefreshWorktreeSummary).not.toHaveBeenCalled();
  });
});
