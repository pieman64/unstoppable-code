/**
 * Behavioral coverage for `FileTabCloseGuard`. The project's jest setup runs
 * tests in a node environment without a DOM rendering library, so these tests
 * exercise the exact handlers the component uses (shared `saveTab` via the
 * desktop session controller + close-guard identity / dirty / fileKey re-checks
 * against the shared session and `useFileTabUiStore`) without rendering JSX.
 *
 * The single-owner refactor (CAN-1426) routes every save through the shared
 * `FileViewerState.files[key]` session; there is no legacy mirror. The handler
 * mirrors what `FileTabCloseGuard` does in the `Save` button path: kick off the
 * controller's `saveTab`, on success run a dirty re-check, a fileKey `matches`
 * re-check, and an identity check against `pendingUnsavedClose`, and only then
 * call `closeTab({ force: true, projectId, worktreeId })` and clear the pending
 * close.
 */
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  Unsubscribe,
} from '@canopy/app-core';
import type { PortalFilePreview } from '@canopy/protocol/portal';
import type * as ChatStoreModule from '../../../stores/chatStore';
import type * as ControllerModule from '../../../lib/file-viewer/desktop-file-session-controller';
import type * as FileTabUiModule from '../../../stores/fileTabUiStore';
import type * as AppStateModule from '@canopy/app-state';
import type { ChatTab, WorktreeChatState } from '../../../stores/chatStore';
import type { PendingUnsavedFileClose } from '../../../stores/fileTabUiStore';

const saveTabsMock = jest.fn<Promise<void>, [unknown]>();
const loadTabsApiMock = jest.fn<
  Promise<{ version: number; tabs: unknown[]; activeTabId: string }>,
  [unknown]
>();
const activeSessionsMock = jest.fn<
  Promise<{ activeChatIds: string[]; sessions: unknown[] }>,
  [unknown]
>();
const setForegroundWorktreeMock = jest.fn<Promise<void>, [unknown]>();

const DESKTOP_CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

type CommandResponders = {
  [K in CommandName]?: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

interface MockClient {
  client: CanopyClient;
  commandResponders: CommandResponders;
}

const PROJECT_ID = 'p';
const WORKTREE_ID = 'w';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const TAB_ID = 'file-1';
const READ_REQUEST = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  fileRootLocalId: 'repo-1',
  relativePath: 'notes.md',
};

