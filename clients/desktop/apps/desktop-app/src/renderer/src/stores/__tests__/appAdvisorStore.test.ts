/**
 * @jest-environment jsdom
 */
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  APP_ADVISOR_PROJECT_ID,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWindowState,
} from '@canopy/desktop-shared/types';

const loadPreferencesMock = jest.fn().mockResolvedValue({});
const savePreferencesMock = jest.fn().mockResolvedValue(undefined);
const openWindowMock = jest
  .fn<Promise<AppAdvisorWindowState>, [unknown]>()
  .mockResolvedValue({ open: true, focused: true });
const closeWindowMock = jest
  .fn<Promise<AppAdvisorWindowState>, []>()
  .mockResolvedValue({ open: false, focused: false });
const toggleWindowMock = jest
  .fn<Promise<AppAdvisorWindowState>, [unknown]>()
  .mockResolvedValue({ open: true, focused: true });
const workEntriesListMock = jest.fn().mockResolvedValue({ entries: [] });

function makeEnvelope(): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision: 0,
    capturedAt: new Date(0).toISOString(),
    digest: 'digest',
    snapshot: {
      archivedContainers: { count: 0, viewerOpen: false },
      activePage: 'overview',
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: false,
      },
    },
  };
}

beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  initOllamaModels([]);
});

beforeEach(() => {
  jest.clearAllMocks();
  openWindowMock.mockResolvedValue({ open: true, focused: true });
  closeWindowMock.mockResolvedValue({ open: false, focused: false });
  toggleWindowMock.mockImplementation(() =>
    Promise.resolve({
      open: !useNavigationStore.getState().appAdvisorOpen,
      focused: !useNavigationStore.getState().appAdvisorOpen,
    }),
  );
  workEntriesListMock.mockResolvedValue({ entries: [] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: loadPreferencesMock,
      savePreferences: savePreferencesMock,
      workEntries: { list: workEntriesListMock },
      chat: { saveTabs: jest.fn() },
      appAdvisor: {
        openWindow: openWindowMock,
        closeWindow: closeWindowMock,
        toggleWindow: toggleWindowMock,
      },
    },
  });
  useChatStore.setState({
    selectedWorktree: null,
    worktreeChats: {},
  });
  useNavigationStore.setState({
    appAdvisorOpen: false,
    appAdvisorFocused: false,
  });
  useAppAdvisorStore.setState({
    open: false,
    pendingQuestions: [],
    appAdvisorModel: 'gpt-5.5',
    appAdvisorThinkingLevel: 'high',
    appAdvisorDefaultInterfaceMode: 'canopy',
    appAdvisorPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  });
  useCurrentUiStateStore.setState({
    revision: 0,
    envelope: makeEnvelope(),
    slices: {},
  });
});

