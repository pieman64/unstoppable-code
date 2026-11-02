/**
 * Revisioned chat store coverage for legacy provider-event suppression,
 * account proxy routing, the canonical command port, tab selection and
 * revision-gap recovery.
 * Setup, and why the suite is split, live in `chatStoreRevisionedHarness.ts`.
 */
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type * as NavigationStoreModule from '../navigationStore';
import {
  saveTabsMock,
  getStateMock,
  commandMock,
  loadChatStore,
  persistedTab,
  snapshot,
  changeEvent,
  commandResult,
  deferred,
  flushMicrotasks,
  KEY,
  hydrate,
  installRevisionedChatStoreHooks,
} from './chatStoreRevisionedHarness';

installRevisionedChatStoreHooks();

// Same describe name as chatStore.revisionedDeltas.test.ts keeps full test names.
describe('committed delta application', () => {
  it('suppresses legacy provider-event reduction for a revisioned scope', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const before = useChatStore.getState().worktreeChats[KEY];

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          id: 'legacy-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'must not double-apply' }],
        },
      },
    });

    expect(useChatStore.getState().worktreeChats[KEY]).toBe(before);
  });

  it.each([true, false])(
    'records the account proxy route (%s) from a routing report and keeps it through canonical updates and a refresh',
    async (accountProxyRouted) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const routedTab = (): boolean | undefined =>
        useChatStore
          .getState()
          .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')
          ?.accountProxyRouted;
      expect(routedTab()).toBeUndefined();

      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        data: {
          type: 'canopy_ai_credits_routing',
          provider: 'claude',
          active: false,
          ...(accountProxyRouted ? { accountProxyRouted: true } : {}),
        },
      });
      expect(routedTab()).toBe(accountProxyRouted);

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'tab.upserted',
            tab: persistedTab('chat-1', { title: 'Renamed' }),
          },
        ]),
      );
      expect(routedTab()).toBe(accountProxyRouted);

      // A revision gap reinstalls the scope from a fresh canonical snapshot.
      getStateMock.mockResolvedValue(
        snapshot(9, [persistedTab('chat-1')], 'chat-1'),
      );
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
        );
      await flushMicrotasks();
      expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
        phase: 'live',
        revision: 9,
      });
      expect(routedTab()).toBe(accountProxyRouted);
      expect(saveTabsMock).not.toHaveBeenCalled();
    },
  );

  it('does not regress fresh renderer activity on a revisioned compatibility event', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(5, [persistedTab('chat-1')], 'chat-1');
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    useChatStore.setState((state) => {
      const current = state.worktreeChats[KEY];
      if (!current) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === 'chat-1' ? { ...tab, lastEventAt: 200 } : tab,
            ),
          },
        },
      };
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'continuing',
        canopy_session_continues: true,
      },
    });

    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.lastEventAt,
    ).toBe(200);
  });

  it('does not double-reduce a committed Codex failure compatibility event and refreshes activity ordering', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'chat-1-provider-error',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'The provider failed',
              },
            ],
            timestamp: 2,
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'failed',
            queuedMessageIds: [],
            lastActivityAt: 200,
            error: {
              code: 'provider_error',
              message: 'The provider failed',
              retryable: true,
              occurredAt: new Date().toISOString(),
            },
          },
        },
      ]),
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'The provider failed' },
        },
      },
    });

    const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(tab?.messages.map((message) => message.id)).toEqual([
      'chat-1-m1',
      'chat-1-provider-error',
    ]);
    expect(tab?.status).toBe('error');
    expect(tab?.lastEventAt).toBe(200);
  });

  it('restores terminal activity ordering from a revision-gap snapshot', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(5, [persistedTab('chat-1')], 'chat-1');
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState((state) => {
      const current = state.worktreeChats[KEY];
      if (!current) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === 'chat-1' ? { ...tab, lastEventAt: 100 } : tab,
            ),
          },
        },
      };
    });

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValueOnce(refreshed.promise);
    useChatStore.getState().handleChatStateChanged(
      changeEvent(8, 9, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'failed',
            queuedMessageIds: [],
            lastActivityAt: 200,
            error: {
              code: 'provider_error',
              message: 'The provider failed',
              retryable: true,
              occurredAt: new Date().toISOString(),
            },
          },
        },
      ]),
    );
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'The provider failed' },
        },
      },
    });
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.lastEventAt,
    ).toBe(100);

    const recovered = snapshot(9, [persistedTab('chat-1')], 'chat-1');
    recovered.runtimeByChatId = {
      'chat-1': {
        status: 'failed',
        queuedMessageIds: [],
        lastActivityAt: 200,
        error: {
          code: 'provider_error',
          message: 'The provider failed',
          retryable: true,
          occurredAt: new Date().toISOString(),
        },
      },
    };
    refreshed.resolve(recovered);
    await flushMicrotasks();

    const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(tab?.status).toBe('error');
    expect(tab?.lastEventAt).toBe(200);
  });

  it('commits a background turn unread transition through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.unread).toBe(
      true,
    );
    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toContainEqual({ type: 'chat.mark_unread', chatId: 'chat-1' });
  });

  it('defers a background unread command until revision recovery is live', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValueOnce(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValueOnce(refreshed.promise);
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'missing' },
        ]),
      );
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );

    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type === 'chat.mark_unread') {
        useChatStore.getState().handleChatStateChanged(
          changeEvent(9, 10, [
            {
              type: 'tab.upserted',
              tab: persistedTab('chat-1', { unread: true }),
            },
          ]),
        );
      }
      return Promise.resolve(commandResult(envelope.commandId, 'applied'));
    });
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();
    expect(commandMock).not.toHaveBeenCalled();

    refreshed.resolve(
      snapshot(9, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toContainEqual({ type: 'chat.mark_unread', chatId: 'chat-1' });
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.unread).toBe(
      true,
    );
  });

  it('commits tab activation, read state, and attention dismissal through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.activate_tab', tabId: 'chat-1' },
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
    ]);
  });

  it('keeps the latest optimistic tab selection while an older activation delta is delayed', async () => {
    const { useChatStore } = loadChatStore();
    const activation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
    );
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.activate_tab'
        ? activation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    // Main was already committing the previous selection when the click
    // occurred. Its contiguous event is canonical but older than the user's
    // in-flight activation, so it must not repaint the visible selection.
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-1' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    const activationEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.activate_tab',
    )?.[0];
    if (!activationEnvelope) throw new Error('Expected activation command');
    activation.resolve({
      commandId: activationEnvelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    // A command result can beat its broadcast; keep the overlay through that
    // interval as well.
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('keeps a newly created tab selected while an older activation commits', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    useChatStore
      .getState()
      .createTab({ projectId: 'proj', worktreeId: 'wt', id: 'new-draft' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-1' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'new-draft',
    );
    const envelope = commandMock.mock.calls.find(
      ([call]) => call.command.type === 'chat.create_tab',
    )?.[0];
    if (!envelope) throw new Error('Expected creation command');
    creation.resolve({
      commandId: envelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'new-draft' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'new-draft',
    );
  });

  it.each(['rejected', 'transport_failed'] as const)(
    'releases a new-tab selection when creation is %s',
    async (failure) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const creation = deferred<ChatCommandResult>();
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.create_tab'
          ? creation.promise
          : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      useChatStore
        .getState()
        .createTab({ projectId: 'proj', worktreeId: 'wt', id: 'new-draft' });
      await flushMicrotasks();
      const envelope = commandMock.mock.calls.find(
        ([call]) => call.command.type === 'chat.create_tab',
      )?.[0];
      if (!envelope) throw new Error('Expected creation command');
      if (failure === 'rejected') {
        creation.resolve({
          commandId: envelope.commandId,
          revision: 5,
          outcome: 'rejected',
        });
      } else {
        creation.reject(new Error('Creation transport failed'));
      }
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        'chat-1',
      );
    },
  );

  it.each(['openFileTab', 'createEmptyFileTab'] as const)(
    'keeps a %s tab selected while an older tab activation commits',
    async (open) => {
      const { useChatStore } = loadChatStore();
      const target = { projectId: 'proj', worktreeId: 'wt' };
      const activation = deferred<ChatCommandResult>();
      const creation = deferred<ChatCommandResult>();
      getStateMock.mockResolvedValue(
        snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
      );
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.activate_tab'
          ? activation.promise
          : envelope.command.type === 'chat.create_file_tab'
            ? creation.promise
            : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');

      // A tab click still crossing to main, then a file tab opened (e.g. from
      // that tab's embedded tree) before the click's activation commits.
      useChatStore.getState().switchTab('chat-2', target);
      const fileTabId =
        open === 'openFileTab'
          ? useChatStore
              .getState()
              .openFileTab(
                { absolutePath: '/repo/q3.xlsx', filename: 'q3.xlsx' },
                target,
              )
          : useChatStore.getState().createEmptyFileTab(target);
      if (fileTabId === null) throw new Error('Expected a file tab');
      await flushMicrotasks();
      const envelopeFor = (type: ChatCommand['type']): ChatCommandEnvelope => {
        const envelope = commandMock.mock.calls.find(
          ([call]) => call.command.type === type,
        )?.[0];
        if (!envelope) throw new Error(`Expected ${type}`);
        return envelope;
      };

      activation.resolve({
        commandId: envelopeFor('chat.activate_tab').commandId,
        revision: 6,
        outcome: 'applied',
      });
      await flushMicrotasks();
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(5, 6, [
            { type: 'tab.active_changed', activeTabId: 'chat-2' },
          ]),
        );
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );

      creation.resolve({
        commandId: envelopeFor('chat.create_file_tab').commandId,
        revision: 7,
        outcome: 'applied',
      });
      await flushMicrotasks();
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(6, 7, [
            { type: 'tab.active_changed', activeTabId: fileTabId },
          ]),
        );
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );
    },
  );

  it('waits for an empty file tab to be created before assigning its path', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_file_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    const target = { projectId: 'proj', worktreeId: 'wt' };
    const tabId = useChatStore.getState().createEmptyFileTab(target);
    if (tabId === null) throw new Error('Expected an empty file tab');
    useChatStore
      .getState()
      .assignFileTab(
        tabId,
        { absolutePath: '/repo/assigned.md', filename: 'assigned.md' },
        target,
      );
    await flushMicrotasks();
    expect(commandMock.mock.calls.map(([call]) => call.command.type)).toEqual([
      'chat.create_file_tab',
    ]);

    const envelope = commandMock.mock.calls[0]?.[0];
    if (!envelope) throw new Error('Expected creation command');
    creation.resolve(commandResult(envelope.commandId, 'applied'));
    await flushMicrotasks();
    expect(commandMock.mock.calls.map(([call]) => call.command.type)).toEqual([
      'chat.create_file_tab',
      'chat.patch_tab_settings',
    ]);
  });

  it.each(['rejected', 'transport_failed'] as const)(
    'releases a new file-tab selection when creation is %s',
    async (failure) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const creation = deferred<ChatCommandResult>();
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.create_file_tab'
          ? creation.promise
          : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      const fileTabId = useChatStore
        .getState()
        .openFileTab(
          { absolutePath: '/repo/q3.xlsx', filename: 'q3.xlsx' },
          { projectId: 'proj', worktreeId: 'wt' },
        );
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );
      const envelope = commandMock.mock.calls.find(
        ([call]) => call.command.type === 'chat.create_file_tab',
      )?.[0];
      if (!envelope) throw new Error('Expected creation command');
      if (failure === 'rejected') {
        creation.resolve({
          commandId: envelope.commandId,
          revision: 5,
          outcome: 'rejected',
        });
      } else {
        creation.reject(new Error('Creation transport failed'));
      }
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        'chat-1',
      );
    },
  );

  it('creates a background file with a non-activating canonical command (CAN-4663)', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation(() => creation.promise);
    const fileTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/notes.md', filename: 'notes.md' },
        { projectId: 'proj', worktreeId: 'wt' },
        { activate: false },
      );
    await flushMicrotasks();
    const envelope = commandMock.mock.calls[0]?.[0];
    expect(envelope?.command).toMatchObject({
      type: 'chat.create_file_tab',
      tabId: fileTabId,
      activate: false,
    });
    if (!envelope) throw new Error('Expected a creation command');
    creation.resolve({
      commandId: envelope.commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  it('never overwrites a user selection made while a background file tab is created', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_file_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    const target = { projectId: 'proj', worktreeId: 'wt' };
    useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/notes.md', filename: 'notes.md' },
        target,
        { activate: false },
      );
    useChatStore.getState().switchTab('chat-2', target);
    await flushMicrotasks();
    const creationEnvelope = commandMock.mock.calls.find(
      ([call]) => call.command.type === 'chat.create_file_tab',
    )?.[0];
    if (!creationEnvelope) throw new Error('Expected creation command');

    creation.resolve({
      commandId: creationEnvelope.commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();

    const activations = commandMock.mock.calls
      .map(([call]) => call.command)
      .filter((command) => command.type === 'chat.activate_tab');
    expect(activations).toEqual([
      { type: 'chat.activate_tab', tabId: 'chat-2' },
    ]);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('keeps the newest file tab selected while an earlier file-tab creation commits', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creations = new Map<
      string,
      ReturnType<typeof deferred<ChatCommandResult>>
    >();
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.create_file_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      const creation = deferred<ChatCommandResult>();
      creations.set(envelope.command.tabId, creation);
      return creation.promise;
    });
    const target = { projectId: 'proj', worktreeId: 'wt' };
    const firstTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/legacy.doc', filename: 'legacy.doc' },
        target,
      );
    // The next file is opened from the first file tab's embedded tree before
    // the first creation (which also activates its tab in main) commits.
    const secondTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/legacy.xls', filename: 'legacy.xls' },
        target,
      );
    if (firstTabId === null || secondTabId === null) {
      throw new Error('Expected file tabs');
    }
    await flushMicrotasks();
    const commandIdFor = (tabId: string): string => {
      const envelope = commandMock.mock.calls.find(
        ([call]) =>
          call.command.type === 'chat.create_file_tab' &&
          call.command.tabId === tabId,
      )?.[0];
      if (!envelope) throw new Error(`Expected creation of ${tabId}`);
      return envelope.commandId;
    };

    creations.get(firstTabId)?.resolve({
      commandId: commandIdFor(firstTabId),
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: firstTabId },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      secondTabId,
    );

    creations.get(secondTabId)?.resolve({
      commandId: commandIdFor(secondTabId),
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: secondTabId },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      secondTabId,
    );
  });

  it('does not let a late activation result supersede a newer tab click', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });

    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');
    expect(activationEnvelopes).toHaveLength(2);
    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'chat-3' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );
  });

  it('rolls a rejected later activation back to a newer accepted canonical tab', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });
    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');

    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 6,
      outcome: 'rejected',
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('rolls consecutive failed activations back to the confirmed canonical tab', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });
    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');

    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 5,
      outcome: 'rejected',
    });
    await flushMicrotasks();
    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 5,
      outcome: 'rejected',
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  it('commits a visible target acknowledgement through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore.getState().markTargetRead('proj', 'wt', {
      tabId: 'chat-1',
    });
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
    ]);
  });

  it('commits a visible worktree selection acknowledgement through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    const { useNavigationStore } =
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore');
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useNavigationStore.setState({ activePage: 'main' });

    useChatStore.getState().selectWorktree('proj', 'wt');
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
      {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        title: 'Tab chat-1',
        modelConfig: {
          fastMode: false,
          speed: 'standard',
          thinkingLevel: 'high',
        },
        proposalMode: 'optional',
      },
    ]);
  });

  it('on a revision gap keeps the last good transcript, disables send, queries one snapshot, and recovers', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockClear();
    getStateMock.mockReturnValue(refreshed.promise);

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'chat-1-m1' },
        ]),
      );

    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );
    // Last good transcript retained.
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages,
    ).toHaveLength(1);
    // Send is disabled while refreshing: the command path refuses to submit.
    const blocked = await useChatStore
      .getState()
      .dispatchChatCommand(
        { projectId: 'proj', worktreeId: 'wt' },
        { type: 'chat.mark_read', chatId: 'chat-1' },
      );
    expect(blocked).toBe('transport_failed');
    expect(commandMock).not.toHaveBeenCalled();
    expect(getStateMock).toHaveBeenCalledTimes(1); // exactly one refresh query

    refreshed.resolve(snapshot(9, [persistedTab('chat-1')], 'chat-1'));
    await flushMicrotasks();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 9,
    });
  });

  it('keeps the last transcript on refresh failure and recovers via Retry', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    getStateMock.mockRejectedValueOnce(new Error('refresh failed'));
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
      );
    await flushMicrotasks();

    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refresh_error',
    );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    getStateMock.mockResolvedValueOnce(
      snapshot(10, [persistedTab('chat-2')], 'chat-2'),
    );
    useChatStore.getState().retryChatStateRefresh('proj', 'wt');
    await flushMicrotasks();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 10,
    });
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-2']);
  });

  it('materializes a canonical starter tab when Retry recovers an empty scope', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    getStateMock.mockRejectedValueOnce(new Error('refresh failed'));
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
      );
    await flushMicrotasks();

    getStateMock.mockResolvedValueOnce(snapshot(10, [], ''));
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );
    useChatStore.getState().retryChatStateRefresh('proj', 'wt');
    await flushMicrotasks();

    const recovered = useChatStore.getState().worktreeChats[KEY];
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 10,
    });
    expect(recovered?.tabs).toHaveLength(1);
    expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.create_tab',
      tabId: recovered?.tabs[0]?.id,
    });
  });
});
