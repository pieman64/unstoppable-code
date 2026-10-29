/**
 * @jest-environment jsdom
 */
import {
  retainAppAdvisorWatchersBridge,
  useAppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';

function makeWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'My watcher',
    target:
      overrides.target ??
      ({
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      } as AppAdvisorWatcherSummary['target']),
    destination:
      overrides.destination ??
      ({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat-1',
      } as AppAdvisorWatcherSummary['destination']),
    ...(overrides.followUpInstruction
      ? { followUpInstruction: overrides.followUpInstruction }
      : {}),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.firedAt ? { firedAt: overrides.firedAt } : {}),
    ...(overrides.deliveryError
      ? { deliveryError: overrides.deliveryError }
      : {}),
  };
}

const listWatchersMock = jest.fn<
  Promise<AppAdvisorWatcherSummary[]>,
  [unknown?]
>();
const listCompletedWatchersMock = jest.fn<
  Promise<AppAdvisorWatcherSummary[]>,
  []
>();
const deleteWatcherMock = jest.fn<
  Promise<{ ok: true } | { ok: false; error: string }>,
  [string]
>();
const createWatcherMock = jest.fn();
const updateWatcherMock = jest.fn();
const holdChatFiringMock = jest.fn();
const releaseChatFiringMock = jest.fn();
let watchersListener: ((watchers: AppAdvisorWatcherSummary[]) => void) | null =
  null;
const onWatchersChangedMock = jest.fn(
  (cb: (watchers: AppAdvisorWatcherSummary[]) => void): (() => void) => {
    watchersListener = cb;
    return (): void => {
      watchersListener = null;
    };
  },
);

beforeEach(() => {
  listWatchersMock.mockReset();
  listWatchersMock.mockResolvedValue([]);
  listCompletedWatchersMock.mockReset();
  listCompletedWatchersMock.mockResolvedValue([]);
  deleteWatcherMock.mockReset();
  deleteWatcherMock.mockResolvedValue({ ok: true });
  createWatcherMock.mockReset();
  createWatcherMock.mockResolvedValue({ ok: true, results: [] });
  updateWatcherMock.mockReset();
  updateWatcherMock.mockResolvedValue({ ok: true });
  holdChatFiringMock.mockReset();
  holdChatFiringMock.mockResolvedValue({ ok: true });
  releaseChatFiringMock.mockReset();
  releaseChatFiringMock.mockResolvedValue({ ok: true });
  onWatchersChangedMock.mockClear();
  watchersListener = null;

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appAdvisor: {
        listWatchers: listWatchersMock,
        listCompletedWatchers: listCompletedWatchersMock,
        deleteWatcher: deleteWatcherMock,
        createWatcher: createWatcherMock,
        updateWatcher: updateWatcherMock,
        holdChatFiring: holdChatFiringMock,
        releaseChatFiring: releaseChatFiringMock,
        onWatchersChanged: onWatchersChangedMock,
      },
    },
  });

  useAppAdvisorWatchersStore.setState({
    watchers: [],
    completedWatchers: [],
    loading: false,
    hydrated: false,
    error: null,
    deleteErrors: {},
  });
});

