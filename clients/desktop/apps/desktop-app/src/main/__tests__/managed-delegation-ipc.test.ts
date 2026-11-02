import { ENVIRONMENT_ACTION_TYPES } from '@canopy/agent-actions';
import { APP_ADVISOR_ACTION_CATALOG } from '@canopy/desktop-shared/lib/app-advisor-actions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { setDelegationActivity } from '../agents/delegation/activity';
import { registerManagedDelegationHandlers } from '../ipc/managed-delegation';
import { registerIpcHandler } from '../ipc/register';
import { managedDelegationLifetimeStatus } from '../agents/delegation/lifetime-status';
import { sendToAllWindows } from '../lib/window-send';
import { scheduleDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const mockStop = jest.fn();
const mockStopAll = jest.fn();
const mockReadChanges = jest.fn();
const mockMessage = jest.fn();
const mockTree = jest.fn();
const mockTranscript = jest.fn();
const mockRoots = jest.fn();
const mockSummary = jest.fn();
const mockExtend = jest.fn();
const mockLifetimeStatus = jest.fn();

jest.mock('../agents/delegation/service', () => ({
  getManagedDelegationLifetimeStatus: (...args: unknown[]): unknown =>
    mockLifetimeStatus(...args),
  messageManagedDelegationForUser: (...args: unknown[]): unknown =>
    mockMessage(...args),
  readManagedDelegationTreeForUser: (...args: unknown[]): unknown =>
    mockTree(...args),
  readManagedDelegationTranscriptForUser: (...args: unknown[]): unknown =>
    mockTranscript(...args),
  readManagedDelegationRootsForUser: (...args: unknown[]): unknown =>
    mockRoots(...args),
  readManagedDelegationWorktreeSummaryForUser: (...args: unknown[]): unknown =>
    mockSummary(...args),
  extendManagedDelegationLifetimeLimit: (...args: unknown[]): unknown =>
    mockExtend(...args),
  stopManagedDelegationForUser: (...args: unknown[]): unknown =>
    mockStop(...args),
  stopAllManagedDelegationsForUser: (...args: unknown[]): unknown =>
    mockStopAll(...args),
  readManagedDelegationChangesForUser: (...args: unknown[]): unknown =>
    mockReadChanges(...args),
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../services/desktop-session-snapshot-invalidation', () => ({
  scheduleDesktopSessionSnapshotInvalidation: jest.fn(),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));

function handler(channel: string): Handler {
  const registered = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([candidate]) => candidate === channel)?.[1];
  if (typeof registered !== 'function')
    throw new Error(`${channel} was not registered`);
  return (event, ...args): unknown =>
    Reflect.apply(registered, undefined, [event, ...args]);
}

const TARGET = { projectId: 'project-a', worktreeId: 'wt-a', chatId: 'chat-a' };

beforeEach((): void => {
  jest.clearAllMocks();
  registerManagedDelegationHandlers();
});

afterEach((): void => {
  setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 0, 0);
  setDelegationActivity('ipc-owner-2', 'project-b/wt-b/chat-b', 0, 0);
});

describe('managed delegation activity IPC', () => {
  it('lists the current per-chat aggregates', async (): Promise<void> => {
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 1, 2);
    setDelegationActivity('ipc-owner-2', 'project-b/wt-b/chat-b', 0, 1);

    const listed = await handler(IPC_CHANNELS.managedDelegationActivityList)(
      undefined,
    );

    expect(listed).toEqual(
      expect.arrayContaining([
        { ...TARGET, live: 1, queued: 2 },
        {
          projectId: 'project-b',
          worktreeId: 'wt-b',
          chatId: 'chat-b',
          live: 0,
          queued: 1,
        },
      ]),
    );
  });

  it('broadcasts every aggregate change, including the change to 0/0', (): void => {
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 1);
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 0);

    expect(sendToAllWindows).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.managedDelegationActivityChanged,
      { ...TARGET, live: 1, queued: 0 },
    );
    expect(sendToAllWindows).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.managedDelegationActivityChanged,
      { ...TARGET, live: 0, queued: 0 },
    );
  });

  it('re-pulls the desktop session snapshot when a chat starts or stops having live delegates', (): void => {
    // The shared sidebar renders its rows' working state from that snapshot,
    // with or without a Remote Control session.
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 1);
    expect(scheduleDesktopSessionSnapshotInvalidation).toHaveBeenCalledTimes(1);
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 0);
    expect(scheduleDesktopSessionSnapshotInvalidation).toHaveBeenCalledTimes(2);
  });

  it('keeps one broadcast subscription when handlers are registered again', (): void => {
    registerManagedDelegationHandlers();
    setDelegationActivity('ipc-owner', 'project-a/wt-a/chat-a', 1);
    expect(sendToAllWindows).toHaveBeenCalledTimes(1);
  });
});

