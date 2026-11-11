jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockCalls: Array<{
  kind: 'query' | 'instruction';
  name: string;
  params: unknown;
  options: { caller: { principalId: string; grants: string[] } };
}> = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: (name: string, params: unknown, options: never): object => {
      mockCalls.push({ kind: 'query', name, params, options });
      return Promise.resolve(
        name === 'core.archive.container.list'
          ? { workspaceId: 'project-1', containers: [] }
          : {
              workspaceId: 'project-1',
              archiveId: 'a1',
              chatId: 'chat-1',
              title: null,
              totalMessages: 0,
              messages: [],
            },
      );
    },
    instruction: (name: string, params: unknown, options: never): object => {
      mockCalls.push({ kind: 'instruction', name, params, options });
      return Promise.resolve({ container: { archiveId: 'a1', locked: true } });
    },
  }),
}));

const mockRestoreTargets: Array<{
  caller: { principalId: string; grants: string[] };
}> = [];
jest.mock('../../canopy-runtime/workspace-lifecycle-dispatch', () => ({
  // The window's restore handler projects core.archive.container.restore
  // through this; the advisor host must use it with its own caller.
  projectedWorkspaceLifecycleCommands: (target: {
    caller: { principalId: string; grants: string[] };
  }): object => {
    mockRestoreTargets.push(target);
    return {
      restoreArchive: (
        _request: unknown,
        run: () => Promise<unknown>,
      ): Promise<unknown> => run(),
    };
  },
}));
const mockRestored: string[] = [];
jest.mock('../../lib/archived-container-restore', () => ({
  restoreArchivedContainer: (
    workspaceId: string,
    containerId: string,
  ): Promise<object> => {
    mockRestored.push(`${workspaceId}/${containerId}`);
    return Promise.resolve({ kind: 'worktree', warnings: [] });
  },
}));
let mockDeleteStatus: 'deleted' | 'busy' | 'not_found' | null = 'deleted';
const mockCoreDeletes: Array<{
  destination: unknown;
  ids: string[];
  call: unknown;
}> = [];
jest.mock('../../canopy-tools/watcher-core-client', () => ({
  deleteWatchersThroughCore: (
    destination: unknown,
    ids: string[],
    call: unknown,
  ): Promise<object> => {
    mockCoreDeletes.push({ destination, ids, call });
    return Promise.resolve({
      text: JSON.stringify({
        ok: true,
        results:
          mockDeleteStatus === null
            ? []
            : ids.map((watcherId) => ({ watcherId, status: mockDeleteStatus })),
      }),
    });
  },
}));
const mockServiceDeletes: Array<{ id: string; options: unknown }> = [];
jest.mock('../watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    list: (): Promise<[]> => Promise.resolve([]),
    deleteWatcher: (id: string, options: unknown): Promise<boolean> => {
      mockServiceDeletes.push({ id, options });
      return Promise.resolve(true);
    },
  }),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { mainAdvisorRecordsActionHost } from '../advisor-records-actions-host';

const DESTINATION = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: APP_ADVISOR_WORKTREE_ID,
  chatId: 'advisor-chat',
};

function host(): ReturnType<typeof mainAdvisorRecordsActionHost> {
  return mainAdvisorRecordsActionHost({
    destination: DESTINATION,
    callKey: 'advisor-chat:toolu_1',
    requestUserAnswers: () => Promise.reject(new Error('unused')),
  });
}

beforeEach(() => {
  mockCalls.length = 0;
  mockRestoreTargets.length = 0;
  mockRestored.length = 0;
  mockCoreDeletes.length = 0;
  mockServiceDeletes.length = 0;
  mockDeleteStatus = 'deleted';
});

describe('the App Advisor records host (CAN-6007)', () => {
  it('reads and locks the archive through core.archive.container.list, core.archive.chat.get and core.archive.container.update, one grant per call', async () => {
    const records = host();
    await records.listArchive('project-1');
    await records.readArchivedChat('project-1', 'a1', 'chat-1', 20);
    await records.setArchiveLocked('project-1', 'a1', true);
    expect(
      mockCalls.map(({ kind, name, params, options }) => ({
        kind,
        name,
        params,
        principalId: options.caller.principalId,
        grants: options.caller.grants,
      })),
    ).toEqual([
      {
        kind: 'query',
        name: 'core.archive.container.list',
        params: { workspaceId: 'project-1' },
        principalId: 'local-desktop-user',
        grants: ['core.archive.read'],
      },
      {
        kind: 'query',
        name: 'core.archive.chat.get',
        params: {
          workspaceId: 'project-1',
          archiveId: 'a1',
          chatId: 'chat-1',
          limit: 20,
        },
        principalId: 'local-desktop-user',
        grants: ['core.archive.read'],
      },
      {
        kind: 'instruction',
        name: 'core.archive.container.update',
        params: {
          workspaceId: 'project-1',
          archiveId: 'a1',
          locked: true,
          _meta: {
            idempotencyKey:
              'app-advisor-action:advisor-chat:toolu_1:archive-lock',
          },
        },
        principalId: 'local-desktop-user',
        grants: ['core.archive.write'],
      },
    ]);
  });

  it("restores through the window's core.archive.container.restore projection with only core.archive.write", async () => {
    await expect(host().restoreArchive('project-1', 'a1')).resolves.toEqual({
      kind: 'worktree',
      warnings: [],
    });
    expect(mockRestoreTargets.map(({ caller }) => caller.grants)).toEqual([
      ['core.archive.write'],
    ]);
    expect(mockRestored).toEqual(['project-1/a1']);
  });

  it("deletes its own watcher through core.initiatedWork.watcher.delete, keyed by the tool call, and another's through the watcher service", async () => {
    const records = host();
    await expect(records.deleteOwnWatcher('w1')).resolves.toEqual({
      ok: true,
    });
    expect(mockCoreDeletes).toEqual([
      {
        destination: DESTINATION,
        ids: ['w1'],
        call: { invocationId: 'advisor-chat:toolu_1' },
      },
    ]);
    await expect(records.deleteWatcher('w2', true)).resolves.toBe(true);
    expect(mockServiceDeletes).toEqual([
      { id: 'w2', options: { notifySubscriber: true } },
    ]);
  });

  it('succeeds on its own watcher only when core reports it deleted', async () => {
    const records = host();
    mockDeleteStatus = 'busy';
    await expect(records.deleteOwnWatcher('w1')).resolves.toEqual({
      ok: false,
      reason: 'busy',
      message: 'The watcher is firing right now. Try again shortly.',
    });
    mockDeleteStatus = 'not_found';
    await expect(records.deleteOwnWatcher('w1')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
      message: 'Watcher w1 was not found.',
    });
    mockDeleteStatus = null;
    await expect(records.deleteOwnWatcher('w1')).resolves.toMatchObject({
      ok: false,
      reason: 'failed',
    });
  });
});
