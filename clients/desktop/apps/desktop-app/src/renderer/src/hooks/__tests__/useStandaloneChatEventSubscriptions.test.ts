/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChatTabsFile,
  StandaloneChatMetaUpdatedEvent,
} from '@canopy/desktop-shared/types';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { useStandaloneChatEventSubscriptions } from '../useStandaloneChatEventSubscriptions';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

const WORKSPACE_ID = 'cowork-1';
const ENTRY_ID = 'entry-1';
const KEY = `${WORKSPACE_ID}/${ENTRY_ID}`;
const CHAT_ID = 'chat-1';

function makeChatTab(overrides?: Partial<ChatTab>): ChatTab {
  return {
    id: CHAT_ID,
    title: 'Cowork chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    model: 'gpt-5.1-codex',
    providerType: 'codex',
    ...overrides,
  };
}

function HookHarness(): null {
  useStandaloneChatEventSubscriptions();
  return null;
}

describe('useStandaloneChatEventSubscriptions model sync (CAN-1305)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;
  let metaHandler: ((event: StandaloneChatMetaUpdatedEvent) => void) | null;
  const unsubscribe = jest.fn();
  const loadTabs = jest.fn<Promise<ChatTabsFile>, [unknown]>();
  const changeModel = jest.fn<Promise<boolean>, [unknown]>();
  const discoverWorktreeEnv = jest.fn().mockResolvedValue({});
  const refreshWorkEntries = jest.fn();
  const loadSidebarProjectEntries = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    ]);
    metaHandler = null;
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab()], activeTabId: CHAT_ID },
      },
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: WORKSPACE_ID,
      refreshWorkEntries,
      loadSidebarProjectEntries,
    });
    originalApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        standaloneChat: {
          onMetaUpdated: jest.fn(
            (handler: (event: StandaloneChatMetaUpdatedEvent) => void) => {
              metaHandler = handler;
              return unsubscribe;
            },
          ),
        },
        chat: { loadTabs, changeModel },
        discoverWorktreeEnv,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(HookHarness));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  async function emit(event: StandaloneChatMetaUpdatedEvent): Promise<void> {
    await act(async () => {
      metaHandler?.(event);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function storedTab(): ChatTab | undefined {
    return useChatStore.getState().worktreeChats[KEY]?.tabs[0];
  }

  it('applies a portal-persisted model to the in-memory tab', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [
        { id: CHAT_ID, model: 'claude-sonnet-4-6', providerType: 'claude' },
      ],
    });

    await emit({ projectId: WORKSPACE_ID, chatId: CHAT_ID });

    expect(loadTabs).toHaveBeenCalledWith({
      projectId: WORKSPACE_ID,
      worktreeId: ENTRY_ID,
    });
    expect(storedTab()?.model).toBe('claude-sonnet-4-6');
    expect(storedTab()?.providerType).toBe('claude');
  });

  it('does not read tabs for a whole-file nudge that names no chat', async () => {
    await emit({ projectId: WORKSPACE_ID });

    expect(loadTabs).not.toHaveBeenCalled();
    expect(storedTab()?.model).toBe('gpt-5.1-codex');
  });

  it('leaves the tab untouched when the persisted model is unchanged', async () => {
    const before = useChatStore.getState().worktreeChats;
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, model: 'gpt-5.1-codex', providerType: 'codex' }],
    });

    await emit({ projectId: WORKSPACE_ID, chatId: CHAT_ID });

    expect(useChatStore.getState().worktreeChats).toBe(before);
  });

  it('leaves the tab untouched when the persisted file omits the harness', async () => {
    // Only the portal `set_model` path writes `executionHarness`; every other
    // `standaloneChatMetaUpdated` emitter leaves whatever the file already had.
    // A tab that carries a locally-resolved harness must not be rewritten (and
    // re-rendered) just because the persisted record has none to apply.
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [makeChatTab({ executionHarness: 'codex' })],
          activeTabId: CHAT_ID,
        },
      },
    });
    const before = useChatStore.getState().worktreeChats;
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, model: 'gpt-5.1-codex', providerType: 'codex' }],
    });

    await emit({ projectId: WORKSPACE_ID, chatId: CHAT_ID });

    expect(useChatStore.getState().worktreeChats).toBe(before);
  });

  it('does not let an older portal model read overwrite a newer one', async () => {
    let resolveOlder!: (file: ChatTabsFile) => void;
    loadTabs
      .mockImplementationOnce(
        () =>
          new Promise<ChatTabsFile>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce({
        version: 1,
        activeTabId: CHAT_ID,
        tabs: [
          { id: CHAT_ID, model: 'claude-sonnet-4-6', providerType: 'claude' },
        ],
      });

    const older = useChatStore
      .getState()
      .syncPersistedTabModel(WORKSPACE_ID, CHAT_ID);
    const newer = useChatStore
      .getState()
      .syncPersistedTabModel(WORKSPACE_ID, CHAT_ID);

    await expect(newer).resolves.toBe(true);
    resolveOlder({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, model: 'gpt-5.1-codex', providerType: 'codex' }],
    });

    await expect(older).resolves.toBe(false);
    expect(storedTab()?.model).toBe('claude-sonnet-4-6');
    expect(storedTab()?.providerType).toBe('claude');
  });

  it('does not let a pending portal read roll back a desktop model choice', async () => {
    let resolvePortalRead!: (file: ChatTabsFile) => void;
    loadTabs.mockImplementationOnce(
      () =>
        new Promise<ChatTabsFile>((resolve) => {
          resolvePortalRead = resolve;
        }),
    );
    changeModel.mockResolvedValueOnce(true);

    const portalSync = useChatStore
      .getState()
      .syncPersistedTabModel(WORKSPACE_ID, CHAT_ID);
    await expect(
      useChatStore.getState().setModelAndWait('claude-sonnet-4-6', {
        projectId: WORKSPACE_ID,
        worktreeId: ENTRY_ID,
        chatId: CHAT_ID,
      }),
    ).resolves.toBe(true);

    resolvePortalRead({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, model: 'gpt-5.1-codex', providerType: 'codex' }],
    });

    await expect(portalSync).resolves.toBe(false);
    expect(storedTab()?.model).toBe('claude-sonnet-4-6');
    expect(storedTab()?.providerType).toBe('claude');
  });

  it('keeps a pending portal read when the desktop model choice is rejected', async () => {
    let resolvePortalRead!: (file: ChatTabsFile) => void;
    loadTabs.mockImplementationOnce(
      () =>
        new Promise<ChatTabsFile>((resolve) => {
          resolvePortalRead = resolve;
        }),
    );
    changeModel.mockResolvedValueOnce(false);

    const portalSync = useChatStore
      .getState()
      .syncPersistedTabModel(WORKSPACE_ID, CHAT_ID);
    await expect(
      useChatStore.getState().setModelAndWait('claude-opus-4-6', {
        projectId: WORKSPACE_ID,
        worktreeId: ENTRY_ID,
        chatId: CHAT_ID,
      }),
    ).resolves.toBe(false);

    resolvePortalRead({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [
        { id: CHAT_ID, model: 'claude-sonnet-4-6', providerType: 'claude' },
      ],
    });

    await expect(portalSync).resolves.toBe(true);
    expect(storedTab()?.model).toBe('claude-sonnet-4-6');
    expect(storedTab()?.providerType).toBe('claude');
  });

  it('still refreshes the work-entry list alongside the model sync', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: CHAT_ID,
      tabs: [
        { id: CHAT_ID, model: 'claude-sonnet-4-6', providerType: 'claude' },
      ],
    });

    await emit({ projectId: WORKSPACE_ID, chatId: CHAT_ID });

    expect(refreshWorkEntries).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(loadSidebarProjectEntries).not.toHaveBeenCalled();
  });
});
