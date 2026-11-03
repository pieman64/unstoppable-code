import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';

const mockCommand = jest.fn<Promise<unknown>, [string, unknown]>();
const mockCapabilities = { worktreeDiscard: true };
const mockOffer = jest.fn();

jest.mock('@/client/ipc-canopy-client', () => ({
  ipcCanopyClient: {
    get capabilities(): { worktreeDiscard: boolean } {
      return mockCapabilities;
    },
    command: (name: string, args: unknown): Promise<unknown> =>
      mockCommand(name, args),
  },
}));
jest.mock('@canopy/app-state', () => ({
  offerWorktreeDiscard: (offer: unknown): unknown => mockOffer(offer),
}));
jest.mock('@/stores/archivedContainersStore', () => ({
  useArchivedContainersStore: {
    getState: (): unknown => ({
      byWorkspace: {
        ws: [{ id: 'archived', name: 'feature/archive', label: 'Owl' }],
      },
    }),
  },
}));

import {
  ARCHIVED_ITEM_DELETE_FAILED,
  offerRetainedArchiveDiscard,
} from '../offerRetainedArchiveDiscard';

const RETAINED: WorktreeDiscardDescription = {
  version: 1,
  workspaceId: 'ws',
  worktreeId: 'archived',
  createdAt: '2026-10-30T00:00:00.000Z',
  status: 'discardable',
  causes: ['source-gone'],
  sources: [{ repoId: 'a', path: '/repos/a', state: 'gone-absent' }],
  targets: [
    {
      kind: 'retained-archive',
      path: '/data/ws/archived-containers/archived',
      identity: '1:2:3',
      identityVerified: false,
      reason: 'source-gone',
    },
  ],
  alsoDeleted: ['chats'],
  preserved: ['branches'],
  mayRemain: [],
  confirmation: 'token-1',
};

beforeEach(() => {
  mockCommand.mockReset();
  mockOffer.mockReset();
  mockCapabilities.worktreeDiscard = true;
});

describe('offerRetainedArchiveDiscard (CAN-5338)', () => {
  it('describes with the opt-in and offers a discardable retained archive', async () => {
    mockCommand.mockResolvedValue(RETAINED);
    const retry = jest.fn();
    await expect(
      offerRetainedArchiveDiscard('ws', 'archived', retry),
    ).resolves.toBe(true);
    expect(mockCommand).toHaveBeenCalledWith('worktree.discard.describe', {
      workspaceId: 'ws',
      worktreeId: 'archived',
      retainedArchives: true,
    });
    expect(mockOffer).toHaveBeenCalledWith({
      workspaceId: 'ws',
      worktreeId: 'archived',
      worktreeName: 'Owl',
      message: ARCHIVED_ITEM_DELETE_FAILED,
      description: RETAINED,
      retainedArchives: true,
      retry,
    });
  });

  it.each([
    [
      'an older host that answers without retained archives',
      (): void => {
        mockCommand.mockResolvedValue({
          ...RETAINED,
          status: 'refused',
          targets: [],
          refusal: { reason: 'not-found' },
        });
      },
    ],
    [
      'a Remote Control host that refuses the channel',
      (): void => {
        mockCommand.mockRejectedValue(new Error('Channel not allowed'));
      },
    ],
    [
      'a describe that throws before answering',
      (): void => {
        mockCommand.mockImplementation(() => {
          throw new TypeError('window.api is undefined');
        });
      },
    ],
    [
      'a client without the discard capability',
      (): void => {
        mockCapabilities.worktreeDiscard = false;
        mockCommand.mockResolvedValue(RETAINED);
      },
    ],
  ])(
    'offers nothing for %s, so the caller keeps its toast',
    async (_label, arrange) => {
      arrange();
      await expect(
        offerRetainedArchiveDiscard('ws', 'archived', jest.fn()),
      ).resolves.toBe(false);
      expect(mockOffer).not.toHaveBeenCalled();
    },
  );
});