describe('appAdvisorWatchersStore', () => {
  it('hydrate populates watchers from window.api.appAdvisor.listWatchers', async () => {
    const watchers = [makeWatcher({ id: 'a' }), makeWatcher({ id: 'b' })];
    listWatchersMock.mockResolvedValueOnce(watchers);

    await useAppAdvisorWatchersStore.getState().hydrate();

    expect(listWatchersMock).toHaveBeenCalledTimes(1);
    expect(useAppAdvisorWatchersStore.getState().watchers).toEqual(watchers);
    expect(useAppAdvisorWatchersStore.getState().loading).toBe(false);
    expect(useAppAdvisorWatchersStore.getState().hydrated).toBe(true);
    expect(useAppAdvisorWatchersStore.getState().error).toBeNull();
  });

  it('hydrate marks an empty successful response as hydrated', async () => {
    listWatchersMock.mockResolvedValueOnce([]);

    await useAppAdvisorWatchersStore.getState().hydrate();

    expect(useAppAdvisorWatchersStore.getState().watchers).toEqual([]);
    expect(useAppAdvisorWatchersStore.getState().hydrated).toBe(true);
  });

  it('hydrate captures an error message without throwing when listWatchers rejects', async () => {
    listWatchersMock.mockRejectedValueOnce(new Error('boom'));

    await useAppAdvisorWatchersStore.getState().hydrate();

    expect(useAppAdvisorWatchersStore.getState().error).toBe('boom');
    expect(useAppAdvisorWatchersStore.getState().watchers).toEqual([]);
    expect(useAppAdvisorWatchersStore.getState().loading).toBe(false);
  });

  it('subscribeBridge wires onWatchersChanged so broadcasts replace state', () => {
    const off = useAppAdvisorWatchersStore.getState().subscribeBridge();
    expect(onWatchersChangedMock).toHaveBeenCalledTimes(1);

    const next = [makeWatcher({ id: 'live-1' })];
    watchersListener?.(next);
    expect(useAppAdvisorWatchersStore.getState().watchers).toEqual(next);
    expect(useAppAdvisorWatchersStore.getState().hydrated).toBe(true);

    off();
    expect(watchersListener).toBeNull();
  });

  it('retainAppAdvisorWatchersBridge shares one ref-counted IPC listener and hydrates once', () => {
    const releaseModal = retainAppAdvisorWatchersBridge();
    const releaseInlineChild = retainAppAdvisorWatchersBridge();
    const releaseSecondInlineChild = retainAppAdvisorWatchersBridge();

    expect(onWatchersChangedMock).toHaveBeenCalledTimes(1);
    expect(listWatchersMock).toHaveBeenCalledTimes(1);

    releaseInlineChild();
    releaseInlineChild();
    releaseSecondInlineChild();
    expect(watchersListener).not.toBeNull();

    const next = [makeWatcher({ id: 'still-live' })];
    watchersListener?.(next);
    expect(useAppAdvisorWatchersStore.getState().watchers).toEqual(next);

    releaseModal();
    expect(watchersListener).toBeNull();

    // The next holder installs a fresh listener.
    const releaseReopened = retainAppAdvisorWatchersBridge();
    expect(onWatchersChangedMock).toHaveBeenCalledTimes(2);
    releaseReopened();
    expect(watchersListener).toBeNull();
  });

  it('watchersForChat filters by destination chat id and visible status', () => {
    const matching = makeWatcher({
      id: 'match',
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
      status: 'active',
    });
    const failed = makeWatcher({
      id: 'failed',
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
      status: 'delivery_failed',
    });
    const wrongChat = makeWatcher({
      id: 'other',
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-2',
      },
    });
    // `firing` and `fired` should never appear in renderer snapshots, but
    // we exercise the local filter defensively so renderer code never
    // surfaces them even if a broadcast did leak.
    const firing = makeWatcher({
      id: 'firing',
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
      status: 'firing',
    });
    const fired = makeWatcher({
      id: 'fired',
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
      status: 'fired',
    });

    useAppAdvisorWatchersStore.setState({
      watchers: [matching, failed, wrongChat, firing, fired],
    });

    const result = useAppAdvisorWatchersStore
      .getState()
      .watchersForChat('advisor-1');
    expect(result.map((w) => w.id)).toEqual(['match', 'failed']);
  });

  it('deleteWatcher records per-id failure messages on { ok: false }', async () => {
    deleteWatcherMock.mockResolvedValueOnce({
      ok: false,
      error: 'unknown watcher',
    });

    const result = await useAppAdvisorWatchersStore
      .getState()
      .deleteWatcher('watcher-77');

    expect(result).toEqual({ ok: false, error: 'unknown watcher' });
    expect(
      useAppAdvisorWatchersStore.getState().deleteErrors['watcher-77'],
    ).toBe('unknown watcher');
  });

  it('deleteWatcher does not throw when the IPC bridge rejects and records the failure', async () => {
    deleteWatcherMock.mockRejectedValueOnce(new Error('ipc down'));

    const result = await useAppAdvisorWatchersStore
      .getState()
      .deleteWatcher('watcher-99');

    expect(result).toEqual({ ok: false, error: 'ipc down' });
    expect(
      useAppAdvisorWatchersStore.getState().deleteErrors['watcher-99'],
    ).toBe('ipc down');
  });

  it('deleteWatcher forwards notifySubscriber=true as a structured request', async () => {
    deleteWatcherMock.mockResolvedValueOnce({ ok: true });
    await useAppAdvisorWatchersStore
      .getState()
      .deleteWatcher('watcher-notify', { notifySubscriber: true });
    expect(deleteWatcherMock).toHaveBeenCalledWith({
      watcherId: 'watcher-notify',
      notifySubscriber: true,
    });
  });

  it('deleteWatcher preserves the legacy string-id path when notifySubscriber is omitted', async () => {
    deleteWatcherMock.mockResolvedValueOnce({ ok: true });
    await useAppAdvisorWatchersStore.getState().deleteWatcher('watcher-legacy');
    expect(deleteWatcherMock).toHaveBeenCalledWith('watcher-legacy');
  });

  it('watchersForTargetChat filters by worktree_chat target and visible status', () => {
    const matching = makeWatcher({
      id: 'target-match',
      target: {
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });
    const otherChat = makeWatcher({
      id: 'other-target',
      target: {
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-2',
      },
    });
    const pipelineTarget = makeWatcher({
      id: 'pipeline-target',
      trigger: 'worktree_pipeline_completion',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        executionId: 'exec-1',
      },
    });

    useAppAdvisorWatchersStore.setState({
      watchers: [matching, otherChat, pipelineTarget],
    });

    const result = useAppAdvisorWatchersStore.getState().watchersForTargetChat({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(result.map((w) => w.id)).toEqual(['target-match']);
  });

  it('createWatcher forwards the request and returns the backend result', async () => {
    createWatcherMock.mockResolvedValueOnce({
      ok: true,
      results: [{ status: 'created', watcher: makeWatcher({ id: 'new' }) }],
    });
    const request = {
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
      watcher: {
        trigger: 'worktree_chat_completion' as const,
        target: {
          kind: 'worktree_chat' as const,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      },
    };

    const result = await useAppAdvisorWatchersStore
      .getState()
      .createWatcher(request);

    expect(createWatcherMock).toHaveBeenCalledWith(request);
    expect(result.ok).toBe(true);
  });

  it('createWatcher returns a structured error when the IPC rejects', async () => {
    createWatcherMock.mockRejectedValueOnce(new Error('nope'));
    const result = await useAppAdvisorWatchersStore.getState().createWatcher({
      destination: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      },
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
    expect(result).toEqual({ ok: false, error: 'nope' });
  });

  it('updateWatcherFollowUp forwards watcherId and instruction', async () => {
    await useAppAdvisorWatchersStore
      .getState()
      .updateWatcherFollowUp('watcher-5', 'do the thing');
    expect(updateWatcherMock).toHaveBeenCalledWith({
      watcherId: 'watcher-5',
      followUpInstruction: 'do the thing',
    });
  });

  it('holdChatFiring and releaseChatFiring forward the chat target', () => {
    const target = {
      scope: 'worktree' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    useAppAdvisorWatchersStore.getState().holdChatFiring(target);
    useAppAdvisorWatchersStore.getState().releaseChatFiring(target);
    expect(holdChatFiringMock).toHaveBeenCalledWith(target);
    expect(releaseChatFiringMock).toHaveBeenCalledWith(target);
  });

  it('hydrate also refreshes the completed-fire history', async () => {
    const completed = [
      makeWatcher({
        id: 'done',
        status: 'fired',
        firedAt: '2026-08-30T10:00:00.000Z',
      }),
    ];
    listCompletedWatchersMock.mockResolvedValueOnce(completed);

    await useAppAdvisorWatchersStore.getState().hydrate();
    // The completed refresh is fire-and-forget off the hydrate path.
    await Promise.resolve();

    expect(listCompletedWatchersMock).toHaveBeenCalledTimes(1);
    expect(useAppAdvisorWatchersStore.getState().completedWatchers).toEqual(
      completed,
    );
  });

  it('a watchers-changed broadcast re-fetches the completed-fire history', async () => {
    const completed = [
      makeWatcher({
        id: 'freshly-fired',
        status: 'fired',
        firedAt: '2026-08-30T11:00:00.000Z',
      }),
    ];
    listCompletedWatchersMock.mockResolvedValue(completed);

    useAppAdvisorWatchersStore.getState().subscribeBridge();
    watchersListener?.([]);
    await Promise.resolve();

    expect(listCompletedWatchersMock).toHaveBeenCalled();
    expect(useAppAdvisorWatchersStore.getState().completedWatchers).toEqual(
      completed,
    );
  });

  it('folds broadcasts during a completed-history fetch into one follow-up fetch', async () => {
    const pending: Array<(watchers: AppAdvisorWatcherSummary[]) => void> = [];
    listCompletedWatchersMock.mockImplementation(
      () =>
        new Promise<AppAdvisorWatcherSummary[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };

    useAppAdvisorWatchersStore.getState().subscribeBridge();
    watchersListener?.([]);
    watchersListener?.([]);
    watchersListener?.([]);
    await settle();
    expect(listCompletedWatchersMock).toHaveBeenCalledTimes(1);

    pending.shift()?.([]);
    await settle();
    expect(listCompletedWatchersMock).toHaveBeenCalledTimes(2);

    const latest = [makeWatcher({ id: 'latest', status: 'fired' })];
    pending.shift()?.(latest);
    await settle();
    expect(listCompletedWatchersMock).toHaveBeenCalledTimes(2);
    expect(useAppAdvisorWatchersStore.getState().completedWatchers).toEqual(
      latest,
    );
  });

  it('keeps the previous completed history when the history fetch fails', async () => {
    const previous = [makeWatcher({ id: 'kept', status: 'fired' })];
    useAppAdvisorWatchersStore.setState({ completedWatchers: previous });
    listCompletedWatchersMock.mockRejectedValueOnce(new Error('down'));

    useAppAdvisorWatchersStore.getState().subscribeBridge();
    watchersListener?.([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useAppAdvisorWatchersStore.getState().completedWatchers).toEqual(
      previous,
    );
  });

  it('drops stale delete errors when the upstream snapshot no longer contains the watcher', async () => {
    deleteWatcherMock.mockResolvedValueOnce({
      ok: false,
      error: 'still firing',
    });
    await useAppAdvisorWatchersStore.getState().deleteWatcher('watcher-1');
    expect(
      useAppAdvisorWatchersStore.getState().deleteErrors['watcher-1'],
    ).toBeDefined();

    useAppAdvisorWatchersStore.getState().subscribeBridge();
    watchersListener?.([]);

    expect(useAppAdvisorWatchersStore.getState().deleteErrors).toEqual({});
  });
});
