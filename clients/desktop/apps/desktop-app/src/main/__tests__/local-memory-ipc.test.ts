import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';

const registered = new Map<string, (...args: unknown[]) => unknown>();
const listMock = jest.fn();
const readMock = jest.fn();
const mutateMock = jest.fn();
const sendMock = jest.fn();
const watchMock = jest.fn();
const unwatchMock = jest.fn();
const statusMock = jest.fn();
const consolidateMock = jest.fn();
const rebuildMock = jest.fn();
const restoreMock = jest.fn();
const listSnapshotsMock = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    registered.set(channel, handler);
  },
}));
jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => '/memory/user',
  getWorkspaceMemoryDir: (id: string): string => `/memory/workspaces/${id}`,
}));
jest.mock('../memory/local/explorer', () => ({
  listLocalMemoryFiles: (...args: unknown[]): unknown => listMock(...args),
  readLocalMemoryDocument: (...args: unknown[]): unknown => readMock(...args),
  mutateLocalMemoryItem: (...args: unknown[]): unknown => mutateMock(...args),
}));
jest.mock('../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: (...args: unknown[]): unknown =>
    sendMock(...args),
  watchLocalMemoryScope: (...args: unknown[]): unknown => watchMock(...args),
  unwatchLocalMemoryScope: (...args: unknown[]): unknown =>
    unwatchMock(...args),
}));
jest.mock('../memory/local/consolidation-status', () => ({
  readLocalMemoryConsolidationStatus: (...args: unknown[]): unknown =>
    statusMock(...args),
}));
jest.mock('../memory/local/manual-consolidation-trigger', () => ({
  runManualLocalMemoryConsolidation: (...args: unknown[]): unknown =>
    consolidateMock(...args),
  runManualLocalMemoryRebuild: (...args: unknown[]): unknown =>
    rebuildMock(...args),
  restoreManualLocalMemorySnapshot: (...args: unknown[]): unknown =>
    restoreMock(...args),
}));
jest.mock('../memory/local/snapshots', () => ({
  listLocalMemorySnapshots: (...args: unknown[]): unknown =>
    listSnapshotsMock(...args),
}));

import { registerLocalMemoryHandlers } from '../ipc/local-memory';

const sender = { id: 7 };

async function call(channel: string, value: unknown): Promise<unknown> {
  const handler = registered.get(channel);
  if (!handler) throw new Error('Handler not registered');
  return await handler({ sender }, value);
}

const STATUS = {
  pendingNotes: 2,
  running: false,
  rebuilding: false,
  lastRunAt: null,
  lastResult: null,
  lastReason: null,
  lastConsolidatedAt: null,
};

