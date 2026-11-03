import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type { AppAdvisorWatcherSurfaces } from '../app-advisor/watchers';
import { emitPortalWatcherProjection } from '../portal/adapters/watchers-adapter';

jest.mock('../portal/adapters/watchers-adapter', () => ({
  emitPortalWatcherProjection: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

const mockDeliverWatcherMessage = jest.fn<Promise<string>, unknown[]>(() =>
  Promise.resolve('submitted'),
);
// Not virtual: the module exists, and a virtual mock can miss its resolved path.
jest.mock('../services/watcher-chat-delivery', () => ({
  deliverWatcherMessageToChat: (...args: unknown[]): Promise<string> =>
    mockDeliverWatcherMessage(...args),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

const mockSetup = jest.fn();
const mockUpdateWatcherFollowUp = jest.fn();
const mockHoldChatFiring = jest.fn();
const mockReleaseChatFiring = jest.fn();
const mockConfigure = jest.fn<void, [AppAdvisorWatcherSurfaces]>();
const mockListCompleted = jest.fn();

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    configure: mockConfigure,
    setup: mockSetup,
    updateWatcherFollowUp: mockUpdateWatcherFollowUp,
    holdChatFiring: mockHoldChatFiring,
    releaseChatFiring: mockReleaseChatFiring,
    list: jest.fn(),
    listCompleted: mockListCompleted,
    deleteWatcher: jest.fn(),
    acknowledgeWatcherMessageDelivery: jest.fn(),
  })),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerAppAdvisorWatcherHandlers } from '../ipc/app-advisor-watchers';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

function getHandler(
  channel: string,
): (_event: unknown, request: unknown) => Promise<unknown> {
  const registration = mockedRegisterIpcHandler.mock.calls.find(
    (call) => call[0] === channel,
  );
  if (!registration) {
    throw new Error(`Missing handler for ${channel}`);
  }

  const handler = registration[1];
  return async (_event: unknown, request: unknown): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [undefined, request]));
}

describe('app advisor watcher IPC handlers', () => {
  it('keeps desktop notifications working when the Portal projection fails', () => {
    jest.mocked(emitPortalWatcherProjection).mockImplementationOnce(() => {
      throw new Error('Sink unavailable');
    });
    const surfaces = mockConfigure.mock.calls[0]?.[0];
    expect(surfaces?.onChange).toBeDefined();
    expect(() => surfaces?.onChange?.([])).not.toThrow();
    expect(emitPortalWatcherProjection).toHaveBeenCalledWith([]);
  });
  it('forwards completed GitHub observations to Portal without adding them to the desktop active list', () => {
    const completed: AppAdvisorWatcherSummary = {
      id: 'github',
      trigger: 'github_workflow_runs_changed',
      status: 'fired',
      label: 'CI',
      destination: {
        projectId: 'project',
        worktreeId: 'branch',
        chatId: 'chat',
      },
      createdAt: '2026-11-01T12:00:00Z',
      target: {
        kind: 'github_workflow_runs',
        items: [],
        notifyOn: { statuses: [], conclusions: [], jobConclusions: [] },
        display: { repositories: [], sample: [] },
      },
    };
    mockConfigure.mock.calls[0]?.[0].onChange?.([], [completed]);
    expect(emitPortalWatcherProjection).toHaveBeenCalledWith([completed]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    registerAppAdvisorWatcherHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
      closeAppAdvisorWindow: jest.fn(),
      toggleAppAdvisorWindow: jest.fn(),
      getAppAdvisorWindowState: jest.fn(),
      markAppAdvisorWindowRendererReady: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
      sendChatWindowCommand: jest.fn(() => true),
      setAppAdvisorFloatingSize: jest.fn(),
      notifyStartupUnlocked: jest.fn(),
    });
  });

  it('configures main-owned watcher delivery even when no windows are registered', async () => {
    const surfaces = mockConfigure.mock.calls[0]?.[0];
    expect(typeof surfaces?.deliverWatcherMessage).toBe('function');
    if (!surfaces) throw new Error('Expected watcher surfaces');
    const delivery = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      watcherId: 'watcher-1',
      deliveryId: 'delivery-1',
      text: 'Watcher fired',
    };
    await expect(surfaces.deliverWatcherMessage(delivery)).resolves.toBe(
      'submitted',
    );
    expect(mockDeliverWatcherMessage).toHaveBeenCalledWith(delivery);
  });

  it('returns a structured error for malformed create destinations', async () => {
    const handler = getHandler(IPC_CHANNELS.appAdvisorWatcherCreate);

    const result = await handler(undefined, {
      watcher: {
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'destination is required.',
    });
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it('never lets the renderer choose a delegate recipient', async () => {
    mockSetup.mockResolvedValueOnce({ ok: true, results: [] });
    const handler = getHandler(IPC_CHANNELS.appAdvisorWatcherCreate);
    const watcher = {
      trigger: 'worktree_chat_completion',
      target: {
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    await handler(undefined, {
      destination: {
        projectId: 'advisor-project',
        worktreeId: 'advisor-worktree',
        chatId: 'advisor-chat',
        chatTitle: 'Advisor',
        delegationId: 'delegate-1',
      },
      watcher,
    });

    expect(mockSetup).toHaveBeenCalledWith(
      { watchers: [watcher] },
      {
        projectId: 'advisor-project',
        worktreeId: 'advisor-worktree',
        chatId: 'advisor-chat',
        chatTitle: 'Advisor',
      },
    );
  });

  it('forwards completed watcher history requests to the service', async () => {
    const completed = [{ id: 'watcher-fired', status: 'fired' }];
    mockListCompleted.mockResolvedValueOnce(completed);
    const handler = getHandler(IPC_CHANNELS.appAdvisorWatchersCompletedList);

    await expect(handler(undefined, undefined)).resolves.toEqual(completed);
    expect(mockListCompleted).toHaveBeenCalledTimes(1);
  });

  it('rejects non-string follow-up updates before calling the service', async () => {
    const handler = getHandler(IPC_CHANNELS.appAdvisorWatcherUpdate);

    const result = await handler(undefined, {
      watcherId: 'watcher-1',
      followUpInstruction: 123,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Invalid followUpInstruction: must be a string',
    });
    expect(mockUpdateWatcherFollowUp).not.toHaveBeenCalled();
  });

  it('validates hold and release chat IDs before calling the service', async () => {
    const holdHandler = getHandler(IPC_CHANNELS.appAdvisorWatcherHoldFiring);
    const releaseHandler = getHandler(
      IPC_CHANNELS.appAdvisorWatcherReleaseFiring,
    );

    await expect(
      holdHandler(undefined, {
        scope: 'worktree',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'bad_chat',
      }),
    ).rejects.toThrow('Invalid chatId');
    await expect(
      releaseHandler(undefined, {
        scope: 'worktree',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'bad_chat',
      }),
    ).rejects.toThrow('Invalid chatId');

    expect(mockHoldChatFiring).not.toHaveBeenCalled();
    expect(mockReleaseChatFiring).not.toHaveBeenCalled();
  });
});
