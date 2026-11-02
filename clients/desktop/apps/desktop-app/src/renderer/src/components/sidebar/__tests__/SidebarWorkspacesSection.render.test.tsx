/** @jest-environment jsdom */
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import type * as DndKitSortable from '@dnd-kit/sortable';
import type {
  ArchivedContainerSummary,
  CanopyApi,
  SidebarItem,
  SingleRepoSidebarItem,
  TrackedPlanData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useBranchFromStore } from '@/stores/branchFromStore';
import { useBranchGroupingPreferenceStore } from '@/stores/branchGroupingPreferenceStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useImportSessionModalStore } from '@/stores/importSessionModalStore';
import { requestSharedContainerInvite } from '@/lib/sharedContainerInviteEvents';
import {
  sharedWorktreeKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import * as WorkEntryRemovalLabelsModule from '@canopy/ui-app/code/shell/work-entry-removal-labels';
import { SidebarWorkspacesSection } from '../SidebarWorkspacesSection';
import { SidebarCoworkWorkspaceRow } from '../SidebarCoworkWorkspaceRow';
import type { WorkEntryMultiSelectBinding } from '@canopy/ui-app/sidebar';

const mockUseSortableRegistration = jest.fn();

jest.mock('@dnd-kit/sortable', () => {
  const actual = jest.requireActual<typeof DndKitSortable>('@dnd-kit/sortable');
  return {
    ...actual,
    useSortable: (
      options: Parameters<typeof actual.useSortable>[0],
    ): ReturnType<typeof actual.useSortable> => {
      mockUseSortableRegistration(options);
      return actual.useSortable(options);
    },
  };
});

jest.mock('@/components/shared/InviteTeammateModal', () => ({
  InviteTeammateModal: ({
    worktreeId,
  }: {
    worktreeId: string;
  }): JSX.Element => (
    <div data-testid="shared-container-invite-modal-stub">{worktreeId}</div>
  ),
}));

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const originalCreateWorktree = useProjectsStore.getState().createWorktree;
const originalRefreshWorktreeDiffStatsVerified =
  useProjectsStore.getState().refreshWorktreeDiffStatsVerified;
const originalDeleteWorkEntry =
  useStandaloneChatStore.getState().deleteWorkEntry;
const originalOpenWorkEntryFromSidebar =
  useStandaloneChatStore.getState().openWorkEntryFromSidebar;
const originalSetWorkEntryPinned =
  useStandaloneChatStore.getState().setWorkEntryPinned;

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      savePreferences: jest.fn().mockResolvedValue(undefined),
      saveProjects: jest.fn().mockResolvedValue(undefined),
      workEntries: {
        list: jest.fn().mockResolvedValue({ entries: [] }),
        reorder: jest.fn().mockResolvedValue(undefined),
      },
      standaloneChat: {
        list: jest.fn().mockResolvedValue({ chats: [] }),
      },
      chat: {
        flushScope: jest.fn().mockResolvedValue(undefined),
      },
      getWorktreeArchiveDisposition: jest
        .fn()
        .mockResolvedValue({ hasArchivableData: false }),
    },
  });
}

function makeProject(id: string, order: number): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order,
    collapsed: true,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