describe('local memory explorer IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registered.clear();
    listMock.mockResolvedValue([]);
    statusMock.mockResolvedValue(STATUS);
    consolidateMock.mockResolvedValue({
      status: 'completed',
      outcome: { result: 'success', inputHash: 'a'.repeat(64) },
      finishedAt: '2026-09-11T12:00:00.000Z',
      recorded: true,
    });
    mutateMock.mockResolvedValue({
      fileKey: 'MEMORY.md',
      revision: 'new',
      items: [],
    });
    registerLocalMemoryHandlers();
  });

  it('resolves user and workspace directories from validated scopes', async () => {
    await call(IPC_CHANNELS.localMemoryList, {
      scope: 'user',
      directory: '/injected/path',
    });
    expect(listMock).toHaveBeenLastCalledWith('/memory/user');
    await call(IPC_CHANNELS.localMemoryList, {
      scope: 'workspace',
      workspaceId: 'my-workspace',
    });
    expect(listMock).toHaveBeenLastCalledWith(
      '/memory/workspaces/my-workspace',
    );
    for (const value of [
      null,
      [],
      { scope: 'organization' },
      { scope: 'workspace', workspaceId: '../escape' },
    ]) {
      await expect(call(IPC_CHANNELS.localMemoryList, value)).rejects.toThrow();
    }
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it.each(
    [
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      CODE_REVIEW_CHAT_PROJECT_ID,
      STANDALONE_CHAT_PROJECT_ID,
    ].flatMap((workspaceId) =>
      [
        IPC_CHANNELS.localMemoryList,
        IPC_CHANNELS.localMemoryRead,
        IPC_CHANNELS.localMemoryUpdateItem,
        IPC_CHANNELS.localMemoryDeleteItem,
      ].map((channel) => ({ workspaceId, channel })),
    ),
  )(
    'rejects reserved chat scope $workspaceId for $channel before filesystem access',
    async ({ workspaceId, channel }) => {
      await expect(
        call(channel, {
          scope: 'workspace',
          workspaceId,
          fileKey: 'MEMORY.md',
          itemId: '0:5',
          revision: 'old',
          text: 'New item',
        }),
      ).rejects.toThrow('Choose a memory workspace');
      expect(listMock).not.toHaveBeenCalled();
      expect(readMock).not.toHaveBeenCalled();
      expect(mutateMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'my-workspace',
    DEFAULT_COWORK_WORKSPACE_ID,
    APP_ADVISOR_PROJECT_ID,
  ])(
    'keeps canonical workspace scope %s available for every operation',
    async (workspaceId) => {
      const request = {
        scope: 'workspace',
        workspaceId,
        fileKey: 'MEMORY.md',
        itemId: '0:5',
        revision: 'old',
        text: 'New item',
      };
      for (const channel of [
        IPC_CHANNELS.localMemoryList,
        IPC_CHANNELS.localMemoryRead,
        IPC_CHANNELS.localMemoryUpdateItem,
        IPC_CHANNELS.localMemoryDeleteItem,
      ])
        await call(channel, request);
      const directory = `/memory/workspaces/${workspaceId}`;
      expect(listMock).toHaveBeenCalledWith(directory);
      expect(readMock).toHaveBeenCalledWith(directory, 'MEMORY.md');
      expect(mutateMock).toHaveBeenCalledTimes(2);
      expect(mutateMock.mock.calls.every(([path]) => path === directory)).toBe(
        true,
      );
    },
  );

  it('rejects malformed mutation fields and broadcasts successful changes', async () => {
    const request = {
      scope: 'user',
      fileKey: 'MEMORY.md',
      itemId: '0:5',
      revision: 'old',
    };
    await expect(
      call(IPC_CHANNELS.localMemoryUpdateItem, request),
    ).rejects.toThrow('Invalid memory request');
    expect(mutateMock).not.toHaveBeenCalled();
    await call(IPC_CHANNELS.localMemoryUpdateItem, {
      ...request,
      text: 'New item',
    });
    expect(mutateMock).toHaveBeenCalledWith('/memory/user', {
      fileKey: 'MEMORY.md',
      itemId: '0:5',
      revision: 'old',
      text: 'New item',
    });
    expect(sendMock).toHaveBeenCalledWith({ scope: 'user' });
  });

  it('does not broadcast a rejected write', async () => {
    mutateMock.mockRejectedValueOnce(new Error('Memory changed'));
    await expect(
      call(IPC_CHANNELS.localMemoryDeleteItem, {
        scope: 'user',
        fileKey: 'MEMORY.md',
        itemId: '0:5',
        revision: 'old',
      }),
    ).rejects.toThrow('Memory changed');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reads consolidation status for a validated scope', async () => {
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidationStatus, {
        scope: 'workspace',
        workspaceId: 'my-workspace',
      }),
    ).resolves.toEqual(STATUS);
    expect(statusMock).toHaveBeenCalledWith('/memory/workspaces/my-workspace');
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidationStatus, {
        scope: 'workspace',
        workspaceId: STANDALONE_CHAT_PROJECT_ID,
      }),
    ).rejects.toThrow('Choose a memory workspace');
  });

  it('runs a manual consolidation and returns the recorded status', async () => {
    const after = {
      ...STATUS,
      pendingNotes: 0,
      lastRunAt: '2026-09-11T12:00:00.000Z',
      lastResult: 'success',
      lastConsolidatedAt: '2026-09-11T12:00:00.000Z',
    };
    statusMock.mockResolvedValueOnce(after);
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidate, { scope: 'user' }),
    ).resolves.toEqual(after);
    expect(consolidateMock).toHaveBeenCalledWith({ scope: 'user' });
    expect(statusMock).toHaveBeenCalledWith('/memory/user');
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidate, { scope: 'organization' }),
    ).rejects.toThrow();
    expect(consolidateMock).toHaveBeenCalledTimes(1);
  });

  it('answers with the run that just finished even when its state write failed', async () => {
    // The stored state still says the previous run failed: the trigger
    // swallowed the write error, so the fresh read is stale.
    statusMock.mockResolvedValueOnce({
      ...STATUS,
      pendingNotes: 0,
      lastRunAt: '2026-09-10T08:00:00.000Z',
      lastResult: 'failed',
      lastReason: 'invalid-output',
      lastConsolidatedAt: '2026-09-09T08:00:00.000Z',
    });
    consolidateMock.mockResolvedValueOnce({
      status: 'completed',
      outcome: { result: 'success', inputHash: 'b'.repeat(64) },
      finishedAt: '2026-09-11T12:30:00.000Z',
      recorded: true,
    });
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidate, { scope: 'user' }),
    ).resolves.toEqual({
      ...STATUS,
      pendingNotes: 0,
      lastRunAt: '2026-09-11T12:30:00.000Z',
      lastResult: 'success',
      lastReason: null,
      lastConsolidatedAt: '2026-09-11T12:30:00.000Z',
    });

    // A failed run keeps the earlier success timestamp but reports itself.
    statusMock.mockResolvedValueOnce({
      ...STATUS,
      lastRunAt: '2026-09-11T12:30:00.000Z',
      lastResult: 'success',
      lastConsolidatedAt: '2026-09-11T12:30:00.000Z',
    });
    consolidateMock.mockResolvedValueOnce({
      status: 'failed',
      reason: 'provider unavailable',
      outcome: { result: 'failed', reason: 'provider unavailable' },
      finishedAt: '2026-09-11T12:45:00.000Z',
      recorded: true,
    });
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidate, { scope: 'user' }),
    ).resolves.toEqual({
      ...STATUS,
      lastRunAt: '2026-09-11T12:45:00.000Z',
      lastResult: 'failed',
      lastReason: 'provider unavailable',
      lastConsolidatedAt: '2026-09-11T12:30:00.000Z',
    });

    // Nothing ran (another run owns the scope): the stored status stands.
    const running = { ...STATUS, running: true };
    statusMock.mockResolvedValueOnce(running);
    consolidateMock.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'already-running',
      outcome: { result: 'skipped', reason: 'already-running' },
      finishedAt: '2026-09-11T12:50:00.000Z',
      recorded: false,
    });
    await expect(
      call(IPC_CHANNELS.localMemoryConsolidate, { scope: 'user' }),
    ).resolves.toEqual(running);
  });

  it('rebuilds a validated scope and answers with the result and fresh status', async () => {
    const rebuild = {
      status: 'completed',
      snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
      restoredInboxNotes: 4,
      restoredImports: 1,
      runs: 2,
    };
    rebuildMock.mockResolvedValue(rebuild);
    await expect(
      call(IPC_CHANNELS.localMemoryRebuild, {
        scope: 'workspace',
        workspaceId: 'my-workspace',
      }),
    ).resolves.toEqual({ rebuild, status: STATUS });
    expect(rebuildMock).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'my-workspace',
    });
    expect(statusMock).toHaveBeenLastCalledWith(
      '/memory/workspaces/my-workspace',
    );
    await expect(
      call(IPC_CHANNELS.localMemoryRebuild, {
        scope: 'workspace',
        workspaceId: STANDALONE_CHAT_PROJECT_ID,
      }),
    ).rejects.toThrow('Choose a memory workspace.');
    expect(rebuildMock).toHaveBeenCalledTimes(1);
  });

  it('lists and restores snapshots for a validated scope', async () => {
    listSnapshotsMock.mockResolvedValue([]);
    restoreMock.mockResolvedValue({
      status: 'restored',
      previousSnapshotId: null,
    });
    await call(IPC_CHANNELS.localMemoryListSnapshots, { scope: 'user' });
    expect(listSnapshotsMock).toHaveBeenCalledWith('/memory/user');
    await expect(
      call(IPC_CHANNELS.localMemoryRestoreSnapshot, {
        scope: 'user',
        snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
      }),
    ).resolves.toEqual({ status: 'restored', previousSnapshotId: null });
    expect(restoreMock).toHaveBeenCalledWith(
      { scope: 'user' },
      '2026-09-30T12-00-00-000Z-0123abcd',
    );
    await expect(
      call(IPC_CHANNELS.localMemoryRestoreSnapshot, { scope: 'user' }),
    ).rejects.toThrow('Invalid memory request.');
  });

  it('watches and unwatches a scope for the calling renderer', async () => {
    await call(IPC_CHANNELS.localMemoryWatch, {
      scope: 'workspace',
      workspaceId: 'my-workspace',
    });
    expect(watchMock).toHaveBeenCalledWith(
      { scope: 'workspace', workspaceId: 'my-workspace' },
      '/memory/workspaces/my-workspace',
      sender,
    );
    await call(IPC_CHANNELS.localMemoryUnwatch, {
      scope: 'workspace',
      workspaceId: 'my-workspace',
    });
    expect(unwatchMock).toHaveBeenCalledWith(
      { scope: 'workspace', workspaceId: 'my-workspace' },
      7,
    );
    await expect(
      call(IPC_CHANNELS.localMemoryWatch, {
        scope: 'workspace',
        workspaceId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      }),
    ).rejects.toThrow('Choose a memory workspace');
    expect(watchMock).toHaveBeenCalledTimes(1);
  });
});
