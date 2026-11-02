import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../../lib/worktree-discard', () => ({
  describeWorktreeDiscard: jest.fn(() =>
    Promise.resolve({ status: 'refused' }),
  ),
  discardWorktree: jest.fn(() =>
    Promise.resolve({
      status: 'discarded',
      removed: [],
      gitCleanup: [],
      warnings: [],
    }),
  ),
}));
jest.mock('../../lib/project-deletion-discard', () => ({
  describeProjectDeletionDiscard: jest.fn(() =>
    Promise.resolve({ status: 'refused', items: [] }),
  ),
}));
jest.mock('../../services/worktree-diff-stats-cache', () => ({
  removeCachedWorktreeDiffStats: jest.fn(),
}));
jest.mock('../../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
}));
import { registerWorktreeDiscardHandlers } from '../worktree-discard';
import {
  describeWorktreeDiscard,
  discardWorktree,
} from '../../lib/worktree-discard';
import { describeProjectDeletionDiscard } from '../../lib/project-deletion-discard';
import { removeCachedWorktreeDiffStats } from '../../services/worktree-diff-stats-cache';
import { READ_ONLY_SCOPE_ERROR } from '../../lib/read-only-scope';

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = mockHandlers.get(channel);
  if (!found) throw new Error(`No handler for ${channel}`);
  return found;
}

beforeAll(() => registerWorktreeDiscardHandlers());
beforeEach(() => jest.clearAllMocks());

describe('CAN-5334 worktree discard IPC', () => {
  it.each([IPC_CHANNELS.worktreeDiscardDescribe, IPC_CHANNELS.worktreeDiscard])(
    '%s refuses a read-only scope before any read',
    async (channel) => {
      await expect(
        Promise.resolve().then(() =>
          handler(channel)(
            {},
            {
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: 'one',
              confirmation: 'token',
            },
          ),
        ),
      ).rejects.toThrow(READ_ONLY_SCOPE_ERROR);
      expect(describeWorktreeDiscard).not.toHaveBeenCalled();
      expect(discardWorktree).not.toHaveBeenCalled();
    },
  );

  it('describes and discards from the desktop user interface', async () => {
    await handler(IPC_CHANNELS.worktreeDiscardDescribe)(
      {},
      { projectId: 'a', worktreeId: 'one' },
    );
    expect(describeWorktreeDiscard).toHaveBeenCalledWith('a', 'one');
    await expect(
      handler(IPC_CHANNELS.worktreeDiscard)(
        {},
        { projectId: 'a', worktreeId: 'one', confirmation: 'token' },
      ),
    ).resolves.toMatchObject({ status: 'discarded' });
    expect(discardWorktree).toHaveBeenCalledWith({
      workspaceId: 'a',
      worktreeId: 'one',
      confirmation: 'token',
      source: 'desktop-ui',
    });
    expect(removeCachedWorktreeDiffStats).toHaveBeenCalledWith('a', 'one');
  });

  it('keeps the diff stats of a worktree whose discard was refused', async () => {
    jest
      .mocked(discardWorktree)
      .mockResolvedValueOnce({ status: 'refused', reason: 'changed' } as never);
    await handler(IPC_CHANNELS.worktreeDiscard)(
      {},
      { projectId: 'a', worktreeId: 'one', confirmation: 'token' },
    );
    expect(removeCachedWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('requires a confirmation and valid ids', async () => {
    await expect(
      Promise.resolve().then(() =>
        handler(IPC_CHANNELS.worktreeDiscard)(
          {},
          { projectId: 'a', worktreeId: 'one' },
        ),
      ),
    ).rejects.toThrow('confirmation');
    await expect(
      Promise.resolve().then(() =>
        handler(IPC_CHANNELS.worktreeDiscardDescribe)(
          {},
          { projectId: '../a', worktreeId: 'one' },
        ),
      ),
    ).rejects.toThrow();
    expect(discardWorktree).not.toHaveBeenCalled();
  });

  it('never forwards a renderer-supplied path: only the ids and the token reach the discard', async () => {
    await handler(IPC_CHANNELS.worktreeDiscard)(
      {},
      {
        projectId: 'a',
        worktreeId: 'one',
        confirmation: 'token',
        path: '/elsewhere',
        targets: [{ kind: 'live-checkout', path: '/elsewhere' }],
        sources: [{ repoId: 'r', path: '/elsewhere' }],
      },
    );
    expect(jest.mocked(discardWorktree).mock.calls).toEqual([
      [
        {
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: 'token',
          source: 'desktop-ui',
        },
      ],
    ]);
  });
});

describe('CAN-5337 project deletion discard IPC', () => {
  it('describes a project and refuses a read-only scope before any read', async () => {
    await handler(IPC_CHANNELS.workspaceDeleteDiscardDescribe)(
      {},
      { workspaceId: 'a' },
    );
    expect(describeProjectDeletionDiscard).toHaveBeenCalledWith('a');
    jest.mocked(describeProjectDeletionDiscard).mockClear();
    await expect(
      Promise.resolve().then(() =>
        handler(IPC_CHANNELS.workspaceDeleteDiscardDescribe)(
          {},
          { workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID },
        ),
      ),
    ).rejects.toThrow(READ_ONLY_SCOPE_ERROR);
    expect(describeProjectDeletionDiscard).not.toHaveBeenCalled();
  });
});
