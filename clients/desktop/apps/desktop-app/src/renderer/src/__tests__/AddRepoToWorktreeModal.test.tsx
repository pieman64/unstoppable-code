/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AdhocExistingWorktreeCombineResponse,
  AdhocMultiRepoCombineResponse,
  AdhocMultiRepoJoinOption,
  ExistingWorktreeJoinWorkspaceGroup,
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { AddRepoToWorktreeModal } from '@/components/worktree/AddRepoToWorktreeModal';
import { switchContextForWorkspace } from '@/lib/contextScope';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/shared', () => ({
  DialogModal: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: ReactNode;
  }): JSX.Element => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

jest.mock('@/lib/contextScope', () => ({
  switchContextForWorkspace: jest.fn(),
}));

const switchContextMock = jest.mocked(switchContextForWorkspace);

const SOURCE_WORKSPACE_ID = 'source-workspace';
const SOURCE_WORKTREE_ID = 'feature-worktree';
const JOIN_WORKSPACE_ID = 'join-workspace';
const JOIN_WORKTREE_ID = 'join-worktree';

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: SOURCE_WORKTREE_ID,
    branchName: 'feature/add-repo',
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceWorkspace(): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: SOURCE_WORKSPACE_ID,
    name: 'Source Workspace',
    color: '#2563eb',
    repos: [
      { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
      { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
    ],
    worktrees: [makeWorktree()],
    collapsed: false,
    order: 0,
  };
}

function makeJoinWorkspace(): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: JOIN_WORKSPACE_ID,
    name: 'Join Workspace',
    repoPath: '/repos/join',
    color: '#16a34a',
    worktrees: [],
    collapsed: false,
    order: 1,
  };
}

