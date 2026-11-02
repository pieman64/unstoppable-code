import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type WorktreeDiscardResult,
} from '@canopy/desktop-shared/types';

const mockEffects: unknown[][] = [];
const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../worktree-discard', () => ({
  describeWorktreeDiscard: jest.fn(),
  discardWorktree: jest.fn(),
  withTypedArchiveRefusal: jest.fn(),
}));
jest.mock('../worktree-archive', () => ({
  archiveWorktree: jest.fn(),
  WorktreeArchiveRefusedError: class extends Error {},
}));
jest.mock('../../services/workspace-portal-service', () => ({
  getWorkspacePortalWorktreeEntity: jest.fn(),
  getWorkspacePortalWorktreeRuntimeStatus: jest.fn(),
}));
jest.mock('../../services/worktree-diff-stats-cache', () => ({
  removeCachedWorktreeDiffStats: jest.fn((...args: unknown[]) => {
    mockEffects.push(['removeCachedWorktreeDiffStats', ...args]);
  }),
}));
jest.mock('../window-send', () => ({
  sendToAllWindows: jest.fn((...args: unknown[]) => {
    mockEffects.push(['sendToAllWindows', ...args]);
  }),
  sendToWindow: jest.fn((...args: unknown[]) => {
    mockEffects.push(['sendToWindow', ...args.slice(1)]);
  }),
}));
jest.mock('../workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
  readWorkspaceConfig: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
  updateWorkspaceWorktrees: jest.fn(),
}));

import { registerWorktreeDiscardHandlers } from '../../ipc/worktree-discard';
import { handlePortalWorktreeDiscard } from '../../portal/adapters/worktree-adapter';
import { discardWorktree } from '../worktree-discard';
import { readWorkspaceWorktrees } from '../workspace-persistence';

const DISCARDED: WorktreeDiscardResult = {
  status: 'discarded',
  removed: ['live-checkout'],
  gitCleanup: [],
  warnings: [],
};
const REMAINING = [{ id: 'other', branchName: 'other', createdAt: 'x' }];

async function viaIpc(): Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.worktreeDiscard);
  if (!handler) throw new Error('No discard handler');
  return await handler(
    {},
    { projectId: 'ws-1', worktreeId: 'wt-1', confirmation: 'token' },
  );
}

async function viaPortal(): Promise<unknown> {
  let completed: unknown;
  await handlePortalWorktreeDiscard(
    {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.worktree.discard',
      payload: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        confirmation: 'token',
      },
      createdAt: '2026-10-30T00:00:00.000Z',
      expiresAt: null,
    } satisfies PortalCommandEnvelope<unknown>,
    {
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete: (_command, result): void => {
        completed = result;
      },
      fail: (_command, code, message): void => {
        completed = { failed: code, message };
      },
    },
  );
  return completed;
}

beforeAll(() => registerWorktreeDiscardHandlers());
beforeEach(() => {
  jest.clearAllMocks();
  mockEffects.length = 0;
});

describe('CAN-5334 discard completion parity (review r4 finding 2, r2 finding 1 family)', () => {
  it.each([
    [
      'the list is read',
      (): void => {
        jest.mocked(readWorkspaceWorktrees).mockResolvedValue(REMAINING);
      },
      { workspaceId: 'ws-1', worktrees: REMAINING },
    ],
    [
      'the list cannot be read',
      (): void => {
        jest
          .mocked(readWorkspaceWorktrees)
          .mockRejectedValue(new Error('unreadable'));
      },
      { workspaceId: 'ws-1' },
    ],
  ] as const)(
    'IPC and Portal have the same post-discard effects when %s',
    async (_label, arrange, broadcast) => {
      const expected = [
        ['removeCachedWorktreeDiffStats', 'ws-1', 'wt-1'],
        ['sendToAllWindows', IPC_CHANNELS.workspaceWorktreesUpdated, broadcast],
      ];
      const effects: unknown[][][] = [];
      for (const run of [viaIpc, viaPortal]) {
        mockEffects.length = 0;
        jest.mocked(discardWorktree).mockResolvedValue(DISCARDED);
        arrange();
        await expect(run()).resolves.toEqual(DISCARDED);
        effects.push([...mockEffects]);
      }
      expect(effects).toEqual([expected, expected]);
    },
  );

  it('neither surface has a post-discard effect when the discard is refused', async () => {
    for (const run of [viaIpc, viaPortal]) {
      jest.mocked(discardWorktree).mockResolvedValue({
        status: 'refused',
        reason: 'changed',
        description: {
          version: 1,
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          createdAt: '',
          status: 'refused',
          causes: [],
          targets: [],
          sources: [],
          preserved: [],
          alsoDeleted: [],
          mayRemain: [],
          confirmation: 'token',
        },
      });
      await run();
    }
    expect(mockEffects).toEqual([]);
    expect(readWorkspaceWorktrees).not.toHaveBeenCalled();
  });
});