function previewFixture(
  overrides: Partial<QueryMap['file.read']['result']> = {},
): QueryMap['file.read']['result'] {
  return {
    workspaceLocalId: PROJECT_ID,
    worktreeLocalId: WORKTREE_ID,
    fileRootLocalId: 'repo-1',
    path: 'notes.md',
    content: 'hello',
    size: 5,
    version: 'v1',
    truncated: false,
    modifiedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockClient(): MockClient {
  const commandResponders: CommandResponders = {};
  const client: CanopyClient = {
    capabilities: DESKTOP_CAPS,
    query: jest.fn().mockResolvedValue(previewFixture()),
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      const responder = commandResponders[name];
      if (!responder) {
        return Promise.reject(new Error(`no command responder for ${name}`));
      }
      return responder(args);
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  return { client, commandResponders };
}

function makeFileTab(): ChatTab {
  return {
    id: TAB_ID,
    title: 'notes.md',
    kind: 'file',
    filePath: '/abs/path/notes.md',
    description: '/abs/path/notes.md',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-04-25T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

function makeWorktreeState(tab: ChatTab): WorktreeChatState {
  return { tabs: [tab], activeTabId: tab.id };
}

interface Harness {
  chatStore: typeof ChatStoreModule;
  controller: typeof ControllerModule.desktopFileSessionController;
  fileTabUi: typeof FileTabUiModule;
  store: ReturnType<typeof AppStateModule.createFileViewerStore>;
  mock: MockClient;
  fileKey: string;
  detach: () => void;
}

function loadHarness(): Harness {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        chat: {
          saveTabs: saveTabsMock,
          loadTabs: loadTabsApiMock,
          activeSessions: activeSessionsMock,
        },
        github: { setForegroundWorktree: setForegroundWorktreeMock },
      },
    },
  });

  const chatStore = jest.requireActual<typeof ChatStoreModule>(
    '../../../stores/chatStore',
  );
  const controllerModule = jest.requireActual<typeof ControllerModule>(
    '../../../lib/file-viewer/desktop-file-session-controller',
  );
  const fileTabUi = jest.requireActual<typeof FileTabUiModule>(
    '../../../stores/fileTabUiStore',
  );
  const appState =
    jest.requireActual<typeof AppStateModule>('@canopy/app-state');

  const mock = createMockClient();
  const store = appState.createFileViewerStore(mock.client);
  // `chatStore.closeTab` reaches the SAME controller singleton this harness
  // attaches to, because both are resolved from one module registry.
  const controller = controllerModule.desktopFileSessionController;
  const detach = controller.attachStore(store, { onSaveCommitted: () => {} });
  const fileKey = appState.fileViewerKey(READ_REQUEST);

  return { chatStore, controller, fileTabUi, store, mock, fileKey, detach };
}

/** Seed a dirty shared session + tab registration + pending-close request. */
async function seedDirtyPending(h: Harness): Promise<PendingUnsavedFileClose> {
  h.chatStore.useChatStore.setState({
    selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    worktreeChats: { [KEY]: makeWorktreeState(makeFileTab()) },
  });
  h.controller.registerTab(TAB_ID, READ_REQUEST);
  await h.store.getState().openFile(READ_REQUEST);
  h.store.getState().updateContent(h.fileKey, 'hello!');
  const pending: PendingUnsavedFileClose = {
    tabId: TAB_ID,
    fileKey: h.fileKey,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    title: 'notes.md',
    filePath: '/abs/path/notes.md',
  };
  h.fileTabUi.useFileTabUiStore.getState().requestUnsavedClose(pending);
  return pending;
}

/** The Don't Save handler used by `FileTabCloseGuard`, lifted for testing. */
function runGuardDontSaveHandler(
  pending: PendingUnsavedFileClose,
  h: Harness,
): void {
  if (!h.controller.matches(pending.tabId, pending.fileKey)) {
    h.fileTabUi.useFileTabUiStore.getState().clearPendingUnsavedClose();
    return;
  }
  h.controller.discardTab(pending.tabId);
  h.chatStore.useChatStore.getState().closeTab(pending.tabId, {
    force: true,
    projectId: pending.projectId,
    worktreeId: pending.worktreeId,
  });
  h.fileTabUi.useFileTabUiStore.getState().clearPendingUnsavedClose();
}

/** The Save handler used by `FileTabCloseGuard`, lifted for direct testing. */
async function runGuardSaveHandler(
  pending: PendingUnsavedFileClose,
  h: Harness,
): Promise<void> {
  if (!h.controller.matches(pending.tabId, pending.fileKey)) {
    h.fileTabUi.useFileTabUiStore.getState().clearPendingUnsavedClose();
    return;
  }
  const saved = await h.controller.saveTab(pending.tabId);
  if (!saved) return;
  if (h.controller.isDirty(pending.tabId)) return;
  if (!h.controller.matches(pending.tabId, pending.fileKey)) return;
  const current = h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose;
  if (
    !current ||
    current.tabId !== pending.tabId ||
    current.fileKey !== pending.fileKey ||
    current.projectId !== pending.projectId ||
    current.worktreeId !== pending.worktreeId ||
    current.title !== pending.title ||
    current.filePath !== pending.filePath
  ) {
    return;
  }
  h.chatStore.useChatStore.getState().closeTab(pending.tabId, {
    force: true,
    projectId: pending.projectId,
    worktreeId: pending.worktreeId,
  });
  h.fileTabUi.useFileTabUiStore.getState().clearPendingUnsavedClose();
}

beforeEach(() => {
  saveTabsMock.mockReset().mockResolvedValue(undefined);
  loadTabsApiMock
    .mockReset()
    .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' });
  activeSessionsMock
    .mockReset()
    .mockResolvedValue({ activeChatIds: [], sessions: [] });
  setForegroundWorktreeMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.resetModules();
});

describe('FileTabCloseGuard Save handler', () => {
  it("clears a stale Don't Save request without discarding or closing the replacement file", async () => {
    const h = loadHarness();
    const pending = await seedDirtyPending(h);
    const matches = jest.spyOn(h.controller, 'matches').mockReturnValue(false);
    const discardTab = jest.spyOn(h.controller, 'discardTab');
    const closeTab = jest.spyOn(
      h.chatStore.useChatStore.getState(),
      'closeTab',
    );

    runGuardDontSaveHandler(pending, h);

    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
    ).toBeNull();
    expect(discardTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    matches.mockRestore();
    discardTab.mockRestore();
    closeTab.mockRestore();
    h.detach();
  });

  it('clears a stale Save request without writing the replacement file', async () => {
    const h = loadHarness();
    const pending = await seedDirtyPending(h);
    const matches = jest.spyOn(h.controller, 'matches').mockReturnValue(false);
    const saveTab = jest.spyOn(h.controller, 'saveTab');

    await runGuardSaveHandler(pending, h);

    expect(saveTab).not.toHaveBeenCalled();
    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
    ).toBeNull();
    matches.mockRestore();
    saveTab.mockRestore();
    h.detach();
  });

  it('force-closes the originating tab and clears pendingUnsavedClose on success', async () => {
    const h = loadHarness();
    h.mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(previewFixture({ content: 'hello!', version: 'v2' }));
    const pending = await seedDirtyPending(h);

    await runGuardSaveHandler(pending, h);

    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
    ).toBeNull();
    const wc = h.chatStore.useChatStore.getState().worktreeChats[KEY];
    if (wc) {
      expect(wc.tabs.some((t) => t.id === TAB_ID)).toBe(false);
    }
    h.detach();
  });

  it('does NOT close the tab when edits are made during the in-flight save (dirty re-check)', async () => {
    const h = loadHarness();
    let resolveSave: (value: PortalFilePreview) => void = () => undefined;
    h.mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      new Promise((resolve) => {
        resolveSave = resolve;
      });
    const pending = await seedDirtyPending(h);

    const guardPromise = runGuardSaveHandler(pending, h);
    // User keeps typing while the save is in flight.
    h.store.getState().updateContent(h.fileKey, 'hello!! more');
    resolveSave(previewFixture({ content: 'hello!', version: 'v2' }));
    await guardPromise;

    const wc = h.chatStore.useChatStore.getState().worktreeChats[KEY];
    expect(wc?.tabs.some((t) => t.id === TAB_ID)).toBe(true);
    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
    ).not.toBeNull();
    h.detach();
  });

  it('does NOT close the tab when pendingUnsavedClose is replaced mid-flight (identity check)', async () => {
    const h = loadHarness();
    let resolveSave: (value: PortalFilePreview) => void = () => undefined;
    h.mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      new Promise((resolve) => {
        resolveSave = resolve;
      });
    const pending = await seedDirtyPending(h);

    const guardPromise = runGuardSaveHandler(pending, h);
    // Replace pendingUnsavedClose with a different request.
    h.fileTabUi.useFileTabUiStore.getState().requestUnsavedClose({
      ...pending,
      tabId: 'some-other-tab',
    });
    resolveSave(previewFixture({ content: 'hello!', version: 'v2' }));
    await guardPromise;

    const wc = h.chatStore.useChatStore.getState().worktreeChats[KEY];
    expect(wc?.tabs.some((t) => t.id === TAB_ID)).toBe(true);
    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose?.tabId,
    ).toBe('some-other-tab');
    h.detach();
  });

  it.each([
    ['title', { title: 'replacement.md' }],
    ['filePath', { filePath: '/abs/path/replacement.md' }],
  ] as const)(
    'does NOT close when the pending %s changes during the save',
    async (_field, replacement) => {
      const h = loadHarness();
      let resolveSave: (value: PortalFilePreview) => void = () => undefined;
      h.mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
        new Promise((resolve) => {
          resolveSave = resolve;
        });
      const pending = await seedDirtyPending(h);

      const guardPromise = runGuardSaveHandler(pending, h);
      h.fileTabUi.useFileTabUiStore.getState().requestUnsavedClose({
        ...pending,
        ...replacement,
      });
      resolveSave(previewFixture({ content: 'hello!', version: 'v2' }));
      await guardPromise;

      const wc = h.chatStore.useChatStore.getState().worktreeChats[KEY];
      expect(wc?.tabs.some((t) => t.id === TAB_ID)).toBe(true);
      expect(
        h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
      ).toMatchObject(replacement);
      h.detach();
    },
  );

  it('keeps modal pending entry intact and surfaces the shared error when save fails', async () => {
    const h = loadHarness();
    h.mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('disk full'));
    const pending = await seedDirtyPending(h);

    await runGuardSaveHandler(pending, h);

    const wc = h.chatStore.useChatStore.getState().worktreeChats[KEY];
    expect(wc?.tabs.some((t) => t.id === TAB_ID)).toBe(true);
    expect(
      h.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose,
    ).not.toBeNull();
    const session = h.controller.getSession(TAB_ID);
    expect(session?.status).toBe('error');
    expect(session?.error).toBe('disk full');
    h.detach();
  });
});
