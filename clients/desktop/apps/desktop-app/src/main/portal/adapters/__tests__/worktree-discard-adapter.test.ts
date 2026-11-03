import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
  WorktreeDiscardDescription,
} from '@canopy/desktop-shared/types';
jest.mock('../../../lib/worktree-discard', () => ({
  describeWorktreeDiscard: jest.fn(),
  discardWorktree: jest.fn(),
  withTypedArchiveRefusal: jest.fn(
    (_request: unknown, run: () => Promise<unknown>) => run(),
  ),
}));
jest.mock('../../../lib/worktree-archive', () => ({
  archiveWorktree: jest.fn(),
  WorktreeArchiveRefusedError: class extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
jest.mock('../../../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  readWorkspaceConfig: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
  updateWorkspaceWorktrees: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../../../services/workspace-portal-service', () => ({
  getWorkspacePortalWorktreeEntity: jest.fn(),
  getWorkspacePortalWorktreeRuntimeStatus: jest.fn(),
}));
jest.mock('../../../services/worktree-diff-stats-cache', () => ({
  removeCachedWorktreeDiffStats: jest.fn(),
}));
import { LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL } from '@canopy/protocol/portal/lifecycle-journal';
import {
  handlePortalWorktreeArchive,
  handlePortalWorktreeDiscard,
  handlePortalWorktreeDiscardDescribe,
  WORKTREE_SOURCE_MISSING_DISCARD_POINTER,
} from '../worktree-adapter';
import type { PortalAdapterContext } from '../types';
import {
  describeWorktreeDiscard,
  discardWorktree,
  withTypedArchiveRefusal,
} from '../../../lib/worktree-discard';
import {
  archiveWorktree,
  WorktreeArchiveRefusedError,
} from '../../../lib/worktree-archive';
import { removeCachedWorktreeDiffStats } from '../../../services/worktree-diff-stats-cache';
import { readWorkspaceWorktrees } from '../../../lib/workspace-persistence';

const origin = {
  kind: 'external_agent' as const,
  connectionId: '00000000-0000-4000-8000-000000000001',
  clientName: 'Agent',
  verified: true,
  userId: '00000000-0000-4000-8000-000000000002',
};

function context(
  events: PortalEventEnvelope[],
  extra: Partial<PortalAdapterContext> = {},
): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (command, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
    ...extra,
  };
}

function envelope<T extends PortalCommandEnvelope['type']>(
  type: T,
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: 'cmd-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-10-29T00:00:00.000Z',
    expiresAt: null,
  };
}

const description = {
  version: 1,
  workspaceId: 'ws-1',
  worktreeId: 'wt-1',
  status: 'discardable',
  confirmation: 'token',
} as WorktreeDiscardDescription;

beforeEach(() => jest.clearAllMocks());

