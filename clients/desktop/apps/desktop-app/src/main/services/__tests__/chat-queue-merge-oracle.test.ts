// Phase-02 oracle: an opaque saved merge still owns exactly one watcher authority.
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import {
  ChatQueueService,
  type ChatQueueServiceDependencies,
} from '../chat-queue-service';
import { isChatTabsSnapshot } from '../../lib/chat-state-snapshots';

const mockRelease = jest.fn(() => Promise.resolve());
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    releaseChatDeliveryAuthority: typeof mockRelease;
  } => ({
    releaseChatDeliveryAuthority: mockRelease,
  }),
}));

const merged: ChatSendMessageRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'watcher-delivery-1',
  watcherDeliveryId: 'delivery-1',
  text: 'Notice text\n\nWatcher text',
  watcherFired: { kind: 'Multiple watchers fired (2)' },
  consolidatedWatcherUserMessageIds: ['notice-1', 'watcher-delivery-1'],
};

interface OracleHarness {
  service: ChatQueueService;
  check: jest.MockedFunction<
    NonNullable<ChatQueueServiceDependencies['checkWatcherIngress']>
  >;
  dispatch: jest.MockedFunction<ChatQueueServiceDependencies['dispatch']>;
}
function harness(allowed: boolean): OracleHarness {
  const check: OracleHarness['check'] = jest.fn<
    ReturnType<OracleHarness['check']>,
    Parameters<OracleHarness['check']>
  >(() =>
    Promise.resolve(
      allowed
        ? { allowed: true }
        : { allowed: false, outcome: 'held', reason: 'owner_boundary' },
    ),
  );
  const dispatch: OracleHarness['dispatch'] = jest.fn<
    ReturnType<OracleHarness['dispatch']>,
    Parameters<OracleHarness['dispatch']>
  >(() => Promise.resolve(undefined));
  const service = new ChatQueueService({
    checkWatcherIngress: check,
    dispatch,
    cancel: (): Promise<void> => Promise.resolve(),
    settleCancelledTurn: (): void => undefined,
    hasActiveProviderTurn: (): boolean => false,
    hasPendingProviderContinuation: (): boolean => false,
    decideTurnSessionReuse: (): Promise<{ kind: 'absent' }> =>
      Promise.resolve({ kind: 'absent' }),
    readPersistedTabOptions: (): Promise<Partial<ChatSendMessageRequest>> =>
      Promise.resolve({}),
    persistRuntime: (): void => undefined,
    broadcast: (): void => undefined,
    now: (): number => 1,
    createId: (): string => 'fresh-row',
    schedule: (fn, ms): ReturnType<typeof setTimeout> => setTimeout(fn, ms),
  });
  service.hydratePersistedInput(merged, 'saved-row', 'desktop', 1);
  return { service, check, dispatch };
}

describe('phase-02 single-authority saved merge oracle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRelease.mockClear();
  });
  afterEach(() => jest.useRealTimers());
  it('checks the one delivery id and holds the entire opaque row when denied', async () => {
    const h = harness(false);
    h.service.onTurnTerminal(merged, 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(h.check).toHaveBeenCalledWith(
      expect.objectContaining({ watcherDeliveryId: 'delivery-1' }),
    );
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(
      h.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({ id: 'saved-row', text: merged.text }),
    ]);
    expect(mockRelease).not.toHaveBeenCalled();
    h.service.resetForTests();
  });
  it('dispatches the opaque merge once and releases its single id once', async () => {
    const h = harness(true);
    h.service.onTurnTerminal(merged, 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(h.check).toHaveBeenCalledWith(
      expect.objectContaining({ watcherDeliveryId: 'delivery-1' }),
    );
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith('delivery-1');
    h.service.resetForTests();
  });
  it('the phase-02 snapshot reader accepts an additive part snapshot on a ledger payload', () => {
    const payload = {
      ...merged,
      watcherPartSnapshots: [
        {
          userMessageId: 'notice-1',
          kind: 'Delegate finished',
          text: 'Notice text',
          delegationNoticeBatchId: 'notice-1',
        },
        {
          userMessageId: merged.userMessageId,
          kind: 'Build',
          text: 'Watcher text',
          watcherDeliveryId: 'delivery-1',
        },
      ],
    };
    expect(
      isChatTabsSnapshot({
        version: 1,
        activeTabId: merged.chatId,
        tabs: [
          {
            id: merged.chatId,
            title: 'Chat',
            createdAt: new Date(0).toISOString(),
            messages: [],
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: merged.userMessageId,
                  revision: 1,
                  state: 'queued',
                  createdAt: 1,
                  text: payload.text,
                  payload,
                  settingsKey: 'settings',
                  origin: 'desktop',
                  attempts: [],
                },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