describe('appAdvisorStore window state', () => {
  it('openDialog routes through window IPC and syncs state', async () => {
    useAppAdvisorStore.getState().openDialog();
    await Promise.resolve();
    await Promise.resolve();

    expect(openWindowMock).toHaveBeenCalledWith({
      focus: true,
      focusComposer: true,
    });
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(true);
    expect(useAppAdvisorStore.getState().open).toBe(true);
  });

  it('closeDialog routes through window IPC and preserves pending questions', async () => {
    useAppAdvisorStore.setState({
      pendingQuestions: [
        {
          requestId: 'req-keep',
          question: { question: 'Keep me?', options: ['Yes'] },
        },
      ],
    });

    useAppAdvisorStore.getState().closeDialog();
    await Promise.resolve();
    await Promise.resolve();

    expect(closeWindowMock).toHaveBeenCalled();
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(false);
    // Hide-only: pending questions survive a close.
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(1);
  });

  it('minimizeDialog asks for the bubble and mirrors it', async () => {
    closeWindowMock.mockResolvedValueOnce({
      open: false,
      focused: false,
      layout: 'floating',
      minimized: true,
    });
    useAppAdvisorStore.getState().minimizeDialog();
    await Promise.resolve();
    await Promise.resolve();

    expect(closeWindowMock).toHaveBeenCalledWith({ minimize: true });
    expect(useAppAdvisorStore.getState().minimized).toBe(true);

    // Any later state without the flag (opened again, closed) clears it.
    useAppAdvisorStore
      .getState()
      .syncWindowState({ open: true, focused: true, layout: 'floating' });
    expect(useAppAdvisorStore.getState().minimized).toBe(false);
  });

  it('toggleDialog routes through window IPC', async () => {
    useAppAdvisorStore.getState().toggleDialog();
    await Promise.resolve();
    await Promise.resolve();
    expect(toggleWindowMock).toHaveBeenCalledWith({ focus: true });
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(true);
  });

  it('syncWindowState mirrors visibility and focus into the navigation store', () => {
    useAppAdvisorStore
      .getState()
      .syncWindowState({ open: true, focused: false });

    expect(useAppAdvisorStore.getState().open).toBe(true);
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(true);
    expect(useNavigationStore.getState().appAdvisorFocused).toBe(false);
  });

  it('syncWindowState mirrors whether a main window exists', () => {
    const { syncWindowState } = useAppAdvisorStore.getState();

    syncWindowState({ open: true, focused: false, mainWindowOpen: false });
    expect(useNavigationStore.getState().appAdvisorMainWindowOpen).toBe(false);

    syncWindowState({ open: true, focused: false });
    expect(useNavigationStore.getState().appAdvisorMainWindowOpen).toBe(true);
  });

  it('marks every hydrated App Advisor entry read when becoming focused', () => {
    const markTargetReadMock = jest.fn();
    useChatStore.setState({
      markTargetRead: markTargetReadMock,
      worktreeChats: {
        [`${APP_ADVISOR_PROJECT_ID}/entry-1`]: {
          tabs: [],
          activeTabId: '',
        },
        [`${APP_ADVISOR_PROJECT_ID}/entry-2`]: {
          tabs: [],
          activeTabId: '',
        },
        'other-project/worktree': { tabs: [], activeTabId: '' },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);

    useAppAdvisorStore
      .getState()
      .syncWindowState({ open: true, focused: true });

    expect(markTargetReadMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
      { allTabs: true },
    );
    expect(markTargetReadMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-2',
      { allTabs: true },
    );
    // Foreign slices are never touched.
    expect(markTargetReadMock).not.toHaveBeenCalledWith(
      'other-project',
      'worktree',
      expect.anything(),
    );
  });

  it('does not mark App Advisor read when visible but not focused', () => {
    const markTargetReadMock = jest.fn();
    useChatStore.setState({
      markTargetRead: markTargetReadMock,
      worktreeChats: {
        [`${APP_ADVISOR_PROJECT_ID}/entry-1`]: { tabs: [], activeTabId: '' },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);

    useAppAdvisorStore
      .getState()
      .syncWindowState({ open: true, focused: false });

    expect(markTargetReadMock).not.toHaveBeenCalled();
  });
});

describe('appAdvisorStore hydrateForNavigation', () => {
  it('lists work entries and hydrates each entry tab slice (no sentinel)', async () => {
    loadPreferencesMock.mockResolvedValueOnce({
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
    });
    workEntriesListMock.mockResolvedValueOnce({
      entries: [{ id: 'entry-1' }, { id: 'entry-2' }],
    });
    const loadTabsForTargetMock = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      loadTabsForTarget: loadTabsForTargetMock,
    } as unknown as Parameters<typeof useChatStore.setState>[0]);

    await useAppAdvisorStore.getState().hydrateForNavigation();

    expect(workEntriesListMock).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
    });
    expect(loadTabsForTargetMock).toHaveBeenCalledTimes(2);
    expect(loadTabsForTargetMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
      expect.objectContaining({ model: 'gpt-5.5' }),
    );
    expect(loadTabsForTargetMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-2',
      expect.objectContaining({ model: 'gpt-5.5' }),
    );
    // Never the legacy sentinel slot.
    expect(loadTabsForTargetMock).not.toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'global',
      expect.anything(),
    );
  });

  it('clears every entry after focus arrives before hydration completes', async () => {
    useNavigationStore.setState({ appAdvisorFocused: true });
    workEntriesListMock.mockResolvedValueOnce({
      entries: [{ id: 'entry-1' }, { id: 'entry-2' }],
    });
    const markTargetReadMock = jest.fn();
    const loadTabsForTargetMock = jest.fn(
      (_projectId: string, entryId: string) => {
        useChatStore.setState((state) => ({
          worktreeChats: {
            ...state.worktreeChats,
            [`${APP_ADVISOR_PROJECT_ID}/${entryId}`]: {
              tabs: [],
              activeTabId: '',
            },
          },
        }));
        return Promise.resolve();
      },
    );
    useChatStore.setState({
      loadTabsForTarget: loadTabsForTargetMock,
      markTargetRead: markTargetReadMock,
    } as unknown as Parameters<typeof useChatStore.setState>[0]);

    await useAppAdvisorStore.getState().hydrateForNavigation();

    expect(markTargetReadMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
      { allTabs: true },
    );
    expect(markTargetReadMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-2',
      { allTabs: true },
    );
  });

  it('swallows listing failures (best-effort nav derivation)', async () => {
    workEntriesListMock.mockRejectedValueOnce(new Error('offline'));
    await expect(
      useAppAdvisorStore.getState().hydrateForNavigation(),
    ).resolves.toBeUndefined();
  });
});

