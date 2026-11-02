/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchivedContainerSummary } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { ArchivedContainersOverviewPage } from '@/components/archive/ArchivedContainersOverviewPage';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { setNativeInputValue } from '@/test-utils/dom';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = 'code-ws-1';

type ArchivedContainerSummaryV1 = Extract<
  ArchivedContainerSummary,
  { version: 1 }
>;

function makeSummary(
  id: string,
  overrides: Partial<Omit<ArchivedContainerSummaryV1, 'version'>> = {},
): ArchivedContainerSummaryV1 {
  return {
    version: 1,
    id,
    kind: 'worktree',
    projectId: WORKSPACE_ID,
    name: `Worktree ${id}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-20T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-08-19T00:00:00.000Z',
    chatCount: 2,
    archivedChatCount: 0,
    executionCount: 1,
    ...overrides,
  };
}

const DELETED_SMALL = makeSummary('deleted-small', {
  name: 'feature/small',
  diskUsage: {
    filesBytes: 1024,
    gitBytes: 1024,
    totalBytes: 2048,
    computedAt: '2026-07-20T00:00:00.000Z',
  },
});
const DELETED_UNMEASURED = makeSummary('deleted-unmeasured', {
  name: 'feature/unmeasured',
});
const ARCHIVED = makeSummary('archived-one', {
  name: 'feature/keep',
  lockedAt: '2026-07-21T00:00:00.000Z',
  diskUsage: {
    filesBytes: 4096,
    gitBytes: 0,
    totalBytes: 4096,
    computedAt: '2026-07-21T00:00:00.000Z',
  },
});

const listMock = jest.fn();
const deleteMock = jest.fn();

describe('ArchivedContainersOverviewPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: jest.Mock;

  beforeEach(() => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = jest.fn();
    listMock.mockReset().mockResolvedValue([]);
    deleteMock.mockReset().mockResolvedValue({ deleted: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        archivedContainers: {
          list: listMock,
          delete: deleteMock,
          onChanged: jest.fn(() => (): void => undefined),
        },
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          id: WORKSPACE_ID,
          name: 'Acme',
          type: 'single-repo',
          repoPath: '/repos/acme',
          color: '#123456',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useArchivedContainersStore.setState({
      byWorkspace: {
        [WORKSPACE_ID]: [DELETED_SMALL, ARCHIVED, DELETED_UNMEASURED],
      },
      loadedWorkspaces: { [WORKSPACE_ID]: true },
      loadingWorkspaces: {},
      viewer: null,
      overview: { workspaceId: WORKSPACE_ID },
      restoringContainer: null,
      emptyTrashRun: null,
      emptyTrashConfirmationWorkspaceId: null,
      pendingByWorkspace: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-testid^="archived-overview-"]')
      .forEach((node) => node.remove());
  });

  function render(
    props: Partial<Parameters<typeof ArchivedContainersOverviewPage>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <ArchivedContainersOverviewPage
          workspaceId={WORKSPACE_ID}
          surface="code"
          onClose={onClose}
          {...props}
        />,
      );
    });
  }

  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function requireElement(testId: string): HTMLElement {
    const element = query(testId);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
  }

  it('lists every retained item with its state icon, size, and project header', () => {
    render();
    expect(requireElement('archived-overview-page').textContent).toContain(
      'Archived and deleted',
    );
    expect(requireElement('archived-overview-workspace-name').textContent).toBe(
      'Acme',
    );
    expect(requireElement('archived-overview-count').textContent).toBe(
      '3 items',
    );
    expect(
      requireElement('archived-overview-state-deleted-small').getAttribute(
        'data-state',
      ),
    ).toBe('deleted');
    expect(
      requireElement('archived-overview-state-deleted-small').getAttribute(
        'aria-label',
      ),
    ).toBe('Deleted');
    expect(
      requireElement('archived-overview-state-archived-one').getAttribute(
        'data-state',
      ),
    ).toBe('archived');
    expect(
      requireElement('archived-overview-size-deleted-small').textContent,
    ).toBe('2 KB');
    expect(
      requireElement('archived-overview-size-archived-one').textContent,
    ).toBe('4 KB');
    // Still measuring: a placeholder, never a fake zero.
    expect(
      requireElement('archived-overview-size-deleted-unmeasured').textContent,
    ).toBe('…');
    expect(query('archived-overview-legacy')).toBeNull();
  });

  it('shows only positive recorded observed cost, with Early access off', () => {
    const recorded = makeSummary('recorded-cost', { observedCostUsd: 1.23 });
    const zero = makeSummary('zero-cost', { observedCostUsd: 0 });
    const unrecorded = makeSummary('unrecorded-cost');
    useArchivedContainersStore.setState({
      byWorkspace: { [WORKSPACE_ID]: [recorded, zero, unrecorded] },
    });
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);

    render();

    const costs = container.querySelectorAll(
      '[data-testid="archived-overview-row-cost"]',
    );
    expect(costs).toHaveLength(1);
    expect(costs[0]?.textContent).toContain('$1.23');
    expect(query('archived-overview-row-recorded-cost')).not.toBeNull();
    expect(query('archived-overview-row-zero-cost')).not.toBeNull();
    expect(query('archived-overview-row-unrecorded-cost')).not.toBeNull();
  });

  it('keeps the row menu always visible on wide layouts and hover-revealed below', () => {
    render();
    expect(
      requireElement('archived-overview-list').parentElement?.className,
    ).toContain('@container/archived-list');
    const trigger = requireElement('archived-overview-deleted-small-actions');
    // Hover/focus reveal remains the baseline…
    expect(trigger.className).toContain('opacity-0');
    expect(trigger.className).toContain('group-hover:opacity-100');
    // …and the container-query variants pin it visible once there is room.
    expect(trigger.className).toContain(
      '@min-[36rem]/archived-list:opacity-100',
    );
    expect(trigger.className).toContain(
      '@min-[36rem]/archived-list:pointer-events-auto',
    );
    expect(
      requireElement('archived-overview-open-deleted-small').className,
    ).toContain('@min-[36rem]/archived-list:pr-8');
  });

  it('renders the actions with the shared header-button shell', () => {
    render();
    const back = requireElement('archived-overview-back');
    const emptyTrash = requireElement('archived-overview-empty-trash');
    expect(back.getAttribute('data-header-action-button')).toBe('true');
    expect(emptyTrash.getAttribute('data-header-action-button')).toBe('true');
    expect(emptyTrash.className).toContain('fg-destructive');
  });

  // CAN-3054. Only the code surface mounts this page as an overlay that owns
  // the window's top row (it covers WorktreeTopBar), so only it reserves the
  // persistent titlebar corner inline. Cowork keeps CoworkTopBar — which
  // carries its own spacer — above the overlay, and the App Advisor popout
  // sits below a drag strip, so a reservation there is a bare indent.
  it('reserves the titlebar corner on the code surface only', () => {
    render({ surface: 'code' });
    const codeTitlebar = requireElement('archived-overview-titlebar');
    expect(
      codeTitlebar.querySelectorAll('[data-testid="page-titlebar-spacer"]'),
    ).toHaveLength(1);

    for (const surface of ['cowork', 'app-advisor'] as const) {
      render({ surface });
      const titlebar = requireElement('archived-overview-titlebar');
      expect(
        titlebar.querySelectorAll('[data-testid="page-titlebar-spacer"]'),
      ).toHaveLength(0);
    }
  });

  it('uses themed separators and action-first sentence-case copy', () => {
    useArchivedContainersStore.setState({
      byWorkspace: { [WORKSPACE_ID]: [ARCHIVED] },
    });
    render();

    const page = requireElement('archived-overview-page');
    expect(page.firstElementChild?.className).not.toContain('border-border');
    expect(
      requireElement('archived-overview-search').parentElement?.className,
    ).not.toContain('border-border');
    expect(
      requireElement('archived-overview-empty-trash').hasAttribute('disabled'),
    ).toBe(true);

    useStandaloneChatStore.setState({
      legacyArchivedByProject: {
        [WORKSPACE_ID]: [
          {
            id: 'legacy-copy',
            title: 'Legacy copy',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            archived: true,
          },
        ],
      },
    });
    useArchivedContainersStore.setState({
      byWorkspace: { [WORKSPACE_ID]: [] },
    });
    act(() => {
      root.render(
        <ArchivedContainersOverviewPage
          workspaceId={WORKSPACE_ID}
          surface="cowork"
          onClose={onClose}
        />,
      );
    });
    expect(
      requireElement('archived-overview-legacy').firstElementChild?.className,
    ).not.toContain('uppercase');

    useStandaloneChatStore.setState({
      legacyArchivedByProject: { [WORKSPACE_ID]: [] },
    });
    act(() => {
      root.render(
        <ArchivedContainersOverviewPage
          workspaceId={WORKSPACE_ID}
          surface="cowork"
          onClose={onClose}
        />,
      );
    });
    expect(requireElement('archived-overview-empty').textContent).toBe(
      'Restore archived or deleted items from this project here.',
    );
  });

  it('uses a themed inset ring around the Empty trash preview', () => {
    render();
    act(() => requireElement('archived-overview-empty-trash').click());
    const list = requireElement('archived-overview-empty-trash-list');
    expect(list.className).toContain('ring-1');
    expect(list.className).toContain('ring-inset');
    expect(list.className).toContain('ring-line-base');
    expect(list.className).not.toContain('border-border');
  });

  it('filters rows by the search box', () => {
    render();
    const input = requireElement('archived-overview-search');
    if (!(input instanceof HTMLInputElement)) throw new Error('input');
    act(() => {
      setNativeInputValue(input, 'keep');
    });
    expect(query('archived-overview-row-archived-one')).not.toBeNull();
    expect(query('archived-overview-row-deleted-small')).toBeNull();
    act(() => {
      setNativeInputValue(input, 'zzz');
    });
    expect(query('archived-overview-no-matches')).not.toBeNull();
  });

  it('opens the viewer for a row and closes via Back', () => {
    render();
    act(() => {
      requireElement('archived-overview-open-deleted-small').click();
    });
    expect(useArchivedContainersStore.getState().viewer).toMatchObject({
      workspaceId: WORKSPACE_ID,
      containerId: 'deleted-small',
    });
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    act(() => {
      requireElement('archived-overview-back').click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the Empty trash dialog buttons with the shared header-button shell', () => {
    render();
    act(() => query('archived-overview-empty-trash')?.click());
    const cancel = query('archived-overview-empty-trash-cancel');
    const confirm = query('archived-overview-empty-trash-confirm');
    expect(cancel?.getAttribute('data-header-action-button')).toBe('true');
    expect(confirm?.getAttribute('data-header-action-button')).toBe('true');
    expect(confirm?.className).toContain('fg-destructive');
    expect(cancel?.className).not.toContain('fg-destructive');
    act(() => cancel?.click());
    expect(query('archived-overview-empty-trash-dialog')).toBeNull();
  });

  it('opens the Empty trash confirmation when requested by App Advisor state', () => {
    useArchivedContainersStore.setState({
      emptyTrashConfirmationWorkspaceId: WORKSPACE_ID,
    });

    render();

    expect(query('archived-overview-empty-trash-dialog')).not.toBeNull();
    act(() => query('archived-overview-empty-trash-cancel')?.click());
    expect(
      useArchivedContainersStore.getState().emptyTrashConfirmationWorkspaceId,
    ).toBeNull();
  });

  it('previews Empty trash with only Deleted items and guaranteed reclaimable file bytes', async () => {
    render();
    const emptyTrash = requireElement('archived-overview-empty-trash');
    expect(emptyTrash.hasAttribute('disabled')).toBe(false);
    act(() => {
      emptyTrash.click();
    });
    const dialog = requireElement('archived-overview-empty-trash-dialog');
    expect(dialog.textContent).toContain('Empty trash?');
    expect(dialog.textContent).toContain('2 deleted items');
    expect(
      query('archived-overview-empty-trash-item-deleted-small'),
    ).not.toBeNull();
    expect(
      query('archived-overview-empty-trash-item-deleted-unmeasured'),
    ).not.toBeNull();
    expect(query('archived-overview-empty-trash-item-archived-one')).toBeNull();
    const measuredItem = requireElement(
      'archived-overview-empty-trash-item-deleted-small',
    );
    expect(measuredItem.textContent).toBe('feature/small2 KB');
    expect(measuredItem.className).toContain('fg-primary/80');
    expect(
      requireElement('archived-overview-empty-trash-item-deleted-unmeasured')
        .textContent,
    ).toBe('feature/unmeasured…');
    // One size is still being measured, so the total is a lower bound.
    expect(
      requireElement('archived-overview-empty-trash-summary').textContent,
    ).toContain('Frees at least 1 KB');
    expect(
      requireElement('archived-overview-empty-trash-confirm').textContent,
    ).toBe('Delete 2 items permanently');

    listMock.mockResolvedValue([ARCHIVED]);
    act(() => {
      requireElement('archived-overview-empty-trash-confirm').click();
    });
    // Confirm closes the preview immediately; the run continues behind it.
    expect(query('archived-overview-empty-trash-dialog')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'archived-one' }),
    );
    expect(useArchivedContainersStore.getState().emptyTrashRun).toBeNull();
  });

  it('previews the resolved display name rather than the stored branch name', () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        [WORKSPACE_ID]: [{ ...DELETED_SMALL, label: 'Release preparation' }],
      },
    });
    render();
    act(() => requireElement('archived-overview-empty-trash').click());

    const item = requireElement(
      'archived-overview-empty-trash-item-deleted-small',
    );
    expect(item.textContent).toBe('Release preparation2 KB');
    expect(item.textContent).not.toContain('feature/small');
    expect(
      requireElement('archived-overview-empty-trash-summary').textContent,
    ).toBe('1 itemFrees at least 1 KB');
    expect(
      requireElement('archived-overview-empty-trash-confirm').textContent,
    ).toBe('Delete 1 item permanently');
  });

  it('turns the Empty trash button into a cancel control while the run is active', async () => {
    let finishFirst: () => void = () => undefined;
    deleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    listMock.mockResolvedValue([ARCHIVED, DELETED_UNMEASURED]);
    render();
    act(() => {
      requireElement('archived-overview-empty-trash').click();
    });
    act(() => {
      requireElement('archived-overview-empty-trash-confirm').click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const group = requireElement('archived-overview-empty-trash-group');
    const button = requireElement('archived-overview-empty-trash');
    expect(group.getAttribute('data-running')).toBe('true');
    expect(group.getAttribute('data-cancel-requested')).toBe('false');
    // Git-action pattern: same label, spinner in the icon slot, the button
    // itself is the cancel control, and a hover ✕ is offered beside it.
    expect(button.textContent).toContain('Empty trash');
    expect(button.getAttribute('aria-label')).toBe('Cancel Empty trash');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(
      requireElement('archived-overview-empty-trash-progress').textContent,
    ).toBe('1 of 2');
    expect(query('pr-status-bar-cancel-git-action')).not.toBeNull();

    act(() => {
      button.click();
    });
    expect(group.getAttribute('data-cancel-requested')).toBe('true');
    expect(
      useArchivedContainersStore.getState().emptyTrashRun?.cancelRequested,
    ).toBe(true);
    // While the cancel is pending the ✕ is withdrawn and the button no longer
    // accepts a second click.
    expect(query('pr-status-bar-cancel-git-action')).toBeNull();
    expect(button.hasAttribute('disabled')).toBe(true);

    finishFirst();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Only the in-flight item was removed; the second never started.
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(group.getAttribute('data-running')).toBe('false');
    expect(query('archived-overview-row-deleted-unmeasured')).not.toBeNull();
  });

  it('disables Empty trash when every item is Archived', () => {
    useArchivedContainersStore.setState({
      byWorkspace: { [WORKSPACE_ID]: [ARCHIVED] },
    });
    render();
    expect(
      requireElement('archived-overview-empty-trash').hasAttribute('disabled'),
    ).toBe(true);
  });

  it('lists legacy archived chats for cowork surfaces and opens them in the legacy overlay', () => {
    const openArchivedChatFromSidebar = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({
      chatProjects: [
        {
          id: 'cowork-1',
          name: 'Scratchpad',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      legacyArchivedByProject: {
        'cowork-1': [
          {
            id: 'legacy-1',
            title: 'Old chat',
            description: 'Finished planning conversation',
            createdAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-02-01T00:00:00.000Z',
            archived: true,
          },
        ],
      },
      openArchivedChatFromSidebar,
    });
    useArchivedContainersStore.setState({
      byWorkspace: { 'cowork-1': [] },
      loadedWorkspaces: { 'cowork-1': true },
      overview: { workspaceId: 'cowork-1' },
    });
    render({ workspaceId: 'cowork-1', surface: 'cowork' });
    expect(requireElement('archived-overview-workspace-name').textContent).toBe(
      'Scratchpad',
    );
    expect(requireElement('archived-overview-count').textContent).toBe(
      '1 item',
    );
    expect(requireElement('archived-overview-legacy').textContent).toContain(
      'Legacy archived chats',
    );
    act(() => {
      requireElement('archived-overview-legacy-row-legacy-1').click();
    });
    expect(openArchivedChatFromSidebar).toHaveBeenCalledWith(
      'cowork-1',
      'legacy-1',
    );
    // Legacy chats are never "trash".
    expect(
      requireElement('archived-overview-empty-trash').hasAttribute('disabled'),
    ).toBe(true);
  });

  it('routes App Advisor legacy chats through selectArchive', () => {
    const selectArchive = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({
      legacyArchivedByProject: {
        [APP_ADVISOR_PROJECT_ID]: [
          {
            id: 'legacy-advisor',
            title: 'Advisor chat',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            archived: true,
          },
        ],
      },
      selectArchive,
    });
    useArchivedContainersStore.setState({
      byWorkspace: { [APP_ADVISOR_PROJECT_ID]: [] },
      loadedWorkspaces: { [APP_ADVISOR_PROJECT_ID]: true },
      overview: { workspaceId: APP_ADVISOR_PROJECT_ID },
    });
    render({ workspaceId: APP_ADVISOR_PROJECT_ID, surface: 'app-advisor' });
    expect(requireElement('archived-overview-workspace-name').textContent).toBe(
      'Orchestrator',
    );
    act(() => {
      requireElement('archived-overview-legacy-row-legacy-advisor').click();
    });
    expect(selectArchive).toHaveBeenCalledWith('legacy-advisor');
  });

  it('shows a removal still being captured as a pending row and counts it', () => {
    useArchivedContainersStore.setState({
      pendingByWorkspace: {
        [WORKSPACE_ID]: [
          {
            workspaceId: WORKSPACE_ID,
            containerId: 'wt-pending',
            kind: 'worktree',
            name: 'feature/pending',
            branchName: 'feature/pending',
            state: 'deleted',
            startedAt: Date.now(),
          },
          {
            workspaceId: WORKSPACE_ID,
            containerId: 'wt-archiving',
            kind: 'worktree',
            name: 'feature/archiving',
            branchName: 'feature/archiving',
            state: 'archived',
            startedAt: Date.now(),
          },
        ],
      },
    });
    render();

    // Placeholders count immediately: 3 retained + 2 pending.
    expect(query('archived-overview-count')?.textContent).toBe('5 items');
    const pendingRow = query('archived-overview-pending-wt-pending');
    expect(pendingRow).not.toBeNull();
    expect(pendingRow?.getAttribute('data-state')).toBe('deleted');
    expect(pendingRow?.getAttribute('aria-busy')).toBe('true');
    expect(pendingRow?.textContent).toContain('feature/pending');
    expect(pendingRow?.textContent).toContain('Deleting…');
    expect(
      query('archived-overview-pending-wt-archiving')?.textContent,
    ).toContain('Archiving…');
    // Nothing to open or act on yet.
    expect(query('archived-overview-open-wt-pending')).toBeNull();
    expect(query('archived-overview-wt-pending-actions')).toBeNull();
    // Pending rows lead the list, ahead of committed items.
    const list = query('archived-overview-list');
    expect(list?.firstElementChild?.getAttribute('data-testid')).toBe(
      'archived-overview-pending-wt-pending',
    );
    // Empty trash previews only committed Deleted items.
    act(() => query('archived-overview-empty-trash')?.click());
    expect(query('archived-overview-empty-trash-item-wt-pending')).toBeNull();
    expect(
      query('archived-overview-empty-trash-confirm')?.textContent,
    ).toContain('Delete 2 items permanently');
  });

  it('filters rows by state alongside the search box', async () => {
    useArchivedContainersStore.setState({
      pendingByWorkspace: {
        [WORKSPACE_ID]: [
          {
            workspaceId: WORKSPACE_ID,
            containerId: 'wt-pending',
            kind: 'worktree',
            name: 'feature/pending',
            state: 'deleted',
            startedAt: Date.now(),
          },
        ],
      },
    });
    render();
    const trigger = query('archived-overview-filter-trigger');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('data-active')).toBe('false');
    expect(query('archived-overview-filter-active-dot')).toBeNull();

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const deletedOption = document.body.querySelector<HTMLElement>(
      '[data-testid="archived-overview-filter-option-deleted"]',
    );
    const archivedOption = document.body.querySelector<HTMLElement>(
      '[data-testid="archived-overview-filter-option-archived"]',
    );
    expect(deletedOption?.getAttribute('aria-checked')).toBe('true');
    expect(archivedOption?.getAttribute('aria-checked')).toBe('true');

    // Hide Deleted: committed and pending deleted rows go, Archived stays.
    await act(async () => {
      deletedOption?.click();
      await Promise.resolve();
    });
    expect(query('archived-overview-row-deleted-small')).toBeNull();
    expect(query('archived-overview-pending-wt-pending')).toBeNull();
    expect(query('archived-overview-row-archived-one')).not.toBeNull();
    expect(trigger?.getAttribute('data-active')).toBe('true');
    expect(query('archived-overview-filter-active-dot')).not.toBeNull();
    // The menu stays open for multi-select.
    expect(
      document.body
        .querySelector(
          '[data-testid="archived-overview-filter-option-deleted"]',
        )
        ?.getAttribute('aria-checked'),
    ).toBe('false');

    // Hide Archived too: nothing left, with filter-specific empty copy.
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="archived-overview-filter-option-archived"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(query('archived-overview-no-matches')?.textContent).toBe(
      'No items match the current filter',
    );

    // Show Deleted again while searching: filter and search combine.
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="archived-overview-filter-option-deleted"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const search = query('archived-overview-search');
    expect(search).toBeInstanceOf(HTMLInputElement);
    if (search instanceof HTMLInputElement) {
      act(() => setNativeInputValue(search, 'unmeasured'));
    }
    expect(query('archived-overview-row-deleted-unmeasured')).not.toBeNull();
    expect(query('archived-overview-row-deleted-small')).toBeNull();
    expect(query('archived-overview-row-archived-one')).toBeNull();
  });
});