describe('managed delegation stop IPC', () => {
  it('stops one delegation for the user', async (): Promise<void> => {
    mockStop.mockResolvedValueOnce({ ok: true, value: {} });

    await expect(
      handler(IPC_CHANNELS.managedDelegationStop)(undefined, {
        ...TARGET,
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockStop).toHaveBeenCalledWith(TARGET, 'delegation-1');
  });

  it('stops every delegation in the chat and reports the count', async (): Promise<void> => {
    mockStopAll.mockResolvedValueOnce({ ok: true, value: { stopped: 3 } });

    await expect(
      handler(IPC_CHANNELS.managedDelegationStopAll)(undefined, TARGET),
    ).resolves.toEqual({ ok: true, stopped: 3 });
    expect(mockStopAll).toHaveBeenCalledWith(TARGET);
  });

  it('maps service errors to the result error message', async (): Promise<void> => {
    const error = {
      code: 'parent_unavailable',
      message: 'That delegation is not one of your descendants.',
      retryable: false,
    };
    mockStop.mockResolvedValueOnce({ ok: false, error });
    mockStopAll.mockResolvedValueOnce({ ok: false, error });

    await expect(
      handler(IPC_CHANNELS.managedDelegationStop)(undefined, {
        ...TARGET,
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: false, error: error.message });
    await expect(
      handler(IPC_CHANNELS.managedDelegationStopAll)(undefined, TARGET),
    ).resolves.toEqual({ ok: false, error: error.message });
  });

  it('reports a thrown service failure as a failed result', async (): Promise<void> => {
    mockStopAll.mockRejectedValueOnce(new Error('broker closed'));

    await expect(
      handler(IPC_CHANNELS.managedDelegationStopAll)(undefined, TARGET),
    ).resolves.toEqual({ ok: false, error: 'broker closed' });
  });

  it.each([
    ['a missing request', undefined],
    ['an unsafe project id', { ...TARGET, projectId: '../project' }],
    ['an unsafe chat id', { ...TARGET, chatId: 'Chat A' }],
    ['a missing delegation id', { ...TARGET }],
    ['an unsafe delegation id', { ...TARGET, delegationId: 'x/../y' }],
  ])('rejects %s before stopping anything', async (_label, request) => {
    await expect(
      handler(IPC_CHANNELS.managedDelegationStop)(undefined, request),
    ).rejects.toThrow(/Invalid/);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('rejects an invalid stop-all target before stopping anything', async (): Promise<void> => {
    await expect(
      handler(IPC_CHANNELS.managedDelegationStopAll)(undefined, {
        ...TARGET,
        worktreeId: '',
      }),
    ).rejects.toThrow(/Invalid/);
    expect(mockStopAll).not.toHaveBeenCalled();
  });
});

describe('managed delegation changes IPC', () => {
  const REQUEST = {
    projectId: 'project-a',
    worktreeId: 'wt-a',
    delegationId: 'delegation-1',
    revision: 'a'.repeat(40),
  };

  it("reads an isolated delegate's changes within the request's worktree", async (): Promise<void> => {
    const changes = { files: [{ path: 'src/a.ts', change: 'modified' }] };
    mockReadChanges.mockResolvedValueOnce(changes);

    await expect(
      handler(IPC_CHANNELS.managedDelegationChanges)(undefined, REQUEST),
    ).resolves.toEqual({ ok: true, changes });
    expect(mockReadChanges).toHaveBeenCalledWith(
      { projectId: 'project-a', worktreeId: 'wt-a' },
      'delegation-1',
      'a'.repeat(40),
      expect.any(AbortSignal),
    );
  });

  it('reports a failed read without its internal detail', async (): Promise<void> => {
    mockReadChanges.mockRejectedValueOnce(
      new Error('git failed in /private/path'),
    );

    await expect(
      handler(IPC_CHANNELS.managedDelegationChanges)(undefined, REQUEST),
    ).resolves.toEqual({
      ok: false,
      error: "Couldn't read the delegate's changes.",
    });
  });

  it.each([
    ['a missing request', undefined],
    ['an unsafe worktree id', { ...REQUEST, worktreeId: '../wt' }],
    ['an unsafe delegation id', { ...REQUEST, delegationId: 'x/../y' }],
    ['a revision that is not an object id', { ...REQUEST, revision: 'HEAD' }],
    ['an option-like revision', { ...REQUEST, revision: '--output=x' }],
  ])('rejects %s before reading anything', async (_label, request) => {
    await expect(
      handler(IPC_CHANNELS.managedDelegationChanges)(undefined, request),
    ).rejects.toThrow(/Invalid/);
    expect(mockReadChanges).not.toHaveBeenCalled();
  });
});

describe('managed delegation viewer IPC', () => {
  const message = {
    ...TARGET,
    delegationId: 'child',
    operation: 'follow_up',
    operationId: '11111111-1111-4111-8111-111111111111',
    message: 'Continue',
  };
  it('forwards user messages and broker outcome codes without altering authority', async () => {
    const snapshot = {
      delegationId: 'child',
      status: 'running',
      outputTruncated: false,
    };
    mockMessage.mockResolvedValueOnce({ ok: true, snapshot });
    expect(
      await handler(IPC_CHANNELS.managedDelegationMessage)(undefined, message),
    ).toEqual({ ok: true, snapshot });
    expect(mockMessage).toHaveBeenCalledWith(message);
    for (const code of [
      'parent_unavailable',
      'busy',
      'not_found',
      'discarded',
      'failed',
    ]) {
      mockMessage.mockResolvedValueOnce({ ok: false, code, error: code });
      expect(
        await handler(IPC_CHANNELS.managedDelegationMessage)(undefined, {
          ...message,
          chatId: 'other-chat',
        }),
      ).toEqual({ ok: false, code, error: code });
    }
  });
  it.each([
    { ...message, operationId: 'not-a-uuid' },
    { ...message, message: '  ' },
    { ...message, message: 'x'.repeat(32769) },
    { ...message, operation: 'discard' },
    { ...message, chatId: '../chat' },
    { ...message, delegationId: '../child' },
    { ...message, projectId: '../project' },
    { ...message, worktreeId: '../worktree' },
  ])(
    'rejects an invalid message without entering the service',
    async (request) => {
      expect(
        await handler(IPC_CHANNELS.managedDelegationMessage)(
          undefined,
          request,
        ),
      ).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(mockMessage).not.toHaveBeenCalled();
    },
  );
  it('allows interrupt without a message and sanitizes unexpected errors', async () => {
    mockMessage.mockResolvedValueOnce({ ok: true, snapshot: {} });
    await handler(IPC_CHANNELS.managedDelegationMessage)(undefined, {
      ...message,
      operation: 'interrupt',
      message: { ignored: 'any payload' },
    });
    mockMessage.mockRejectedValueOnce(new Error('/private/secret failure'));
    const result = await handler(IPC_CHANNELS.managedDelegationMessage)(
      undefined,
      message,
    );
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });
  it('reads trees and roots through scoped service projections', async () => {
    mockTree.mockResolvedValueOnce([{ description: 'Review', snapshot: {} }]);
    expect(
      await handler(IPC_CHANNELS.managedDelegationTree)(undefined, TARGET),
    ).toMatchObject({ ok: true, entries: [{ description: 'Review' }] });
    expect(mockTree).toHaveBeenCalledWith(TARGET);
    mockRoots.mockResolvedValueOnce([
      { chatId: 'chat-a', total: 2, live: 1, lastActivityAt: 10 },
    ]);
    const scope = {
      projectId: TARGET.projectId,
      worktreeId: TARGET.worktreeId,
    };
    expect(
      await handler(IPC_CHANNELS.managedDelegationRoots)(undefined, scope),
    ).toEqual([{ chatId: 'chat-a', total: 2, live: 1, lastActivityAt: 10 }]);
    expect(mockRoots).toHaveBeenCalledWith(scope);
  });
  it('rejects invalid tree and roots targets and sanitizes failures', async () => {
    expect(
      await handler(IPC_CHANNELS.managedDelegationTree)(undefined, {
        ...TARGET,
        chatId: '../chat',
      }),
    ).toMatchObject({ ok: false });
    expect(mockTree).not.toHaveBeenCalled();
    await expect(
      handler(IPC_CHANNELS.managedDelegationRoots)(undefined, {
        projectId: '../project',
        worktreeId: 'wt',
      }),
    ).rejects.toThrow();
    expect(mockRoots).not.toHaveBeenCalled();
    mockTree.mockRejectedValueOnce(new Error('/private/path'));
    expect(
      await handler(IPC_CHANNELS.managedDelegationTree)(undefined, TARGET),
    ).toEqual({ ok: false, error: "Couldn't read the delegation tree." });
    mockRoots.mockRejectedValueOnce(new Error('/private/path'));
    await expect(
      handler(IPC_CHANNELS.managedDelegationRoots)(undefined, {
        projectId: 'project',
        worktreeId: 'wt',
      }),
    ).rejects.toThrow("Couldn't read chats with delegations.");
  });
  it('extends the lifetime limit for a validated worktree scope', async () => {
    const scope = { projectId: 'project-a', worktreeId: 'wt-a' };
    mockExtend.mockResolvedValueOnce({
      ok: true,
      baseline: 512,
      effectiveLimit: 1024,
      retained: 512,
    });
    expect(
      await handler(IPC_CHANNELS.managedDelegationExtendLifetimeLimit)(
        undefined,
        scope,
      ),
    ).toEqual({ ok: true, baseline: 512, effectiveLimit: 1024, retained: 512 });
    expect(mockExtend).toHaveBeenCalledWith(scope);
    mockExtend.mockResolvedValueOnce({ ok: false, reason: 'at_cap' });
    expect(
      await handler(IPC_CHANNELS.managedDelegationExtendLifetimeLimit)(
        undefined,
        scope,
      ),
    ).toEqual({ ok: false, reason: 'at_cap' });
  });

  it('reads authoritative lifetime status with validated ids and broadcasts only scoped coalesced changes', async () => {
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    mockLifetimeStatus.mockResolvedValue({
      kind: 'unavailable',
      reason: 'uncertain',
    });
    expect(
      await handler(IPC_CHANNELS.managedDelegationLifetimeStatus)({}, scope),
    ).toEqual({ kind: 'unavailable', reason: 'uncertain' });
    expect(mockLifetimeStatus).toHaveBeenCalledWith(scope);
    expect(
      await handler(IPC_CHANNELS.managedDelegationLifetimeStatus)(
        {},
        { ...scope, projectId: '../bad' },
      ),
    ).toEqual({ kind: 'error', reason: 'invalid_request' });
    expect(mockLifetimeStatus).toHaveBeenCalledTimes(1);
    managedDelegationLifetimeStatus.changed(scope);
    managedDelegationLifetimeStatus.changed(scope);
    await Promise.resolve();
    expect(
      jest
        .mocked(sendToAllWindows)
        .mock.calls.filter(
          ([channel]) =>
            channel === IPC_CHANNELS.managedDelegationLifetimeChanged,
        ),
    ).toEqual([[IPC_CHANNELS.managedDelegationLifetimeChanged, scope]]);
  });
  it('exposes the lifetime limit to no agent action catalog', () => {
    // Raising the limit grants agents capacity, so only the user can do it.
    const lifetime = /lifetime/i;
    expect(
      APP_ADVISOR_ACTION_CATALOG.filter(
        (entry) => lifetime.test(entry.type) || lifetime.test(entry.summary),
      ),
    ).toEqual([]);
    expect(
      ENVIRONMENT_ACTION_TYPES.filter((type) => lifetime.test(type)),
    ).toEqual([]);
  });
  it('refuses an invalid lifetime-limit scope without reaching the service', async () => {
    for (const raw of [
      { projectId: '../project', worktreeId: 'wt-a' },
      { projectId: 'project-a', worktreeId: 'wt/../a' },
      { projectId: 'project-a' },
      'project-a',
      undefined,
    ])
      expect(
        await handler(IPC_CHANNELS.managedDelegationExtendLifetimeLimit)(
          undefined,
          raw,
        ),
      ).toEqual({ ok: false, reason: 'invalid_request' });
    expect(mockExtend).not.toHaveBeenCalled();
  });
  it('reads transcript pages and keeps wrong-chat not_found', async () => {
    const request = {
      ...TARGET,
      delegationId: 'child',
      beforeSequence: 10,
      limit: 2,
    };
    const result = {
      ok: true,
      task: { description: 'Review' },
      snapshot: {},
      runGeneration: 1,
      items: [],
      hasMore: false,
    };
    mockTranscript.mockResolvedValueOnce(result);
    expect(
      await handler(IPC_CHANNELS.managedDelegationTranscriptPage)(
        undefined,
        request,
      ),
    ).toEqual(result);
    expect(mockTranscript).toHaveBeenCalledWith(request);
    mockTranscript.mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
      error: 'not found',
    });
    expect(
      await handler(IPC_CHANNELS.managedDelegationTranscriptPage)(undefined, {
        ...request,
        chatId: 'other-chat',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });
  it.each([
    { limit: 201 },
    { limit: 0 },
    { limit: 1.5 },
    { beforeSequence: -1 },
    { beforeSequence: 1.5 },
    { delegationId: '../child' },
    { chatId: '../chat' },
  ])('rejects invalid transcript paging %p', async (fields) => {
    expect(
      await handler(IPC_CHANNELS.managedDelegationTranscriptPage)(undefined, {
        ...TARGET,
        delegationId: 'child',
        ...fields,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mockTranscript).not.toHaveBeenCalled();
  });
  it('sanitizes transcript errors', async () => {
    mockTranscript.mockRejectedValueOnce(new Error('/private/path'));
    expect(
      await handler(IPC_CHANNELS.managedDelegationTranscriptPage)(undefined, {
        ...TARGET,
        delegationId: 'child',
      }),
    ).toMatchObject({ ok: false, code: 'failed' });
  });
  const summaryRequest = {
    projectId: 'project-a',
    worktreeId: 'wt-a',
    delegationId: 'child',
    revision: 'a'.repeat(40),
  };
  it('passes the summary revision and timeout, and hides foreign-worktree failures', async () => {
    mockSummary.mockResolvedValueOnce({
      delegationId: 'child',
      filesChanged: 2,
    });
    expect(
      await handler(IPC_CHANNELS.managedDelegationWorktreeSummary)(
        undefined,
        summaryRequest,
      ),
    ).toMatchObject({ ok: true, summary: { filesChanged: 2 } });
    expect(mockSummary).toHaveBeenCalledWith(
      { projectId: 'project-a', worktreeId: 'wt-a' },
      'child',
      'a'.repeat(40),
      expect.any(AbortSignal),
    );
    mockSummary.mockRejectedValueOnce(new Error('/private/foreign-worktree'));
    expect(
      await handler(IPC_CHANNELS.managedDelegationWorktreeSummary)(undefined, {
        ...summaryRequest,
        worktreeId: 'foreign-wt',
      }),
    ).toEqual({
      ok: false,
      error: "Couldn't read the delegate's worktree summary.",
    });
  });
  it.each([
    { revision: 'HEAD' },
    { revision: '--help' },
    { delegationId: '../child' },
    { projectId: '../project' },
    { worktreeId: '../wt' },
  ])('validates summaries %p before reading', async (fields) => {
    expect(
      await handler(IPC_CHANNELS.managedDelegationWorktreeSummary)(undefined, {
        ...summaryRequest,
        ...fields,
      }),
    ).toMatchObject({ ok: false });
    expect(mockSummary).not.toHaveBeenCalled();
  });
});

describe('managed delegation transcript IPC', () => {
  it('rejects a malformed delegation id before reading any log', async (): Promise<void> => {
    await expect(
      handler(IPC_CHANNELS.managedDelegationTranscript)(undefined, {
        ...TARGET,
        delegationId: '../other-chat',
        runGeneration: 1,
      }),
    ).rejects.toThrow('Invalid delegationId');
  });
});