describe('appAdvisorStore ask-user questions', () => {
  it('askUserQuestion opens the window and resolves through answerQuestion', async () => {
    const promise = useAppAdvisorStore
      .getState()
      .askUserQuestion('req-1', { question: 'Pick', options: ['A', 'B'] });

    expect(openWindowMock).toHaveBeenCalledWith({ focus: true });
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(1);

    useAppAdvisorStore.getState().answerQuestion('req-1', {
      question: 'Pick',
      selectedOptions: ['A'],
    });

    await expect(promise).resolves.toEqual({
      question: 'Pick',
      selectedOptions: ['A'],
    });
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('askUserQuestion keeps the asking chat so its composer asks it', async () => {
    const promise = useAppAdvisorStore
      .getState()
      .askUserQuestion(
        'req-chat',
        { question: 'Pick', options: ['A'] },
        'tab-7',
      );
    expect(useAppAdvisorStore.getState().pendingQuestions).toEqual([
      {
        requestId: 'req-chat',
        question: { question: 'Pick', options: ['A'] },
        chatId: 'tab-7',
      },
    ]);
    useAppAdvisorStore.getState().dismissQuestion('req-chat');
    await expect(promise).resolves.toBeNull();
  });

  it('askUserQuestion is idempotent on duplicate unresolved requestIds', async () => {
    const requestId = `req-dup-${Math.random().toString(36).slice(2)}`;
    const first = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestId, { question: 'Q', options: ['A'] });
    const second = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestId, { question: 'Q', options: ['A'] });

    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(1);

    useAppAdvisorStore.getState().answerQuestion(requestId, {
      question: 'Q',
      selectedOptions: ['A'],
    });
    await expect(first).resolves.toEqual({
      question: 'Q',
      selectedOptions: ['A'],
    });
    await expect(second).resolves.toEqual({
      question: 'Q',
      selectedOptions: ['A'],
    });
  });

  it('re-asks of an answered requestId resolve with the cached answer', async () => {
    const requestId = `req-cached-${Math.random().toString(36).slice(2)}`;
    const first = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestId, { question: 'Q', options: ['A'] });
    useAppAdvisorStore.getState().answerQuestion(requestId, {
      question: 'Q',
      selectedOptions: ['A'],
    });
    await first;
    openWindowMock.mockClear();

    const reAsk = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestId, { question: 'Q', options: ['A'] });
    await expect(reAsk).resolves.toEqual({
      question: 'Q',
      selectedOptions: ['A'],
    });
    // Cached answers never re-open the window.
    expect(openWindowMock).not.toHaveBeenCalled();
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('dismissQuestion resolves null and removes the card', async () => {
    const requestId = `req-dismiss-${Math.random().toString(36).slice(2)}`;
    const promise = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestId, { question: 'Q', options: ['A'] });
    useAppAdvisorStore.getState().dismissQuestion(requestId);
    await expect(promise).resolves.toBeNull();
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('dismissAllQuestions resolves all pending with null', async () => {
    const requestA = `req-a-${Math.random().toString(36).slice(2)}`;
    const requestB = `req-b-${Math.random().toString(36).slice(2)}`;
    const a = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestA, { question: 'A', options: ['x'] });
    const b = useAppAdvisorStore
      .getState()
      .askUserQuestion(requestB, { question: 'B', options: ['y'] });
    useAppAdvisorStore.getState().dismissAllQuestions();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(0);
  });
});

describe('appAdvisorStore preferences', () => {
  it('applyPreferences normalizes builtin skill sources and dedupes refs', () => {
    useAppAdvisorStore.getState().applyPreferences({
      appAdvisorModel: 'claude-sonnet-4-6',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'builtin', skillName: 'deep-research' },
          { sourceId: 'builtin/app', skillName: 'deep-research' },
          { sourceId: 'marketplace:x', skillName: 'other' },
        ],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      defaultAppAdvisorInterfaceMode: 'canopy',
    });

    const selections = useAppAdvisorStore.getState().appAdvisorPluginSelections;
    expect(selections.skillRefs).toEqual([
      { sourceId: 'builtin:app', skillName: 'deep-research' },
      { sourceId: 'marketplace:x', skillName: 'other' },
    ]);
    expect(useAppAdvisorStore.getState().appAdvisorModel).toBe(
      'claude-sonnet-4-6',
    );
  });
});

describe('initial layout', () => {
  async function freshLayout(appAdvisor: object): Promise<string> {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { appAdvisor },
    });
    let layout = '';
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('@/stores/appAdvisorStore');
      layout = fresh.useAppAdvisorStore.getState().layout;
    });
    return layout;
  }

  it('starts in the layout App Advisor’s page was made for', async () => {
    // Early access gives its page the floating layout, so its first frame is
    // the panel and not the full window's layout.
    expect(await freshLayout({ initialLayout: 'floating' })).toBe('floating');
  });

  it('starts in the full layout without one', async () => {
    expect(await freshLayout({})).toBe('full');
  });
});