function makeProjectWithWorktree(
  id: string,
  worktreeId: string,
): SingleRepoSidebarItem {
  return {
    ...makeProject(id, 0),
    collapsed: false,
    worktrees: [
      {
        id: worktreeId,
        branchName: 'feature/sidebar-active-state',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function makeTrackedPlan(
  projectId: string,
  worktreeId: string,
): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId,
    worktreeId,
    source: 'claude',
    title: 'Plan explore safety',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Plan',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
  };
}

function makeChatTab(id: string): ChatTab {
  return {
    id,
    title: 'Plan explore chat',
    messages: [],
    status: 'streaming',
    error: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

function makeCoworkProject(id: string, order: number): SidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#654321',
    collapsed: false,
    order,
    // CAN-1074: this suite asserts manual Work Entry drag-and-drop, which
    // only the `'manual'` item sort mode keeps enabled.
    itemSortMode: 'manual',
  };
}

function makeArchivedCoworkEntry(
  id: string,
  projectId: string,
): ArchivedContainerSummary {
  return {
    version: 1,
    id,
    kind: 'work-entry',
    projectId,
    name: 'Locked archive',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-01-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-01-09T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    lockedAt: '2026-01-02T00:00:00.000Z',
  };
}

function makeEmptyMultiRepoProject(id: string, order: number): SidebarItem {
  return {
    id,
    type: 'multi-repo',
    name: id,
    color: '#2563eb',
    repos: [],
    worktrees: [],
    collapsed: true,
    order,
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

async function renderSection(options?: {
  preserveSingleWorkspace?: boolean;
  client?: ReturnType<typeof createFakeClient>['client'];
}): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  installWindowApi();
  const projects = useProjectsStore.getState().projects;
  if (projects.length === 1 && !options?.preserveSingleWorkspace) {
    useProjectsStore.setState({
      projects: [...projects, makeProject('__header-test-companion', 999)],
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CanopyClientProvider
        client={options?.client ?? createFakeClient().client}
      >
        <SidebarWorkspacesSection
          stickyHeaderLead={
            <button data-testid="sidebar-more-stub" type="button">
              More
            </button>
          }
        />
      </CanopyClientProvider>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

function unmountSection(root: Root, container: HTMLElement): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/**
 * Every command row in a sidebar menu carries a leading glyph. Ordering rows
 * are radios whose leading rail is the selection check, so they are exempt.
 */
function expectMenuCommandRowsHaveIcons(menu: HTMLElement | null): void {
  expect(menu).not.toBeNull();
  const rows = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelector('svg')).not.toBeNull();
  }
}

/**
 * Pin/Unpin is the first row of every sidebar item menu, so the control sits
 * in the same place whatever the row is.
 */
function expectPinLeadsMenu(menu: HTMLElement | null): void {
  expect(menu).not.toBeNull();
  const rows = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [],
  );
  expect(rows[0]?.getAttribute('data-testid')).toMatch(/(toggle-)?pin/);
  expect(rows[0]?.textContent).toContain('Pin to top');
}

describe('SidebarWorkspacesSection', () => {
  beforeEach(() => {
    mockUseSortableRegistration.mockClear();
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    useProjectsStore.setState({
      projects: [],
      isLoading: false,
      hiddenWorkspaceIds: [],
      uncommittedChanges: {},
      branchInfoRequest: null,
      branchRenameRequest: null,
      createWorktree: originalCreateWorktree,
      refreshWorktreeDiffStatsVerified:
        originalRefreshWorktreeDiffStatsVerified,
    });
    useBranchFromStore.getState().resolveConfirmation(null);
    useSidebarStore.setState({
      codeSectionCollapsed: false,
      chatsSectionCollapsed: false,
      // This suite asserts manual drag-and-drop ordering throughout, which is
      // the default `'manual'` mode; `'last-updated'` has its own coverage
      // below.
      projectSortMode: 'manual',
    });
    useChatStore.setState({
      selectedWorktree: null,
      worktreeChats: {},
      pendingPlanExits: {},
    });
    useActivityStore.setState({ trackedPlans: {} });
    resetLiveBackgroundTaskStoreForTests();
    useStandaloneChatStore.setState({
      chatProjectsLoaded: true,
      initialized: true,
      activeChatProjectId: 'cowork-target',
      activeWorkEntryId: null,
      sidebarEntriesByProject: {},
      legacyArchivedByProject: {},
      workEntries: [],
      deleteWorkEntry: originalDeleteWorkEntry,
      openWorkEntryFromSidebar: originalOpenWorkEntryFromSidebar,
      setWorkEntryPinned: originalSetWorkEntryPinned,
    });
    useBranchGroupingPreferenceStore.setState({ enabled: true });
    useArchivedContainersStore.setState({
      byWorkspace: {},
      loadedWorkspaces: {},
      loadingWorkspaces: {},
      viewer: null,
      restoringContainer: null,
    });
    useNavigationStore.setState({
      activePage: 'overview',
      homeComposerFocusRequest: 0,
      addWorkspaceModalOpen: false,
      pendingDispatchPipeline: undefined,
      pendingArchiveWorktree: undefined,
    });
    useHomeComposerStore.getState().reset();
    useImportSessionModalStore.getState().close();
  });

  it.each([true, false])(
    'keeps Shared projects independent of Projects collapse while a setup runs (%s)',
    async (hasProjects): Promise<void> => {
      const originalContext = useWorkspaceContextStore.getState();
      const originalFlags = useFeatureFlagsStore.getState();
      const fake = createFakeClient();
      const organizationId = 'org-a';
      fake.query.mockResolvedValue({
        context: 'org:org-a',
        revision: 'r1',
        fetchedAt: '',
        stale: false,
        error: null,
        projects: hasProjects
          ? [
              {
                id: 'catalog',
                organizationId,
                name: 'Catalog',
                description: null,
                kind: 'CODE',
                location: 'LOCAL',
                repository: null,
                state: 'ACTIVE',
                revision: 1,
                authorizationVersion: 1,
                defaultListed: true,
                preference: 'FOLLOW_DEFAULTS',
                listed: true,
                capabilities: {
                  administer: false,
                  manageCloud: false,
                  use: true,
                },
                instance: null,
              },
            ]
          : [],
      });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId },
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
          revision: 1,
        },
      });
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags.snapshot,
          values: {
            ...originalFlags.snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useProjectsStore.setState({
        projects: ['local-alpha', 'local-beta'].map((id, order) => ({
          ...makeProject(id, order),
          owner: {
            type: 'organization',
            organizationId,
            projectId: id,
            instanceId: `instance-${id}`,
            bindingGeneration: 0,
          },
        })),
      });
      const { container, root } = await renderSection({ client: fake.client });
      try {
        await act(async (): Promise<void> => {
          await Promise.resolve();
        });
        // CAN-3386: an idle catalog project is never a sidebar row.
        expect(
          container.querySelector(
            '[data-testid="sidebar-section-shared-projects"]',
          ),
        ).toBeNull();
        if (hasProjects)
          await act(async (): Promise<void> => {
            fake.emit('org-projects.setup-progress', {
              progress: {
                projectId: 'catalog',
                instanceId: null,
                state: 'materializing',
                message: 'Cloning repository',
                percent: 42,
                updatedAt: 'materializing',
              },
              occurredAt: 'materializing',
            });
            await Promise.resolve();
          });
        const group = container.querySelector(
          '[data-testid="sidebar-section-shared-projects"]',
        );
        if (hasProjects) {
          expect(group).not.toBeNull();
          expect(group?.textContent).toContain('Shared projects');
          expect(
            group?.querySelector(
              '[data-testid="sidebar-org-project-placeholder-catalog"]',
            ),
          ).not.toBeNull();
          expect(mockUseSortableRegistration).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: 'catalog' }),
          );
        } else {
          expect(group).toBeNull();
        }
        const projectRows = (): NodeListOf<HTMLElement> =>
          container.querySelectorAll<HTMLElement>(
            '[data-testid="sidebar-project-header-local-alpha"], [data-testid="sidebar-project-header-local-beta"]',
          );
        expect(projectRows()).toHaveLength(2);
        const toggle = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-code-toggle"]',
        );
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
          toggle?.click();
          await Promise.resolve();
        });
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(projectRows()).toHaveLength(0);
        if (hasProjects) {
          for (const testId of [
            'sidebar-section-shared-projects',
            'sidebar-org-project-placeholder-catalog',
          ]) {
            const element = container.querySelector<HTMLElement>(
              `[data-testid="${testId}"]`,
            );
            expect(element).not.toBeNull();
            expect(element?.isConnected).toBe(true);
            // jsdom has no layout; check visibility through the ancestor chain.
            for (let node = element; node; node = node.parentElement) {
              expect(node.hidden).toBe(false);
              const style = window.getComputedStyle(node);
              expect(style.display).not.toBe('none');
              expect(style.visibility).not.toBe('hidden');
              expect(style.opacity).not.toBe('0');
            }
          }
        } else {
          expect(
            container.querySelector(
              '[data-testid="sidebar-section-shared-projects"]',
            ),
          ).toBeNull();
        }
      } finally {
        unmountSection(root, container);
        useWorkspaceContextStore.setState(originalContext);
        useFeatureFlagsStore.setState(originalFlags);
      }
    },
  );

  it('shows None found for an empty organization, with no way back to Personal (CAN-3550)', async (): Promise<void> => {
    const originalContext = useWorkspaceContextStore.getState();
    const originalFlags = useFeatureFlagsStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    useFeatureFlagsStore.setState({
      snapshot: {
        ...originalFlags.snapshot,
        values: {
          ...originalFlags.snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    const { container, root } = await renderSection();
    try {
      const emptyState = container.querySelector(
        '[data-testid="sidebar-context-empty-state"]',
      );
      // The legacy section renders the same row as the shared sidebar.
      expect(emptyState?.textContent).toBe('None found');
      expect(
        emptyState?.querySelector(
          '[data-testid="sidebar-context-empty-state-label"]',
        )?.textContent,
      ).toBe('None found');
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-add"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-back"]',
        ),
      ).toBeNull();
    } finally {
      unmountSection(root, container);
      useWorkspaceContextStore.setState(originalContext);
      useFeatureFlagsStore.setState(originalFlags);
    }
  });

  it('points an organization with nothing on this computer at Add project (CAN-3386)', async (): Promise<void> => {
    const originalContext = useWorkspaceContextStore.getState();
    const originalFlags = useFeatureFlagsStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const fake = createFakeClient();
    fake.query.mockResolvedValue({
      context: `org:${organizationId}`,
      revision: 'r1',
      fetchedAt: '',
      stale: false,
      error: null,
      projects: [
        {
          id: 'catalog',
          organizationId,
          name: 'Catalog',
          description: null,
          kind: 'CODE',
          location: 'LOCAL',
          repository: null,
          state: 'ACTIVE',
          revision: 1,
          authorizationVersion: 1,
          defaultListed: true,
          preference: 'FOLLOW_DEFAULTS',
          listed: true,
          capabilities: { administer: false, manageCloud: false, use: true },
          instance: null,
        },
      ],
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    useFeatureFlagsStore.setState({
      snapshot: {
        ...originalFlags.snapshot,
        values: {
          ...originalFlags.snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useNavigationStore.setState({ addWorkspaceModalOpen: false });
    const { container, root } = await renderSection({ client: fake.client });
    try {
      await act(async (): Promise<void> => {
        await Promise.resolve();
      });
      const emptyState = container.querySelector(
        '[data-testid="sidebar-context-empty-state"]',
      );
      expect(
        emptyState?.querySelector(
          '[data-testid="sidebar-context-empty-state-label"]',
        )?.textContent,
      ).toBe('None found');
      expect(emptyState?.textContent).not.toContain('Add a project from Acme');
      expect(
        container.querySelector(
          '[data-testid="sidebar-org-project-placeholder-catalog"]',
        ),
      ).toBeNull();
      // The row carries no Add project of its own: the Projects header's "+"
      // stays on screen while the list is empty and opens the dialog.
      expect(emptyState?.textContent).toBe('None found');
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-add"]',
        ),
      ).toBeNull();
      const add = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-section-code-add"]',
      );
      expect(add).not.toBeNull();
      expect(add?.closest('[class~="opacity-0"]')).toBeNull();
      act((): void => {
        add?.click();
      });
      expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-back"]',
        ),
      ).toBeNull();
    } finally {
      unmountSection(root, container);
      useNavigationStore.setState({ addWorkspaceModalOpen: false });
      useWorkspaceContextStore.setState(originalContext);
      useFeatureFlagsStore.setState(originalFlags);
    }
  });

  it.each([false, true])(
    'does not show the organization empty state for a hidden organization project (manually hidden: %s)',
    async (manuallyHidden: boolean): Promise<void> => {
      const originalContext = useWorkspaceContextStore.getState();
      const originalFlags = useFeatureFlagsStore.getState();
      const organizationId = '11111111-1111-4111-8111-111111111111';
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId },
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
          revision: 1,
        },
      });
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags.snapshot,
          values: {
            ...originalFlags.snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useProjectsStore.setState({
        hiddenWorkspaceIds: manuallyHidden ? ['hidden-org-project'] : [],
        projects: [
          {
            ...makeProject('hidden-org-project', 0),
            alwaysShow: false,
            owner: {
              type: 'organization',
              organizationId,
              projectId: '22222222-2222-4222-8222-222222222222',
              instanceId: '33333333-3333-4333-8333-333333333333',
              bindingGeneration: 0,
            },
          },
        ],
      });
      const { container, root } = await renderSection({
        preserveSingleWorkspace: true,
      });
      try {
        expect(
          container.querySelector(
            '[data-testid="sidebar-context-empty-state"]',
          ),
        ).toBeNull();
      } finally {
        unmountSection(root, container);
        useWorkspaceContextStore.setState(originalContext);
        useFeatureFlagsStore.setState(originalFlags);
      }
    },
  );

  it('hides a sole project header while keeping its rows visible', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('only-workspace', 'only-worktree')],
    });

    const { container, root } = await renderSection({
      preserveSingleWorkspace: true,
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-sortable-header-only-workspace"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-worktree-id="only-worktree"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Projects');
    expect(
      container.querySelector('[data-testid="sidebar-section-code-add"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.sidebar-workspace-sticky-header'),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('uses the visible partition when one of two projects is hidden', async () => {
    useProjectsStore.setState({
      projects: [
        makeProjectWithWorktree('visible', 'visible-worktree'),
        makeProject('hidden', 1),
      ],
      hiddenWorkspaceIds: ['hidden'],
    });
    const { container, root } = await renderSection();
    expect(
      container.querySelector(
        '[data-testid="sidebar-project-sortable-header-visible"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-worktree-id="visible-worktree"]'),
    ).not.toBeNull();
    unmountSection(root, container);
  });

  it.each(['code', 'cowork'] as const)(
    'routes sole %s project acting-header actions',
    async (kind) => {
      const workspace =
        kind === 'code'
          ? makeProjectWithWorktree('sole-target', 'sole-worktree')
          : makeCoworkProject('sole-target', 0);
      const createWorktree = jest.fn();
      const createWorkEntryInProject = jest.fn(
        (): Promise<void> => Promise.resolve(),
      );
      useProjectsStore.setState({ projects: [workspace], createWorktree });
      useStandaloneChatStore.setState({ createWorkEntryInProject });
      const { container, root } = await renderSection({
        preserveSingleWorkspace: true,
      });

      const settings = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-sole-workspace-settings-sole-target"]',
      );
      const create = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-sole-workspace-new-task-sole-target"]',
      );
      // The sole project's overflow entries live in the section's single
      // header menu; a second "…" beside it would repeat the same glyph.
      const more = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-section-code-more"]',
      );
      expect(
        container.querySelector(
          '[data-testid="sidebar-sole-workspace-more-sole-target"]',
        ),
      ).toBeNull();
      const workspacesLabel = Array.from(
        container.querySelectorAll(
          '[data-onboarding-anchor="sidebar-workspaces"] span',
        ),
      ).find((element) => element.textContent === 'Projects');
      const actions = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sole-workspace-actions-sole-target"]',
      );
      expect(workspacesLabel?.textContent).toBe('Projects');
      expect(workspacesLabel?.className).toContain('shrink-0');
      expect(workspacesLabel?.className).not.toContain('truncate');
      expect(workspacesLabel?.className).not.toContain('min-w-0');
      expect(actions?.className).toContain('shrink-0');
      expect(actions?.className).toContain('opacity-0');
      expect(actions?.className).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(actions?.className).toContain(
        'group-focus-within/sidebar-item:opacity-100',
      );
      expect(actions?.className).toContain('pointer-coarse:opacity-100');
      expect(settings).not.toBeNull();
      expect(create).not.toBeNull();
      expect(more).not.toBeNull();
      act(() => settings?.click());
      expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
        workspaceId: 'sole-target',
      });
      act(() => create?.click());
      if (kind === 'code')
        expect(createWorktree).toHaveBeenCalledWith(
          'sole-target',
          expect.any(Object),
        );
      else {
        expect(createWorkEntryInProject).toHaveBeenCalledWith('sole-target');
        expect(useNavigationStore.getState().activePage).toBe('chat');
      }
      act(() => more?.click());
      const importItem = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-import-session-menu-item"]',
      );
      expect(importItem).not.toBeNull();
      act(() => importItem?.click());
      act(() => useCloudConnectGateStore.getState().pending?.proceed());
      expect(useImportSessionModalStore.getState().target).toEqual({
        workspaceId: 'sole-target',
      });
      unmountSection(root, container);
    },
  );

  it('renders project headers when multiple code and cowork entries exist', async () => {
    useProjectsStore.setState({
      projects: [
        makeProjectWithWorktree('code-workspace', 'code-worktree'),
        makeCoworkProject('cowork-workspace', 1),
      ],
    });

    const { container, root } = await renderSection({
      preserveSingleWorkspace: true,
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-sortable-header-code-workspace"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-cowork-project-cowork-workspace-header"]',
      ),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  it('reveals project headers live when a second project is added', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('first-workspace', 'first-worktree')],
    });
    const { container, root } = await renderSection({
      preserveSingleWorkspace: true,
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-sortable-header-first-workspace"]',
      ),
    ).toBeNull();

    await act(async () => {
      useProjectsStore.setState({
        projects: [
          makeProjectWithWorktree('first-workspace', 'first-worktree'),
          makeCoworkProject('second-workspace', 1),
        ],
      });
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-sortable-header-first-workspace"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-cowork-project-second-workspace-header"]',
      ),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    useSharedContainersStore.setState({ sharedWorktrees: {} });
  });

  it('renders the section header and controls', async () => {
    const { container, root } = await renderSection();

    expect(
      container.querySelector('[data-testid="sidebar-section-code"]'),
    ).not.toBeNull();
    // The toggle id must live on the actual control (the button carrying
    // aria-expanded/focus), not on header content (#1717 review).
    const toggle = container.querySelector(
      '[data-testid="sidebar-section-code-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="sidebar-section-code-add"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-section-code-more"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="sidebar-section-code"]')
        ?.getAttribute('data-onboarding-anchor'),
    ).toBeNull();
    // The onboarding anchor wraps the Workspaces header content (now inside
    // the toggle button after the control-contract fix); the tour positions by
    // the anchor element itself, not by its relationship to the toggle.
    const workspacesAnchor = container.querySelector(
      '[data-onboarding-anchor="sidebar-workspaces"]',
    );
    expect(workspacesAnchor).not.toBeNull();
    expect(workspacesAnchor?.textContent).toContain('Projects');
    expect(workspacesAnchor?.className).toContain('gap-1');
    const workspaceHeader = workspacesAnchor?.parentElement?.parentElement;
    expect(workspaceHeader?.classList.contains('sticky')).toBe(false);
    expect(workspaceHeader?.className).toContain('px-1');
    const workspaceContent = container.querySelector(
      '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
    );
    expect(workspaceContent?.className.split(' ')).not.toContain('pt-1');
    expect(workspaceContent?.className.split(' ')).toContain('pb-1');
    expect(workspaceContent?.className.split(' ')).toContain(
      'sidebar-workspaces-rows-clip',
    );
    expect(workspacesAnchor?.className).not.toContain('gap-1.5');
    expect(workspacesAnchor?.className).not.toContain('hover:bg-');

    const workspacesLabel = Array.from(
      workspacesAnchor?.querySelectorAll('span') ?? [],
    ).find((element) => element.textContent === 'Projects');
    const workspacesChevron = workspacesAnchor?.querySelector(
      '[data-testid="sidebar-workspaces-chevron"]',
    );
    expect(workspacesLabel).not.toBeUndefined();
    expect(workspacesChevron).not.toBeNull();
    expect(workspacesChevron).not.toBeUndefined();
    if (
      workspacesLabel === undefined ||
      workspacesChevron === null ||
      workspacesChevron === undefined
    ) {
      throw new Error('Expected the Projects label and chevron');
    }
    expect(workspacesLabel.className).toContain('fg-quaternary');
    expect(workspacesLabel.className).toContain(
      'group-hover/workspaces:fg-secondary',
    );
    expect(
      workspacesLabel.compareDocumentPosition(workspacesChevron) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(workspacesChevron.getAttribute('class') ?? '').toContain('h-4 w-4');
    expect(workspacesChevron.getAttribute('class') ?? '').toContain(
      'opacity-0',
    );
    expect(workspacesChevron.getAttribute('class') ?? '').toContain(
      'fg-quaternary',
    );
    expect(workspacesChevron.getAttribute('class') ?? '').toContain(
      'group-hover/workspaces:fg-secondary',
    );
    expect(workspacesChevron.getAttribute('class') ?? '').toContain(
      'group-hover/workspaces:opacity-100',
    );

    const workspacesHeaderRow = workspacesAnchor?.closest(
      '.group\\/workspaces',
    );
    expect(workspacesHeaderRow).not.toBeNull();
    expect(workspacesHeaderRow?.className).not.toContain('hover:bg-');
    expect(
      container
        .querySelector('[data-testid="sidebar-section-code-add"]')
        ?.getAttribute('data-onboarding-anchor'),
    ).toBe('workspace-add');
    const addButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-add"]',
    );
    expect(addButton).not.toBeNull();
    expect(addButton?.className).toContain('h-6 w-6');
    expect(addButton?.className).toContain('border-0');
    expect(addButton?.className).toContain('bg-transparent');
    expect(addButton?.className).toContain('fg-tertiary');
    expect(addButton?.className).toContain('hover:bg-subtle');
    expect(addButton?.className).toContain('hover:fg-primary');
    expect(addButton?.className).not.toContain('border-border');

    const addIcon = addButton?.querySelector('[data-app-icon="true"]');
    expect(addIcon?.getAttribute('style')).toContain('width: 14px');
    expect(addIcon?.getAttribute('style')).toContain('height: 14px');
    expect(addIcon?.getAttribute('class') ?? '').not.toContain('stroke-width');

    // The single overflow menu shares the add control's icon-button metrics.
    const moreButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-more"]',
    );
    expect(moreButton?.className).toContain('h-6 w-6');
    expect(moreButton?.className).toContain('fg-tertiary');
    expect(moreButton?.className).toContain('hover:bg-subtle');
    expect(moreButton?.className).toContain('hover:fg-primary');
    expect(container.textContent).toContain('Projects');

    unmountSection(root, container);
  });

  it('renders one real header inside one native sticky controls group', async () => {
    const { container, root } = await renderSection();
    const stickyHeaders = container.querySelectorAll('.sidebar-sticky-header');
    expect(stickyHeaders).toHaveLength(1);
    expect(stickyHeaders[0]?.classList.contains('sticky')).toBe(false);
    expect(
      stickyHeaders[0]?.querySelector(
        '[data-testid="sidebar-section-code-toggle"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelectorAll(
        '[data-onboarding-anchor="sidebar-workspaces"]',
      ),
    ).toHaveLength(1);
    const stickyGroup = container.querySelector(
      '[data-testid="sidebar-more-sticky-container"]',
    );
    expect(stickyGroup?.className).toContain('sticky');
    // The band stacks beneath the pinned More row and the Chats header, so its
    // offset is a computed stack rather than the bare `top-px` (CAN-2363).
    expect(stickyGroup?.getAttribute('style')).toContain(
      '--sidebar-more-height',
    );
    expect(
      container.querySelector('[data-testid="sidebar-more-sticky-lead"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-more-sticky-lead"] [data-testid="sidebar-more-stub"]',
      ),
    ).not.toBeNull();
    expect(
      stickyGroup?.querySelector('[data-testid="sidebar-more-workspaces-gap"]')
        ?.className,
    ).toContain('h-3');
    expect(
      stickyGroup?.querySelectorAll('.sidebar-sticky-header'),
    ).toHaveLength(1);
    unmountSection(root, container);
  });

  it('keeps More mounted in the native sticky group while projects load', async () => {
    useProjectsStore.setState({ isLoading: true });

    const { container, root } = await renderSection();
    const stickyGroup = container.querySelector(
      '[data-testid="sidebar-more-sticky-container"]',
    );

    expect(stickyGroup?.className).toContain('sticky');
    // The band stacks beneath the pinned More row and the Chats header, so its
    // offset is a computed stack rather than the bare `top-px` (CAN-2363).
    expect(stickyGroup?.getAttribute('style')).toContain(
      '--sidebar-more-height',
    );
    expect(
      container.querySelector('[data-testid="sidebar-more-sticky-lead"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-more-sticky-lead"] [data-testid="sidebar-more-stub"]',
      ),
    ).not.toBeNull();
    expect(
      stickyGroup?.querySelector('[data-testid="sidebar-more-workspaces-gap"]')
        ?.className,
    ).toContain('h-3');
    expect(
      container.querySelector('[data-testid="sidebar-section-code-loading"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-onboarding-anchor="sidebar-workspaces"]'),
    ).toBeNull();

    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-more-stub"]',
    );
    if (!more) throw new Error('Expected More while projects load');
    act(() => more.focus());
    await act(async () => {
      useProjectsStore.setState({ isLoading: false });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="sidebar-more-stub"]')).toBe(
      more,
    );
    expect(document.activeElement).toBe(more);

    unmountSection(root, container);
  });

  it('keeps More, the gap, and Projects in DOM order without an inset swap', async () => {
    const { container, root } = await renderSection();
    const stickyGroup = container.querySelector(
      '[data-testid="sidebar-more-sticky-container"]',
    );
    expect(
      Array.from(stickyGroup?.children ?? []).map((child) =>
        child.getAttribute('data-testid'),
      ),
    ).toEqual([
      'sidebar-more-workspaces-gap',
      null,
      'sidebar-selected-pin-top',
      'sidebar-sticky-workspace-slot',
    ]);
    // More is pinned above the band, not inside it, so it reads with the nav
    // rather than as part of the Projects header (CAN-2363).
    const moreLead = container.querySelector(
      '[data-testid="sidebar-more-sticky-lead"]',
    );
    expect(moreLead).not.toBeNull();
    expect(
      moreLead?.querySelector('[data-testid="sidebar-more-stub"]'),
    ).not.toBeNull();
    if (moreLead === null || stickyGroup === null) {
      throw new Error('Expected the More lead and sticky group');
    }
    expect(
      Boolean(
        moreLead.compareDocumentPosition(stickyGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      container.querySelector(
        '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
      )?.className,
    ).not.toContain('-mt-1');
    expect(
      container.querySelector('[data-onboarding-anchor="sidebar-workspaces"]')
        ?.className,
    ).toContain('translate-y-0.5');
    // No rule under the band. It marked the band's bottom edge back when the
    // band was transparent; the band paints now, so the edge is the surface
    // change itself, and the rule only showed for the handful of scroll
    // positions between fading in and being covered.
    expect(
      container.querySelector(
        '[data-testid="sidebar-sticky-workspaces-divider"]',
      ),
    ).toBeNull();
    const slot = container.querySelector(
      '[data-testid="sidebar-sticky-workspace-slot"]',
    );
    expect(slot?.hasAttribute('hidden')).toBe(true);
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    // The selected-item pin group is a stable hidden host until the scroll
    // sync reveals it with portaled copies inside.
    const pinTop = container.querySelector(
      '[data-testid="sidebar-selected-pin-top"]',
    );
    expect(pinTop?.hasAttribute('hidden')).toBe(true);
    expect(pinTop?.getAttribute('aria-hidden')).toBe('true');
    expect(
      pinTop?.querySelector('[data-sidebar-selected-pin-part="header"]'),
    ).not.toBeNull();
    expect(
      pinTop?.querySelector('[data-sidebar-selected-pin-part="row"]'),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  it('portals each interactive project header into one transparent fixed-slot host', async () => {
    useProjectsStore.setState({
      projects: [
        makeProject('code-slot', 0),
        makeCoworkProject('chat-slot', 1),
      ],
    });

    const { container, root } = await renderSection();
    const slot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-sticky-workspace-slot"]',
    );
    const hosts = Array.from(
      slot?.querySelectorAll<HTMLElement>(
        '[data-sidebar-sticky-slot-workspace-id]',
      ) ?? [],
    );

    expect(slot?.className).not.toContain('bg-');
    expect(
      hosts.map((host) => host.dataset.sidebarStickySlotWorkspaceId),
    ).toEqual(['code-slot', 'chat-slot']);
    expect(
      hosts[0]?.querySelector(
        '[data-testid="sidebar-project-header-code-slot-sticky-slot"]',
      ),
    ).not.toBeNull();
    expect(
      hosts[1]?.querySelector(
        '[data-testid="sidebar-cowork-project-chat-slot-header-sticky-slot"]',
      ),
    ).not.toBeNull();
    expect(
      hosts[0]?.querySelector('[aria-label="Reorder code-slot"]'),
    ).not.toBeNull();
    expect(
      hosts[1]?.querySelector('[aria-label="New task in chat-slot"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="sidebar-project-header-code-slot"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '[data-testid="sidebar-cowork-project-chat-slot-header"]',
      ),
    ).toHaveLength(1);

    unmountSection(root, container);
  });

  it('anchors a keyboard-opened Cowork context menu to the project header', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });

    const { container, root } = await renderSection();
    const header = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-header"]',
    );
    if (!header) throw new Error('Expected Cowork project header');
    jest.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      left: 48,
      top: 64,
      right: 248,
      bottom: 96,
      width: 200,
      height: 32,
      x: 48,
      y: 64,
      toJSON: () => ({}),
    });

    act(() => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 0,
        }),
      );
    });

    const anchor = document.querySelector<HTMLElement>(
      '[data-testid="workspace-session-context-menu-anchor"]',
    );
    expect(anchor?.style.left).toBe('48px');
    expect(anchor?.style.top).toBe('96px');
    const shareItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-share-template-menu-item"]',
    );
    expect(shareItem).not.toBeNull();
    act(() => shareItem?.click());
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'cowork-target',
      initialTab: 'share',
    });

    unmountSection(root, container);
  });

  it('offers Move to organization in the Cowork project menu only when the host passes it', async () => {
    const item = makeCoworkProject('cowork-target', 0);
    useProjectsStore.setState({ projects: [item] });
    installWindowApi();
    const onMoveToOrganizationRequested = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderRow = async (
      onMove: ((workspaceId: string) => void) | undefined,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            {item.type === 'cowork' ? (
              <SidebarCoworkWorkspaceRow
                item={item}
                disableDrag
                onMoveToOrganizationRequested={onMove}
              />
            ) : null}
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
    };
    const openMenu = (): void => {
      const header = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-header"]',
      );
      if (!header) throw new Error('Expected Cowork project header');
      act(() => {
        header.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 0,
            clientY: 0,
          }),
        );
      });
    };
    const moveItem = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        '[data-testid="workspace-move-to-organization-menu-item"]',
      );

    await renderRow(undefined);
    openMenu();
    expect(
      document.querySelector('[data-testid="workspace-session-context-menu"]'),
    ).not.toBeNull();
    expect(moveItem()).toBeNull();

    await renderRow(onMoveToOrganizationRequested);
    openMenu();
    expect(moveItem()?.textContent).toContain('Move to org…');
    act(() => moveItem()?.click());
    expect(onMoveToOrganizationRequested).toHaveBeenCalledWith('cowork-target');
    expect(
      document.querySelector('[data-testid="workspace-session-context-menu"]'),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('gives every command row in the Cowork project menu a leading icon', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });

    const { container, root } = await renderSection();
    const header = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-header"]',
    );
    if (!header) throw new Error('Expected Cowork project header');

    act(() => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 0,
        }),
      );
    });

    expectMenuCommandRowsHaveIcons(
      document.querySelector<HTMLElement>(
        '[data-testid="workspace-session-context-menu"]',
      ),
    );

    unmountSection(root, container);
  });

  it('keeps expanded project layout stationary around a 32px sortable header', async () => {
    useProjectsStore.setState({
      projects: [
        makeProjectWithWorktree('expanded-code', 'expanded-worktree'),
        { ...makeProject('collapsed-code', 1), collapsed: true },
        makeCoworkProject('cowork-target', 2),
      ],
    });

    const { container, root } = await renderSection();
    const workspace = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace-id="expanded-code"]',
    );
    const flowHeader = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-sortable-header-expanded-code"]',
    );
    const stickyHeader = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-sortable-header-expanded-code-sticky-slot"]',
    );
    const worktree = workspace?.querySelector<HTMLElement>(
      '[data-testid="worktree-row"]',
    );
    const collapsedHeader = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-sortable-header-collapsed-code"]',
    );

    expect(workspace?.className).toContain('relative');
    expect(workspace?.className).not.toContain('opacity-0');
    expect(workspace?.getAttribute('style')).toBeNull();
    expect(flowHeader?.className).toContain('h-8');
    expect(stickyHeader?.className).toContain('h-8');
    expect(collapsedHeader?.className).toContain('h-8');
    expect(flowHeader?.dataset.sidebarWorkspaceSortableHeader).toBe(
      'expanded-code',
    );
    expect(worktree).not.toBeNull();
    expect(
      workspace?.querySelector(
        '[data-sidebar-folder-content="code-workspace"]',
      ),
    ).not.toBeNull();

    const icon = flowHeader?.querySelector<HTMLButtonElement>(
      '[aria-label="Reorder expanded-code"]',
    );
    const label = flowHeader?.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse expanded-code"]',
    );
    const settings = flowHeader?.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for expanded-code"]',
    );
    const add = flowHeader?.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for expanded-code"]',
    );
    expect(icon?.dataset.workspaceDragActivator).toBe('icon');
    expect(label?.dataset.workspaceDragActivator).toBe('label');
    expect(settings?.dataset.workspaceDragActivator).toBeUndefined();
    expect(add?.dataset.workspaceDragActivator).toBeUndefined();

    const coworkHeader = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-header"]',
    );
    expect(
      coworkHeader?.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-drag-handle"]',
      )?.dataset.workspaceDragActivator,
    ).toBe('icon');
    expect(
      coworkHeader?.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-toggle"]',
      )?.dataset.workspaceDragActivator,
    ).toBe('label');
    expect(
      coworkHeader?.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-settings"]',
      )?.dataset.workspaceDragActivator,
    ).toBeUndefined();

    unmountSection(root, container);
  });

  it('keeps the source header dimmed and children painted during keyboard drag cancel', async () => {
    useProjectsStore.setState({
      projects: [
        makeProjectWithWorktree('drag-source', 'source-worktree'),
        {
          ...makeProjectWithWorktree('drag-target', 'target-worktree'),
          order: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    const sourceWorkspace = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace-id="drag-source"]',
    );
    const sourceHeader = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-sortable-header-drag-source"]',
    );
    const sourceWorktree = sourceWorkspace?.querySelector<HTMLElement>(
      '[data-testid="worktree-row"]',
    );
    const dragHandle = sourceHeader?.querySelector<HTMLButtonElement>(
      '[aria-label="Reorder drag-source"]',
    );

    await act(async () => {
      dragHandle?.focus();
      dragHandle?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'Space',
          key: ' ',
        }),
      );
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-testid="workspace-drag-overlay"]'),
    ).not.toBeNull();
    expect(sourceHeader?.className).toContain('opacity-60');
    expect(sourceWorkspace?.className).not.toContain('opacity-0');
    expect(sourceWorktree).not.toBeNull();
    expect(sourceWorktree?.className).not.toContain('opacity-0');
    expect(
      sourceWorkspace?.querySelector(
        '[data-sidebar-folder-content="code-workspace"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      dragHandle?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'Escape',
          key: 'Escape',
        }),
      );
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-testid="workspace-drag-overlay"]'),
    ).toBeNull();
    expect(sourceHeader?.className).not.toContain('opacity-60');
    expect(
      container.querySelector('[data-testid="workspace-drop-indicator"]'),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('opens Add Project without changing the active page', async () => {
    useNavigationStore.setState({
      activePage: 'usage',
      addWorkspaceModalOpen: false,
    });

    const { container, root } = await renderSection();
    const addButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-add"]',
    );

    await act(async () => {
      addButton?.click();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('usage');

    unmountSection(root, container);
  });

  it('offers ordering and project visibility from one header menu', async () => {
    useProjectsStore.setState({
      projects: [makeProject('alpha', 0), makeProject('beta', 1)],
    });

    const { container, root } = await renderSection();

    // The Projects header carries a single overflow menu. The
    // separate filter "…" that used to sit beside it is gone; its options
    // live in this menu alongside the ordering choices, the way the Chats
    // header already works.
    expect(
      container.querySelectorAll('[data-testid="worktree-filter-trigger"]'),
    ).toHaveLength(0);
    const header = container
      .querySelector('[data-testid="sidebar-section-code-toggle"]')
      ?.closest('.sidebar-sticky-header');
    expect(header?.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1);

    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-more"]',
    );
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });

    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-section-code-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(
      menu?.querySelector('[data-testid="sidebar-projects-sort-last-updated"]'),
    ).not.toBeNull();
    expect(
      menu?.querySelector('[data-testid="sidebar-projects-sort-manual"]'),
    ).not.toBeNull();
    expect(menu?.textContent).toContain('Show projects');

    const alpha = menu?.querySelector<HTMLElement>(
      '[data-testid="sidebar-projects-show-alpha"]',
    );
    expect(alpha?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(alpha?.getAttribute('aria-checked')).toBe('true');
    // Project identity and worktree count travel with the row, as they did in
    // the standalone filter menu.
    expect(
      alpha?.querySelector('[data-testid="sidebar-projects-show-icon-alpha"]'),
    ).not.toBeNull();
    expect(alpha?.textContent).toContain('alpha');
    expect(
      menu?.querySelector('[data-testid="sidebar-projects-show-beta"]'),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  it('toggles project visibility without closing the header menu', async () => {
    useProjectsStore.setState({
      projects: [makeProject('alpha', 0), makeProject('beta', 1)],
    });

    const { container, root } = await renderSection();
    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-more"]',
    );
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });

    const beta = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-projects-show-beta"]',
    );
    await act(async () => {
      beta?.click();
      await Promise.resolve();
    });

    expect(useProjectsStore.getState().hiddenWorkspaceIds).toEqual(['beta']);
    // Multi-select: hiding one project leaves the menu open so the next
    // choice does not need a second trip to the header.
    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-section-code-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(
      menu
        ?.querySelector('[data-testid="sidebar-projects-show-beta"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false');

    unmountSection(root, container);
  });

  it('keeps the header menu visible and dotted while projects are hidden', async () => {
    useProjectsStore.setState({
      projects: [makeProject('alpha', 0), makeProject('beta', 1)],
      hiddenWorkspaceIds: ['beta'],
    });

    const { container, root } = await renderSection();
    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-more"]',
    );
    const activeDot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-section-code-more-active-dot"]',
    );
    const addButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-add"]',
    );

    // Hiding projects is state the user cannot see in the rows themselves, so
    // the control that reverses it must not wait for a hover.
    // Neither the button nor a reveal wrapper hides it at rest.
    expect(more?.className).not.toContain('opacity-0');
    expect(more?.closest('[class~="opacity-0"]')).toBeNull();
    expect(more?.getAttribute('data-active')).toBe('true');
    expect(activeDot?.className).toContain('bg-fg-blue');
    expect(activeDot?.className).toContain('right-0.5 top-0.5');
    expect(addButton?.closest('.hidden')).toBeNull();

    unmountSection(root, container);
  });

  it('gives every command row in the Projects header menu a leading icon', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('sole-target', 'sole-worktree')],
    });

    const { container, root } = await renderSection({
      preserveSingleWorkspace: true,
    });
    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-code-more"]',
    );
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });

    expectMenuCommandRowsHaveIcons(
      document.body.querySelector<HTMLElement>(
        '[data-testid="sidebar-section-code-menu"]',
      ),
    );

    unmountSection(root, container);
  });

  it('keeps the expand chevron visible while the section is collapsed', async () => {
    useSidebarStore.setState({ codeSectionCollapsed: true });

    const { container, root } = await renderSection();
    const chevron = container.querySelector<SVGElement>(
      '[data-testid="sidebar-workspaces-chevron"]',
    );

    const chevronClassName = chevron?.getAttribute('class');
    expect(chevronClassName).toContain('-rotate-90');
    expect(chevronClassName).toContain('opacity-100');
    expect(chevronClassName).not.toContain('transform');
    expect(chevronClassName).not.toContain('pointer-coarse:opacity-100');

    unmountSection(root, container);
  });

  it('renders one project section per visible project', async () => {
    useProjectsStore.setState({
      projects: [
        { ...makeProject('alpha', 0), collapsed: true },
        { ...makeProjectWithWorktree('beta', 'wt-beta'), order: 1 },
        makeProject('gamma', 2),
      ],
    });

    const { container, root } = await renderSection();

    // The DOM contract is one <section> per workspace (the outer Workspaces
    // group is a div via SidebarSection as="div" so `locator('section')`
    // automation matches exactly one element per workspace).
    expect(container.querySelectorAll('section').length).toBe(3);
    const workspaceSections = container.querySelectorAll<HTMLElement>(
      '[data-workspace-expanded]',
    );
    expect(workspaceSections[0]?.className).toContain('mb-px');
    expect(workspaceSections[1]?.className).toContain('mb-2');
    expect(workspaceSections[2]?.className).not.toContain('mb-');
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    expect(
      container.querySelector('[data-sidebar-folder-content="code-workspace"]')
        ?.className,
    ).toContain('sidebar-fade-presence');

    unmountSection(root, container);
  });

  it('uses one-pixel empty gaps and eight-pixel expanded-content gaps', async () => {
    useProjectsStore.setState({
      projects: [
        { ...makeProject('collapsed-code', 0), collapsed: true },
        { ...makeProject('empty-code', 1), collapsed: false },
        {
          ...makeProjectWithWorktree('expanded-code', 'wt-expanded'),
          order: 2,
        },
        { ...makeCoworkProject('empty-cowork', 3), collapsed: false },
        { ...makeCoworkProject('expanded-cowork', 4), collapsed: false },
        { ...makeCoworkProject('collapsed-cowork', 5), collapsed: true },
        makeProject('next', 6),
      ],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'expanded-cowork',
      workEntries: [
        {
          id: 'expanded-cowork-entry',
          title: 'Visible chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
      sidebarEntriesByProject: {
        'empty-cowork': [],
      },
      legacyArchivedByProject: {
        'empty-cowork': [],
        'expanded-cowork': [],
        'collapsed-cowork': [],
      },
    });

    const { container, root } = await renderSection();

    expect(
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-project-header-collapsed-code"]',
        )
        ?.closest<HTMLElement>('[data-workspace-expanded]')?.className,
    ).toContain('mb-px');
    expect(
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-project-header-empty-code"]',
        )
        ?.closest<HTMLElement>('[data-workspace-expanded]')?.className,
    ).toContain('mb-px');
    expect(
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-project-header-expanded-code"]',
        )
        ?.closest<HTMLElement>('[data-workspace-expanded]')?.className,
    ).toContain('mb-2');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-empty-cowork"]',
      )?.className,
    ).toContain('mb-px');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-expanded-cowork"]',
      )?.className,
    ).toContain('mb-2');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="sidebar-cowork-project-collapsed-cowork"]',
      )?.className,
    ).toContain('mb-px');

    unmountSection(root, container);
  });

  it('keeps code project headers full width', async () => {
    useProjectsStore.setState({ projects: [makeProject('alpha', 0)] });

    const { container, root } = await renderSection();
    const dragHandle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Reorder alpha"]',
    );
    expect(dragHandle?.querySelector('svg')).not.toBeNull();
    // Empty workspaces stay toggleable (cowork parity), so the icon slot
    // keeps its hover-revealed disclosure chevron and the name button
    // carries the collapse label instead of a "has no worktrees" notice.
    expect(
      dragHandle?.querySelector('[data-workspace-disclosure-chevron="true"]'),
    ).not.toBeNull();
    const nameButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand alpha"]',
    );
    // ProjectHeader wraps WorkspaceSectionHeader before entering
    // SidebarSection's flex header slot. Locate that wrapper by its stable
    // automation hook so internal WorkspaceSectionHeader markup can evolve.
    const projectHeaderWrapper = nameButton?.closest(
      '[data-testid^="sidebar-project-header-"]',
    );
    expect(projectHeaderWrapper?.classList.contains('w-full')).toBe(true);

    unmountSection(root, container);
  });

  it('renders Code worktree rows with the classic hierarchy', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
    });

    const { container, root } = await renderSection();
    const header = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-header-alpha"]',
    );
    const headerSurface = header?.firstElementChild as HTMLElement | null;
    const worktree = container.querySelector<HTMLElement>(
      '[data-testid="worktree-row"]',
    );
    expect(headerSurface?.className).toContain('h-8');
    expect(headerSurface?.className).toContain('rounded-row');
    expect(worktree?.dataset.worktreeLayout).toBe('classic');
    // The generated worktree name remains visible in the classic subtitle so
    // users can refer to worktrees by names such as "otter" or "fox".
    expect(worktree?.textContent).toContain('calm-otter');
    // Idle rows render empty space in the leading slot instead of a dot.
    expect(
      worktree?.querySelector(
        '[data-testid="worktree-idle-status-placeholder"]',
      ),
    ).not.toBeNull();
    expect(
      worktree?.querySelector('[data-testid="worktree-row-status-rail"]'),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('shows the creating placeholder below pinned rows, where the new worktree lands', async () => {
    const project = makeProjectWithWorktree('alpha', 'tail-otter');
    useProjectsStore.setState({
      projects: [
        {
          ...project,
          worktrees: [
            {
              id: 'pinned-fox',
              branchName: 'feature/pinned',
              createdAt: '2026-01-01T00:00:00.000Z',
              pinned: true,
            },
            ...project.worktrees,
          ],
        },
      ],
      creatingWorktreeForProject: new Set(['alpha']),
    });

    const { container, root } = await renderSection();
    try {
      const [pinnedRow, tailRow] = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-sidebar-folder-content="code-workspace"] [data-testid="worktree-row"]',
        ),
      );
      const placeholder = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-worktree-creating-placeholder"]',
      );
      expect(pinnedRow?.textContent).toContain('pinned-fox');
      expect(tailRow?.textContent).toContain('tail-otter');
      if (!placeholder) throw new Error('Expected the creating placeholder');
      expect(pinnedRow?.compareDocumentPosition(placeholder)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(tailRow?.compareDocumentPosition(placeholder)).toBe(
        Node.DOCUMENT_POSITION_PRECEDING,
      );
    } finally {
      unmountSection(root, container);
      useProjectsStore.setState({ creatingWorktreeForProject: new Set() });
    }
  });

  it('creates and opens a worktree from the project add button', async () => {
    let resolveCreate:
      | ((created: { id: string } | undefined) => void)
      | undefined;
    let onRegistered: ((worktree: WorktreeData) => void) | undefined;
    const createWorktree = jest.fn(
      (
        _projectId: string,
        options?: { onRegistered?: (worktree: WorktreeData) => void },
      ) =>
        new Promise<{ id: string } | undefined>((resolve) => {
          resolveCreate = resolve;
          onRegistered = options?.onRegistered;
        }),
    );
    useProjectsStore.setState({
      projects: [makeProject('alpha', 0)],
      createWorktree,
    });
    useNavigationStore.setState({ activePage: 'usage' });

    const { container, root } = await renderSection();
    const addWorktreeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for alpha"]',
    );

    await act(async () => {
      addWorktreeButton?.click();
      await Promise.resolve();
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree.mock.calls[0]?.[0]).toBe('alpha');
    expect(createWorktree.mock.calls[0]?.[1]?.onRegistered).toBeInstanceOf(
      Function,
    );
    expect(useNavigationStore.getState().activePage).toBe('usage');

    await act(async () => {
      onRegistered?.({
        id: 'wt-new',
        branchName: 'wt-new',
        createdAt: '2026-07-30T00:00:00.000Z',
      });
      await Promise.resolve();
    });

    // The active UI moves at local registration; the broader creation promise
    // is still pending on persistence/post-create work at this point.
    expect(useNavigationStore.getState().activePage).toBe('main');

    await act(async () => {
      resolveCreate?.({ id: 'wt-new' });
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().activePage).toBe('main');

    unmountSection(root, container);
  });

  it('creates and opens a new task in the cowork project, like a code project', async () => {
    const createWorkEntryInProject = jest.fn(
      (): Promise<void> => Promise.resolve(),
    );
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({ createWorkEntryInProject });
    useNavigationStore.setState({
      activePage: 'home',
      homeComposerFocusRequest: 0,
    });

    const { container, root } = await renderSection();
    const addTaskButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="New task in cowork-target"]',
    );

    await act(async () => {
      addTaskButton?.click();
      await Promise.resolve();
    });

    // The "+" makes the task right away and opens it, so the user can run a
    // pipeline (or anything else) before sending a first message.
    expect(createWorkEntryInProject).toHaveBeenCalledWith('cowork-target');
    expect(useNavigationStore.getState().activePage).toBe('chat');
    expect(useHomeComposerStore.getState().workspaceId).not.toBe(
      'cowork-target',
    );

    unmountSection(root, container);
  });

  it('tells the user when creating a cowork task fails', async () => {
    const addToast = jest.fn();
    const originalAddToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      createWorkEntryInProject: jest.fn(
        (): Promise<void> => Promise.reject(new Error('create failed')),
      ),
    });

    const { container, root } = await renderSection();
    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="New task in cowork-target"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      // A failed create is not silent: the user learns nothing was made.
      expect(addToast).toHaveBeenCalledWith(
        "Couldn't create the task. Try again.",
        'error',
      );
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
      unmountSection(root, container);
    }
  });

  it('tells the user when opening a cowork task fails', async () => {
    const addToast = jest.fn();
    const originalAddToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    useProjectsStore.setState({
      projects: [
        { ...makeCoworkProject('cowork-target', 0), collapsed: false },
      ],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-dead',
          title: 'Forked chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
      openWorkEntryFromSidebar: jest.fn(
        (): Promise<void> =>
          Promise.reject(new Error('Chat project not found')),
      ),
    });

    const { container, root } = await renderSection();
    try {
      await act(async () => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="sidebar-work-entry-entry-dead"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The row is fire-and-forget, so without this the click looks ignored.
      expect(addToast).toHaveBeenCalledWith(
        "Couldn't open the task. Try again.",
        'error',
      );
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
      unmountSection(root, container);
    }
  });

  it('shows the selected empty task in the sidebar and keeps other empty tasks hidden', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useNavigationStore.setState({ activePage: 'chat' });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      activeWorkEntryId: 'entry-new',
      workEntries: [
        {
          id: 'entry-new',
          title: 'New task',
          createdAt: '2026-01-02T00:00:00.000Z',
          chatCount: 1,
        },
        {
          id: 'entry-stale-empty',
          title: 'New task',
          createdAt: '2026-01-01T00:00:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();

    const newRow = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-new"]',
    );
    expect(newRow).not.toBeNull();
    expect(newRow?.hasAttribute('data-sidebar-selected-item')).toBe(true);
    expect(
      container.querySelector(
        '[data-testid="sidebar-work-entry-entry-stale-empty"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('shows Settings with an accent dot for an empty multi-repo project', async () => {
    useProjectsStore.setState({
      projects: [makeEmptyMultiRepoProject('empty-workspace', 0)],
    });

    const { container, root } = await renderSection();
    const preferencesButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for empty-workspace"]',
    );
    const addButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for empty-workspace"]',
    );

    expect(preferencesButton).not.toBeNull();
    expect(
      preferencesButton?.closest(
        '.hidden.group-hover\\/sidebar-item\\:inline-flex',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-settings-warning-dot"]'),
    ).not.toBeNull();
    expect(addButton?.disabled).toBe(true);

    unmountSection(root, container);
  });

  it('hides the project list body when the section is collapsed', async () => {
    useSidebarStore.setState({ codeSectionCollapsed: true });
    useProjectsStore.setState({ projects: [makeProject('alpha', 0)] });

    const { container, root } = await renderSection();

    // Collapsed: the outer group (a div) keeps its header mounted while the
    // per-workspace <section>s unmount with the hidden list content.
    expect(container.querySelectorAll('section').length).toBe(0);
    // Header still renders while collapsed.
    expect(
      container.querySelector('[data-testid="sidebar-section-code-toggle"]'),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  it('persists a cowork project collapse and restores it on remount', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });

    const firstRender = await renderSection();
    const workspace = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target"]',
    );
    expect(workspace?.className).not.toContain('bg-accent');
    expect(workspace?.className).not.toContain('ring-line-accent');
    const toggle = firstRender.container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-toggle"]',
    );
    const header = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-header"]',
    );
    expect(header?.className).toContain('fg-primary');
    expect(header?.className).not.toContain('fg-tertiary');
    expect(header?.className).toContain('hover:bg-subtle');
    expect(header?.className).toContain('duration-150');
    expect(header?.className).toContain('transition-colors');
    expect(header?.className).toContain('group/sidebar-item');
    expect(header?.className).toContain('pl-1.5');
    expect(header?.className).toContain('pr-1');
    expect(toggle?.className).toContain('group-hover/sidebar-item:pr-19');
    expect(
      firstRender.container.querySelector(
        '[data-sidebar-folder-content="cowork-workspace"]',
      ),
    ).toBeNull();
    const dragHandle = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-drag-handle"]',
    );
    expect(dragHandle?.querySelector('svg')).not.toBeNull();
    // The disclosure chevron overlays the leading icon slot instead of
    // rendering after the workspace name: hidden at rest (no chevron in the
    // default state), revealed on row hover/focus while the icon fades out.
    const coworkChevron = dragHandle?.querySelector<HTMLElement>(
      '[data-testid="workspace-section-collapse-chevron"]',
    );
    expect(coworkChevron).not.toBeNull();
    expect(
      toggle?.querySelector(
        '[data-testid="workspace-section-collapse-chevron"]',
      ),
    ).toBeNull();
    expect(coworkChevron?.getAttribute('class')).toContain('opacity-0');
    expect(coworkChevron?.getAttribute('class')).toContain(
      'group-hover/sidebar-item:opacity-100',
    );
    const coworkIconWrapper = dragHandle?.querySelector<HTMLElement>(
      '[data-testid="workspace-icon-disclosure-swap"] > span',
    );
    expect(coworkIconWrapper?.getAttribute('class')).toContain(
      'group-hover/sidebar-item:opacity-0',
    );
    // The resting cowork badge contains the shared filled folder.
    expect(
      coworkIconWrapper?.querySelector(
        '[data-app-icon="true"][data-glyph="folder-fill1"]',
      ),
    ).not.toBeNull();
    const settingsButton = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-settings"]',
    );
    const newChatButton = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-new-chat"]',
    );
    // The overlay reaches the row edge and swallows its own presses once
    // revealed, so gaps around the controls cannot fall through to the
    // collapse toggle beneath it.
    const coworkActionOverlay = settingsButton?.closest('.absolute');
    expect(coworkActionOverlay?.className).toContain('right-0');
    expect(coworkActionOverlay?.className).toContain('pr-1');
    expect(coworkActionOverlay?.className).toContain('pointer-events-none');
    expect(coworkActionOverlay?.className).toContain(
      'group-hover/sidebar-item:pointer-events-auto',
    );
    for (const action of [settingsButton, newChatButton]) {
      expect(action?.className).toContain('h-6 w-6');
      expect(action?.className).toContain('bg-transparent');
      // The sidebar's one icon-button hover: the `bg-subtle` square.
      expect(action?.className).toContain('hover:bg-subtle');
      expect(action?.className).toContain('hover:fg-primary');
      expect(action?.parentElement?.parentElement?.className).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(action?.parentElement?.parentElement?.className).toContain(
        'pointer-events-none',
      );
      expect(
        action?.querySelector('[data-app-icon="true"]')?.getAttribute('style'),
      ).toContain('width: 14px');
    }
    expect(settingsButton?.parentElement?.parentElement?.parentElement).toBe(
      newChatButton?.parentElement?.parentElement?.parentElement,
    );
    expect(
      settingsButton?.parentElement?.parentElement?.parentElement?.className,
    ).toContain('gap-0.5');
    if (settingsButton === null || newChatButton === null) {
      throw new Error('Expected cowork Settings and New chat buttons');
    }
    expect(
      settingsButton.compareDocumentPosition(newChatButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      firstRender.container.querySelector(
        '[data-testid="sidebar-cowork-project-cowork-target-chevron"]',
      ),
    ).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const emptyState = firstRender.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-cowork-target-empty"]',
    );
    expect(emptyState).toBeNull();
    expect(firstRender.container.textContent).not.toContain('No chats');
    expect(newChatButton?.getAttribute('aria-label')).toBe(
      'New task in cowork-target',
    );

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    const persistedProjects = useProjectsStore.getState().projects;
    expect(persistedProjects[0]?.collapsed).toBe(true);
    expect(window.api.saveProjects).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cowork-target', collapsed: true }),
      ]),
    );

    unmountSection(firstRender.root, firstRender.container);

    // A renderer reload rehydrates this same persisted item from the main
    // process. Remount with that payload and verify the row stays collapsed.
    useProjectsStore.setState({ projects: persistedProjects });
    const restoredRender = await renderSection();
    const restoredToggle =
      restoredRender.container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-toggle"]',
      );
    expect(restoredToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(restoredRender.container.textContent).not.toContain('No chats');

    unmountSection(restoredRender.root, restoredRender.container);
  });

  it('renders the first cowork work entry without remounting an empty project', async (): Promise<void> => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({ activeChatProjectId: 'cowork-target' });
    const { container, root } = await renderSection();
    expect(container.textContent).not.toContain('No chats');
    expect(
      container.querySelector(
        '[data-sidebar-folder-content="cowork-workspace"]',
      ),
    ).toBeNull();

    await act(async (): Promise<void> => {
      useStandaloneChatStore.setState({
        workEntries: [
          {
            id: 'entry-first',
            title: 'First chat',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
          },
        ],
      });
      await Promise.resolve();
    });

    const body = container.querySelector(
      '[data-sidebar-folder-content="cowork-workspace"]',
    );
    expect(body?.className).toContain('sidebar-fade-presence');
    expect(
      body?.querySelector('[data-testid="sidebar-work-entry-entry-first"]')
        ?.textContent,
    ).toContain('First chat');
    unmountSection(root, container);
  });

  it('shows a cowork-style empty state for an expanded code project with no worktrees', async () => {
    useProjectsStore.setState({
      projects: [{ ...makeProject('empty-code', 0), collapsed: false }],
    });

    const { container, root } = await renderSection();
    const emptyState = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-empty-code-empty"]',
    );

    expect(emptyState?.textContent).toContain('No worktrees');
    // Same treatment as the cowork "No chats" row.
    expect(emptyState?.className).toContain('fg-quaternary');
    expect(emptyState?.className).toContain('pl-8');

    // The disclosure stays toggleable with zero worktrees, matching cowork:
    // collapsing hides the empty row, expanding restores it.
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse empty-code"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-empty-code-empty"]',
      ),
    ).toBeNull();
    const expandToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand empty-code"]',
    );
    expect(expandToggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      expandToggle?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-empty-code-empty"]',
      ),
    ).not.toBeNull();

    unmountSection(root, container);
  });

  it('hides the code-workspace empty state when collapsed, populated, or archived', async () => {
    useProjectsStore.setState({
      projects: [
        makeProject('collapsed-code', 0),
        { ...makeProjectWithWorktree('populated-code', 'wt-1'), order: 1 },
        {
          ...makeProject('archived-code', 2),
          collapsed: false,
          archivedContainerCount: 2,
        },
      ],
    });

    const { container, root } = await renderSection();

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-collapsed-code-empty"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-project-populated-code-empty"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-project-archived-code-empty"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('derives code-workspace empty-state archive presence from the loaded archive store', async () => {
    // Once the archive store has loaded a workspace, its data supersedes the
    // sidebar item's possibly-stale archivedContainerCount snapshot (restore/
    // permanent-delete update the store before the best-effort sidebar
    // refresh, which can fail silently).
    useProjectsStore.setState({
      projects: [
        {
          // Stale snapshot says 2 archived containers, but the loaded store
          // says none remain: the empty state must show.
          ...makeProject('stale-count-code', 0),
          collapsed: false,
          archivedContainerCount: 2,
        },
        {
          // Stale snapshot says none, but the loaded store has one: the
          // Archived subgroup renders, so the empty state must stay hidden.
          ...makeProject('stale-zero-code', 1),
          collapsed: false,
        },
      ],
    });
    useArchivedContainersStore.setState({
      byWorkspace: {
        'stale-count-code': [],
        'stale-zero-code': [
          {
            ...makeArchivedCoworkEntry('archived-wt', 'stale-zero-code'),
            kind: 'worktree',
          },
        ],
      },
      loadedWorkspaces: {
        'stale-count-code': true,
        'stale-zero-code': true,
      },
    });

    const { container, root } = await renderSection();

    expect(
      container.querySelector(
        '[data-testid="sidebar-project-stale-count-code-empty"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-project-stale-zero-code-empty"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('collapses a hovered project on the first rapid click', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('rapid-click-target', 0)],
    });

    const { container, root } = await renderSection();
    const header = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-cowork-project-rapid-click-target-header"]',
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-cowork-project-rapid-click-target-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      toggle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      toggle?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      toggle?.click();
      await Promise.resolve();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'rapid-click-target')
        ?.collapsed,
    ).toBe(true);
    expect(window.api.saveProjects).toHaveBeenCalledTimes(1);

    unmountSection(root, container);
  });

  it('loads an inactive cowork project that is restored expanded', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-inactive', 0)],
    });
    useStandaloneChatStore.setState({ activeChatProjectId: 'cowork-target' });

    const { container, root } = await renderSection();

    expect(window.api.workEntries.list).toHaveBeenCalledWith({
      projectId: 'cowork-inactive',
    });

    unmountSection(root, container);
  });

  it('only highlights the selected worktree while the worktrees page is active', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('alpha', 'wt-main')],
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'alpha', worktreeId: 'wt-main' },
    });
    useNavigationStore.setState({ activePage: 'main' });

    const { container, root } = await renderSection();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="worktree-row"]',
    );

    expect(row).not.toBeNull();
    expect(row?.querySelector('[aria-label="Idle"]')).toBeNull();
    // Idle renders an invisible placeholder in the leading slot, never a dot.
    expect(
      row?.querySelector('[data-testid="worktree-idle-status-placeholder"]'),
    ).not.toBeNull();
    expect(row?.className).toContain('bg-muted');
    expect(row?.className).toContain('fg-primary');

    await act(async () => {
      useNavigationStore.getState().navigate('overview');
      await Promise.resolve();
    });

    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'alpha',
      worktreeId: 'wt-main',
    });
    expect(row?.className).not.toContain('bg-muted');
    expect(row?.className).toContain('hover:bg-subtle');

    unmountSection(root, container);
  });

  it('shows only a hover-revealed drag handle in the default-rest cowork status slot', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-default',
          title: 'New Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    const statusSlot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-default-status-slot"]',
    );

    // Mirrors the code-worktree trailing slot: an EMPTY status slot is not
    // rendered at all, so it never steals title width.
    expect(statusSlot).toBeNull();
    const leadingSlot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-default-leading-slot"]',
    );
    expect(leadingSlot).not.toBeNull();
    expect(leadingSlot?.getAttribute('aria-hidden')).toBe('true');
    expect(leadingSlot?.children).toHaveLength(0);
    expect(leadingSlot?.className).toContain('h-5 w-5');
    const title = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-default"] p',
    );
    expect(title?.parentElement?.className).toContain('cursor-default');
    expect(title?.parentElement?.className).not.toContain('cursor-grab');
    expect(title?.parentElement?.className).not.toContain('cursor-grabbing');
    expect(title?.parentElement?.getAttribute('aria-roledescription')).toBe(
      'sortable',
    );
    expect(title?.parentElement?.className).toContain('group/sidebar-item');
    expect(title?.parentElement?.className).toContain('fg-secondary');
    expect(title?.className).not.toContain('fg-primary');
    expect(title?.className).not.toContain('fg-secondary');

    unmountSection(root, container);
  });

  it('rerenders only affected work-entry rows and the selected pinned copy', async () => {
    useProjectsStore.setState({
      projects: [
        {
          ...makeCoworkProject('cowork-target', 0),
          archiveRetentionDays: 7,
        },
      ],
    });
    useNavigationStore.setState({ activePage: 'chat' });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      activeWorkEntryId: 'entry-1',
      workEntries: ['entry-1', 'entry-2', 'entry-3'].map((id) => ({
        id,
        title: id,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastMessageAt: '2026-01-01T00:01:00.000Z',
        chatCount: 1,
      })),
    });
    const tooltipSpy = jest.spyOn(
      WorkEntryRemovalLabelsModule,
      'deleteRetentionTooltip',
    );
    const { container, root } = await renderSection();
    tooltipSpy.mockClear();

    act(() => {
      useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-2' });
    });

    // The previous and next in-flow rows update their selected styling, and
    // the pin host replaces its selected-row copy. Unaffected in-flow rows do
    // not rerender.
    expect(tooltipSpy).toHaveBeenCalledTimes(3);
    tooltipSpy.mockRestore();
    unmountSection(root, container);
  });

  it('suppresses trailing statuses on done cowork entries', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-done-unread',
          title: 'Done but unread',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
          status: 'done',
          unreadChats: [{ chatId: 'chat-x', title: 'Unread chat' }],
        },
      ],
    });

    const { container, root } = await renderSection();
    // Done outranks everything: the checkmark leads and NO trailing status
    // (unread dot, spinner, question dot) renders.
    expect(
      container.querySelector(
        '[data-testid="sidebar-work-entry-entry-done-unread-done"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-work-entry-entry-done-unread-status-slot"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('shows the cowork spinner beside the single top-priority attention dot', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-both',
          title: 'Streaming and unread',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 2,
          hasActiveChat: true,
          unreadChats: [{ chatId: 'chat-u', title: 'Unread chat' }],
        },
        {
          id: 'entry-question',
          title: 'Question while streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 2,
          hasActiveChat: true,
          unreadChats: [{ chatId: 'chat-u2', title: 'Unread chat' }],
        },
      ],
    });
    useChatStore.setState({
      pendingQuestions: {
        'q-1': {
          requestId: 'q-1',
          projectId: 'cowork-target',
          worktreeId: 'entry-question',
          chatId: 'chat-q',
          questions: [],
        },
      },
    });

    const { container, root } = await renderSection();

    // Ported from the code-worktree rows: the working spinner coexists with
    // ONE attention dot (question orange > unread blue) instead of the old
    // one-at-a-time chain.
    const bothSlot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-both-status-slot"]',
    );
    expect(bothSlot).not.toBeNull();
    expect(
      bothSlot?.querySelector(
        '[data-testid="sidebar-work-entry-entry-both-thinking"]',
      ),
    ).not.toBeNull();
    expect(
      bothSlot?.querySelector(
        '[data-testid="sidebar-work-entry-entry-both-unread"]',
      ),
    ).not.toBeNull();

    const questionSlot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-question-status-slot"]',
    );
    expect(
      questionSlot?.querySelector(
        '[data-testid="sidebar-work-entry-entry-question-thinking"]',
      ),
    ).not.toBeNull();
    expect(
      questionSlot?.querySelector(
        '[data-testid="sidebar-work-entry-entry-question-question"]',
      ),
    ).not.toBeNull();
    // Needs-input outranks unread: the orange dot replaces the blue one.
    expect(
      questionSlot?.querySelector(
        '[data-testid="sidebar-work-entry-entry-question-unread"]',
      ),
    ).toBeNull();

    // Slot rhythm matches the two 24px rail buttons: w-6 slots, and the
    // cluster shifts exactly one rail width on hover so the dots line up
    // beside the buttons.
    expect(bothSlot?.className).toContain('-mr-0.5');
    expect(bothSlot?.className).toContain('pointer-fine:group-hover:mr-11.5');
    for (const child of Array.from(bothSlot?.children ?? [])) {
      // A rich-tooltip wrapper may sit between the slot and the sized glyph;
      // the 20x24 box is on whichever element actually paints it.
      const sized = (child as HTMLElement).className.includes('h-5 w-6')
        ? (child as HTMLElement)
        : child.querySelector('.h-5.w-6');
      expect(sized).not.toBeNull();
    }

    useChatStore.setState({ pendingQuestions: {} });
    unmountSection(root, container);
  });

  it('opens the work-entry menu on right-click, matching the ••• button', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-ctx',
          title: 'Context menu',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-ctx"]',
    );
    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 240,
          clientY: 180,
        }),
      );
      await Promise.resolve();
    });
    const popover = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-ctx-menu-popover"]',
    );
    expect(popover).not.toBeNull();
    // Anchored at the right-click point, not at the ••• button.
    expect(popover?.style.top).toBe('184px');
    expect(popover?.style.left).toBe('240px');

    unmountSection(root, container);
  });

  it('keeps focus on the work-entry ••• trigger and lists its commands in order', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-order',
          title: 'Menu order',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
          pinned: true,
          status: 'done',
        },
      ],
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-order-menu"]',
    );
    await act(async () => {
      menuButton?.focus();
      menuButton?.click();
      await Promise.resolve();
    });
    const popover = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-order-menu-popover"]',
    );
    expect(popover).not.toBeNull();
    expect(menuButton?.getAttribute('aria-expanded')).toBe('true');
    // The desktop menu surface leaves focus on its trigger.
    expect(document.activeElement).toBe(menuButton);
    const commands = Array.from(
      popover?.querySelectorAll<HTMLElement>('[data-testid]') ?? [],
    )
      .map((node) => node.getAttribute('data-testid') ?? '')
      .filter((testId) =>
        /-(toggle-pin|rename|toggle-done|invite|archive|delete)$/.test(testId),
      );
    expect(commands).toEqual([
      'sidebar-work-entry-entry-order-toggle-pin',
      'sidebar-work-entry-entry-order-rename',
      'sidebar-work-entry-entry-order-toggle-done',
      'sidebar-work-entry-entry-order-invite',
      'sidebar-work-entry-entry-order-archive',
      'sidebar-work-entry-entry-order-delete',
    ]);
    // Labels follow the entry's pin and done state.
    expect(popover?.textContent).toContain('Unpin');
    expect(popover?.textContent).toContain('Mark active');
    expect(
      popover
        ?.querySelector(
          '[data-testid="sidebar-work-entry-entry-order-archive"]',
        )
        ?.getAttribute('title'),
    ).toBe(WorkEntryRemovalLabelsModule.ARCHIVE_TOOLTIP);

    // Pressing the trigger again closes the menu.
    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="sidebar-work-entry-entry-order-menu-popover"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('adds the bulk selection to a work-entry menu, or replaces it for a selection of 2 or more', async () => {
    const item = makeCoworkProject('cowork-target', 0);
    useProjectsStore.setState({ projects: [item] });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'e1',
          title: 'Selectable',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });
    installWindowApi();
    const onRowsChange = jest.fn();
    const binding = (replacesMenu: boolean): WorkEntryMultiSelectBinding => ({
      selection: {
        keys: new Set(),
        kind: undefined,
        active: false,
        count: 0,
        isSelected: () => false,
        toggle: jest.fn(),
        selectRange: jest.fn(),
        selectAllInList: jest.fn(),
        clear: jest.fn(),
        replace: jest.fn(),
      },
      onRowsChange,
      escapeClears: true,
      isRemoving: () => false,
      rowMenuFor: () => undefined,
      menuItemsFor: (_key, testIds) => ({
        items: [
          {
            key: replacesMenu ? 'bulk-archive' : 'toggle-selection',
            label: replacesMenu ? 'Archive 2 chats' : 'Select',
            onSelect: jest.fn(),
            icon: 'archive',
            testId: replacesMenu
              ? testIds?.bulkArchive
              : testIds?.toggleSelection,
          },
        ],
        replacesMenu,
      }),
      isSelectable: () => true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (replacesMenu: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            {item.type === 'cowork' ? (
              <SidebarCoworkWorkspaceRow
                item={item}
                disableDrag
                workEntryMultiSelect={binding(replacesMenu)}
              />
            ) : null}
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
    };
    const openMenu = async (): Promise<HTMLElement | null> => {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-e1-menu"]',
          )
          ?.click();
        await Promise.resolve();
      });
      return document.querySelector<HTMLElement>(
        '[data-testid="sidebar-work-entry-e1-menu-popover"]',
      );
    };

    await render(false);
    expect(
      container
        .querySelector('[data-testid="sidebar-work-entry-e1"]')
        ?.hasAttribute('data-worktree-selection-row'),
    ).toBe(true);
    expect(onRowsChange).toHaveBeenLastCalledWith(
      new Map([
        [
          'cowork-target',
          [
            expect.objectContaining({
              key: 'work-entry:cowork-target/e1',
              kind: 'work-entry',
              selectable: true,
            }),
          ],
        ],
      ]),
    );
    let popover = await openMenu();
    expect(
      popover?.querySelector(
        '[data-testid="sidebar-work-entry-e1-toggle-selection"]',
      ),
    ).not.toBeNull();
    expect(
      popover?.querySelector('[data-testid="sidebar-work-entry-e1-rename"]'),
    ).not.toBeNull();
    await openMenu();

    await render(true);
    popover = await openMenu();
    expect(
      popover?.querySelector(
        '[data-testid="sidebar-work-entry-e1-bulk-archive"]',
      ),
    ).not.toBeNull();
    expect(
      popover?.querySelector('[data-testid="sidebar-work-entry-e1-rename"]'),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('previews the unread chats while the work-entry unread dot is hovered', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-preview',
          title: 'Preview',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
          unreadChats: [
            {
              chatId: 'chat-preview',
              title: 'Latest reply',
              preview: 'Here is the summary.',
            },
          ],
        },
      ],
    });

    const { container, root } = await renderSection();
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-preview-unread"]',
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-preview"]',
    );
    expect(dot).not.toBeNull();
    await act(async () => {
      dot?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Unread Chats');
    expect(document.body.textContent).toContain('Latest reply');
    expect(document.body.textContent).toContain('Here is the summary.');

    // The open preview is a snapshot: a background list refresh that
    // replaces the entry does not rewrite it under the pointer.
    await act(async () => {
      useStandaloneChatStore.setState({
        workEntries: [
          {
            id: 'entry-preview',
            title: 'Preview',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:02:00.000Z',
            chatCount: 1,
            unreadChats: [
              {
                chatId: 'chat-preview',
                title: 'Latest reply',
                preview: 'A newer summary.',
              },
            ],
          },
        ],
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Here is the summary.');
    expect(document.body.textContent).not.toContain('A newer summary.');

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('Here is the summary.');

    unmountSection(root, container);
  });

  it('keeps an empty draft out of the sidebar until its first message', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    const draft = {
      id: 'entry-draft',
      title: 'New Chat',
      createdAt: '2026-01-01T00:00:00.000Z',
      chatCount: 1,
    };
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [draft],
    });

    const { container, root } = await renderSection();

    expect(
      container.querySelector('[data-testid="sidebar-work-entry-entry-draft"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('No chats');

    await act(async () => {
      useStandaloneChatStore.setState({
        workEntries: [
          {
            ...draft,
            lastMessageAt: '2026-01-01T00:01:00.000Z',
          },
        ],
      });
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="sidebar-work-entry-entry-draft"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('No chats');

    unmountSection(root, container);
  });

  it('links a cowork project to its Archived and deleted overview instead of listing rows inline', async () => {
    const projectId = 'archive-stability';
    const archivedEntry = makeArchivedCoworkEntry('locked-entry', projectId);
    useProjectsStore.setState({
      projects: [makeCoworkProject(projectId, 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      sidebarEntriesByProject: { [projectId]: [] },
      legacyArchivedByProject: { [projectId]: [] },
    });
    useArchivedContainersStore.setState({
      byWorkspace: { [projectId]: [archivedEntry] },
      loadedWorkspaces: { [projectId]: true },
    });

    const { container, root } = await renderSection();
    const link = container.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar-cowork-project-${projectId}-archived-link"]`,
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('Archived and deleted 1');
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${projectId}-archived-toggle"]`,
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="archived-entry-row-locked-entry"]',
      ),
    ).toBeNull();

    // A refresh that momentarily empties the list keeps the link mounted
    // via the retained count once data lands again.
    await act(async () => {
      useArchivedContainersStore.setState({
        byWorkspace: { [projectId]: [] },
        loadedWorkspaces: { [projectId]: true },
        loadingWorkspaces: { [projectId]: true },
      });
      await Promise.resolve();
    });
    await act(async () => {
      useArchivedContainersStore.setState({
        byWorkspace: { [projectId]: [archivedEntry] },
        loadedWorkspaces: { [projectId]: true },
        loadingWorkspaces: {},
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${projectId}-archived-link"]`,
      )?.textContent,
    ).toBe('Archived and deleted 1');

    unmountSection(root, container);
  });

  it('reserves the combined cowork status and action rail for long unread titles', async () => {
    const longTitle = 'Daily Checklist For Healthy Work Day Habits';
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-unread',
          title: longTitle,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
          unreadChats: [{ chatId: 'chat-unread', title: 'Unread chat' }],
        },
      ],
    });

    const { container, root } = await renderSection();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-unread"]',
    );
    const title = row?.querySelector<HTMLElement>('p');
    const status = row?.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-unread-status-slot"]',
    );
    const actionRail = row
      ?.querySelector(
        '[data-testid="sidebar-work-entry-entry-unread-delete-button"]',
      )
      ?.closest<HTMLElement>('.absolute');

    expect(title?.textContent).toBe(longTitle);
    expect(title?.getAttribute('title')).toBe(longTitle);
    // Mirrors the code-worktree rows: the status dot is an in-flow trailing
    // slot (not an absolutely-positioned rail) that shifts left beside the
    // revealed hover actions instead of hiding under them; the slot's hover
    // margin carries the reserve, so the title does not pay it twice.
    expect(title?.className).not.toContain('pr-6');
    expect(title?.className).not.toContain('group-hover/sidebar-item:pr-12');
    expect(status?.className).toContain('h-5 ');
    expect(status?.className).toContain('pointer-fine:group-hover:mr-11.5');
    expect(status?.className).toContain(
      'pointer-fine:group-focus-within:mr-11.5',
    );
    expect(status?.className).not.toContain('pointer-fine:group-hover:hidden');
    expect(status?.closest('.absolute')).toBeNull();
    expect(actionRail?.className).toContain('right-1');
    expect(actionRail?.className).not.toContain('right-8');

    unmountSection(root, container);
  });

  it('shows a cowork entry with only live delegates as background work and blocks its removal', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-delegates',
          title: 'Delegating',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });
    // The entry's chat finished its own turn; only its delegates still run.
    useDelegationActivityStore.getState().applyActivity({
      projectId: 'cowork-target',
      worktreeId: 'entry-delegates',
      chatId: 'chat-root',
      live: 1,
      queued: 0,
    });
    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'cowork-target',
      worktreeId: 'entry-delegates',
      chatId: 'chat-root',
      sessionActive: true,
      liveTasks: [{ taskId: 'provider-task', taskType: 'local_agent' }],
    });

    const { container, root } = await renderSection();
    try {
      // A running turn would draw the accent spinner; background work alone
      // draws the neutral one, counting the delegate and the provider task.
      expect(
        container.querySelector(
          '[data-testid="sidebar-work-entry-entry-delegates-thinking"]',
        ),
      ).toBeNull();
      expect(
        container
          .querySelector(
            '[data-testid="sidebar-work-entry-entry-delegates-background"]',
          )
          ?.getAttribute('aria-label'),
      ).toBe('2 background tasks running');
      const deleteButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-work-entry-entry-delegates-delete-button"]',
      );
      expect(deleteButton?.disabled).toBe(true);
      // The disabled hover Delete explains itself in its tooltip.
      act(() => {
        deleteButton?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Delegates are still running here. Stop them first.',
      );

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-delegates-menu"]',
          )
          ?.click();
        await Promise.resolve();
      });
      const archiveItem = document.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-work-entry-entry-delegates-archive"]',
      );
      const deleteItem = document.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-work-entry-entry-delegates-delete"]',
      );
      expect(archiveItem?.disabled).toBe(true);
      expect(deleteItem?.disabled).toBe(true);
      expect(archiveItem?.title).toBe(
        'Delegates are still running here. Stop them first.',
      );
      expect(deleteItem?.title).toBe(
        'Delegates are still running here. Stop them first.',
      );

      // Delegates finished: removal is available again.
      await act(async () => {
        useDelegationActivityStore.getState().applyActivity({
          projectId: 'cowork-target',
          worktreeId: 'entry-delegates',
          chatId: 'chat-root',
          live: 0,
          queued: 0,
        });
        useLiveBackgroundTaskStore.getState().applyPush({
          projectId: 'cowork-target',
          worktreeId: 'entry-delegates',
          chatId: 'chat-root',
          sessionActive: false,
          liveTasks: [],
        });
        await Promise.resolve();
      });
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-delegates-delete-button"]',
        )?.disabled,
      ).toBe(false);
      expect(
        container.querySelector(
          '[data-testid="sidebar-work-entry-entry-delegates-background"]',
        ),
      ).toBeNull();
    } finally {
      unmountSection(root, container);
      resetDelegationActivityStoreForTests();
    }
  });

  it.each(['local_agent', 'local_workflow'] as const)(
    'blocks cowork removal for live %s work and shows it as background work',
    async (taskType) => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'entry-background',
            title: 'Background work',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useLiveBackgroundTaskStore.getState().applyPush({
        projectId: 'cowork-target',
        worktreeId: 'entry-background',
        chatId: 'chat-root',
        sessionActive: true,
        liveTasks: [{ taskId: 'provider-task', taskType }],
      });

      const { container, root } = await renderSection();
      try {
        expect(
          container.querySelector(
            '[data-testid="sidebar-work-entry-entry-background-thinking"]',
          ),
        ).toBeNull();
        expect(
          container
            .querySelector(
              '[data-testid="sidebar-work-entry-entry-background-background"]',
            )
            ?.getAttribute('aria-label'),
        ).toBe('1 background task running');
        const deleteButton = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-background-delete-button"]',
        );
        expect(deleteButton?.disabled).toBe(true);
        act(() => {
          deleteButton?.parentElement?.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true }),
          );
        });
        expect(
          document.body.querySelector('[role="tooltip"]')?.textContent,
        ).toBe(
          'Background agents or workflows are still running here. Stop them first.',
        );

        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="sidebar-work-entry-entry-background-menu"]',
            )
            ?.click();
          await Promise.resolve();
        });
        const archiveItem = document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-background-archive"]',
        );
        const deleteItem = document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-background-delete"]',
        );
        expect(archiveItem?.disabled).toBe(true);
        expect(deleteItem?.disabled).toBe(true);
        expect(archiveItem?.title).toBe(
          'Background agents or workflows are still running here. Stop them first.',
        );
        expect(deleteItem?.title).toBe(
          'Background agents or workflows are still running here. Stop them first.',
        );
      } finally {
        unmountSection(root, container);
      }
    },
  );

  it('does not block cowork removal for shell-only provider work', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-shell',
          title: 'Shell work',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });
    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'cowork-target',
      worktreeId: 'entry-shell',
      chatId: 'chat-root',
      sessionActive: true,
      liveTasks: [{ taskId: 'shell-task', taskType: 'local_bash' }],
    });

    const { container, root } = await renderSection();
    try {
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-shell-delete-button"]',
        )?.disabled,
      ).toBe(false);
    } finally {
      unmountSection(root, container);
    }
  });

  it('re-checks an unvisited cowork entry before confirming removal', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    const deleteWorkEntry = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-unvisited',
          title: 'Unvisited entry',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
      deleteWorkEntry,
    });
    let resolveSnapshot:
      | ((snapshot: {
          chats: {
            'chat-root': {
              sessionActive: true;
              liveTasks: [{ taskId: string; taskType: 'local_agent' }];
            };
          };
        }) => void)
      | undefined;
    const listLiveBgTasks = jest.fn(
      () =>
        new Promise<{
          chats: {
            'chat-root': {
              sessionActive: true;
              liveTasks: [{ taskId: string; taskType: 'local_agent' }];
            };
          };
        }>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const { container, root } = await renderSection();
    const existingApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...existingApi,
        activity: { ...existingApi.activity, listLiveBgTasks },
      },
    });
    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-menu"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-delete"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(listLiveBgTasks).toHaveBeenCalledWith({
        projectId: 'cowork-target',
        worktreeId: 'entry-unvisited',
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-confirm-delete"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-unvisited-confirm-delete"]',
        )?.disabled,
      ).toBe(true);
      await act(async () => {
        resolveSnapshot?.({
          chats: {
            'chat-root': {
              sessionActive: true,
              liveTasks: [{ taskId: 'agent-task', taskType: 'local_agent' }],
            },
          },
        });
        await Promise.resolve();
      });

      expect(deleteWorkEntry).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        'Background agents or workflows are still running here. Stop them first.',
      );
    } finally {
      unmountSection(root, container);
    }
  });

  it('does not remove a cowork entry when its confirmation is cancelled during the re-check', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    const deleteWorkEntry = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-unvisited',
          title: 'Unvisited entry',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
      deleteWorkEntry,
    });
    let resolveSnapshot:
      | ((snapshot: { chats: Record<string, never> }) => void)
      | undefined;
    const listLiveBgTasks = jest.fn(
      () =>
        new Promise<{ chats: Record<string, never> }>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const { container, root } = await renderSection();
    const existingApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...existingApi,
        activity: { ...existingApi.activity, listLiveBgTasks },
      },
    });
    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-menu"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-delete"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-unvisited-confirm-delete"]',
          )
          ?.click();
        await Promise.resolve();
      });
      // The shared confirmation's Cancel (its esc chip is part of its text).
      const cancel =
        document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-unvisited-delete-dialog"] [data-testid="confirm-dialog-cancel"]',
        ) ?? undefined;
      expect(cancel).toBeDefined();
      // The chat title is masked in session replay.
      expect(
        document.querySelector(
          '[data-testid="sidebar-work-entry-entry-unvisited-delete-dialog"] h2 .ph-mask',
        )?.textContent,
      ).toBe('Unvisited entry');
      await act(async () => {
        cancel?.click();
        await Promise.resolve();
      });
      // The idle snapshot arrives after the user already backed out.
      await act(async () => {
        resolveSnapshot?.({ chats: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(deleteWorkEntry).not.toHaveBeenCalled();
    } finally {
      unmountSection(root, container);
    }
  });

  it('reserves the cowork status/action rail only when it is visible', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-menu',
          title: 'New Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-menu-menu"]',
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-menu"]',
    );
    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-menu-delete-button"]',
    );
    const icon = menuButton?.querySelector('svg');

    expect(row?.className).toContain('h-8');
    expect(row?.className).toContain('px-1.5');
    expect(row?.className).not.toContain('pl-');
    expect(row?.className).not.toContain('pr-');
    expect(menuButton?.getAttribute('aria-label')).toBe('More actions');
    expect(menuButton?.getAttribute('aria-haspopup')).toBe('menu');
    // The quick-access chip is always Delete (trash); Archive lives in the
    // menu only.
    expect(deleteButton?.getAttribute('aria-label')).toBe('Delete');
    await act(async () => {
      focusViaKeyboard(deleteButton);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Delete',
    );
    expect(row?.querySelector('span.w-12')).toBeNull();
    expect(row?.querySelector('p')?.className).toContain(
      'group-hover/sidebar-item:pr-12',
    );
    expect(row?.querySelector('p')?.className).not.toContain('pr-6');
    expect(menuButton?.className).toContain('h-6');
    expect(menuButton?.className).toContain('w-6');
    expect(menuButton?.className).toContain('rounded-md');
    expect(menuButton?.parentElement?.parentElement?.className).toContain(
      'group-hover/sidebar-item:opacity-100',
    );
    expect(menuButton?.parentElement?.parentElement?.className).toContain(
      'pointer-events-none',
    );
    // The sidebar's one ••• glyph size, header or row.
    expect(icon?.style.width).toBe('14px');
    expect(icon?.style.height).toBe('14px');

    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="sidebar-work-entry-entry-menu-delete-dialog"]',
      ),
    ).not.toBeNull();

    // The shared confirmation's Cancel (its esc chip is part of its text).
    const cancelButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-menu-delete-dialog"] [data-testid="confirm-dialog-cancel"]',
    );
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      cancelButton?.click();
      menuButton?.click();
      await Promise.resolve();
    });
    const renameMenuItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-menu-rename"]',
    );
    const deleteMenuItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-menu-delete"]',
    );
    expect(
      renameMenuItem?.querySelector('[data-app-icon="true"]'),
    ).not.toBeNull();
    expect(
      deleteMenuItem?.querySelector('[data-app-icon="true"]'),
    ).not.toBeNull();

    await act(async () => {
      renameMenuItem?.click();
      await Promise.resolve();
    });
    const renameDialog = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-menu-rename-dialog"]',
    );
    const renameInput = renameDialog?.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-work-entry-entry-menu-rename-input"]',
    );
    expect(renameDialog).not.toBeNull();
    expect(renameInput?.value).toBe('New Chat');
    if (renameInput) {
      await act(async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        );
        if (descriptor?.set === undefined) {
          throw new Error('Expected the input value setter');
        }
        descriptor.set.call(renameInput, '');
        renameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
    }
    const renameSubmit = renameDialog?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(renameSubmit?.disabled).toBe(false);
    expect(
      container.querySelector(
        '[data-testid="sidebar-work-entry-entry-menu-rename-input"]',
      ),
    ).toBeNull();

    unmountSection(root, container);
  });

  it('toggles a cowork work entry between done and active from its menu', async () => {
    const setWorkEntryStatus = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      setWorkEntryStatus,
      workEntries: [
        {
          id: 'entry-done',
          title: 'SUP-412 Refund flow',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-done"]',
    );
    expect(row?.getAttribute('data-entry-status')).toBe('active');
    expect(
      container.querySelector(
        '[data-testid="sidebar-work-entry-entry-done-done"]',
      ),
    ).toBeNull();

    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-done-menu"]',
    );
    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });
    const toggleItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-done-toggle-done"]',
    );
    expect(toggleItem?.textContent).toContain('Mark done');

    await act(async () => {
      toggleItem?.click();
      await Promise.resolve();
    });
    expect(setWorkEntryStatus).toHaveBeenCalledWith(
      'entry-done',
      'done',
      'cowork-target',
    );

    // A done entry renders the success check in the status slot, dims its
    // title, and flips the menu item to the inverse action.
    await act(async () => {
      useStandaloneChatStore.setState({
        workEntries: [
          {
            id: 'entry-done',
            title: 'SUP-412 Refund flow',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
            status: 'done',
          },
        ],
      });
      await Promise.resolve();
    });

    const doneRow = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-done"]',
    );
    expect(doneRow?.getAttribute('data-entry-status')).toBe('done');
    const doneGlyph = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-done-done"]',
    );
    expect(doneGlyph).not.toBeNull();
    expect(doneGlyph?.getAttribute('aria-label')).toBe('Done');
    // Same done vocabulary as a code worktree row: the shared Done status
    // glyph (the green circled check) in the LEADING slot, no title dimming.
    expect(
      doneGlyph?.querySelector('[data-status-glyph="done"]')?.className,
    ).toContain('fg-success-strong');
    expect(
      doneGlyph?.closest(
        '[data-testid="sidebar-work-entry-entry-done-leading-slot"]',
      ),
    ).not.toBeNull();
    expect(
      doneGlyph?.querySelector(
        '[data-app-icon="true"][data-glyph="circle-check"]',
      ),
    ).not.toBeNull();
    expect(doneRow?.querySelector('p')?.className).not.toContain('opacity-70');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-done-menu"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const activeItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-work-entry-entry-done-toggle-done"]',
    );
    expect(activeItem?.textContent).toContain('Mark active');
    await act(async () => {
      activeItem?.click();
      await Promise.resolve();
    });
    expect(setWorkEntryStatus).toHaveBeenLastCalledWith(
      'entry-done',
      'active',
      'cowork-target',
    );

    unmountSection(root, container);
  });

  it('sizes the cowork work entry menu to the shared sidebar menu width', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-target', 0)],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'cowork-target',
      workEntries: [
        {
          id: 'entry-width',
          title: 'SUP-412 Refund flow',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        },
      ],
    });

    const { container, root } = await renderSection();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-width-menu"]',
        )
        ?.click();
      await Promise.resolve();
    });

    const popover = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-work-entry-entry-width-menu-popover"]',
    );
    expect(popover).not.toBeNull();
    const classes = popover?.className.split(/\s+/) ?? [];
    // Every sidebar menu shares one fixed 180px width. 160px (w-40) wrapped
    // "Invite a teammate" onto a second line inside the h-8 rows; 180px fits
    // the longest label with room to spare.
    expect(classes).not.toContain('w-40');
    expect(classes).toContain('w-45');
    expect(classes).not.toContain('w-max');

    unmountSection(root, container);
  });

  it('requests worktree action modals without changing the active page', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('alpha', 'wt-main')],
    });
    useNavigationStore.setState({
      activePage: 'usage',
      pendingDispatchPipeline: undefined,
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-button"]',
    );

    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });

    const dispatchItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-dispatch-pipeline"]',
    );
    await act(async () => {
      dispatchItem?.click();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingDispatchPipeline).toEqual({
      projectId: 'alpha',
      worktreeId: 'wt-main',
    });
    expect(useNavigationStore.getState().activePage).toBe('usage');

    unmountSection(root, container);
  });

  it('warns before branching from a worktree with uncommitted changes', async () => {
    const createWorktree = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('alpha', 'wt-main')],
      uncommittedChanges: { 'alpha/wt-main': true },
      createWorktree,
      refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(true),
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-button"]',
    );
    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });

    const branchItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-create-branch"]',
    );
    await act(async () => {
      branchItem?.click();
      await Promise.resolve();
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(useBranchFromStore.getState().pending).toMatchObject({
      projectId: 'alpha',
      worktreeId: 'wt-main',
    });

    await act(async () => {
      useBranchFromStore.getState().resolveConfirmation('do-not-commit');
      await Promise.resolve();
    });

    expect(createWorktree).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        baseWorktreeId: 'wt-main',
        select: false,
      }),
    );

    unmountSection(root, container);
  });

  it('requests worktree deletion without changing the active page', async () => {
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree('alpha', 'wt-main')],
    });
    useNavigationStore.setState({
      activePage: 'usage',
      pendingArchiveWorktree: undefined,
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-button"]',
    );

    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });

    const deleteItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-delete"]',
    );
    await act(async () => {
      deleteItem?.click();
      await Promise.resolve();
    });

    const confirmDialog =
      document.querySelector<HTMLElement>('[role="dialog"]');
    // Delete keeps the worktree for the retention window; its dialog commits
    // through Preserve local or Delete local (Archive has its own menu item
    // and dialog).
    expect(confirmDialog?.textContent).toContain(
      'Delete worktree “feature/sidebar-active-state”?',
    );
    const preserveBranchItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-removal-preserve-branch"]',
    );
    await act(async () => {
      preserveBranchItem?.click();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingArchiveWorktree).toEqual({
      projectId: 'alpha',
      worktreeId: 'wt-main',
      deleteBranch: false,
      expectedBranchName: 'feature/sidebar-active-state',
      lockAfterArchive: undefined,
      deleteWithoutRetentionIfMissing: true,
    });
    expect(useNavigationStore.getState().activePage).toBe('usage');

    unmountSection(root, container);
  });

  it('disables worktree removal while an originating plan-explore session is active', async () => {
    const projectId = 'alpha';
    const worktreeId = 'wt-main';
    const worktreeKey = `${projectId}/${worktreeId}`;
    const plan = makeTrackedPlan(projectId, worktreeId);
    useProjectsStore.setState({
      projects: [makeProjectWithWorktree(projectId, worktreeId)],
    });
    useActivityStore.setState({ trackedPlans: { [worktreeKey]: [plan] } });
    useChatStore.setState({
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/${plan.id}`]: {
          activeTabId: 'plan-chat-1',
          tabs: [makeChatTab('plan-chat-1')],
        },
      },
    });

    const { container, root } = await renderSection();
    const menuButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-button"]',
    );

    await act(async () => {
      menuButton?.click();
      await Promise.resolve();
    });

    const archiveItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-actions-menu-archive"]',
    );
    expect(archiveItem?.disabled).toBe(true);
    expect(archiveItem?.title).toContain('Stop all sessions');

    unmountSection(root, container);
  });

  it('collapses hidden-only optional projects into the hidden section', async () => {
    // A workspace with `alwaysShow: false` and only hidden worktrees partitions
    // into the "Hidden" group rather than the visible list. Moved
    // here from the WorktreeManager render suite when the in-page list was
    // relocated to the sidebar.
    const hiddenOnly: SidebarItem = {
      ...makeProject('hidden-only', 0),
      alwaysShow: false,
      collapsed: false,
      worktrees: [
        {
          id: 'wt-hidden',
          branchName: 'feature/hidden-only',
          createdAt: '2026-01-01T00:00:00.000Z',
          hidden: true,
        },
      ],
    };
    useProjectsStore.setState({ projects: [hiddenOnly] });

    const { container, root } = await renderSection();

    expect(
      container.querySelector('[data-testid="hidden-workspaces-section"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Hidden');
    // The hidden group is collapsed by default, so the workspace's worktree
    // branch is not rendered until expanded.
    expect(container.textContent).not.toContain('feature/hidden-only');

    unmountSection(root, container);
  });

  // Selected-item pinning (sticky-selected-item.ts): the section wires the
  // flow-row measurement mark and portals pinned header + row copies into the
  // pin hosts. The tests wrap the section in the AppSidebar shell shape
  // (`data-testid="app-sidebar"` root plus the bottom pin host AppSidebar
  // renders) so `findSelectedPinHosts` resolves like in the real sidebar.
  describe('selected-item pin portals', () => {
    async function renderSectionInSidebarShell(
      preserveSingleWorkspace = false,
    ): Promise<{
      container: HTMLElement;
      root: Root;
    }> {
      installWindowApi();
      const projects = useProjectsStore.getState().projects;
      if (projects.length === 1 && !preserveSingleWorkspace) {
        useProjectsStore.setState({
          projects: [...projects, makeProject('__pin-test-companion', 999)],
        });
      }
      const container = document.createElement('div');
      container.setAttribute('data-testid', 'app-sidebar');
      const bottomHost = document.createElement('div');
      bottomHost.setAttribute('data-sidebar-selected-pin-bottom', '');
      bottomHost.hidden = true;
      const bottomHeaderPart = document.createElement('div');
      bottomHeaderPart.setAttribute('data-sidebar-selected-pin-part', 'header');
      const bottomRowPart = document.createElement('div');
      bottomRowPart.setAttribute('data-sidebar-selected-pin-part', 'row');
      bottomHost.append(bottomHeaderPart, bottomRowPart);
      const sectionMount = document.createElement('div');
      container.append(sectionMount, bottomHost);
      document.body.appendChild(container);
      const root = createRoot(sectionMount);
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <SidebarWorkspacesSection
              stickyHeaderLead={
                <button data-testid="sidebar-more-stub" type="button">
                  More
                </button>
              }
            />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      return { container, root };
    }

    it('marks the selected worktree row and portals pinned copies into every host', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });

      const { container, root } = await renderSectionInSidebarShell();

      const markedRows = container.querySelectorAll(
        '[data-sidebar-selected-item]',
      );
      expect(markedRows).toHaveLength(1);
      expect(
        markedRows[0]?.querySelector('[data-testid="worktree-row"]'),
      ).not.toBeNull();

      const topHost = container.querySelector(
        '[data-sidebar-selected-pin-top]',
      );
      expect(topHost?.hasAttribute('hidden')).toBe(true);
      expect(
        topHost?.querySelector(
          '[data-testid="sidebar-project-sortable-header-alpha-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        topHost?.querySelector('[data-testid="worktree-row-pinned"]'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll(
          '[data-testid="worktree-actions-menu-button"]',
        ),
      ).toHaveLength(1);
      expect(
        topHost?.querySelector(
          '[data-testid="worktree-actions-menu-button-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-testid="worktree-row-action-chip"]'),
      ).toHaveLength(1);
      expect(
        topHost?.querySelector(
          '[data-testid="worktree-row-action-chip-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        topHost
          ?.querySelector('[data-testid="worktree-row-pinned"]')
          ?.className.includes('touch-none'),
      ).toBe(false);
      expect(topHost?.querySelector('[aria-label="Reorder alpha"]')).toBeNull();
      const bottomHost = container.querySelector(
        '[data-sidebar-selected-pin-bottom]',
      );
      expect(
        bottomHost?.querySelector(
          '[data-testid="sidebar-project-sortable-header-alpha-pin-bottom"]',
        ),
      ).not.toBeNull();
      expect(
        bottomHost?.querySelector('[data-testid="worktree-row-pinned"]'),
      ).not.toBeNull();
      expect(
        bottomHost?.querySelector('[aria-label="Reorder alpha"]'),
      ).toBeNull();
      expect(
        bottomHost?.querySelector(
          '[data-testid="worktree-actions-menu-button-pin-bottom"]',
        ),
      ).not.toBeNull();
      // Pinned copies never carry the flow measurement mark or the flow
      // row's automation id.
      expect(topHost?.querySelector('[data-sidebar-selected-item]')).toBeNull();
      expect(topHost?.querySelector('[data-testid="worktree-row"]')).toBeNull();

      // Pinned headers keep the full collapse affordance: the hover
      // icon→chevron disclosure swap AND the aria-expanded toggle, exactly
      // like flow/slot headers — a pinned header without the visible
      // affordance still toggles on click, silently flipping the collapse
      // state under the user.
      // Pinned copies suffix their fixed ids by surface (CAN-3127).
      for (const [host, surface] of [
        [topHost, 'pin-top'],
        [bottomHost, 'pin-bottom'],
      ] as const) {
        expect(
          host?.querySelector(
            `[data-testid="workspace-section-collapse-chevron-${surface}"]`,
          ),
        ).not.toBeNull();
        expect(
          host?.querySelector(
            '[data-testid="workspace-section-collapse-chevron"]',
          ),
        ).toBeNull();
        expect(host?.querySelector('button[aria-expanded]')).not.toBeNull();
      }

      unmountSection(root, container);
    });

    it('mounts the selected-row pin portals without a project header', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });
      const { container, root } = await renderSectionInSidebarShell(true);
      expect(
        container.querySelector('.sidebar-workspace-sticky-header'),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-sidebar-selected-pin-top] [data-testid="worktree-row-pinned"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-sidebar-selected-pin-bottom] [data-testid="worktree-row-pinned"]',
        ),
      ).not.toBeNull();
      unmountSection(root, container);
    });

    it('marks a shared code worktree row with the shared badge', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useSharedContainersStore.setState({
        sharedWorktrees: {
          [sharedWorktreeKey('alpha', 'calm-otter')]: {
            projectId: 'alpha',
            worktreeId: 'calm-otter',
            organizationId: 'org-1',
            containerId: 'container-1',
            revision: 1,
          },
        },
      });
      const { container, root } = await renderSectionInSidebarShell();

      const row = container.querySelector('[data-testid="worktree-row"]');
      expect(row).not.toBeNull();
      expect(
        row?.querySelector('[data-testid="worktree-row-shared-badge"]'),
      ).not.toBeNull();
      // Persistent metadata never claims the single leading slot.
      expect(
        row
          ?.querySelector('[data-testid="worktree-row-leading-slot"]')
          ?.querySelector('[data-testid="worktree-row-shared-badge"]'),
      ).toBeNull();
      // It sits on the title line now, not buried mid-subtitle after the PR
      // badge, so both row types read the same.
      expect(
        row
          ?.querySelector('[data-testid="worktree-row-subtitle"]')
          ?.querySelector('[data-testid="worktree-row-shared-badge"]'),
      ).toBeNull();

      unmountSection(root, container);
    });

    it('names the code worktree share entry "Share", with the share glyph', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="worktree-actions-menu-button"]',
          )
          ?.click();
        await Promise.resolve();
      });

      const item = document.querySelector<HTMLElement>(
        '[data-testid="worktree-actions-menu-invite"]',
      );
      expect(item).not.toBeNull();
      // The entry opens the dialog for all of sharing - inviting *and*
      // revoking - so it is named for that, not for the invite half, and it
      // carries the same glyph the row badge uses.
      expect(item?.textContent).toContain('Share');
      expect(item?.textContent).not.toContain('Invite a teammate');
      expect(item?.querySelector('svg')).not.toBeNull();

      unmountSection(root, container);
    });

    it('leaves an unshared code worktree row without the shared badge', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      const { container, root } = await renderSectionInSidebarShell();

      expect(
        container.querySelector('[data-testid="worktree-row-shared-badge"]'),
      ).toBeNull();

      unmountSection(root, container);
    });

    it('mounts one programmatic invite modal across flow and pinned code rows', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });
      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        expect(
          requestSharedContainerInvite({
            projectId: 'alpha',
            worktreeId: 'calm-otter',
            containerType: 'CODE_WORKTREE',
          }),
        ).toBe(true);
        await Promise.resolve();
      });

      expect(
        container.querySelectorAll(
          '[data-testid="shared-container-invite-modal-stub"]',
        ),
      ).toHaveLength(1);

      unmountSection(root, container);
    });

    it('replaces an open invite when App Advisor targets another code row', async () => {
      const project = makeProjectWithWorktree('alpha', 'first');
      project.worktrees.push({
        id: 'second',
        branchName: 'feature/second',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      useProjectsStore.setState({ projects: [project] });

      const { container, root } = await renderSectionInSidebarShell();
      await act(async () => {
        expect(
          requestSharedContainerInvite({
            projectId: 'alpha',
            worktreeId: 'first',
            containerType: 'CODE_WORKTREE',
          }),
        ).toBe(true);
        expect(
          requestSharedContainerInvite({
            projectId: 'alpha',
            worktreeId: 'second',
            containerType: 'CODE_WORKTREE',
          }),
        ).toBe(true);
        await Promise.resolve();
      });

      const modals = container.querySelectorAll(
        '[data-testid="shared-container-invite-modal-stub"]',
      );
      expect(modals).toHaveLength(1);
      expect(modals[0]?.textContent).toBe('second');

      unmountSection(root, container);
    });

    it('opens one branch-rename dialog when pinned copies share the selected worktree', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });

      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        useProjectsStore.getState().requestBranchRename('alpha', 'calm-otter');
        await Promise.resolve();
      });

      expect(document.querySelectorAll('#branch-info-calm-otter')).toHaveLength(
        1,
      );

      unmountSection(root, container);
    });

    it('opens one branch-info dialog when pinned copies share the selected worktree', async () => {
      useProjectsStore.setState({
        projects: [makeProjectWithWorktree('alpha', 'calm-otter')],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });

      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        useProjectsStore.getState().requestBranchInfo('alpha', 'calm-otter');
        await Promise.resolve();
      });

      expect(document.querySelectorAll('#branch-info-calm-otter')).toHaveLength(
        1,
      );

      unmountSection(root, container);
    });

    it('keeps the selected row stuck under its collapsed project header', async () => {
      useProjectsStore.setState({
        projects: [
          {
            ...makeProjectWithWorktree('alpha', 'calm-otter'),
            collapsed: true,
          },
        ],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'alpha', worktreeId: 'calm-otter' },
      });
      useNavigationStore.setState({ activePage: 'main' });

      const { container, root } = await renderSectionInSidebarShell();

      // The collapsed workspace renders exactly its selected row, directly
      // under the header, still carrying the measurement mark — so both the
      // in-flow "stuck under the project" treatment and the pinned copies
      // survive a collapse.
      const collapsedSelected = container.querySelector(
        '[data-testid="sidebar-project-alpha-collapsed-selected"]',
      );
      expect(collapsedSelected).not.toBeNull();
      expect(
        collapsedSelected?.querySelector('[data-testid="worktree-row"]'),
      ).not.toBeNull();
      expect(
        collapsedSelected
          ?.querySelector('[data-testid="worktree-row"]')
          ?.className.includes('touch-none'),
      ).toBe(false);
      expect(
        collapsedSelected
          ?.querySelector('[data-testid="worktree-row"]')
          ?.className.includes('cursor-default'),
      ).toBe(true);
      expect(
        collapsedSelected
          ?.querySelector('[data-testid="worktree-row"]')
          ?.className.includes('select-none'),
      ).toBe(true);
      expect(
        container.querySelectorAll('[data-sidebar-selected-item]'),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll('[data-testid="worktree-row"]'),
      ).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="worktree-row-pinned"]'),
      ).not.toBeNull();
      expect(mockUseSortableRegistration).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'calm-otter' }),
      );
      expect(mockUseSortableRegistration).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'selected-pin-calm-otter' }),
      );

      unmountSection(root, container);
    });

    it('does not render collapsed rows for unselected worktrees', async () => {
      useProjectsStore.setState({
        projects: [
          {
            ...makeProjectWithWorktree('alpha', 'calm-otter'),
            collapsed: true,
          },
        ],
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'beta', worktreeId: 'other' },
      });
      useNavigationStore.setState({ activePage: 'main' });

      const { container, root } = await renderSectionInSidebarShell();

      expect(
        container.querySelector(
          '[data-testid="sidebar-project-alpha-collapsed-selected"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="worktree-row"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="worktree-row-pinned"]'),
      ).toBeNull();

      unmountSection(root, container);
    });

    it('keeps the active work entry stuck under its collapsed cowork header', async () => {
      useProjectsStore.setState({
        projects: [
          { ...makeCoworkProject('cowork-target', 0), collapsed: true },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Pinned entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useNavigationStore.setState({ activePage: 'chat' });

      const { container, root } = await renderSectionInSidebarShell();

      const collapsedSelected = container.querySelector(
        '[data-testid="sidebar-cowork-project-cowork-target-collapsed-selected"]',
      );
      expect(collapsedSelected).not.toBeNull();
      expect(
        collapsedSelected?.querySelector(
          '[data-testid="sidebar-work-entry-entry-1"]',
        ),
      ).not.toBeNull();
      expect(
        collapsedSelected
          ?.querySelector('[data-testid="sidebar-work-entry-entry-1"]')
          ?.className.includes('touch-none'),
      ).toBe(false);
      expect(
        container.querySelectorAll('[data-sidebar-selected-item]'),
      ).toHaveLength(1);
      expect(
        container.querySelector(
          '[data-testid="sidebar-work-entry-entry-1-pin-top"]',
        ),
      ).not.toBeNull();
      expect(mockUseSortableRegistration).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'entry-1' }),
      );
      expect(mockUseSortableRegistration).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'selected-pin-entry-1' }),
      );

      unmountSection(root, container);
    });

    it('portals pinned copies for the active cowork work entry', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Pinned entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useSidebarItemGroupsStore.setState({
        byScope: {
          'workspace:cowork-target': [
            {
              id: 'grp-hidden',
              name: 'Group 1',
              color: 'neutral',
              collapsed: false,
              labelHidden: true,
              memberIds: ['entry-1'],
            },
          ],
        },
      });
      useNavigationStore.setState({ activePage: 'chat' });

      const { container, root } = await renderSectionInSidebarShell();

      const markedRows = container.querySelectorAll(
        '[data-sidebar-selected-item]',
      );
      expect(markedRows).toHaveLength(1);
      expect(markedRows[0]?.getAttribute('data-testid')).toBe(
        'sidebar-work-entry-entry-1',
      );

      const topHost = container.querySelector(
        '[data-sidebar-selected-pin-top]',
      );
      expect(
        topHost?.querySelector(
          '[data-testid="sidebar-item-group-header-frame-pin-top"]',
        ),
      ).toBeNull();
      expect(
        topHost?.querySelector(
          '[data-testid="sidebar-cowork-project-cowork-target-header-pin-top"]',
        ),
      ).not.toBeNull();
      // The cowork header's badge and disclosure swap suffix their fixed ids
      // on the pinned copy too (CAN-3127).
      for (const id of [
        'workspace-kind-badge',
        'workspace-icon-disclosure-swap',
        'workspace-section-collapse-chevron',
      ]) {
        expect(
          topHost?.querySelector(`[data-testid="${id}-pin-top"]`),
        ).not.toBeNull();
        expect(topHost?.querySelector(`[data-testid="${id}"]`)).toBeNull();
      }
      expect(
        topHost?.querySelector(
          '[data-testid="sidebar-work-entry-entry-1-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelectorAll(
          '[data-testid="sidebar-work-entry-entry-1-menu"]',
        ),
      ).toHaveLength(1);
      expect(
        topHost?.querySelector(
          '[data-testid="sidebar-work-entry-entry-1-menu-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        topHost
          ?.querySelector('[data-testid="sidebar-work-entry-entry-1-pin-top"]')
          ?.className.includes('touch-none'),
      ).toBe(false);
      const bottomHost = container.querySelector(
        '[data-sidebar-selected-pin-bottom]',
      );
      expect(
        bottomHost?.querySelector(
          '[data-testid="sidebar-item-group-header-frame-pin-bottom"]',
        ),
      ).toBeNull();
      expect(
        bottomHost?.querySelector(
          '[data-testid="sidebar-cowork-project-cowork-target-header-pin-bottom"]',
        ),
      ).not.toBeNull();
      expect(
        bottomHost?.querySelector(
          '[data-testid="sidebar-work-entry-entry-1-pin-bottom"]',
        ),
      ).not.toBeNull();
      expect(
        bottomHost?.querySelector(
          '[data-testid="sidebar-work-entry-entry-1-menu-pin-bottom"]',
        ),
      ).not.toBeNull();

      unmountSection(root, container);
      useSidebarItemGroupsStore.setState({ byScope: {} });
    });

    it('mounts cowork selected-row pin portals without a project header', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Pinned entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useNavigationStore.setState({ activePage: 'chat' });
      const { container, root } = await renderSectionInSidebarShell(true);
      expect(
        container.querySelector('.sidebar-workspace-sticky-header'),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-sidebar-selected-pin-top] [data-testid="sidebar-work-entry-entry-1-pin-top"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-sidebar-selected-pin-bottom] [data-testid="sidebar-work-entry-entry-1-pin-bottom"]',
        ),
      ).not.toBeNull();
      unmountSection(root, container);
    });

    it('marks a shared cowork work-entry row with the shared badge', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Shared entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      // Cowork keys as `(project id, work entry id)` in the same slots code
      // worktrees use.
      useSharedContainersStore.setState({
        sharedWorktrees: {
          [sharedWorktreeKey('cowork-target', 'entry-1')]: {
            projectId: 'cowork-target',
            worktreeId: 'entry-1',
            organizationId: 'org-1',
            containerId: 'container-2',
            revision: 1,
          },
        },
      });
      useNavigationStore.setState({ activePage: 'chat' });
      const { container, root } = await renderSectionInSidebarShell();

      const entryRow = container.querySelector(
        '[data-testid="sidebar-work-entry-entry-1"]',
      );
      const badge = entryRow?.querySelector(
        '[data-testid="worktree-row-shared-badge"]',
      );
      expect(badge).not.toBeNull();
      // Same slot as the code-worktree row: last on the title line, after the
      // title and ahead of everything the row reveals on hover. This entry has
      // no trailing status, so anchor on elements that always render — a
      // status-slot-only assertion would pass vacuously here.
      const title = entryRow?.querySelector('p[title="Shared entry"]');
      const deleteButton = entryRow?.querySelector(
        '[data-testid="sidebar-work-entry-entry-1-delete-button"]',
      );
      expect(title).not.toBeNull();
      expect(deleteButton).not.toBeNull();
      if (badge && title && deleteButton) {
        expect(
          title.compareDocumentPosition(badge) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeGreaterThan(0);
        expect(
          badge.compareDocumentPosition(deleteButton) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeGreaterThan(0);
      }
      // ...and it fades under a fine pointer exactly like the code-worktree
      // row, because that slot is where the ••• and rail buttons appear.
      expect(badge?.className).toContain(
        'pointer-fine:group-hover/sidebar-item:opacity-0',
      );
      expect(badge?.className).toContain(
        'pointer-fine:group-focus-within/sidebar-item:opacity-0',
      );
      // Exactly one coarse-pointer action reserve on this line. The badge does
      // not fade on a coarse pointer, so it is the element that carries the
      // 46px — and the title has to give it up, or the two stack and truncate
      // the title ~94px early where ~46px is needed.
      expect(badge?.className).toContain('pointer-coarse:mr-11.5');
      expect(title?.className).not.toContain('pointer-coarse:pr-12');
      // The fine-pointer reserves stay on the title: there the badge fades out
      // instead of reserving, so the title still needs its own room.
      expect(title?.className).toContain('group-hover/sidebar-item:pr-12');

      unmountSection(root, container);
    });

    it('names the cowork share entry "Share" too, matching the code row', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Shared entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useNavigationStore.setState({ activePage: 'chat' });
      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-work-entry-entry-1-menu"]',
          )
          ?.click();
        await Promise.resolve();
      });

      const item = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-work-entry-entry-1-invite"]',
      );
      expect(item).not.toBeNull();
      // Identical label and glyph on both row types: the two menus must not
      // name the same destination differently.
      expect(item?.textContent).toContain('Share');
      expect(item?.textContent).not.toContain('Invite a teammate');
      expect(item?.querySelector('svg')).not.toBeNull();

      unmountSection(root, container);
    });

    it('mounts one programmatic invite modal across flow and pinned cowork rows', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'entry-1',
        workEntries: [
          {
            id: 'entry-1',
            title: 'Pinned entry',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastMessageAt: '2026-08-01T01:00:00.000Z',
            chatCount: 1,
          },
        ],
      });
      useNavigationStore.setState({ activePage: 'chat' });
      const { container, root } = await renderSectionInSidebarShell();

      await act(async () => {
        expect(
          requestSharedContainerInvite({
            projectId: 'cowork-target',
            worktreeId: 'entry-1',
            containerType: 'COWORK_WORK_ENTRY',
          }),
        ).toBe(true);
        await Promise.resolve();
      });

      expect(
        container.querySelectorAll(
          '[data-testid="shared-container-invite-modal-stub"]',
        ),
      ).toHaveLength(1);

      unmountSection(root, container);
    });
  });

  describe('default Chats workspace', () => {
    function stickySlotWorkspaceIds(container: HTMLElement): string[] {
      const hosts = container.querySelectorAll<HTMLElement>(
        '[data-sidebar-sticky-slot-workspace-id]',
      );
      return Array.from(hosts).map(
        (host) => host.dataset.sidebarStickySlotWorkspaceId ?? '',
      );
    }

    it('keeps the default cowork workspace out of the Projects list', async () => {
      // It renders in the top-level Chats section instead, so it must not be
      // a project row, a sortable, or a sticky-slot occupant here.
      useProjectsStore.setState({
        projects: [
          makeProjectWithWorktree('code-workspace', 'code-worktree'),
          makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID, 5),
        ],
      });

      const { container, root } = await renderSection();

      // It renders in the Chats section, which this component also hosts —
      // what matters is that it is not part of the Projects list.
      const projectRows = container.querySelector(
        '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
      );
      expect(projectRows).not.toBeNull();
      expect(
        projectRows?.querySelector(
          `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}"]`,
        ),
      ).toBeNull();
      expect(stickySlotWorkspaceIds(container)).toEqual(['code-workspace']);

      unmountSection(root, container);
    });

    it('marks exactly one Chats header for the rail sync to find', async () => {
      // The sync resolves the Chats header with a first-match
      // `querySelector`, so more than one element carrying the mark makes
      // correctness depend on render order. That held only by accident: the
      // real header renders before the project rows. Once the shared surface
      // owns the rail, document order changes and a stray mark would silently
      // rebind the sticky geometry to the wrong element — visible as subtly
      // wrong stickiness rather than an error.
      useProjectsStore.setState({
        projects: [
          makeProjectWithWorktree('code-workspace', 'code-worktree'),
          makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID, 5),
        ],
      });

      const { container, root } = await renderSection();

      expect(
        container.querySelectorAll('[data-sidebar-chats-header]'),
      ).toHaveLength(1);

      unmountSection(root, container);
    });

    it('keeps named cowork workspaces in the Projects list', async () => {
      useProjectsStore.setState({
        projects: [
          makeProjectWithWorktree('code-workspace', 'code-worktree'),
          makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID, 1),
          makeCoworkProject('cowork-research', 2),
        ],
      });

      const { container, root } = await renderSection();

      expect(
        container.querySelector(
          '[data-testid="sidebar-cowork-project-cowork-research-header"]',
        ),
      ).not.toBeNull();
      expect(stickySlotWorkspaceIds(container)).toEqual([
        'code-workspace',
        'cowork-research',
      ]);

      unmountSection(root, container);
    });

    it('ignores a hidden id for it and keeps it out of the Hidden group', async () => {
      // The workspace filter must never be able to take the catch-all bucket
      // away, and the recovered workspace still counts toward the header rule.
      useProjectsStore.setState({
        projects: [
          makeProjectWithWorktree('code-workspace', 'code-worktree'),
          makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID, 1),
        ],
        hiddenWorkspaceIds: [DEFAULT_COWORK_WORKSPACE_ID],
      });

      const { container, root } = await renderSection();

      expect(
        container.querySelector('[data-testid="hidden-workspaces-section"]'),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-project-sortable-header-code-workspace"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-sole-workspace-actions-code-workspace"]',
        ),
      ).toBeNull();

      unmountSection(root, container);
    });
  });

  // --- CAN-1074: recency + pinning ---------------------------------------
  it('limits projects in batches without unmounting a selected distant Code project', async () => {
    useProjectsStore.setState({
      projects: Array.from({ length: 25 }, (_, index) =>
        makeProject(`project-${index + 1}`, index),
      ),
    });
    const { container, root } = await renderSection();
    try {
      const ids = (): string[] =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-testid^="sidebar-project-sortable-header-"]',
          ),
        )
          .map((node) => node.dataset.testid ?? '')
          .filter((id) => !id.endsWith('-sticky-slot'));
      const click = (id: string): void => {
        const button = container.querySelector<HTMLButtonElement>(
          `[data-testid="${id}"]`,
        );
        expect(button).not.toBeNull();
        act(() => button?.click());
      };
      expect(ids()).toHaveLength(10);
      click('sidebar-projects-show-more');
      expect(ids()).toHaveLength(20);
      click('sidebar-projects-show-more');
      expect(ids()).toHaveLength(25);
      act(() => {
        useNavigationStore.setState({ activePage: 'main' });
        useChatStore.setState({
          selectedWorktree: { projectId: 'project-25', worktreeId: 'worktree' },
        });
      });
      click('sidebar-projects-show-less');
      expect(ids()).toHaveLength(11);
      expect(ids()).toContain('sidebar-project-sortable-header-project-25');
      act(() => {
        useChatStore.setState({ selectedWorktree: null });
        useArchivedContainersStore.setState({
          overview: { workspaceId: 'project-24' },
        });
      });
      expect(ids()).toHaveLength(11);
      expect(ids()).toContain('sidebar-project-sortable-header-project-24');
    } finally {
      unmountSection(root, container);
    }
  });

  it('retains the Home composer project after its newly added reveal signal expires', async () => {
    const projects = Array.from({ length: 25 }, (_, index) =>
      makeProject(`project-${index + 1}`, index),
    );
    useProjectsStore.setState({ projects, recentlyAddedProjectIds: new Set() });
    const { container, root } = await renderSection();
    try {
      act(() => {
        useNavigationStore.setState({ activePage: 'home' });
        useHomeComposerStore.setState({ workspaceId: 'new-project' });
        useProjectsStore.setState({
          projects: [...projects, makeProject('new-project', 25)],
          recentlyAddedProjectIds: new Set(['new-project']),
        });
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-project-sortable-header-new-project"]',
        ),
      ).not.toBeNull();
      act(() =>
        useProjectsStore.setState({ recentlyAddedProjectIds: new Set() }),
      );
      expect(
        container.querySelector(
          '[data-testid="sidebar-project-sortable-header-new-project"]',
        ),
      ).not.toBeNull();
      act(() => useHomeComposerStore.setState({ workspaceId: 'project-1' }));
      expect(
        container.querySelector(
          '[data-testid="sidebar-project-sortable-header-new-project"]',
        ),
      ).toBeNull();
    } finally {
      unmountSection(root, container);
      useProjectsStore.setState({ recentlyAddedProjectIds: new Set() });
    }
  });

  describe('recency and pinning', () => {
    function projectWithActivity(
      id: string,
      lastTouchedAt: string,
      pinned?: boolean,
    ): SingleRepoSidebarItem {
      return {
        ...makeProject(id, 0),
        collapsed: true,
        ...(pinned ? { pinned: true } : {}),
        worktrees: [
          {
            id: `${id}-wt`,
            branchName: `feature/${id}`,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastTouchedAt,
          },
        ],
      };
    }

    function renderedProjectOrder(container: HTMLElement): string[] {
      return (
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-testid^="sidebar-project-sortable-header-"]',
          ),
        )
          .map((node) =>
            (node.getAttribute('data-testid') ?? '').replace(
              'sidebar-project-sortable-header-',
              '',
            ),
          )
          // The sticky-slot copies mirror the in-flow rows; keep only the
          // in-flow sequence so the assertion reads as the visible order.
          .filter((id) => !id.endsWith('-sticky-slot'))
      );
    }

    /**
     * Visible top-level row order across BOTH workspace kinds: git sections
     * expose `sidebar-project-sortable-header-<id>`, cowork rows expose
     * `sidebar-cowork-project-<id>-header`.
     */
    function renderedWorkspaceOrder(container: HTMLElement): string[] {
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid^="sidebar-project-sortable-header-"], [data-testid^="sidebar-cowork-project-"][data-testid$="-header"]',
        ),
      )
        .map((node) =>
          (node.getAttribute('data-testid') ?? '')
            .replace('sidebar-project-sortable-header-', '')
            .replace('sidebar-cowork-project-', '')
            .replace(/-header$/, ''),
        )
        .filter((id) => !id.endsWith('-sticky-slot'));
    }

    it('orders workspaces by their newest worktree activity in last-updated mode', async () => {
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [
          projectWithActivity('stale', '2026-01-01T00:00:00.000Z'),
          projectWithActivity('freshest', '2026-09-01T00:00:00.000Z'),
          projectWithActivity('middling', '2026-05-01T00:00:00.000Z'),
        ],
      });

      const { container, root } = await renderSection();
      expect(renderedProjectOrder(container)).toEqual([
        'freshest',
        'middling',
        'stale',
      ]);

      unmountSection(root, container);
    });

    it('keeps the persisted order when the section is set to manual', async () => {
      useSidebarStore.setState({ projectSortMode: 'manual' });
      useProjectsStore.setState({
        projects: [
          projectWithActivity('stale', '2026-01-01T00:00:00.000Z'),
          projectWithActivity('freshest', '2026-09-01T00:00:00.000Z'),
          projectWithActivity('middling', '2026-05-01T00:00:00.000Z'),
        ],
      });

      const { container, root } = await renderSection();
      expect(renderedProjectOrder(container)).toEqual([
        'stale',
        'freshest',
        'middling',
      ]);

      unmountSection(root, container);
    });

    it('floats a pinned workspace above the recency-ordered list', async () => {
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [
          projectWithActivity('freshest', '2026-09-01T00:00:00.000Z'),
          projectWithActivity(
            'ancient-but-pinned',
            '2020-01-01T00:00:00.000Z',
            true,
          ),
        ],
      });

      const { container, root } = await renderSection();
      expect(renderedProjectOrder(container)[0]).toBe('ancient-but-pinned');

      unmountSection(root, container);
    });

    it('renders a pinned grouped child ahead of its unpinned parent', async () => {
      useProjectsStore.setState({
        projects: [
          {
            ...makeProject('grouped', 0),
            collapsed: false,
            itemSortMode: 'last-updated',
            worktrees: [
              {
                id: 'parent',
                branchName: 'feature/parent',
                createdAt: '2026-06-01T00:00:00.000Z',
              },
              {
                id: 'child',
                branchName: 'feature/child',
                createdAt: '2026-01-01T00:00:00.000Z',
                pinned: true,
                branchGroupingParentWorktreeId: 'parent',
              },
            ],
          },
        ],
        baseBranches: {
          'grouped/parent': 'main',
          'grouped/child': 'feature/parent',
        },
        defaultBranches: {
          'grouped/parent': 'main',
          'grouped/child': 'main',
        },
      });

      const { container, root } = await renderSection({
        preserveSingleWorkspace: true,
      });
      const rowOrder = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'),
      ).map((row) => row.dataset.worktreeId);

      expect(rowOrder).toEqual(['child', 'parent']);
      expect(
        container.querySelector(
          '[data-testid="worktree-branch-group-children"]',
        ),
      ).toBeNull();

      const childRow = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'),
      ).find((row) => row.dataset.worktreeId === 'child');
      await act(async () => {
        childRow
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="worktree-actions-menu-button"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(
        document.querySelector(
          '[data-testid="worktree-actions-menu-toggle-grouping"]',
        )?.textContent,
      ).toContain('Unstack from base');

      unmountSection(root, container);
    });

    it('keeps every pinned peer ahead of an unpinned grouped child', async () => {
      useProjectsStore.setState({
        projects: [
          {
            ...makeProject('grouped', 0),
            collapsed: false,
            itemSortMode: 'last-updated',
            worktrees: [
              {
                id: 'pinned-base',
                branchName: 'feature/base',
                createdAt: '2026-06-01T00:00:00.000Z',
                pinned: true,
              },
              {
                id: 'pinned-peer',
                branchName: 'feature/peer',
                createdAt: '2026-05-01T00:00:00.000Z',
                pinned: true,
              },
              {
                id: 'unpinned-child',
                branchName: 'feature/child',
                createdAt: '2026-07-01T00:00:00.000Z',
                branchGroupingParentWorktreeId: 'pinned-base',
              },
            ],
          },
        ],
        baseBranches: {
          'grouped/pinned-base': 'main',
          'grouped/pinned-peer': 'main',
          'grouped/unpinned-child': 'feature/base',
        },
        defaultBranches: {
          'grouped/pinned-base': 'main',
          'grouped/pinned-peer': 'main',
          'grouped/unpinned-child': 'main',
        },
      });

      const { container, root } = await renderSection({
        preserveSingleWorkspace: true,
      });
      const rowOrder = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'),
      ).map((row) => row.dataset.worktreeId);

      expect(rowOrder).toEqual([
        'pinned-base',
        'pinned-peer',
        'unpinned-child',
      ]);
      expect(
        container.querySelector('[data-child-worktree-id="unpinned-child"]'),
      ).toBeNull();

      unmountSection(root, container);
    });

    it('offers pin and sort controls in the workspace context menu', async () => {
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [projectWithActivity('alpha', '2026-09-01T00:00:00.000Z')],
      });

      const { container, root } = await renderSection();
      const header = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-project-header-alpha"]',
      );
      expect(header).not.toBeNull();
      await act(async () => {
        header?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });

      expect(
        document.querySelector('[data-testid="workspace-toggle-pin-menu-item"]')
          ?.textContent,
      ).toContain('Pin to top');
      expect(
        document.querySelector(
          '[data-testid="workspace-item-sort-last-updated"]',
        ),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="workspace-item-sort-manual"]'),
      ).not.toBeNull();

      unmountSection(root, container);
    });

    it('leads every sidebar item menu with Pin to top', async () => {
      useProjectsStore.setState({
        projects: [
          projectWithActivity('alpha', '2026-09-01T00:00:00.000Z'),
          makeCoworkProject('cowork-target', 1),
        ],
      });

      const { container, root } = await renderSection();

      // Code project row.
      const projectHeader = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-project-header-alpha"]',
      );
      await act(async () => {
        projectHeader?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      expectPinLeadsMenu(
        document.querySelector<HTMLElement>(
          '[data-testid="workspace-session-context-menu"]',
        ),
      );
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });

      // Cowork project row.
      const coworkOptions = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-options"]',
      );
      await act(async () => {
        coworkOptions?.click();
        await Promise.resolve();
      });
      expectPinLeadsMenu(
        document.querySelector<HTMLElement>(
          '[data-testid="workspace-session-context-menu"]',
        ),
      );

      unmountSection(root, container);
    });

    it('opens the code project options menu from a visible button', async () => {
      useProjectsStore.setState({
        projects: [projectWithActivity('alpha', '2026-09-01T00:00:00.000Z')],
      });

      const { container, root } = await renderSection();
      const optionsButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-project-options-button"]',
      );
      expect(optionsButton).not.toBeNull();

      await act(async () => {
        optionsButton?.click();
        await Promise.resolve();
      });

      expect(
        document.querySelector('[data-testid="workspace-toggle-pin-menu-item"]')
          ?.textContent,
      ).toContain('Pin to top');

      unmountSection(root, container);
    });

    it('opens the cowork project options menu from a visible button', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });

      const { container, root } = await renderSection();
      const optionsButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-cowork-project-cowork-target-options"]',
      );
      expect(optionsButton).not.toBeNull();

      await act(async () => {
        optionsButton?.click();
        await Promise.resolve();
      });

      expect(
        document.querySelector('[data-testid="workspace-toggle-pin-menu-item"]')
          ?.textContent,
      ).toContain('Pin to top');
      expect(
        document.querySelector('[data-testid="workspace-settings-menu-item"]'),
      ).not.toBeNull();

      unmountSection(root, container);
    });

    it('keeps work entries in manual order when the workspace has no sort mode', async () => {
      useProjectsStore.setState({
        projects: [
          { ...makeCoworkProject('cowork-target', 0), itemSortMode: undefined },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'quiet',
            title: 'Quiet',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-02T00:00:00.000Z',
            chatCount: 1,
          },
          {
            id: 'chatty',
            title: 'Chatty',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-06-02T00:00:00.000Z',
            chatCount: 1,
          },
        ],
      });

      const { container, root } = await renderSection();
      const order = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid^="sidebar-work-entry-"][data-testid$="-leading-slot"]',
        ),
      ).map((node) =>
        (node.getAttribute('data-testid') ?? '')
          .replace('sidebar-work-entry-', '')
          .replace('-leading-slot', ''),
      );
      expect(order).toEqual(['quiet', 'chatty']);

      unmountSection(root, container);
    });

    it('orders work entries by recency and pins above the tail', async () => {
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [
          {
            ...makeCoworkProject('cowork-target', 0),
            itemSortMode: 'last-updated',
          },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'quiet',
            title: 'Quiet',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-02T00:00:00.000Z',
            chatCount: 1,
          },
          {
            id: 'chatty',
            title: 'Chatty',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-06-02T00:00:00.000Z',
            chatCount: 1,
          },
          {
            id: 'pinned',
            title: 'Pinned',
            pinned: true,
            createdAt: '2020-01-01T00:00:00.000Z',
            lastMessageAt: '2020-01-02T00:00:00.000Z',
            chatCount: 1,
          },
        ],
      });

      const { container, root } = await renderSection();
      const order = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid^="sidebar-work-entry-"][data-testid$="-leading-slot"]',
        ),
      ).map((node) =>
        (node.getAttribute('data-testid') ?? '')
          .replace('sidebar-work-entry-', '')
          .replace('-leading-slot', ''),
      );
      expect(order).toEqual(['pinned', 'chatty', 'quiet']);

      unmountSection(root, container);
    });

    it('keeps a pinned empty work entry visible after leaving its workspace', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'another-workspace',
        sidebarEntriesByProject: {
          'cowork-target': [
            {
              id: 'empty-pinned',
              title: 'Pinned empty entry',
              pinned: true,
              createdAt: '2026-09-01T00:00:00.000Z',
              chatCount: 0,
            },
          ],
        },
      });

      const { container, root } = await renderSection();

      expect(
        container.querySelector(
          '[data-testid="sidebar-work-entry-empty-pinned"]',
        ),
      ).not.toBeNull();

      unmountSection(root, container);
    });

    it('leads the work entry menu with Pin to top', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'entry-order',
            title: 'Order me',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
          },
        ],
      });

      const { container, root } = await renderSection();
      const menuButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-work-entry-entry-order-menu"]',
      );
      await act(async () => {
        menuButton?.click();
        await Promise.resolve();
      });

      expectPinLeadsMenu(
        document.querySelector<HTMLElement>(
          '[data-testid="sidebar-work-entry-entry-order-menu-popover"]',
        ),
      );

      unmountSection(root, container);
    });

    it('shows an error toast when a work-entry pin write fails', async () => {
      const addToast = jest.fn();
      const setWorkEntryPinned = jest.fn(() =>
        Promise.reject(new Error('save failed')),
      );
      const originalAddToast = useGitHubStore.getState().addToast;
      useGitHubStore.setState({ addToast });
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'entry-failed',
            title: 'Pin me',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
          },
        ],
        setWorkEntryPinned,
      });

      const { container, root } = await renderSection();
      try {
        const menuButton = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-failed-menu"]',
        );
        expect(menuButton).not.toBeNull();
        await act(async () => {
          menuButton?.click();
          await Promise.resolve();
        });
        const togglePin = document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-work-entry-entry-failed-toggle-pin"]',
        );
        expect(togglePin).not.toBeNull();
        await act(async () => {
          togglePin?.click();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(setWorkEntryPinned).toHaveBeenCalledWith(
          'entry-failed',
          true,
          'cowork-target',
        );
        expect(addToast).toHaveBeenCalledWith('Failed to pin', 'error');
      } finally {
        useGitHubStore.setState({ addToast: originalAddToast });
        unmountSection(root, container);
      }
    });

    it('ranks the ACTIVE cowork workspace by its live work entries', async () => {
      // The active cowork project's entries live in `workEntries`, not in
      // `sidebarEntriesByProject` (see `getSidebarProjectEntries`). Reading
      // only the map would leave the workspace the user is chatting in with
      // no recency at all, pinning it to its manual slot.
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [
          projectWithActivity('stale-code', '2026-01-01T00:00:00.000Z'),
          { ...makeCoworkProject('active-cowork', 1), itemSortMode: undefined },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'active-cowork',
        workEntries: [
          {
            id: 'live',
            title: 'Live',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-09-01T00:00:00.000Z',
            chatCount: 1,
          },
        ],
      });

      const { container, root } = await renderSection();
      expect(renderedWorkspaceOrder(container)).toEqual([
        'active-cowork',
        'stale-code',
      ]);

      unmountSection(root, container);
    });

    it('drops work-entry drag sources while the section sorts by recency', async () => {
      useSidebarStore.setState({ projectSortMode: 'last-updated' });
      useProjectsStore.setState({
        projects: [
          {
            ...makeCoworkProject('cowork-target', 0),
            itemSortMode: 'last-updated',
          },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'entry-default',
            title: 'New Chat',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
          },
        ],
      });

      const { container, root } = await renderSection();
      const title = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-work-entry-entry-default"] p',
      );
      // Recency-ordered rows are not drag sources; only pinned rows and
      // manual-mode sections keep a sortable registration.
      expect(
        title?.parentElement?.getAttribute('aria-roledescription'),
      ).toBeNull();

      unmountSection(root, container);
    });

    it('allows membership drags in recency mode when Cowork has group destinations', async () => {
      useProjectsStore.setState({
        projects: [
          {
            ...makeCoworkProject('cowork-target', 0),
            itemSortMode: 'last-updated',
          },
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: ['a', 'b'].map((id) => ({
          id,
          title: id,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        })),
      });
      useSidebarItemGroupsStore.setState({
        byScope: {
          'workspace:cowork-target': [
            {
              id: 'grp-notes',
              name: 'Notes',
              collapsed: false,
              color: 'neutral',
              memberIds: ['a'],
            },
          ],
        },
      });
      const { container, root } = await renderSection();
      expect(
        container
          .querySelector('[data-testid="sidebar-work-entry-b"]')
          ?.getAttribute('aria-roledescription'),
      ).toBe('sortable');
      unmountSection(root, container);
      useSidebarItemGroupsStore.setState({ byScope: {} });
    });

    it('omits row and group drag bindings from a collapsed Cowork selected projection', async () => {
      useProjectsStore.setState({
        projects: [
          { ...makeCoworkProject('cowork-target', 0), collapsed: true },
          makeProject('other', 1),
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        activeWorkEntryId: 'a',
        workEntries: ['a', 'b'].map((id) => ({
          id,
          title: id,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-01T00:01:00.000Z',
          chatCount: 1,
        })),
      });
      useNavigationStore.setState({ activePage: 'chat' });
      useSidebarItemGroupsStore.setState({
        byScope: {
          'workspace:cowork-target': [
            {
              id: 'grp-notes',
              name: 'Notes',
              collapsed: false,
              color: 'neutral',
              memberIds: ['a', 'b'],
            },
          ],
        },
      });
      const { container, root } = await renderSection();
      const projection = container.querySelector(
        '[data-testid="sidebar-cowork-project-cowork-target-collapsed-selected"]',
      );
      expect(projection).not.toBeNull();
      expect(
        projection?.querySelector('[data-testid="sidebar-work-entry-a"]'),
      ).not.toBeNull();
      expect(
        projection?.querySelector('[aria-roledescription="sortable"]'),
      ).toBeNull();
      expect(
        projection?.querySelector('[data-sidebar-group-drag-source]'),
      ).toBeNull();
      expect(
        projection?.querySelector(
          '[data-testid="sidebar-item-group-drop-zone"]',
        ),
      ).toBeNull();
      unmountSection(root, container);
      useSidebarItemGroupsStore.setState({ byScope: {} });
    });

    it('keeps hidden member activity visible on a collapsed Cowork group', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-target', 0)],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: 'cowork-target',
        workEntries: [
          {
            id: 'a',
            title: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastMessageAt: '2026-01-01T00:01:00.000Z',
            chatCount: 1,
            hasActiveChat: true,
          },
        ],
      });
      useSidebarItemGroupsStore.setState({
        byScope: {
          'workspace:cowork-target': [
            {
              id: 'grp-notes',
              name: 'Notes',
              collapsed: true,
              color: 'neutral',
              memberIds: ['a'],
            },
          ],
        },
      });
      const { container, root } = await renderSection();
      expect(
        container.querySelector(
          '[data-sidebar-item-group-id="grp-notes"] [aria-label="Active work in group"]',
        ),
      ).not.toBeNull();
      unmountSection(root, container);
      useSidebarItemGroupsStore.setState({ byScope: {} });
    });
  });
});
