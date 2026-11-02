/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ArchivedContainerSummary,
  CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  AppAdvisorNav,
  isAppAdvisorSettingsSavedDetail,
} from '@/components/app-advisor/AppAdvisorNav';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import { setNativeInputValue } from '@/test-utils/dom';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/lib/browserViewBounds', () => ({
  dispatchBrowserViewBoundsInvalidated: jest.fn(),
}));

import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';

function entry(id: string, title: string): CoworkWorkEntryMeta {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    providerType: 'claude',
    chatCount: 1,
  };
}

function containerSummary(id: string, name: string): ArchivedContainerSummary {
  return {
    version: 1,
    id,
    kind: 'work-entry',
    projectId: 'app-advisor',
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-07-01T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-08T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

function byTestId(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) throw new Error(`Element not found: ${testId}`);
  return found;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AppAdvisorNav', () => {
  it('narrows App Advisor settings events without force casts', () => {
    expect(
      isAppAdvisorSettingsSavedDetail({
        archiveRetentionDays: 30,
        autoArchiveDays: 7,
      }),
    ).toBe(true);
    expect(isAppAdvisorSettingsSavedDetail(null)).toBe(false);
    expect(isAppAdvisorSettingsSavedDetail({ autoArchiveDays: 'seven' })).toBe(
      false,
    );
  });

  let container: HTMLDivElement;
  let root: Root;
  let selectWorkEntryMock: jest.Mock;
  let createWorkEntryMock: jest.Mock;
  let renameWorkEntryMock: jest.Mock;
  let deleteWorkEntryMock: jest.Mock;
  let setWorkEntryPinnedMock: jest.Mock;
  let selectArchiveMock: jest.Mock;
  let loadLegacyArchivedChatsMock: jest.Mock;
  let settingsLoadMock: jest.Mock;
  let settingsChangedListener: (settings: unknown) => void;
  let archivedListMock: jest.Mock;

  beforeEach(() => {
    useSidebarItemGroupsStore.setState({ byScope: {}, errors: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    selectWorkEntryMock = jest.fn().mockResolvedValue(undefined);
    createWorkEntryMock = jest.fn().mockResolvedValue(undefined);
    renameWorkEntryMock = jest.fn().mockResolvedValue(undefined);
    deleteWorkEntryMock = jest.fn().mockResolvedValue(undefined);
    setWorkEntryPinnedMock = jest.fn().mockResolvedValue(undefined);
    selectArchiveMock = jest.fn().mockResolvedValue(undefined);
    loadLegacyArchivedChatsMock = jest.fn().mockResolvedValue(undefined);
    settingsLoadMock = jest.fn().mockResolvedValue({ version: 1 });
    settingsChangedListener = (): void => {};
    archivedListMock = jest.fn().mockResolvedValue([]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        appAdvisor: {
          settingsLoad: settingsLoadMock,
          onSettingsChanged: jest.fn(
            (listener: (settings: unknown) => void) => {
              settingsChangedListener = listener;
              return jest.fn();
            },
          ),
        },
        archivedContainers: { list: archivedListMock },
      },
    });
    // The surface scopes the store to App Advisor before the nav mounts.
    useStandaloneChatStore.setState({
      activeChatProjectId: APP_ADVISOR_PROJECT_ID,
      workEntries: [entry('entry-1', 'First'), entry('entry-2', 'Second')],
      activeWorkEntryId: 'entry-1',
      archiveOverlayChatId: null,
      legacyArchivedByProject: {
        'app-advisor': [
          {
            id: 'legacy-1',
            title: 'Old chat',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            archived: true,
            archivedAt: '2026-06-01T00:00:00.000Z',
            providerType: 'claude',
          } as never,
        ],
      },
      selectWorkEntry: selectWorkEntryMock,
      createWorkEntry: createWorkEntryMock,
      renameWorkEntry: renameWorkEntryMock,
      deleteWorkEntry: deleteWorkEntryMock,
      setWorkEntryPinned: setWorkEntryPinnedMock,
      selectArchive: selectArchiveMock,
      loadLegacyArchivedChats: loadLegacyArchivedChatsMock,
    });
    useArchivedContainersStore.setState({
      byWorkspace: {},
      loadedWorkspaces: {},
      viewer: null,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  async function render(collapsed = false): Promise<void> {
    await act(async () => {
      root.render(<AppAdvisorNav collapsed={collapsed} />);
      // Flush the nav's mount-time settings/container loads inside act.
      await Promise.resolve();
    });
  }

  it('keeps the empty Advisor header and its controls when there are no entries', async () => {
    useStandaloneChatStore.setState({
      workEntries: [],
      activeWorkEntryId: null,
      legacyArchivedByProject: {},
    });
    useSidebarItemGroupsStore.setState({
      byScope: {
        'app-advisor': [
          {
            id: 'grp-kept',
            name: 'Kept',
            color: 'neutral',
            collapsed: false,
            keepWhenEmpty: true,
            memberIds: [],
          },
        ],
      },
    });
    await render();
    expect(byTestId('sidebar-item-group-empty')).toBeDefined();
    expect(byTestId('sidebar-item-group-menu-trigger')).toBeDefined();
    click(byTestId('sidebar-item-group-create'));
    expect(createWorkEntryMock).toHaveBeenCalledWith({
      sidebarItemGroupId: 'grp-kept',
    });
  });

  it('renders entry rows with the nav prefix and no control buttons (corner owns them)', async () => {
    await render();
    expect(byTestId('app-advisor-nav')).toBeTruthy();
    expect(byTestId('app-advisor-nav-entry-entry-1')).toBeTruthy();
    expect(byTestId('app-advisor-nav-entry-entry-2')).toBeTruthy();
    // Toggle/settings/new-entry live in the AppAdvisorTitlebarCorner overlay.
    expect(
      document.querySelector('[data-testid="app-advisor-nav-collapse"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="app-advisor-nav-settings"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="app-advisor-nav-new-entry"]'),
    ).toBeNull();
  });

  it('wires entry selection', async () => {
    await render();
    click(byTestId('app-advisor-nav-entry-entry-2'));
    expect(selectWorkEntryMock).toHaveBeenCalledWith('entry-2');
  });

  it('renames entries through the shared row menu', async () => {
    await render();
    click(byTestId('app-advisor-nav-entry-entry-1-menu'));
    click(byTestId('app-advisor-nav-entry-entry-1-rename'));
    const input = byTestId(
      'app-advisor-nav-entry-entry-1-rename-input',
    ) as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, 'Renamed');
    });
    act(() => {
      input.form?.requestSubmit();
    });
    expect(renameWorkEntryMock).toHaveBeenCalledWith('entry-1', 'Renamed');
    expect(
      document.querySelector(
        '[data-testid="app-advisor-nav-entry-entry-1-rename-input"]',
      ),
    ).toBeNull();
  });

  it('renders each entry as the shared Work Entry row', async () => {
    await render();
    expect(byTestId('app-advisor-nav-entry-entry-1').getAttribute('role')).toBe(
      'button',
    );
    expect(byTestId('app-advisor-nav-entry-entry-1-leading-slot')).toBeTruthy();
  });

  it('offers Pin to top as the first row-menu item and pins in App Advisor', async () => {
    await render();
    click(byTestId('app-advisor-nav-entry-entry-2-menu'));
    const items = document.querySelectorAll<HTMLElement>(
      '[data-testid="app-advisor-nav-entry-entry-2-menu-popover"] [role="menuitem"]',
    );
    expect(items[0]?.dataset.testid).toBe(
      'app-advisor-nav-entry-entry-2-toggle-pin',
    );
    expect(items[0]?.textContent).toContain('Pin to top');
    click(byTestId('app-advisor-nav-entry-entry-2-toggle-pin'));
    expect(setWorkEntryPinnedMock).toHaveBeenCalledWith(
      'entry-2',
      true,
      'app-advisor',
    );
  });

  it('lists pinned entries first, marks them, and offers Unpin', async () => {
    useStandaloneChatStore.setState({
      workEntries: [
        entry('entry-1', 'First'),
        { ...entry('entry-2', 'Second'), pinned: true },
        entry('entry-3', 'Third'),
      ],
    });
    await render();
    const rowIds = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
      ),
      (row) => row.dataset.standaloneChatId,
    );
    expect(rowIds).toEqual(['entry-2', 'entry-1', 'entry-3']);
    expect(
      byTestId('app-advisor-nav-entry-entry-2')
        .querySelector('[data-testid="worktree-row-pinned-badge"]')
        ?.getAttribute('aria-label'),
    ).toBe('Pinned');
    expect(
      byTestId('app-advisor-nav-entry-entry-1').querySelector(
        '[data-testid="worktree-row-pinned-badge"]',
      ),
    ).toBeNull();

    click(byTestId('app-advisor-nav-entry-entry-2-menu'));
    const toggle = byTestId('app-advisor-nav-entry-entry-2-toggle-pin');
    expect(toggle.textContent).toContain('Unpin');
    click(toggle);
    expect(setWorkEntryPinnedMock).toHaveBeenCalledWith(
      'entry-2',
      false,
      'app-advisor',
    );
  });

  it('deletes entries only after the confirm and keeps the container unlocked', async () => {
    await render();
    click(byTestId('app-advisor-nav-entry-entry-2-menu'));
    click(byTestId('app-advisor-nav-entry-entry-2-delete'));
    expect(deleteWorkEntryMock).not.toHaveBeenCalled();
    expect(
      byTestId('app-advisor-nav-entry-entry-2-delete-dialog').textContent,
    ).toContain('Delete “Second”?');
    click(byTestId('app-advisor-nav-entry-entry-2-confirm-delete'));
    expect(deleteWorkEntryMock).toHaveBeenCalledWith('entry-2', undefined, {
      lockAfterArchive: false,
    });
  });

  it('archives entries through the Archive item, asking main to lock the container', async () => {
    await render();
    click(byTestId('app-advisor-nav-entry-entry-2-menu'));
    click(byTestId('app-advisor-nav-entry-entry-2-archive'));
    expect(deleteWorkEntryMock).not.toHaveBeenCalled();
    click(byTestId('app-advisor-nav-entry-entry-2-confirm-delete'));
    expect(deleteWorkEntryMock).toHaveBeenCalledWith('entry-2', undefined, {
      lockAfterArchive: true,
    });
  });

  it('labels Delete with the retention window from settings', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 3,
    });
    await render();
    click(byTestId('app-advisor-nav-entry-entry-1-menu'));
    const menuItem = byTestId('app-advisor-nav-entry-entry-1-delete');
    expect(menuItem.textContent?.trim()).toBe('Delete');
    expect(menuItem.getAttribute('title')).toBe(
      'Kept for 3 days, then removed',
    );
    expect(
      byTestId('app-advisor-nav-entry-entry-1-archive').getAttribute('title'),
    ).toBe('Kept until you delete it');
  });

  it('treats a legacy retention-off setting (0) as the default window', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 0,
    });
    await render();
    click(byTestId('app-advisor-nav-entry-entry-1-menu'));
    const menuItem = byTestId('app-advisor-nav-entry-entry-1-delete');
    expect(menuItem.textContent?.trim()).toBe('Delete');
    expect(menuItem.getAttribute('title')).toBe(
      'Kept for 7 days, then removed',
    );
  });

  it('reconciles retention controls after an external settings save', async () => {
    await render();
    act(() => {
      settingsChangedListener({
        version: 1,
        archiveRetentionDays: 0,
        autoArchiveDays: null,
      });
    });
    click(byTestId('app-advisor-nav-entry-entry-1-menu'));
    expect(
      byTestId('app-advisor-nav-entry-entry-1-delete').textContent?.trim(),
    ).toBe('Delete');
  });

  it('links to the Archived and deleted overview, counting legacy chats and containers', async () => {
    archivedListMock.mockResolvedValue([
      containerSummary('container-1', 'Archived entry'),
    ]);
    await render();
    expect(archivedListMock).toHaveBeenCalledWith({
      projectId: 'app-advisor',
    });

    const link = byTestId('app-advisor-nav-archived-link');
    // Combined count: one legacy chat + one archived container.
    expect(link.textContent).toBe('Archived and deleted 2');
    expect(link.getAttribute('data-selected')).toBe('false');
    // The in-nav list is gone: rows live on the overview page now.
    expect(
      document.querySelector('[data-testid="app-advisor-nav-archived-toggle"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="archived-entry-row-container-1"]'),
    ).toBeNull();

    click(link);
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'app-advisor',
    });
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(
      byTestId('app-advisor-nav-archived-link').getAttribute('data-selected'),
    ).toBe('true');
  });

  it('highlights the overview link while a container viewer is open', async () => {
    await render();
    act(() => {
      useArchivedContainersStore
        .getState()
        .openViewer('app-advisor', 'container-1');
    });
    expect(
      byTestId('app-advisor-nav-archived-link').getAttribute('data-selected'),
    ).toBe('true');
  });

  it('drops the live-entry highlight while the container viewer is open', async () => {
    await render();
    expect(byTestId('app-advisor-nav-entry-entry-1').className).toContain(
      'bg-muted',
    );
    act(() => {
      useArchivedContainersStore
        .getState()
        .openViewer('app-advisor', 'container-1');
    });
    expect(byTestId('app-advisor-nav-entry-entry-1').className).not.toContain(
      'bg-muted',
    );
  });

  it('collapsed mode renders a zero-width nav with no contents', async () => {
    await render(true);
    const nav = byTestId('app-advisor-nav');
    expect(nav.getAttribute('data-collapsed')).toBe('true');
    expect(
      document.querySelector('[data-testid="app-advisor-nav-entry-entry-1"]'),
    ).toBeNull();
    expect(nav.childElementCount).toBe(0);
  });

  it('invalidates browser view bounds when the width transition settles', async () => {
    await render();
    const nav = byTestId('app-advisor-nav');
    act(() => {
      const event = new Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'width' });
      nav.dispatchEvent(event);
    });
    expect(dispatchBrowserViewBoundsInvalidated).toHaveBeenCalledTimes(1);

    // Non-width transitions (e.g. hover colors) never invalidate.
    act(() => {
      const event = new Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'background' });
      nav.dispatchEvent(event);
    });
    expect(dispatchBrowserViewBoundsInvalidated).toHaveBeenCalledTimes(1);
  });
  it('shows an entry whose chat has only background work with the background spinner', async () => {
    useDelegationActivityStore.getState().applyActivity({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      live: 1,
      queued: 1,
    });
    try {
      await render();
      expect(
        byTestId('app-advisor-nav-entry-entry-1-background').getAttribute(
          'aria-label',
        ),
      ).toBe('2 background tasks running');
      expect(
        document.querySelector(
          '[data-testid="app-advisor-nav-entry-entry-1-thinking"]',
        ),
      ).toBeNull();
    } finally {
      resetDelegationActivityStoreForTests();
    }
  });

  it('renders the Advisor group and retains its selected member when collapsed', async () => {
    useSidebarItemGroupsStore.setState({
      byScope: {
        'app-advisor': [
          {
            id: 'grp-advisor',
            name: 'Investigations',
            color: 'categorical-1',
            collapsed: true,
            memberIds: ['entry-1', 'entry-2'],
          },
        ],
      },
    });
    await render();
    expect(
      document.querySelector('[data-sidebar-item-group-id="grp-advisor"]'),
    ).not.toBeNull();
    expect(byTestId('app-advisor-nav-entry-entry-1')).toBeDefined();
    expect(
      document.querySelector('[data-testid="app-advisor-nav-entry-entry-2"]'),
    ).toBeNull();
  });

  describe('bulk selection (CAN-3975)', () => {
    async function flush(): Promise<void> {
      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    /** Cmd-click on macOS, Ctrl-click elsewhere: both set, either platform. */
    function toggle(entryId: string): void {
      act(() => {
        byTestId(`app-advisor-nav-entry-${entryId}`).dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            metaKey: true,
            ctrlKey: true,
          }),
        );
      });
    }

    function selected(entryId: string): boolean {
      return (
        document
          .querySelector(`[data-testid="app-advisor-nav-entry-${entryId}"]`)
          ?.getAttribute('data-multiselected') === 'true'
      );
    }

    async function bulkArchive(entryId: string): Promise<void> {
      act(() => {
        byTestId(`app-advisor-nav-entry-${entryId}`).dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      click(byTestId(`app-advisor-nav-entry-${entryId}-bulk-archive`));
      await flush();
    }

    interface Deferred {
      readonly promise: Promise<void>;
      readonly resolve: () => void;
    }

    function deferred(): Deferred {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    it('Cmd-click selects two entries and the selection menu archives both, the open entry last', async () => {
      await render();
      toggle('entry-1');
      toggle('entry-2');
      expect(selected('entry-1')).toBe(true);
      expect(selected('entry-2')).toBe(true);
      await bulkArchive('entry-1');
      expect(
        byTestId('app-advisor-batch-removal-dialog').textContent,
      ).toContain('Archive 2 chats?');
      click(byTestId('app-advisor-batch-removal-dialog-confirm'));
      await flush();
      // entry-1 is the open entry, so it goes last.
      expect(deleteWorkEntryMock.mock.calls).toEqual([
        ['entry-2', APP_ADVISOR_PROJECT_ID, { lockAfterArchive: true }],
        ['entry-1', APP_ADVISOR_PROJECT_ID, { lockAfterArchive: true }],
      ]);
    });

    it('a batch keeps removing App Advisor entries after the active project changes', async () => {
      const pending = [deferred(), deferred()];
      deleteWorkEntryMock.mockImplementation(
        () => pending[deleteWorkEntryMock.mock.calls.length - 1]?.promise,
      );
      await render();
      toggle('entry-1');
      toggle('entry-2');
      await bulkArchive('entry-2');
      click(byTestId('app-advisor-batch-removal-dialog-confirm'));
      await flush();
      expect(deleteWorkEntryMock).toHaveBeenCalledTimes(1);
      // Another project becomes active mid-batch; App Advisor's entries move
      // to the per-project cache.
      const entries = useStandaloneChatStore.getState().workEntries;
      act(() => {
        useStandaloneChatStore.setState({
          activeChatProjectId: 'other-project',
          sidebarEntriesByProject: { [APP_ADVISOR_PROJECT_ID]: entries },
        });
      });
      await act(async () => {
        pending[0]?.resolve();
        await Promise.resolve();
      });
      await flush();
      expect(deleteWorkEntryMock.mock.calls).toEqual([
        ['entry-2', APP_ADVISOR_PROJECT_ID, { lockAfterArchive: true }],
        ['entry-1', APP_ADVISOR_PROJECT_ID, { lockAfterArchive: true }],
      ]);
      await act(async () => {
        pending[1]?.resolve();
        await Promise.resolve();
      });
    });

    it('a plain click opens the entry and ends the selection', async () => {
      await render();
      toggle('entry-1');
      click(byTestId('app-advisor-nav-entry-entry-2'));
      expect(selected('entry-1')).toBe(false);
      expect(selectWorkEntryMock).toHaveBeenCalledWith('entry-2');
    });

    it('runs a confirmed batch in the background, through a collapse, to the end', async () => {
      const pending = [deferred(), deferred()];
      deleteWorkEntryMock.mockImplementation(
        () => pending[deleteWorkEntryMock.mock.calls.length - 1]?.promise,
      );
      await render();
      toggle('entry-1');
      toggle('entry-2');
      await bulkArchive('entry-2');
      click(byTestId('app-advisor-batch-removal-dialog-confirm'));
      await flush();
      // The confirm closes at once; the nav shows the queue's progress.
      expect(
        document.body.querySelector(
          '[data-testid="app-advisor-batch-removal-dialog"]',
        ),
      ).toBeNull();
      expect(byTestId('app-advisor-nav-footer-callout')?.textContent).toContain(
        'Archiving chats',
      );
      expect(deleteWorkEntryMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        pending[0]?.resolve();
        await Promise.resolve();
      });
      await render(true);
      await flush();
      expect(deleteWorkEntryMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        pending[1]?.resolve();
        await Promise.resolve();
      });
      await flush();
      await render();
      expect(
        document.body.querySelector(
          '[data-testid="app-advisor-nav-footer-callout"]',
        ),
      ).toBeNull();
    });
  });
});