describe('CAN-5334 Portal worktree discard', () => {
  it.each([
    [
      'describe',
      handlePortalWorktreeDiscardDescribe,
      'portal.worktree.discard.describe',
    ],
    ['discard', handlePortalWorktreeDiscard, 'portal.worktree.discard'],
  ] as const)(
    'refuses %s from an external agent before reading anything',
    async (_label, handler, type) => {
      const events: PortalEventEnvelope[] = [];
      await handler(
        envelope(type, {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          confirmation: 'token',
          // CAN-5338: the retained-archive opt-in grants an agent nothing.
          retainedArchives: true,
        }),
        context(events, { origin }),
      );
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { code: 'forbidden' } },
      });
      expect(describeWorktreeDiscard).not.toHaveBeenCalled();
      expect(discardWorktree).not.toHaveBeenCalled();
    },
  );

  it('completes describe with the description', async () => {
    jest.mocked(describeWorktreeDiscard).mockResolvedValue(description);
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeDiscardDescribe(
      envelope('portal.worktree.discard.describe', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      }),
      context(events),
    );
    expect(describeWorktreeDiscard).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: description },
    });
  });

  it('CAN-5338 forwards only a literal retained-archive opt-in to describe and discard', async () => {
    jest.mocked(describeWorktreeDiscard).mockResolvedValue(description);
    jest.mocked(discardWorktree).mockResolvedValue({
      status: 'refused',
      reason: 'changed',
      description,
    });
    for (const retainedArchives of [true, 'yes']) {
      await handlePortalWorktreeDiscardDescribe(
        envelope('portal.worktree.discard.describe', {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          retainedArchives,
        }),
        context([]),
      );
      await handlePortalWorktreeDiscard(
        envelope('portal.worktree.discard', {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          confirmation: 'token',
          retainedArchives,
        }),
        context([]),
      );
    }
    expect(jest.mocked(describeWorktreeDiscard).mock.calls).toEqual([
      ['ws-1', 'wt-1', { retainedArchives: true }],
      ['ws-1', 'wt-1'],
    ]);
    expect(
      jest
        .mocked(discardWorktree)
        .mock.calls.map(([request]) => request.retainedArchives),
    ).toEqual([true, undefined]);
  });

  it('requires a confirmation and valid ids', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeDiscard(
      envelope('portal.worktree.discard', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      }),
      context(events),
    );
    await handlePortalWorktreeDiscard(
      envelope('portal.worktree.discard', {
        workspaceId: '../ws',
        worktreeId: 'wt-1',
        confirmation: 'token',
      }),
      context(events),
    );
    expect(events.map((event) => event.payload)).toEqual([
      {
        error: expect.objectContaining({ code: 'invalid_payload' }) as unknown,
      },
      {
        error: expect.objectContaining({ code: 'invalid_payload' }) as unknown,
      },
    ]);
    expect(discardWorktree).not.toHaveBeenCalled();
  });

  it('completes a discard and its typed refusal as results, from the Portal user interface', async () => {
    const refused = {
      status: 'refused' as const,
      reason: 'changed' as const,
      description,
    };
    jest.mocked(discardWorktree).mockResolvedValue(refused);
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeDiscard(
      envelope('portal.worktree.discard', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        confirmation: 'token',
      }),
      context(events),
    );
    expect(discardWorktree).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      confirmation: 'token',
      source: 'portal-ui',
    });
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: refused },
    });
    expect(removeCachedWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('drops the discarded worktree diff stats before broadcasting its list, as the desktop does (review r4 finding 2)', async () => {
    jest.mocked(discardWorktree).mockResolvedValue({
      status: 'discarded',
      removed: ['live-checkout'],
      gitCleanup: [],
      warnings: [],
    });
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeDiscard(
      envelope('portal.worktree.discard', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        confirmation: 'token',
      }),
      context(events),
    );
    expect(removeCachedWorktreeDiffStats).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(
      jest.mocked(removeCachedWorktreeDiffStats).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(readWorkspaceWorktrees).mock.invocationCallOrder[0] ??
        Number.NaN,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'portal.command.completed' }),
    );
  });

  it('never forwards a client-supplied path: only the ids and the token reach the discard', async () => {
    jest.mocked(discardWorktree).mockResolvedValue({
      status: 'refused',
      reason: 'changed',
      description,
    });
    await handlePortalWorktreeDiscard(
      envelope('portal.worktree.discard', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        confirmation: 'token',
        path: '/elsewhere',
        targets: [{ kind: 'live-checkout', path: '/elsewhere' }],
        sources: [{ repoId: 'r', path: '/elsewhere' }],
      }),
      context([]),
    );
    expect(jest.mocked(discardWorktree).mock.calls).toEqual([
      [
        {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          confirmation: 'token',
          source: 'portal-ui',
        },
      ],
    ]);
  });

  it('passes an archive typedRefusal through and completes the refusal', async () => {
    const refusal = {
      success: false,
      warnings: [],
      refusal: {
        reason: 'source-unavailable',
        message: 'x',
        discard: description,
      },
    };
    jest.mocked(withTypedArchiveRefusal).mockResolvedValueOnce(refusal);
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeArchive(
      envelope('portal.worktree.archive', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        typedRefusal: true,
      }) as never,
      context(events),
    );
    expect(jest.mocked(withTypedArchiveRefusal).mock.calls[0]?.[0]).toEqual({
      typedRefusal: true,
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result: refusal },
      }),
    ]);
  });

  describe('CAN-5336 untyped refusals', () => {
    const archive = (typedRefusal?: boolean): never =>
      envelope('portal.worktree.archive', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        ...(typedRefusal ? { typedRefusal } : {}),
      }) as never;
    const sourceRefusal = (): Error =>
      new WorktreeArchiveRefusedError(
        'source-unavailable',
        "Couldn't verify the worktree's source repositories. Check repository access and retry.",
      );

    it('points a gone source at the discard instead of retrying', async () => {
      jest.mocked(archiveWorktree).mockRejectedValueOnce(sourceRefusal());
      jest.mocked(describeWorktreeDiscard).mockResolvedValueOnce({
        ...description,
        causes: ['source-gone'],
      });
      const events: PortalEventEnvelope[] = [];
      await handlePortalWorktreeArchive(archive(), context(events));
      expect(describeWorktreeDiscard).toHaveBeenCalledWith('ws-1', 'wt-1');
      expect(events).toEqual([
        expect.objectContaining({
          type: 'portal.command.failed',
          payload: {
            error: {
              code: 'invalid_payload',
              message: WORKTREE_SOURCE_MISSING_DISCARD_POINTER,
            },
          },
        }),
      ]);
    });

    it.each([
      [
        'a refused description',
        (): Promise<WorktreeDiscardDescription> =>
          Promise.resolve({
            ...description,
            status: 'refused' as const,
            causes: [],
          }),
      ],
      [
        'a discardable description without a gone source',
        (): Promise<WorktreeDiscardDescription> =>
          Promise.resolve({
            ...description,
            causes: ['stranded-removal-journal' as const],
          }),
      ],
      [
        'a description that throws',
        (): Promise<WorktreeDiscardDescription> =>
          Promise.reject(new Error('unreadable')),
      ],
    ])('keeps the retry copy for %s', async (_label, describe) => {
      jest.mocked(archiveWorktree).mockRejectedValueOnce(sourceRefusal());
      jest.mocked(describeWorktreeDiscard).mockImplementationOnce(describe);
      const events: PortalEventEnvelope[] = [];
      await handlePortalWorktreeArchive(archive(), context(events));
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { message: sourceRefusal().message } },
      });
    });

    it('fails a typed request the archive refused for an unreadable journal with its message unchanged (G)', async () => {
      const journal = Object.assign(
        new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL),
        { reason: 'recovery-required' },
      );
      jest.mocked(archiveWorktree).mockRejectedValueOnce(journal);
      const events: PortalEventEnvelope[] = [];
      await handlePortalWorktreeArchive(archive(true), context(events));
      expect(events).toEqual([
        expect.objectContaining({
          type: 'portal.command.failed',
          payload: {
            error: {
              code: 'execution_failed',
              message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
            },
          },
        }),
      ]);
      expect(describeWorktreeDiscard).not.toHaveBeenCalled();
    });
  });

  it('never returns the user-only discard description to an external agent', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorktreeArchive(
      envelope('portal.worktree.archive', {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        typedRefusal: true,
      }) as never,
      context(events, { origin }),
    );
    expect(
      jest.mocked(withTypedArchiveRefusal).mock.calls[0]?.[0],
    ).toMatchObject({ typedRefusal: false });
  });
});