function makeMultiRepoJoinWorkspace(
  overrides: Partial<MultiRepoSidebarItem> = {},
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: JOIN_WORKSPACE_ID,
    name: 'Join Workspace',
    color: '#16a34a',
    repos: [{ id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' }],
    worktrees: [],
    collapsed: false,
    order: 1,
    ...overrides,
  };
}

function makeCombineResponse(): AdhocMultiRepoCombineResponse {
  return {
    sourceWorkspaceId: SOURCE_WORKSPACE_ID,
    sourceWorktreeId: SOURCE_WORKTREE_ID,
    destinationWorkspaceId: SOURCE_WORKSPACE_ID,
    destinationWorktreeId: SOURCE_WORKTREE_ID,
    destinationWorkspace: makeSourceWorkspace(),
    destinationWorktree: makeWorktree(),
    repoMappings: [],
    selectedRepoIdRewrites: {},
    filePathRewrites: [],
    compatibilitySymlinks: [],
    createdTemporaryWorkspace: false,
    reusedWorkspace: true,
    removedSourceWorktree: false,
  };
}

function makeExistingJoinGroups(
  overrides: Partial<ExistingWorktreeJoinWorkspaceGroup> = {},
): ExistingWorktreeJoinWorkspaceGroup[] {
  return [
    {
      workspaceId: JOIN_WORKSPACE_ID,
      workspaceName: 'Join Workspace',
      color: '#16a34a',
      isMultiRepo: false,
      repoCount: 1,
      temporary: false,
      candidates: [
        {
          workspaceId: JOIN_WORKSPACE_ID,
          worktreeId: JOIN_WORKTREE_ID,
          branchName: 'feature/join-me',
          repoOverlaps: [],
          addsNewRepo: true,
        },
      ],
      ...overrides,
    },
  ];
}

function makeExistingCombineResponse(): AdhocExistingWorktreeCombineResponse {
  return {
    ...makeCombineResponse(),
    destinationWorkspaceId: 'destination-workspace',
    destinationWorktreeId: 'destination-worktree',
    removedSourceWorktree: true,
    joinedWorktree: {
      workspaceId: JOIN_WORKSPACE_ID,
      worktreeId: JOIN_WORKTREE_ID,
      repoMappings: [
        {
          destinationRepoId: 'joined-dest-repo',
          repoName: 'Joined Repo',
          repoPath: '/repos/joined',
          newWorktreePath: '/worktrees/destination/repos/joined-dest-repo',
        },
      ],
      selectedRepoIdRewrites: { 'joined-old-repo': 'joined-new-repo' },
      filePathRewrites: [{ fromRoot: '/joined/from', toRoot: '/joined/to' }],
      compatibilitySymlinks: [],
    },
  };
}

function toJoinOption(item: SidebarItem): AdhocMultiRepoJoinOption {
  if (item.type === 'multi-repo') {
    return {
      id: item.id,
      name: item.name,
      color: item.color,
      isMultiRepo: true,
      repoCount: item.repos.length,
      temporary: item.temporary === true,
    };
  }
  return {
    id: item.id,
    name: item.name,
    color: item.color,
    isMultiRepo: false,
    repoCount: 1,
    temporary: false,
  };
}

function setupStores(
  overrides: {
    combineWorktreeWithWorkspace?: jest.Mock;
    combineWorktreeWithExistingWorktree?: jest.Mock;
    migrateWorktreeTabsToAdhocWorkspace?: jest.Mock;
    flushWorktreeTabs?: jest.Mock;
    selectWorktree?: jest.Mock;
    addToast?: jest.Mock;
    worktreeError?: string | null;
    existingJoinGroups?: ExistingWorktreeJoinWorkspaceGroup[];
  } = {},
): { listExistingWorktreeJoinOptions: jest.Mock } {
  const listExistingWorktreeJoinOptions = jest.fn(() =>
    Promise.resolve({
      groups: overrides.existingJoinGroups ?? makeExistingJoinGroups(),
    }),
  );
  useProjectsStore.setState({
    projects: [makeSourceWorkspace(), makeJoinWorkspace()],
    worktreeError: overrides.worktreeError ?? null,
    combineWorktreeWithWorkspace:
      overrides.combineWorktreeWithWorkspace ??
      jest.fn(() => Promise.resolve(makeCombineResponse())),
    combineWorktreeWithExistingWorktree:
      overrides.combineWorktreeWithExistingWorktree ??
      jest.fn(() => Promise.resolve(makeExistingCombineResponse())),
  });
  useChatStore.setState({
    flushWorktreeTabs:
      overrides.flushWorktreeTabs ?? jest.fn(() => Promise.resolve()),
    migrateWorktreeTabsToAdhocWorkspace:
      overrides.migrateWorktreeTabsToAdhocWorkspace ??
      jest.fn(() => Promise.resolve()),
    selectWorktree: overrides.selectWorktree ?? jest.fn(),
  });
  useGitHubStore.setState({
    addToast: overrides.addToast ?? jest.fn(),
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...(window.api ?? {}),
      listAdhocMultiRepoJoinOptions: jest.fn(() =>
        Promise.resolve({
          options: useProjectsStore
            .getState()
            .projects.filter((item) => item.id !== SOURCE_WORKSPACE_ID)
            .map(toJoinOption),
        }),
      ),
      listExistingWorktreeJoinOptions,
    },
  });
  return { listExistingWorktreeJoinOptions };
}

async function renderModal(): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AddRepoToWorktreeModal
        sourceWorkspaceId={SOURCE_WORKSPACE_ID}
        sourceWorktreeId={SOURCE_WORKTREE_ID}
        onClose={jest.fn()}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

function getButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!button) {
    throw new Error(`Missing button ${testId}`);
  }
  return button;
}

function getInput(container: HTMLElement, testId: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `[data-testid="${testId}"]`,
  );
  if (!input) {
    throw new Error(`Missing input ${testId}`);
  }
  return input;
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve();
  }
}

