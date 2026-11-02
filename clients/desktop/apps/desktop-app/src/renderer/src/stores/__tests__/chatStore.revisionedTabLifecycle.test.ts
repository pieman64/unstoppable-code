/**
 * Revisioned chat store coverage for structural tab lifecycle commands,
 * including file view mode defaults and session memory.
 * Setup, and why the suite is split, live in `chatStoreRevisionedHarness.ts`.
 */
import type {
  ChatCommand,
  ChatCommandResult,
  PersistedChatTab,
  initCodexModels as InitCodexModels,
} from '@canopy/desktop-shared/types';
import type * as LastViewModeModule from '../../lib/file-viewer/last-view-mode';
import {
  getStateMock,
  changeModelMock,
  commandMock,
  getResolvedDefaultMock,
  loadChatStore,
  persistedTab,
  tabsFile,
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

describe('structural tab lifecycle commands', () => {
  /**
   * Mimic main's canonical view: structural commands succeed only for tabs
   * main knows about, exactly like the real service's `not_found` handling.
   */
  function installCanonicalAwareCommandMock(initialTabIds: string[]): {
    knownTabIds: Set<string>;
  } {
    const knownTabIds = new Set(initialTabIds);
    commandMock.mockImplementation((envelope): Promise<ChatCommandResult> => {
      const command = envelope.command;
      if (
        command.type === 'chat.create_tab' ||
        command.type === 'chat.create_file_tab'
      ) {
        knownTabIds.add(command.tabId);
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      if (command.type === 'chat.activate_tab') {
        return Promise.resolve(
          commandResult(
            envelope.commandId,
            knownTabIds.has(command.tabId) ? 'applied' : 'not_found',
          ),
        );
      }
      return Promise.resolve(commandResult(envelope.commandId, 'applied'));
    });
    return { knownTabIds };
  }

  it('commits chat.create_tab for a newly created draft tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const draft = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1');
    expect(draft).toBeDefined();
    const createCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_tab');
    expect(createCommands).toEqual([
      expect.objectContaining({ type: 'chat.create_tab', tabId: draft?.id }),
    ]);
  });

  it('queues draft actions behind canonical creation and creates from the latest tab state', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);
    commandMock.mockClear();
    const approvalDefault = deferred<'full-access'>();
    getResolvedDefaultMock.mockReturnValueOnce(approvalDefault.promise);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'draft',
    });
    useChatStore.setState((state) => {
      const worktree = state.worktreeChats[KEY];
      if (!worktree) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...worktree,
            tabs: worktree.tabs.map((tab) =>
              tab.id === 'draft'
                ? { ...tab, title: 'Latest title', selectedRepoId: 'repo-2' }
                : tab,
            ),
          },
        },
      };
    });
    useChatStore.getState().closeTab('draft', {
      projectId: 'proj',
      worktreeId: 'wt',
    });
    await flushMicrotasks();

    expect(commandMock).not.toHaveBeenCalled();

    approvalDefault.resolve('full-access');
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'draft',
        title: 'Latest title',
        selectedRepoId: 'repo-2',
        approvalMode: 'full-access',
      }),
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: 'draft',
      }),
    ]);
  });

  it.each([true, false])(
    'waits for a draft tab creation and keeps its model target after navigation (explicit target: %s)',
    async (explicitTarget) => {
      const { useChatStore } = loadChatStore();
      const { initCodexModels } = jest.requireActual<{
        initCodexModels: typeof InitCodexModels;
      }>('@canopy/desktop-shared/types');
      initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
      installCanonicalAwareCommandMock(['chat-1']);
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(
          commandResult(
            envelope.commandId,
            envelope.command.type === 'chat.patch_tab_settings'
              ? 'not_found'
              : 'applied',
          ),
        ),
      );
      await hydrate(useChatStore);
      commandMock.mockClear();
      const approvalDefault = deferred<'ask'>();
      getResolvedDefaultMock.mockReturnValueOnce(approvalDefault.promise);
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });

      useChatStore.getState().createTab({
        projectId: 'proj',
        worktreeId: 'wt',
        id: 'draft',
      });
      const modelChange = useChatStore.getState().setModelAndWait(
        'gpt-5.5',
        explicitTarget
          ? {
              projectId: 'proj',
              worktreeId: 'wt',
              chatId: 'draft',
            }
          : undefined,
      );
      await flushMicrotasks();

      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { ...state.worktreeChats[KEY], activeTabId: 'chat-1' },
        },
      }));

      // A fresh worktree/chat can expose its composer while approval-default
      // resolution still holds up canonical tab creation. The model channel
      // must not target that renderer-only id and provoke a not_found refresh.
      expect(changeModelMock).not.toHaveBeenCalled();

      approvalDefault.resolve('ask');
      await expect(modelChange).resolves.toBe(true);
      expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
        type: 'chat.create_tab',
        tabId: 'draft',
      });
      expect(changeModelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'draft',
          model: 'gpt-5.5',
        }),
      );
      expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
      expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
        'chat-1',
      );
      expect(useChatStore.getState().pendingModelChanges).toEqual({});
    },
  );

  it('waits for a replaced starter tab close before creating at the returned revision', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((commandEnvelope) => {
      if (commandEnvelope.command.type === 'chat.close_tab') {
        return closeResult.promise;
      }
      return Promise.resolve({
        commandId: commandEnvelope.commandId,
        revision: 7,
        outcome: 'applied',
      });
    });
    await hydrate(useChatStore, [persistedTab('starter', { messages: [] })]);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();

    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        expectedRevision: 5,
        command: {
          type: 'chat.close_tab',
          tabId: 'starter',
          mode: 'discard_empty',
        },
      }),
    );

    closeResult.resolve({
      commandId: commandMock.mock.calls[0]?.[0].commandId ?? 'close',
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();

    expect(commandMock).toHaveBeenCalledTimes(2);
    const createEnvelope = commandMock.mock.calls[1]?.[0];
    expect(createEnvelope?.expectedRevision).toBe(6);
    expect(createEnvelope?.command).toMatchObject({
      type: 'chat.create_tab',
      tabId: 'replacement',
    });
  });

  it('creates a replacement when the deferred starter was never canonical', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock([]);
    const starterDefault = deferred<'ask'>();
    getResolvedDefaultMock
      .mockReturnValueOnce(starterDefault.promise)
      .mockResolvedValueOnce('full-access');

    const hydration = hydrate(useChatStore, []);
    await flushMicrotasks();
    const starterId = useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    expect(starterId).toBeDefined();

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    starterDefault.resolve('ask');
    await hydration;
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'replacement',
        approvalMode: 'full-access',
      }),
    ]);
  });

  it('closes a starter at the revision returned by its pending creation', async () => {
    const { useChatStore } = loadChatStore();
    const starterCreateResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) => {
      if (commandMock.mock.calls.length === 1) {
        return starterCreateResult.promise;
      }
      return Promise.resolve({
        commandId: envelope.commandId,
        revision: envelope.command.type === 'chat.close_tab' ? 7 : 8,
        outcome: 'applied',
      });
    });

    const hydration = hydrate(useChatStore, []);
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);
    const starterEnvelope = commandMock.mock.calls[0]?.[0];
    const starterTabId =
      starterEnvelope?.command.type === 'chat.create_tab'
        ? starterEnvelope.command.tabId
        : undefined;
    expect(starterTabId).toBeDefined();

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);

    starterCreateResult.resolve({
      commandId: starterEnvelope?.commandId ?? 'starter-create',
      revision: 6,
      outcome: 'applied',
    });
    await hydration;
    await flushMicrotasks();
    await flushMicrotasks();

    const closeEnvelope = commandMock.mock.calls[1]?.[0];
    expect(closeEnvelope?.expectedRevision).toBe(6);
    expect(closeEnvelope?.command).toMatchObject({
      type: 'chat.close_tab',
      tabId: starterTabId,
    });
    const replacementEnvelope = commandMock.mock.calls[2]?.[0];
    expect(replacementEnvelope?.expectedRevision).toBe(7);
    expect(replacementEnvelope?.command).toMatchObject({
      type: 'chat.create_tab',
      tabId: 'replacement',
    });
  });

  it('creates a replacement when the discarded starter is already absent', async () => {
    const { useChatStore } = loadChatStore();
    commandMock.mockImplementation((envelope) =>
      Promise.resolve({
        commandId: envelope.commandId,
        revision: envelope.command.type === 'chat.close_tab' ? 6 : 7,
        outcome:
          envelope.command.type === 'chat.close_tab' ? 'not_found' : 'applied',
      }),
    );
    await hydrate(useChatStore, [persistedTab('starter', { messages: [] })]);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({ type: 'chat.close_tab', tabId: 'starter' }),
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'replacement',
      }),
    ]);
    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
  });

  it('consumes approval-default failures while a scope is not revisioned live', async () => {
    const { useChatStore } = loadChatStore();
    useChatStore.setState({
      fetchApprovalDefault: jest
        .fn()
        .mockRejectedValue(new Error('approval defaults unavailable')),
    });

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'hydrating',
      id: 'local-draft',
    });
    await flushMicrotasks();

    expect(
      useChatStore.getState().worktreeChats['proj/hydrating']?.activeTabId,
    ).toBe('local-draft');
  });

  it('a fresh draft tab survives switching away and back without a conflict refresh', async () => {
    // Regression: create a tab, click into another tab, return to the new
    // (unused) tab. Pre-fix the draft never reached canonical state, so the
    // return-activation hit `not_found`, showed "This chat changed
    // elsewhere. Your view has been refreshed.", and the refresh erased the
    // draft.
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const draftId = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1')?.id;
    expect(draftId).toBeDefined();
    if (!draftId) return;

    useChatStore
      .getState()
      .switchTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .switchTab(draftId, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
    const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
    expect(tabs.map((tab) => tab.id)).toContain(draftId);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      draftId,
    );
  });

  it('commits chat.create_file_tab for a newly opened file tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    const fileTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/src/index.ts', filename: 'index.ts' },
        { projectId: 'proj', worktreeId: 'wt' },
      );
    await flushMicrotasks();

    expect(fileTabId).not.toBeNull();
    const fileCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_file_tab');
    expect(fileCommands).toEqual([
      expect.objectContaining({
        type: 'chat.create_file_tab',
        tabId: fileTabId,
        filePath: '/repo/src/index.ts',
      }),
    ]);
    expect(fileCommands[0]).not.toHaveProperty('viewMode');
  });

  it('commits the seeded view mode with chat.create_file_tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    const fileTabId = useChatStore.getState().openFileTab(
      {
        absolutePath: '/repo/docs/report.md',
        filename: 'report.md',
        initialViewMode: 'preview',
      },
      { projectId: 'proj', worktreeId: 'wt' },
    );
    await flushMicrotasks();

    const fileCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_file_tab');
    expect(fileCommands).toEqual([
      expect.objectContaining({
        type: 'chat.create_file_tab',
        tabId: fileTabId,
        filePath: '/repo/docs/report.md',
        viewMode: 'preview',
      }),
    ]);
  });

  it('commits chat.reorder_tabs with the full resulting order', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .reorderTabs('chat-2', 'chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const reorderCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.reorder_tabs');
    expect(reorderCommands).toEqual([
      expect.objectContaining({
        type: 'chat.reorder_tabs',
        tabIds: ['chat-2', 'chat-1'],
      }),
    ]);
  });

  it('sequences pin settings and reorder commands across canonical revisions', async () => {
    const { useChatStore } = loadChatStore();
    let canonicalRevision = 5;
    let canonicalOrder = ['chat-1', 'chat-2'];
    let pinnedChatIds = new Set<string>();
    commandMock.mockImplementation((commandEnvelope) => {
      const expectedRevision = commandEnvelope.expectedRevision;
      if (expectedRevision !== canonicalRevision) {
        return Promise.resolve({
          commandId: commandEnvelope.commandId,
          revision: canonicalRevision,
          outcome: 'conflict',
        });
      }
      const command = commandEnvelope.command;
      if (command.type === 'chat.patch_tab_settings') {
        pinnedChatIds = new Set(pinnedChatIds);
        if (command.patch.pinned === true) pinnedChatIds.add(command.tabId);
        else pinnedChatIds.delete(command.tabId);
      } else if (command.type === 'chat.reorder_tabs') {
        canonicalOrder = [...command.tabIds];
      }
      canonicalRevision += 1;
      return Promise.resolve({
        commandId: commandEnvelope.commandId,
        revision: canonicalRevision,
        outcome: 'applied',
      });
    });
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .setTabPinned('chat-2', true, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([commandEnvelope]) => ({
        type: commandEnvelope.command.type,
        expectedRevision: commandEnvelope.expectedRevision,
      })),
    ).toEqual([
      { type: 'chat.patch_tab_settings', expectedRevision: 5 },
      { type: 'chat.reorder_tabs', expectedRevision: 6 },
    ]);
    expect(Array.from(pinnedChatIds)).toEqual(['chat-2']);
    expect(canonicalOrder).toEqual(['chat-2', 'chat-1']);
  });

  it('commits chat.close_tab discard_empty when closing an unused draft', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);
    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const draftId = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1')?.id;
    expect(draftId).toBeDefined();
    if (!draftId) return;

    useChatStore
      .getState()
      .closeTab(draftId, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(closeCommands).toEqual([
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: draftId,
        mode: 'discard_empty',
      }),
    ]);
  });

  it('does not rematerialize a closed tab when an older upsert arrives after the close result', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.close_tab'
        ? closeResult.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .closeTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const closeEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.close_tab',
    )?.[0];
    if (!closeEnvelope) throw new Error('Expected close command');

    closeResult.resolve({
      commandId: closeEnvelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    // A pre-close mutation was already committed when the user clicked close,
    // but its broadcast was delayed. It may update canonical data without
    // making the optimistically closed tab or panel visible again.
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.upserted', tab: persistedTab('chat-2') },
        ]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [{ type: 'tab.removed', tabId: 'chat-2' }]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);
  });

  it('refreshes a destructively filtered tab when optimistic close is rejected', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.close_tab'
        ? closeResult.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);
    getStateMock.mockClear();
    getStateMock.mockResolvedValue(
      snapshot(7, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
    );

    useChatStore
      .getState()
      .closeTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.upserted', tab: persistedTab('chat-2') },
        ]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    const closeEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.close_tab',
    )?.[0];
    if (!closeEnvelope) throw new Error('Expected close command');
    closeResult.resolve({
      commandId: closeEnvelope.commandId,
      revision: 6,
      outcome: 'rejected',
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(getStateMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1', 'chat-2']);
  });

  it.each([false, true])(
    'archives an unloaded background transcript (bulk: %s)',
    async (bulk) => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        persistedTab('chat-2', {
          messages: [],
          transcriptLoaded: false,
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 2,
            committedByteLength: 200,
            transcriptRevision: 1,
            hasActiveSidecar: false,
            messageCount: 2,
          },
        }),
      ]);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs[1]?.messages,
      ).toEqual([]);
      commandMock.mockClear();

      const target = { projectId: 'proj', worktreeId: 'wt' };
      if (bulk) useChatStore.getState().closeTabs(['chat-2'], target);
      else useChatStore.getState().closeTab('chat-2', target);
      await flushMicrotasks();
      await flushMicrotasks();

      const command = commandMock.mock.calls[0]?.[0].command;
      expect(command).toMatchObject(
        bulk
          ? {
              type: 'chat.close_tabs',
              targets: [{ tabId: 'chat-2', mode: 'archive' }],
            }
          : { type: 'chat.close_tab', tabId: 'chat-2', mode: 'archive' },
      );
    },
  );

  it('atomically persists the replacement when closing the final tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore, [persistedTab('chat-1', { messages: [] })]);

    useChatStore
      .getState()
      .closeTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const replacementId =
      useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(replacementId).toBeDefined();
    expect(closeCommands).toHaveLength(1);
    const closeCommand = closeCommands[0];
    if (!closeCommand || closeCommand.type !== 'chat.close_tab') {
      throw new Error('Expected one close-tab command');
    }
    expect(closeCommand).toMatchObject({
      tabId: 'chat-1',
      mode: 'discard_empty',
      replacementTabId: replacementId,
    });
    expect(closeCommand.replacementTab).toMatchObject({
      type: 'chat.create_tab',
      tabId: replacementId,
      approvalMode: 'ask',
    });
    expect(closeCommand.replacementTab?.modelConfig).toBeDefined();
    expect(typeof closeCommand.replacementTab?.deferredToolsAllowed).toBe(
      'boolean',
    );
  });

  it('commits one atomic command when bulk-closing multiple tabs', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
    await hydrate(useChatStore, [
      persistedTab('chat-1', { messages: [] }),
      persistedTab('chat-2', { messages: [] }),
    ]);

    useChatStore.getState().closeTabs(['chat-1', 'chat-2'], {
      projectId: 'proj',
      worktreeId: 'wt',
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const replacementId =
      useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    expect(commandMock).toHaveBeenCalledTimes(1);
    const closeCommand = commandMock.mock.calls[0]?.[0].command;
    if (!closeCommand || closeCommand.type !== 'chat.close_tabs') {
      throw new Error('Expected one bulk-close command');
    }
    expect(closeCommand).toMatchObject({
      targets: [
        { tabId: 'chat-1', mode: 'discard_empty' },
        { tabId: 'chat-2', mode: 'discard_empty' },
      ],
      replacementTabId: replacementId,
    });
    expect(closeCommand.replacementTab).toMatchObject({
      type: 'chat.create_tab',
      tabId: replacementId,
      approvalMode: 'ask',
    });
    expect(closeCommand.replacementTab?.modelConfig).toBeDefined();
    expect(typeof closeCommand.replacementTab?.deferredToolsAllowed).toBe(
      'boolean',
    );
  });

  it("dispatches close mode 'discard' for a contentful close in a hard-delete sentinel scope", async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['plan-chat']);
    getStateMock.mockResolvedValue({
      schemaVersion: 1,
      projectId: 'plan-explore-chat',
      worktreeId: 'plan-1',
      revision: 5,
      tabsFile: tabsFile([persistedTab('plan-chat')], 'plan-chat'),
      archives: [],
      runtimeByChatId: {},
      queue: [],
    });
    await useChatStore
      .getState()
      .loadTabsForTarget('plan-explore-chat', 'plan-1');

    useChatStore.getState().closeTab('plan-chat', {
      projectId: 'plan-explore-chat',
      worktreeId: 'plan-1',
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(closeCommands).toEqual([
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: 'plan-chat',
        mode: 'discard',
      }),
    ]);
  });

  it('commits chat.fork_tab for a same-scope fork', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore
      .getState()
      .forkTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const forkCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.fork_tab');
    const forkedTab = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1');
    expect(forkedTab).toBeDefined();
    expect(forkCommands).toEqual([
      expect.objectContaining({
        type: 'chat.fork_tab',
        sourceTabId: 'chat-1',
        targetTabId: forkedTab?.id,
      }),
    ]);
  });

  describe('file view mode defaults and session memory (CAN-4955)', () => {
    const target = { projectId: 'proj', worktreeId: 'wt' };
    const fileTab = (
      id: string,
      filePath: string,
      overrides: Partial<PersistedChatTab> = {},
    ): PersistedChatTab =>
      persistedTab(id, {
        kind: 'file',
        title: filePath.split('/').pop(),
        filePath,
        description: filePath,
        messages: [],
        ...overrides,
      });
    const loadMemory = (): typeof LastViewModeModule =>
      jest.requireActual<typeof LastViewModeModule>(
        '../../lib/file-viewer/last-view-mode',
      );
    const commandsOfType = <T extends ChatCommand['type']>(
      type: T,
    ): Array<Extract<ChatCommand, { type: T }>> =>
      commandMock.mock.calls
        .map(([envelope]) => envelope.command)
        .filter(
          (command): command is Extract<ChatCommand, { type: T }> =>
            command.type === type,
        );

    it('commits the same kind default it shows locally', async () => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1']);
      await hydrate(useChatStore);

      const markdownId = useChatStore
        .getState()
        .openFileTab(
          { absolutePath: '/repo/docs/report.md', filename: 'report.md' },
          target,
        );
      const codeId = useChatStore
        .getState()
        .openFileTab(
          { absolutePath: '/repo/src/index.ts', filename: 'index.ts' },
          target,
        );
      await flushMicrotasks();

      const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
      expect(tabs.find((tab) => tab.id === markdownId)?.fileViewMode).toBe(
        'preview',
      );
      expect(
        tabs.find((tab) => tab.id === codeId)?.fileViewMode,
      ).toBeUndefined();
      const creates = commandsOfType('chat.create_file_tab');
      expect(creates.find((c) => c.tabId === markdownId)?.viewMode).toBe(
        'preview',
      );
      expect(creates.find((c) => c.tabId === codeId)).not.toHaveProperty(
        'viewMode',
      );
    });

    it('replaces a stale empty-tab mode when assigning a file', async () => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1', 'empty-code', 'empty-md']);
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('empty-code', '', {
          title: 'Open file',
          fileViewMode: 'preview',
        }),
        fileTab('empty-md', '', { title: 'Open file', fileViewMode: 'raw' }),
      ]);
      commandMock.mockClear();

      useChatStore
        .getState()
        .assignFileTab(
          'empty-code',
          { absolutePath: '/repo/src/index.ts', filename: 'index.ts' },
          target,
        );
      useChatStore
        .getState()
        .assignFileTab(
          'empty-md',
          { absolutePath: '/repo/docs/notes.md', filename: 'notes.md' },
          target,
        );
      await flushMicrotasks();

      const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
      expect(
        tabs.find((tab) => tab.id === 'empty-code')?.fileViewMode,
      ).toBeUndefined();
      expect(tabs.find((tab) => tab.id === 'empty-md')?.fileViewMode).toBe(
        'preview',
      );
      expect(
        commandsOfType('chat.patch_tab_settings').map((c) => [
          c.tabId,
          c.patch.fileViewMode,
        ]),
      ).toEqual([
        ['empty-code', null],
        ['empty-md', 'preview'],
      ]);
    });

    it('remembers an accepted choice across close and reopen', async () => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1', 'file-1']);
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'preview' }),
      ]);

      useChatStore.getState().setFileTabViewMode('file-1', 'raw', target);
      await flushMicrotasks();
      useChatStore.getState().closeTab('file-1', target);
      await flushMicrotasks();
      await flushMicrotasks();
      commandMock.mockClear();

      const reopenedId = useChatStore
        .getState()
        .openFileTab(
          { absolutePath: '/repo/docs/report.md', filename: 'report.md' },
          target,
        );
      await flushMicrotasks();
      const reopened = useChatStore
        .getState()
        .worktreeChats[KEY]?.tabs.find((tab) => tab.id === reopenedId);
      expect(reopened?.fileViewMode).toBe('raw');
      expect(commandsOfType('chat.create_file_tab')[0]?.viewMode).toBe('raw');
    });

    it.each(['closed', 'reassigned'])(
      'remembers an accepted choice for its original file when the tab was %s before acknowledgement',
      async (transition) => {
        const { useChatStore } = loadChatStore();
        const modeResult = deferred<ChatCommandResult>();
        commandMock.mockImplementation((envelope) =>
          envelope.command.type === 'chat.patch_tab_settings'
            ? modeResult.promise
            : Promise.resolve(commandResult(envelope.commandId, 'applied')),
        );
        await hydrate(useChatStore, [
          persistedTab('chat-1'),
          fileTab('file-1', '/repo/docs/report.md', {
            fileViewMode: 'preview',
          }),
        ]);

        useChatStore.getState().setFileTabViewMode('file-1', 'raw', target);
        await flushMicrotasks();
        const modeEnvelope = commandMock.mock.calls.find(
          ([envelope]) => envelope.command.type === 'chat.patch_tab_settings',
        )?.[0];
        if (!modeEnvelope) throw new Error('Expected mode command');

        if (transition === 'closed') {
          useChatStore.getState().closeTab('file-1', target);
          await flushMicrotasks();
          await flushMicrotasks();
          expect(
            useChatStore
              .getState()
              .worktreeChats[KEY]?.tabs.some((tab) => tab.id === 'file-1'),
          ).toBe(false);
        } else {
          // A newer canonical projection retargets the same tab while the
          // earlier command acknowledgement is still in flight.
          useChatStore.setState((state) => ({
            worktreeChats: {
              ...state.worktreeChats,
              [KEY]: {
                ...state.worktreeChats[KEY],
                tabs: state.worktreeChats[KEY].tabs.map((tab) =>
                  tab.id === 'file-1'
                    ? {
                        ...tab,
                        filePath: '/repo/docs/other.md',
                        fileViewMode: 'preview',
                      }
                    : tab,
                ),
              },
            },
          }));
        }
        modeResult.resolve(commandResult(modeEnvelope.commandId, 'applied'));
        await flushMicrotasks();
        await flushMicrotasks();

        expect(
          loadMemory().readRememberedFileViewMode({
            ...target,
            absolutePath: '/repo/docs/report.md',
          }),
        ).toBe('raw');
        expect(
          loadMemory().readRememberedFileViewMode({
            ...target,
            absolutePath: '/repo/docs/other.md',
          }),
        ).toBeUndefined();
      },
    );

    it.each(['applied', 'rejected'] as const)(
      'preserves a restored reading mode only for an accepted Diff transition: %s',
      async (outcome) => {
        const { useChatStore } = loadChatStore();
        await hydrate(useChatStore, [
          persistedTab('chat-1'),
          fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'raw' }),
        ]);
        commandMock.mockImplementation((envelope) =>
          Promise.resolve(commandResult(envelope.commandId, outcome)),
        );
        useChatStore.getState().setFileTabViewMode('file-1', 'diff', target);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(
          loadMemory().readRememberedFileViewMode({
            ...target,
            absolutePath: '/repo/docs/report.md',
          }),
        ).toBe(outcome === 'applied' ? 'raw' : undefined);
      },
    );

    it('keeps an accepted Source choice when Diff sees an older tab projection', async () => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'preview' }),
      ]);
      // Acknowledgements can arrive before their metadata projection.
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      useChatStore.getState().setFileTabViewMode('file-1', 'raw', target);
      await flushMicrotasks();
      useChatStore.getState().setFileTabViewMode('file-1', 'diff', target);
      await flushMicrotasks();
      useChatStore.getState().closeTab('file-1', target);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(
        loadMemory().readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/docs/report.md',
        }),
      ).toBe('raw');
    });

    it('does not remember a rejected view change', async () => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-1', '/repo/docs/report.md'),
      ]);
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(
          commandResult(
            envelope.commandId,
            envelope.command.type === 'chat.patch_tab_settings'
              ? 'rejected'
              : 'applied',
          ),
        ),
      );

      useChatStore.getState().setFileTabViewMode('file-1', 'raw', target);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(
        loadMemory().readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/docs/report.md',
        }),
      ).toBeUndefined();
    });

    it('remembers a restored mode only when the close is accepted', async () => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'raw' }),
      ]);
      const identity = { ...target, absolutePath: '/repo/docs/report.md' };
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(commandResult(envelope.commandId, 'rejected')),
      );

      useChatStore.getState().closeTab('file-1', target);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(loadMemory().readRememberedFileViewMode(identity)).toBeUndefined();

      commandMock.mockImplementation((envelope) =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      useChatStore.getState().closeTab('file-1', target);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(loadMemory().readRememberedFileViewMode(identity)).toBe('raw');
    });

    it('remembers modes from an accepted bulk close', async () => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1', 'file-md', 'file-csv']);
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-md', '/repo/docs/report.md', { fileViewMode: 'raw' }),
        fileTab('file-csv', '/repo/data/rows.csv', { fileViewMode: 'table' }),
      ]);

      useChatStore.getState().closeTabs(['file-md', 'file-csv'], target);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      const memory = loadMemory();
      expect(
        memory.readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/docs/report.md',
        }),
      ).toBe('raw');
      expect(
        memory.readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/data/rows.csv',
        }),
      ).toBe('table');
    });

    it('does not remember modes from a rejected bulk close', async () => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-md', '/repo/docs/report.md', { fileViewMode: 'raw' }),
        fileTab('file-csv', '/repo/data/rows.csv', { fileViewMode: 'table' }),
      ]);
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(commandResult(envelope.commandId, 'rejected')),
      );
      useChatStore.getState().closeTabs(['file-md', 'file-csv'], target);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(
        loadMemory().readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/docs/report.md',
        }),
      ).toBeUndefined();
      expect(
        loadMemory().readRememberedFileViewMode({
          ...target,
          absolutePath: '/repo/data/rows.csv',
        }),
      ).toBeUndefined();
    });

    it.each(['single', 'bulk'] as const)(
      'remembers the original file when a pending %s close sees a reassigned tab',
      async (closeKind) => {
        const { useChatStore } = loadChatStore();
        const closeResult = deferred<ChatCommandResult>();
        commandMock.mockImplementation((envelope) =>
          envelope.command.type === 'chat.close_tab' ||
          envelope.command.type === 'chat.close_tabs'
            ? closeResult.promise
            : Promise.resolve(commandResult(envelope.commandId, 'applied')),
        );
        await hydrate(useChatStore, [
          persistedTab('chat-1'),
          fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'raw' }),
        ]);

        if (closeKind === 'single') {
          useChatStore.getState().closeTab('file-1', target);
        } else {
          useChatStore.getState().closeTabs(['file-1'], target);
        }
        await flushMicrotasks();
        const closeEnvelope = commandMock.mock.calls.find(
          ([envelope]) =>
            envelope.command.type === 'chat.close_tab' ||
            envelope.command.type === 'chat.close_tabs',
        )?.[0];
        if (!closeEnvelope) throw new Error('Expected close command');

        // A canonical update can retarget the tab while its close is pending.
        useChatStore.setState((state) => ({
          worktreeChats: {
            ...state.worktreeChats,
            [KEY]: {
              ...state.worktreeChats[KEY],
              tabs: state.worktreeChats[KEY].tabs.map((tab) =>
                tab.id === 'file-1'
                  ? {
                      ...tab,
                      filePath: '/repo/docs/other.md',
                      fileViewMode: 'preview',
                    }
                  : tab,
              ),
            },
          },
        }));
        closeResult.resolve(commandResult(closeEnvelope.commandId, 'applied'));
        await flushMicrotasks();
        await flushMicrotasks();

        expect(
          loadMemory().readRememberedFileViewMode({
            ...target,
            absolutePath: '/repo/docs/report.md',
          }),
        ).toBe('raw');
        expect(
          loadMemory().readRememberedFileViewMode({
            ...target,
            absolutePath: '/repo/docs/other.md',
          }),
        ).toBeUndefined();
      },
    );

    it('keeps a choice made while an earlier close was still pending', async () => {
      const { useChatStore } = loadChatStore();
      const closeResult = deferred<ChatCommandResult>();
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.close_tab'
          ? closeResult.promise
          : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        fileTab('file-1', '/repo/docs/report.md', { fileViewMode: 'raw' }),
      ]);
      const identity = { ...target, absolutePath: '/repo/docs/report.md' };

      useChatStore.getState().closeTab('file-1', target);
      await flushMicrotasks();
      // A newer choice for the same file lands before the close resolves.
      const memory = loadMemory();
      memory.rememberFileViewModeChoice(identity, 'preview', {
        sequence: memory.nextFileViewModeSequence(),
        tabId: 'file-reopened',
      });
      const closeEnvelope = commandMock.mock.calls.find(
        ([envelope]) => envelope.command.type === 'chat.close_tab',
      )?.[0];
      if (!closeEnvelope) throw new Error('Expected close command');
      closeResult.resolve(commandResult(closeEnvelope.commandId, 'applied'));
      await flushMicrotasks();
      await flushMicrotasks();

      expect(loadMemory().readRememberedFileViewMode(identity)).toBe('preview');
    });
  });
});