describe('AddRepoToWorktreeModal interactions', () => {
  beforeEach(() => {
    switchContextMock.mockReset();
    switchContextMock.mockResolvedValue(true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists eligible join projects without showing the source project', async () => {
    setupStores();
    useProjectsStore.setState({
      projects: [makeSourceWorkspace(), makeMultiRepoJoinWorkspace()],
    });

    const { container, root } = await renderModal();
    try {
      expect(container.textContent).toContain('Join Workspace');
      expect(container.textContent).not.toContain('Source Workspace');
      expect(container.textContent).toContain('1 repo');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the empty state when no eligible join projects exist', async () => {
    setupStores();
    useProjectsStore.setState({
      projects: [makeSourceWorkspace()],
    });

    const { container, root } = await renderModal();
    try {
      expect(container.textContent).toContain('No eligible projects');
      expect(container.textContent).toContain(
        'Add a project with at least one repo that is not already here.',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('annotates temporary destination options with the Temporary subtitle suffix', async () => {
    setupStores();
    useProjectsStore.setState({
      projects: [
        makeSourceWorkspace(),
        makeMultiRepoJoinWorkspace({ temporary: true }),
      ],
    });

    const { container, root } = await renderModal();
    try {
      expect(container.textContent).toContain('1 repo • Temporary');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('filters fallback project labels when destination names are missing', async () => {
    setupStores();
    useProjectsStore.setState({
      projects: [
        makeSourceWorkspace(),
        makeMultiRepoJoinWorkspace({ name: undefined as unknown as string }),
      ],
    });

    const { container, root } = await renderModal();
    try {
      const searchInput = getInput(
        container,
        'add-repo-to-worktree-modal-search',
      );

      act(() => {
        searchInput.value = 'repository';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(container.textContent).toContain('Repository');
      expect(container.textContent).not.toContain('No matching projects');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows the update-workspace mode choice for non-temporary multi-repo sources', async () => {
    setupStores();
    const { container, root } = await renderModal();
    try {
      act(() => {
        getButton(
          container,
          `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
        ).click();
      });

      const temporaryMode = getButton(
        container,
        'add-repo-to-worktree-modal-mode-temporary',
      );
      const updateMode = getButton(
        container,
        'add-repo-to-worktree-modal-mode-update',
      );

      expect(container.textContent).toContain('Temporary');
      expect(container.textContent).toContain('Update project');
      expect(temporaryMode.getAttribute('aria-pressed')).toBe('true');

      act(() => {
        updateMode.click();
      });
      expect(updateMode.getAttribute('aria-pressed')).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses the singular repo subtitle for one-repo multi-repo destination projects', async () => {
    setupStores();
    useProjectsStore.setState({
      projects: [makeSourceWorkspace(), makeMultiRepoJoinWorkspace()],
    });

    const { container, root } = await renderModal();
    try {
      expect(container.textContent).toContain('1 repo');
      expect(container.textContent).not.toContain('1 repos');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders Combine loading text while submission is in flight', async () => {
    let resolveCombine:
      | ((response: AdhocMultiRepoCombineResponse) => void)
      | undefined;
    setupStores({
      combineWorktreeWithWorkspace: jest.fn(
        () =>
          new Promise<AdhocMultiRepoCombineResponse>((resolve) => {
            resolveCombine = resolve;
          }),
      ),
    });
    const { container, root } = await renderModal();
    try {
      act(() => {
        getButton(
          container,
          `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
        ).click();
      });
      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-submit').click();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Combining…');

      await act(async () => {
        resolveCombine?.(makeCombineResponse());
        await Promise.resolve();
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('selects the destination before migrating removed source tabs', async () => {
    const migrateWorktreeTabsToAdhocWorkspace = jest.fn(() =>
      Promise.resolve(),
    );
    const selectWorktree = jest.fn();
    setupStores({
      combineWorktreeWithWorkspace: jest.fn(() =>
        Promise.resolve({
          ...makeCombineResponse(),
          removedSourceWorktree: true,
        }),
      ),
      migrateWorktreeTabsToAdhocWorkspace,
      selectWorktree,
    });
    const { container, root } = await renderModal();
    try {
      act(() => {
        getButton(
          container,
          `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
        ).click();
      });
      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-submit').click();
        await flushMicrotasks();
      });

      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenCalledTimes(1);
      expect(selectWorktree).toHaveBeenCalledWith(
        SOURCE_WORKSPACE_ID,
        SOURCE_WORKTREE_ID,
        { deferTabLoad: true },
      );
      expect(selectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        migrateWorktreeTabsToAdhocWorkspace.mock.invocationCallOrder[0],
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the backend error below the modal actions when combine fails', async () => {
    setupStores({
      combineWorktreeWithWorkspace: jest.fn(() => Promise.resolve(null)),
      worktreeError: 'Cannot add repo right now.',
    });
    const { container, root } = await renderModal();
    try {
      act(() => {
        getButton(
          container,
          `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
        ).click();
      });
      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-submit').click();
        await Promise.resolve();
      });

      expect(
        container.querySelector(
          '[data-testid="add-repo-to-worktree-modal-error"]',
        )?.textContent,
      ).toBe('Cannot add repo right now.');
      expect(
        container.querySelector(
          `[data-testid="add-repo-to-worktree-modal-error"] .${POSTHOG_REPLAY_BLOCK_CLASS}`,
        )?.textContent,
      ).toBe('Cannot add repo right now.');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('defaults to the New Worktrees pill with current behavior', async () => {
    const { listExistingWorktreeJoinOptions } = setupStores();
    const { container, root } = await renderModal();
    try {
      const newPill = getButton(
        container,
        'add-repo-to-worktree-modal-pill-new',
      );
      const existingPill = getButton(
        container,
        'add-repo-to-worktree-modal-pill-existing',
      );
      expect(newPill.getAttribute('aria-pressed')).toBe('true');
      expect(existingPill.getAttribute('aria-pressed')).toBe('false');
      // The workspace multi-select picker (current behavior) stays visible.
      expect(
        container.querySelector(
          '[data-testid="add-repo-to-worktree-modal-list"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          `[data-testid="add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}"]`,
        ),
      ).not.toBeNull();
      expect(listExistingWorktreeJoinOptions).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('switches to Existing Worktrees and lists grouped candidates', async () => {
    const { listExistingWorktreeJoinOptions } = setupStores();
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listExistingWorktreeJoinOptions).toHaveBeenCalledWith({
        sourceWorkspaceId: SOURCE_WORKSPACE_ID,
        sourceWorktreeId: SOURCE_WORKTREE_ID,
      });
      expect(
        container.querySelector(
          `[data-testid="existing-worktree-picker-group-${JOIN_WORKSPACE_ID}"]`,
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          `[data-testid="existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}"]`,
        ),
      ).not.toBeNull();
      expect(container.textContent).toContain('Join Workspace');
      expect(container.textContent).toContain('feature/join-me');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not refetch existing worktrees when switching pills after the first load', async () => {
    const { listExistingWorktreeJoinOptions } = setupStores();
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(listExistingWorktreeJoinOptions).toHaveBeenCalledTimes(1);

      // Toggle back to New, then to Existing again — the cached content sticks.
      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-pill-new').click();
        await Promise.resolve();
      });
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listExistingWorktreeJoinOptions).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          `[data-testid="existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}"]`,
        ),
      ).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('refetches the existing worktrees when the refresh button is clicked', async () => {
    const { listExistingWorktreeJoinOptions } = setupStores();
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(listExistingWorktreeJoinOptions).toHaveBeenCalledTimes(1);

      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-refresh').click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(listExistingWorktreeJoinOptions).toHaveBeenCalledTimes(2);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows per-repo preservation warnings for the selected candidate', async () => {
    setupStores({
      existingJoinGroups: makeExistingJoinGroups({
        candidates: [
          {
            workspaceId: JOIN_WORKSPACE_ID,
            worktreeId: JOIN_WORKTREE_ID,
            branchName: 'feature/join-me',
            repoOverlaps: [
              {
                repoName: 'app',
                sourceHasChanges: false,
                targetHasChanges: true,
                sourceBranch: 'main',
                targetBranch: 'main',
              },
            ],
            addsNewRepo: false,
          },
        ],
      }),
    });
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        container.querySelector(
          '[data-testid="add-repo-to-worktree-modal-overlap-warnings"]',
        ),
      ).toBeNull();

      act(() => {
        getButton(
          container,
          `existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}`,
        ).click();
      });

      const warnings = container.querySelector(
        '[data-testid="add-repo-to-worktree-modal-overlap-warnings"]',
      );
      expect(warnings).not.toBeNull();
      expect(warnings?.textContent).toContain(
        'app: changes from the selected worktree will be kept.',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('submits an existing-worktree join and migrates both sides', async () => {
    const combineWorktreeWithExistingWorktree = jest.fn(() =>
      Promise.resolve(makeExistingCombineResponse()),
    );
    const migrateWorktreeTabsToAdhocWorkspace = jest.fn(() =>
      Promise.resolve(),
    );
    const flushWorktreeTabs = jest.fn(() => Promise.resolve());
    const selectWorktree = jest.fn();
    const addToast = jest.fn();
    setupStores({
      combineWorktreeWithExistingWorktree,
      migrateWorktreeTabsToAdhocWorkspace,
      flushWorktreeTabs,
      selectWorktree,
      addToast,
    });
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        getButton(
          container,
          `existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}`,
        ).click();
      });

      const submit = getButton(container, 'add-repo-to-worktree-modal-submit');
      expect(submit.textContent).toBe('Join worktree');

      await act(async () => {
        submit.click();
        await flushMicrotasks();
      });

      expect(combineWorktreeWithExistingWorktree).toHaveBeenCalledWith({
        sourceWorkspaceId: SOURCE_WORKSPACE_ID,
        sourceWorktreeId: SOURCE_WORKTREE_ID,
        joinWorkspaceId: JOIN_WORKSPACE_ID,
        joinWorktreeId: JOIN_WORKTREE_ID,
        mode: 'temporary',
      });
      expect(flushWorktreeTabs).toHaveBeenCalledWith(
        SOURCE_WORKSPACE_ID,
        SOURCE_WORKTREE_ID,
      );
      expect(flushWorktreeTabs).toHaveBeenCalledWith(
        JOIN_WORKSPACE_ID,
        JOIN_WORKTREE_ID,
      );
      // Both flushWorktreeTabs calls must complete before combineWorktreeWithExistingWorktree.
      const combineOrder =
        combineWorktreeWithExistingWorktree.mock.invocationCallOrder[0];
      expect(flushWorktreeTabs.mock.invocationCallOrder[0]).toBeLessThan(
        combineOrder,
      );
      expect(flushWorktreeTabs.mock.invocationCallOrder[1]).toBeLessThan(
        combineOrder,
      );

      const response = makeExistingCombineResponse();
      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenCalledTimes(2);
      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenNthCalledWith(
        1,
        response,
      );
      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenNthCalledWith(2, {
        ...response,
        sourceWorkspaceId: response.joinedWorktree.workspaceId,
        sourceWorktreeId: response.joinedWorktree.worktreeId,
        repoMappings: response.joinedWorktree.repoMappings,
        selectedRepoIdRewrites: response.joinedWorktree.selectedRepoIdRewrites,
        sourceRootRepoIdRewrite:
          response.joinedWorktree.sourceRootRepoIdRewrite,
        filePathRewrites: response.joinedWorktree.filePathRewrites,
        compatibilitySymlinks: response.joinedWorktree.compatibilitySymlinks,
        removedTemporaryWorkspaceId:
          response.joinedWorktree.removedTemporaryWorkspaceId,
      });
      expect(selectWorktree).toHaveBeenCalledWith(
        'destination-workspace',
        'destination-worktree',
        { deferTabLoad: true },
      );
      expect(selectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        migrateWorktreeTabsToAdhocWorkspace.mock.invocationCallOrder[0],
      );
      expect(addToast).toHaveBeenCalledWith(
        'Joined worktree',
        'success',
        undefined,
        {
          projectId: 'destination-workspace',
          worktreeId: 'destination-worktree',
        },
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('existing-mode submit with removedSourceWorktree:false only migrates the joined side', async () => {
    const responseNoRemove: AdhocExistingWorktreeCombineResponse = {
      ...makeExistingCombineResponse(),
      removedSourceWorktree: false,
    };
    const combineWorktreeWithExistingWorktree = jest.fn(() =>
      Promise.resolve(responseNoRemove),
    );
    const migrateWorktreeTabsToAdhocWorkspace = jest.fn(() =>
      Promise.resolve(),
    );
    setupStores({
      combineWorktreeWithExistingWorktree,
      migrateWorktreeTabsToAdhocWorkspace,
    });
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        getButton(
          container,
          `existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}`,
        ).click();
      });

      await act(async () => {
        getButton(container, 'add-repo-to-worktree-modal-submit').click();
        await flushMicrotasks();
      });

      // removedSourceWorktree is false so the source-side migrate must NOT run.
      // Only the joined-side migrate should run exactly once.
      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenCalledTimes(1);
      expect(migrateWorktreeTabsToAdhocWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceId: responseNoRemove.joinedWorktree.workspaceId,
          sourceWorktreeId: responseNoRemove.joinedWorktree.worktreeId,
        }),
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps the submit disabled until a worktree is selected', async () => {
    setupStores();
    const { container, root } = await renderModal();
    try {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const submit = getButton(container, 'add-repo-to-worktree-modal-submit');
      expect(submit.disabled).toBe(true);

      act(() => {
        getButton(
          container,
          `existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}`,
        ).click();
      });

      expect(submit.disabled).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('AddRepoToWorktreeModal destination context (CAN-3846)', () => {
  const DESTINATION_WORKSPACE_ID = 'destination-workspace';
  const DESTINATION_WORKTREE_ID = 'destination-worktree';
  const OTHER_SELECTION = {
    projectId: 'other-workspace',
    worktreeId: 'other-worktree',
  };

  type JoinPath = 'combine' | 'existing';
  const PATHS: { path: JoinPath; toast: string }[] = [
    { path: 'combine', toast: 'Created multi-repo worktree' },
    { path: 'existing', toast: 'Joined worktree' },
  ];

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  interface Harness {
    container: HTMLDivElement;
    root: Root;
    selectWorktree: jest.Mock;
    deselectWorktree: jest.Mock;
    migrateWorktreeTabsToAdhocWorkspace: jest.Mock;
    addToast: jest.Mock;
    onClose: jest.Mock;
  }

  /** Both join paths consume the source; `existing` also consumes the joined worktree. */
  async function renderJoin(
    path: JoinPath,
    selectedWorktree: { projectId: string; worktreeId: string } | null,
  ): Promise<Harness> {
    const selectWorktree = jest.fn();
    const migrateWorktreeTabsToAdhocWorkspace = jest.fn(() =>
      Promise.resolve(),
    );
    const addToast = jest.fn();
    setupStores({
      combineWorktreeWithWorkspace: jest.fn(() =>
        Promise.resolve({
          ...makeCombineResponse(),
          destinationWorkspaceId: DESTINATION_WORKSPACE_ID,
          destinationWorktreeId: DESTINATION_WORKTREE_ID,
          removedSourceWorktree: true,
        }),
      ),
      selectWorktree,
      migrateWorktreeTabsToAdhocWorkspace,
      addToast,
    });
    const deselectWorktree = jest.fn((): void => {
      useChatStore.setState({ selectedWorktree: null });
    });
    useChatStore.setState({ selectedWorktree, deselectWorktree });

    const onClose = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <AddRepoToWorktreeModal
          sourceWorkspaceId={SOURCE_WORKSPACE_ID}
          sourceWorktreeId={SOURCE_WORKTREE_ID}
          onClose={onClose}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });
    if (path === 'existing') {
      await act(async () => {
        getButton(
          container,
          'add-repo-to-worktree-modal-pill-existing',
        ).click();
        await flushMicrotasks();
      });
      act(() => {
        getButton(
          container,
          `existing-worktree-picker-option-${JOIN_WORKSPACE_ID}-${JOIN_WORKTREE_ID}`,
        ).click();
      });
    } else {
      act(() => {
        getButton(
          container,
          `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
        ).click();
      });
    }
    return {
      container,
      root,
      selectWorktree,
      deselectWorktree,
      migrateWorktreeTabsToAdhocWorkspace,
      addToast,
      onClose,
    };
  }

  async function submit(container: HTMLElement): Promise<void> {
    await act(async () => {
      getButton(container, 'add-repo-to-worktree-modal-submit').click();
      await flushMicrotasks();
    });
  }

  function expectCompletedJoin(harness: Harness, toast: string): void {
    expect(
      harness.container.querySelector(
        '[data-testid="add-repo-to-worktree-modal-error"]',
      ),
    ).toBeNull();
    expect(harness.addToast).toHaveBeenCalledWith(toast, 'success', undefined, {
      projectId: DESTINATION_WORKSPACE_ID,
      worktreeId: DESTINATION_WORKTREE_ID,
    });
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  }

  beforeEach(() => {
    switchContextMock.mockReset();
    switchContextMock.mockResolvedValue(true);
  });

  afterEach(() => {
    useChatStore.setState({ selectedWorktree: null });
    document.body.innerHTML = '';
  });

  describe.each(PATHS)('$path', ({ path, toast }) => {
    it('waits for the owning context before selecting the destination', async () => {
      const pending = deferred<boolean>();
      switchContextMock.mockReturnValueOnce(pending.promise);
      const harness = await renderJoin(path, null);
      try {
        await submit(harness.container);

        expect(switchContextMock).toHaveBeenCalledWith(
          DESTINATION_WORKSPACE_ID,
        );
        expect(harness.selectWorktree).not.toHaveBeenCalled();
        expect(
          harness.migrateWorktreeTabsToAdhocWorkspace,
        ).not.toHaveBeenCalled();

        await act(async () => {
          pending.resolve(true);
          await flushMicrotasks();
        });

        expect(harness.selectWorktree).toHaveBeenCalledWith(
          DESTINATION_WORKSPACE_ID,
          DESTINATION_WORKTREE_ID,
          { deferTabLoad: true },
        );
        expect(switchContextMock.mock.invocationCallOrder[0]).toBeLessThan(
          harness.selectWorktree.mock.invocationCallOrder[0],
        );
        expect(harness.selectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
          harness.migrateWorktreeTabsToAdhocWorkspace.mock
            .invocationCallOrder[0],
        );
        expect(harness.deselectWorktree).not.toHaveBeenCalled();
        expectCompletedJoin(harness, toast);
      } finally {
        act(() => {
          harness.root.unmount();
        });
      }
    });

    it('keeps a refused destination unselected and clears the consumed source', async () => {
      switchContextMock.mockResolvedValueOnce(false);
      const harness = await renderJoin(path, {
        projectId: SOURCE_WORKSPACE_ID,
        worktreeId: SOURCE_WORKTREE_ID,
      });
      try {
        await submit(harness.container);

        expect(harness.selectWorktree).not.toHaveBeenCalled();
        expect(harness.deselectWorktree).toHaveBeenCalledTimes(1);
        expect(
          harness.deselectWorktree.mock.invocationCallOrder[0],
        ).toBeLessThan(
          harness.migrateWorktreeTabsToAdhocWorkspace.mock
            .invocationCallOrder[0],
        );
        expect(
          harness.migrateWorktreeTabsToAdhocWorkspace,
        ).toHaveBeenCalledTimes(path === 'existing' ? 2 : 1);
        expect(useChatStore.getState().selectedWorktree).toBeNull();
        expectCompletedJoin(harness, toast);
      } finally {
        act(() => {
          harness.root.unmount();
        });
      }
    });

    it('treats a rejected switch as navigation failure, not a failed join', async () => {
      switchContextMock.mockRejectedValueOnce(new Error('stale revision'));
      const harness = await renderJoin(path, {
        projectId: SOURCE_WORKSPACE_ID,
        worktreeId: SOURCE_WORKTREE_ID,
      });
      try {
        await submit(harness.container);

        expect(harness.selectWorktree).not.toHaveBeenCalled();
        expect(harness.deselectWorktree).toHaveBeenCalledTimes(1);
        expect(
          harness.migrateWorktreeTabsToAdhocWorkspace,
        ).toHaveBeenCalledTimes(path === 'existing' ? 2 : 1);
        expectCompletedJoin(harness, toast);
      } finally {
        act(() => {
          harness.root.unmount();
        });
      }
    });

    it('preserves an unrelated selection when the switch is refused', async () => {
      switchContextMock.mockResolvedValueOnce(false);
      const harness = await renderJoin(path, OTHER_SELECTION);
      try {
        await submit(harness.container);

        expect(harness.selectWorktree).not.toHaveBeenCalled();
        expect(harness.deselectWorktree).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedWorktree).toEqual(
          OTHER_SELECTION,
        );
        expectCompletedJoin(harness, toast);
      } finally {
        act(() => {
          harness.root.unmount();
        });
      }
    });

    it('preserves a selection changed while the switch was pending', async () => {
      const pending = deferred<boolean>();
      switchContextMock.mockReturnValueOnce(pending.promise);
      const harness = await renderJoin(path, {
        projectId: SOURCE_WORKSPACE_ID,
        worktreeId: SOURCE_WORKTREE_ID,
      });
      try {
        await submit(harness.container);
        useChatStore.setState({ selectedWorktree: OTHER_SELECTION });

        await act(async () => {
          pending.resolve(false);
          await flushMicrotasks();
        });

        expect(harness.selectWorktree).not.toHaveBeenCalled();
        expect(harness.deselectWorktree).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedWorktree).toEqual(
          OTHER_SELECTION,
        );
        expectCompletedJoin(harness, toast);
      } finally {
        act(() => {
          harness.root.unmount();
        });
      }
    });
  });

  it('clears a consumed joined worktree when the switch is refused', async () => {
    switchContextMock.mockResolvedValueOnce(false);
    const harness = await renderJoin('existing', {
      projectId: JOIN_WORKSPACE_ID,
      worktreeId: JOIN_WORKTREE_ID,
    });
    try {
      await submit(harness.container);

      expect(harness.selectWorktree).not.toHaveBeenCalled();
      expect(harness.deselectWorktree).toHaveBeenCalledTimes(1);
      expect(harness.deselectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        harness.migrateWorktreeTabsToAdhocWorkspace.mock.invocationCallOrder[1],
      );
      expectCompletedJoin(harness, 'Joined worktree');
    } finally {
      act(() => {
        harness.root.unmount();
      });
    }
  });

  it('does not switch context when the join itself fails', async () => {
    const harness = await renderJoin('combine', null);
    act(() => {
      useProjectsStore.setState({
        combineWorktreeWithWorkspace: jest.fn(() => Promise.resolve(null)),
        worktreeError: 'Cannot add repo right now.',
      });
    });
    try {
      await submit(harness.container);

      expect(switchContextMock).not.toHaveBeenCalled();
      expect(harness.selectWorktree).not.toHaveBeenCalled();
      expect(harness.addToast).not.toHaveBeenCalled();
    } finally {
      act(() => {
        harness.root.unmount();
      });
    }
  });
});
