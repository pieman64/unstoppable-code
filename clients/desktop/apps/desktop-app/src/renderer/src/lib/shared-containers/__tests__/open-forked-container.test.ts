/**
 * Navigation to a freshly forked container (CAN-2552, CAN-4782).
 *
 * Several things here are ordering hazards rather than routing preferences:
 *
 * - The sidebar reload has to complete BEFORE the selection. Main created the
 *   workspace after the renderer's last listing, so selecting first points
 *   chat state at a row the store has never seen.
 * - A context switch has to complete BEFORE the selection too. Entering a
 *   context clears the selection and restores the one remembered there, so a
 *   copy selected first would be replaced.
 * - A Cowork fork keys as `(workspaceId, entryId)` with the entry id in the
 *   `worktreeId` slot, and lands on the 'chat' page. Routing it through
 *   `selectWorktree` would look plausible and select nothing.
 * - Nothing may claim the copy opened until it really is selected: the viewer
 *   only closes and focus is only requested after that.
 *
 * This file mocks the stores, so it structurally cannot observe the
 * stale-`chatProjects` bug that made a forked workspace unselectable. The
 * real coverage for that lives in `stores/__tests__/standaloneChatStore.test.ts`
 * ('standaloneChatStore sidebar multi-project'), against `switchChatProject`'s
 * own listing.
 */
import type { WorkspaceContext } from '@canopy/desktop-shared/types';
import type { SharedContainerForkResponse } from '@canopy/protocol/shared-containers';

interface FakeProject {
  id: string;
  owner?: { type: 'organization'; organizationId: string };
}

const reconcileSelectionWithScoping = jest.fn();
jest.mock('@/lib/workspaceContextSelection', () => ({
  reconcileSelectionWithScoping: (...args: unknown[]): void => {
    reconcileSelectionWithScoping(...args);
  },
}));
const order: string[] = [];
const navigationListeners = new Set<() => void>();
const selectionListeners = new Set<(state: typeof chatState) => void>();
const contextListeners = new Set<() => void>();
const projectsState: {
  projects: FakeProject[];
  loadProjects: jest.Mock<Promise<void>, [unknown?]>;
} = { projects: [], loadProjects: jest.fn<Promise<void>, [unknown?]>() };
const chatState: {
  selectedWorktree: { projectId: string; worktreeId: string } | null;
  selectWorktree: jest.Mock<void, [string, string]>;
} = {
  selectedWorktree: null,
  selectWorktree: jest.fn<void, [string, string]>(),
};
const standaloneState: {
  activeChatProjectId: string;
  activeWorkEntryId: string | null;
  openWorkEntryFromSidebar: jest.Mock<Promise<void>, [string, string]>;
  cancelPendingWorkEntryNavigation: jest.Mock<void, []>;
} = {
  activeChatProjectId: 'cowork-default',
  activeWorkEntryId: null,
  openWorkEntryFromSidebar: jest.fn<Promise<void>, [string, string]>(),
  cancelPendingWorkEntryNavigation: jest.fn<void, []>(),
};
const navigationState = {
  activePage: 'main',
  navigate: jest.fn((page: string) => order.push(`navigate:${page}`)),
  requestForkedContainerFocus: jest.fn(() => order.push('focus')),
};
const replicasState = {
  closeViewer: jest.fn(() => order.push('closeViewer')),
};
const contextState: {
  accountEpoch: number;
  setContext: jest.Mock<Promise<unknown>, [WorkspaceContext]>;
} = {
  accountEpoch: 0,
  setContext: jest.fn<Promise<unknown>, [WorkspaceContext]>(),
};
let scoping: WorkspaceContext | undefined;

jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  getSidebarScopingContext: (): WorkspaceContext | undefined => scoping,
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): unknown => projectsState },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => chatState,
    subscribe: (listener: (state: typeof chatState) => void): (() => void) => {
      selectionListeners.add(listener);
      return (): void => {
        selectionListeners.delete(listener);
      };
    },
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): unknown => navigationState,
    subscribe: (listener: () => void): (() => void) => {
      navigationListeners.add(listener);
      return (): void => {
        navigationListeners.delete(listener);
      };
    },
  },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: { getState: (): unknown => standaloneState },
}));
jest.mock('@/stores/sharedContainerReplicasStore', () => ({
  useSharedContainerReplicasStore: { getState: (): unknown => replicasState },
}));
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: {
    getState: (): unknown => contextState,
    subscribe: (listener: () => void): (() => void) => {
      contextListeners.add(listener);
      return (): void => {
        contextListeners.delete(listener);
      };
    },
  },
}));
jest.mock('@/lib/automationContextScope', () => ({
  workspaceOwnerContext: (workspace: FakeProject): WorkspaceContext =>
    workspace.owner === undefined
      ? { kind: 'personal' }
      : {
          kind: 'organization',
          organizationId: workspace.owner.organizationId,
        },
}));

import { openForkedContainer } from '../open-forked-container';

const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ORG_1: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'org-1',
};
const ORG_2: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'org-2',
};

const PROVENANCE = {
  sourceContainerId: 'container-1',
  sourceRevisionId: 'revision-1',
  sourceOwnerDisplayName: 'Dana',
  organizationId: 'org-1',
  forkedAt: '2026-09-09T10:00:00.000Z',
};

const CODE_COPY = {
  containerType: 'CODE_WORKTREE',
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  warnings: [],
  provenance: PROVENANCE,
} satisfies SharedContainerForkResponse;

const COWORK_COPY = {
  containerType: 'COWORK_WORK_ENTRY',
  projectId: 'cowork-1',
  worktreeId: 'entry-1',
  warnings: [],
  provenance: PROVENANCE,
} satisfies SharedContainerForkResponse;

/** The list the next reload returns. */
let listedProjects: FakeProject[];

beforeEach(() => {
  expect(
    navigationListeners.size + selectionListeners.size + contextListeners.size,
  ).toBe(0);
  order.length = 0;
  jest.clearAllMocks();
  scoping = undefined;
  contextState.accountEpoch = 0;
  navigationState.activePage = 'main';
  navigationState.navigate.mockImplementation((page) => {
    order.push(`navigate:${page}`);
    navigationState.activePage = page;
    navigationListeners.forEach((listener): void => listener());
    return order.length;
  });
  chatState.selectedWorktree = null;
  standaloneState.activeChatProjectId = 'cowork-default';
  standaloneState.activeWorkEntryId = null;
  projectsState.projects = [];
  listedProjects = [{ id: 'workspace-1' }, { id: 'cowork-1' }];
  projectsState.loadProjects.mockImplementation(() => {
    order.push('loadProjects');
    projectsState.projects = listedProjects;
    return Promise.resolve();
  });
  chatState.selectWorktree.mockImplementation((projectId, worktreeId) => {
    order.push('selectWorktree');
    // The real guard refuses a worktree missing from the snapshot.
    if (projectsState.projects.some((project) => project.id === projectId)) {
      chatState.selectedWorktree = { projectId, worktreeId };
    }
  });
  standaloneState.openWorkEntryFromSidebar.mockImplementation(
    (projectId, entryId) => {
      order.push('openWorkEntryFromSidebar');
      standaloneState.activeChatProjectId = projectId;
      standaloneState.activeWorkEntryId = entryId;
      return Promise.resolve();
    },
  );
  contextState.setContext.mockImplementation((context) => {
    order.push(`setContext:${context.kind}`);
    scoping = context;
    // Entering a context restores the selection remembered there.
    chatState.selectedWorktree = {
      projectId: 'remembered',
      worktreeId: 'remembered-worktree',
    };
    return Promise.resolve({ context });
  });
});

describe('openForkedContainer', () => {
  it('reloads, selects, then closes the viewer and requests focus in the same context', async () => {
    scoping = PERSONAL;

    await expect(openForkedContainer(CODE_COPY)).resolves.toEqual({
      switchedTo: null,
    });

    expect(order).toEqual([
      'loadProjects',
      'selectWorktree',
      'navigate:main',
      'closeViewer',
      'focus',
    ]);
    expect(projectsState.loadProjects).toHaveBeenCalledWith({
      silent: true,
      requireSuccess: true,
    });
    expect(reconcileSelectionWithScoping).toHaveBeenCalledWith(PERSONAL);
    expect(contextState.setContext).not.toHaveBeenCalled();
    expect(chatState.selectedWorktree).toEqual({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      page: 'main',
      accountEpoch: 0,
    });
  });

  it('enters Personal before selecting a Personal copy made from an organization share', async () => {
    scoping = ORG_1;

    await expect(openForkedContainer(CODE_COPY)).resolves.toEqual({
      switchedTo: PERSONAL,
    });

    expect(order).toEqual([
      'loadProjects',
      'setContext:personal',
      'selectWorktree',
      'navigate:main',
      'closeViewer',
      'focus',
    ]);
    // The restored selection did not overwrite the copy.
    expect(chatState.selectedWorktree).toEqual({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('enters the organization that owns the destination', async () => {
    scoping = PERSONAL;
    listedProjects = [
      {
        id: 'workspace-1',
        owner: { type: 'organization', organizationId: 'org-2' },
      },
    ];

    await expect(openForkedContainer(CODE_COPY)).resolves.toEqual({
      switchedTo: ORG_2,
    });
    expect(contextState.setContext).toHaveBeenCalledWith(ORG_2);
  });

  it('follows an existing destination owner, not the share, including a linked Personal workspace', async () => {
    // The share came from org-1 and the user is there; the existing Personal
    // workspace they picked is linked into org-1, but it is still Personal.
    scoping = ORG_1;

    const result = await openForkedContainer(CODE_COPY);

    expect(result.switchedTo).toEqual(PERSONAL);
    expect(contextState.setContext).toHaveBeenCalledWith(PERSONAL);
  });

  it('keeps unscoped navigation when scoping is off or not hydrated', async () => {
    listedProjects = [
      {
        id: 'workspace-1',
        owner: { type: 'organization', organizationId: 'org-2' },
      },
    ];

    await expect(openForkedContainer(CODE_COPY)).resolves.toEqual({
      switchedTo: null,
    });
    expect(contextState.setContext).not.toHaveBeenCalled();
    expect(navigationState.navigate).toHaveBeenCalledWith('main');
  });

  it('retries once when the refreshed list does not have the copy yet', async () => {
    let reloads = 0;
    projectsState.loadProjects.mockImplementation(() => {
      reloads += 1;
      projectsState.projects = reloads === 1 ? [] : listedProjects;
      return Promise.resolve();
    });

    await openForkedContainer(CODE_COPY);

    expect(projectsState.loadProjects).toHaveBeenCalledTimes(2);
    expect(chatState.selectedWorktree?.worktreeId).toBe('worktree-1');
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledTimes(
      1,
    );
  });

  it('retries once when the selection silently does not land', async () => {
    chatState.selectWorktree.mockImplementationOnce(() => undefined);

    await openForkedContainer(CODE_COPY);

    expect(projectsState.loadProjects).toHaveBeenCalledTimes(2);
    expect(chatState.selectWorktree).toHaveBeenCalledTimes(2);
    expect(chatState.selectedWorktree?.worktreeId).toBe('worktree-1');
  });

  it('retries once after a failed reload', async () => {
    projectsState.loadProjects.mockImplementationOnce(() =>
      Promise.reject(new Error('offline')),
    );

    await openForkedContainer(CODE_COPY);

    expect(projectsState.loadProjects).toHaveBeenCalledTimes(2);
    expect(navigationState.navigate).toHaveBeenCalledWith('main');
  });

  it.each([
    [
      'the copy never appears',
      (): void => {
        listedProjects = [];
      },
    ],
    [
      'the selection never lands',
      (): void => {
        chatState.selectWorktree.mockImplementation(() => undefined);
      },
    ],
    [
      'the reload keeps failing',
      (): void => {
        projectsState.loadProjects.mockImplementation(() =>
          Promise.reject(new Error('offline')),
        );
      },
    ],
  ])('stops after one retry when %s', async (_label, arrange) => {
    arrange();

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow();

    expect(projectsState.loadProjects).toHaveBeenCalledTimes(2);
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(replicasState.closeViewer).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('propagates a rejected context switch without selecting or retrying', async () => {
    scoping = ORG_1;
    contextState.setContext.mockRejectedValueOnce(new Error('Stale revision'));

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow(
      'Stale revision',
    );

    expect(contextState.setContext).toHaveBeenCalledTimes(1);
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('rejects a switch that resolved without entering the owning context', async () => {
    scoping = ORG_1;
    contextState.setContext.mockImplementationOnce(() =>
      Promise.resolve({ context: ORG_1 }),
    );

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow(
      'The workspace context changed while opening the copy.',
    );

    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });

  it('opens a Cowork fork as a Work Entry on the chat page', async () => {
    await expect(openForkedContainer(COWORK_COPY)).resolves.toEqual({
      switchedTo: null,
    });

    expect(standaloneState.openWorkEntryFromSidebar).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
    );
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(order.slice(-3)).toEqual(['navigate:chat', 'closeViewer', 'focus']);
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        page: 'chat',
      }),
    );
  });

  it('propagates a failed Cowork selection instead of navigating anyway', async () => {
    standaloneState.openWorkEntryFromSidebar.mockRejectedValueOnce(
      new Error('Chat project not found'),
    );

    await expect(openForkedContainer(COWORK_COPY)).rejects.toThrow(
      'Chat project not found',
    );

    // Navigating to a page that would render the previously active workspace
    // is worse than staying put: it looks like the copy opened.
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(replicasState.closeViewer).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it.each(['selection', 'page', 'page round trip', 'account', 'context'])(
    'cancels a pending Cowork open after independent %s navigation',
    async (change) => {
      scoping = PERSONAL;
      let cancelled = false;
      let finishSelection: () => void = () => undefined;
      let selectionStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        selectionStarted = resolve;
      });
      standaloneState.cancelPendingWorkEntryNavigation.mockImplementationOnce(
        () => {
          cancelled = true;
        },
      );
      standaloneState.openWorkEntryFromSidebar.mockImplementationOnce(
        (projectId, entryId) =>
          new Promise<void>((resolve) => {
            finishSelection = (): void => {
              if (!cancelled) {
                chatState.selectedWorktree = { projectId, worktreeId: entryId };
                selectionListeners.forEach((listener): void =>
                  listener(chatState),
                );
                standaloneState.activeChatProjectId = projectId;
                standaloneState.activeWorkEntryId = entryId;
              }
              resolve();
            };
            selectionStarted();
          }),
      );
      const opening = openForkedContainer(COWORK_COPY);
      const rejected = expect(opening).rejects.toThrow();
      await started;
      const chosen = { projectId: 'code-workspace', worktreeId: 'chosen-code' };
      if (change === 'selection') {
        chatState.selectedWorktree = chosen;
        selectionListeners.forEach((listener): void => listener(chatState));
      } else if (change === 'page' || change === 'page round trip') {
        navigationState.navigate('home');
        if (change === 'page round trip') navigationState.navigate('main');
        navigationState.navigate.mockClear();
      } else {
        if (change === 'account') contextState.accountEpoch += 1;
        else scoping = ORG_1;
        contextListeners.forEach((listener): void => listener());
      }
      finishSelection();
      await rejected;
      expect(cancelled).toBe(true);
      expect(chatState.selectedWorktree).toEqual(
        change === 'selection' ? chosen : null,
      );
      expect(navigationState.navigate).not.toHaveBeenCalled();
      expect(replicasState.closeViewer).not.toHaveBeenCalled();
      expect(
        navigationState.requestForkedContainerFocus,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects a Cowork open that resolved on another entry', async () => {
    standaloneState.openWorkEntryFromSidebar.mockImplementationOnce(() =>
      Promise.resolve(),
    );

    await expect(openForkedContainer(COWORK_COPY)).rejects.toThrow(
      'The copy could not be opened.',
    );
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });

  it('does not close the viewer or request focus when navigation is refused', async () => {
    navigationState.navigate.mockImplementationOnce(() => 0);
    await expect(openForkedContainer(COWORK_COPY)).rejects.toThrow();
    expect(replicasState.closeViewer).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('leaves the user on a page they chose during the refresh', async () => {
    projectsState.loadProjects.mockImplementationOnce(() => {
      projectsState.projects = listedProjects;
      navigationState.activePage = 'home';
      return Promise.resolve();
    });
    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow();
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });

  it('lets only the newest of overlapping reveals navigate', async () => {
    const reloads: Array<() => void> = [];
    projectsState.loadProjects.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          reloads.push((): void => {
            projectsState.projects = listedProjects;
            resolve();
          });
        }),
    );

    const first = openForkedContainer(CODE_COPY);
    const firstResult = expect(first).rejects.toThrow(
      'A newer request replaced opening the copy.',
    );
    const second = openForkedContainer(CODE_COPY);
    expect(projectsState.loadProjects).toHaveBeenCalledTimes(1);
    reloads[0]?.();
    await firstResult;
    // Only after the older attempt has settled may the newer one select.
    await Promise.resolve();
    reloads[1]?.();
    await expect(second).resolves.toEqual({ switchedTo: null });

    expect(navigationState.navigate).toHaveBeenCalledTimes(1);
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledTimes(
      1,
    );
  });

  it('preserves a different worktree selected during the refresh', async () => {
    const chosen = { projectId: 'other-project', worktreeId: 'other-worktree' };
    projectsState.loadProjects.mockImplementationOnce(() => {
      projectsState.projects = listedProjects;
      chatState.selectedWorktree = chosen;
      return Promise.resolve();
    });

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow();
    expect(chatState.selectedWorktree).toEqual(chosen);
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('preserves a page chosen while the owning-context switch is pending', async () => {
    scoping = ORG_1;
    let finishSwitch: () => void = () => undefined;
    let switchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      switchStarted = resolve;
    });
    contextState.setContext.mockImplementationOnce(
      (context) =>
        new Promise((resolve) => {
          finishSwitch = (): void => {
            scoping = context;
            resolve({ context });
          };
          switchStarted();
        }),
    );

    const opening = openForkedContainer(CODE_COPY);
    const rejected = expect(opening).rejects.toThrow();
    await started;
    navigationState.navigate('home');
    navigationState.navigate.mockClear();
    finishSwitch();
    await rejected;
    expect(navigationState.activePage).toBe('home');
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('lets the latest reveal follow an older pending owning-context switch', async () => {
    scoping = ORG_1;
    let finishSwitch: () => void = () => undefined;
    let switchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      switchStarted = resolve;
    });
    contextState.setContext.mockImplementationOnce(
      (context) =>
        new Promise((resolve) => {
          finishSwitch = (): void => {
            scoping = context;
            resolve({ context });
          };
          switchStarted();
        }),
    );

    const older = openForkedContainer(CODE_COPY);
    const rejected = expect(older).rejects.toThrow(
      'A newer request replaced opening the copy.',
    );
    await started;
    const latest = openForkedContainer(CODE_COPY);
    finishSwitch();
    await rejected;
    await expect(latest).resolves.toEqual({ switchedTo: null });
    expect(contextState.setContext).toHaveBeenCalledTimes(1);
    expect(navigationState.navigate).toHaveBeenCalledTimes(1);
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledTimes(
      1,
    );
  });

  it('allows the synchronous route and selection restoration of its own context switch', async () => {
    scoping = ORG_1;
    navigationState.activePage = 'chat';
    contextState.setContext.mockImplementationOnce((context) => {
      scoping = context;
      chatState.selectedWorktree = {
        projectId: 'remembered',
        worktreeId: 'remembered',
      };
      selectionListeners.forEach((listener): void => listener(chatState));
      navigationState.navigate('main');
      contextListeners.forEach((listener): void => listener());
      return Promise.resolve({ context });
    });

    await expect(openForkedContainer(CODE_COPY)).resolves.toEqual({
      switchedTo: PERSONAL,
    });
    expect(chatState.selectedWorktree?.worktreeId).toBe(CODE_COPY.worktreeId);
  });

  it('preserves a selection made after context application while its reply is pending', async () => {
    scoping = ORG_1;
    let finishSwitch: () => void = () => undefined;
    let switchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      switchStarted = resolve;
    });
    contextState.setContext.mockImplementationOnce(
      (context) =>
        new Promise((resolve) => {
          scoping = context;
          contextListeners.forEach((listener): void => listener());
          finishSwitch = (): void => {
            resolve({ context });
          };
          switchStarted();
        }),
    );
    const chosen = { projectId: 'other-project', worktreeId: 'other-worktree' };
    const opening = openForkedContainer(CODE_COPY);
    const rejected = expect(opening).rejects.toThrow();
    await started;
    chatState.selectedWorktree = chosen;
    selectionListeners.forEach((listener): void => listener(chatState));
    finishSwitch();
    await rejected;
    expect(chatState.selectedWorktree).toEqual(chosen);
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });

  it('checks the account again after the final asynchronous reveal boundary', async () => {
    chatState.selectWorktree.mockImplementationOnce((projectId, worktreeId) => {
      chatState.selectedWorktree = { projectId, worktreeId };
      queueMicrotask((): void => {
        contextState.accountEpoch += 1;
      });
    });

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow();
    expect(navigationState.navigate).not.toHaveBeenCalled();
    expect(navigationState.requestForkedContainerFocus).not.toHaveBeenCalled();
  });

  it('serializes a pending Cowork selection before revealing a different copy', async () => {
    let finishSelection: () => void = () => undefined;
    let selectionStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      selectionStarted = resolve;
    });
    standaloneState.openWorkEntryFromSidebar.mockImplementationOnce(
      (projectId, entryId) =>
        new Promise<void>((resolve) => {
          finishSelection = (): void => {
            standaloneState.activeChatProjectId = projectId;
            standaloneState.activeWorkEntryId = entryId;
            resolve();
          };
          selectionStarted();
        }),
    );
    const older = openForkedContainer(COWORK_COPY);
    const rejected = expect(older).rejects.toThrow(
      'A newer request replaced opening the copy.',
    );
    await started;
    const newer = openForkedContainer(CODE_COPY);
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    finishSelection();
    await rejected;
    await newer;
    expect(navigationState.navigate).toHaveBeenCalledTimes(1);
    expect(navigationState.navigate).toHaveBeenCalledWith('main');
    expect(chatState.selectedWorktree).toEqual({
      projectId: CODE_COPY.projectId,
      worktreeId: CODE_COPY.worktreeId,
    });
    expect(navigationState.requestForkedContainerFocus).toHaveBeenCalledTimes(
      1,
    );
  });

  it('waits for deferred context restoration before installing the copy', async () => {
    scoping = ORG_1;
    let finishRestore: () => void = () => undefined;
    contextState.setContext.mockImplementationOnce(
      (context) =>
        new Promise((resolve) => {
          scoping = context;
          finishRestore = (): void => {
            chatState.selectedWorktree = {
              projectId: 'remembered',
              worktreeId: 'remembered',
            };
            resolve({ context });
          };
        }),
    );
    const opening = openForkedContainer(CODE_COPY);
    await Promise.resolve();
    await Promise.resolve();
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
    finishRestore();
    await opening;
    expect(chatState.selectedWorktree).toEqual({
      projectId: CODE_COPY.projectId,
      worktreeId: CODE_COPY.worktreeId,
    });
  });

  it('drops a reveal when the account changes during the reload', async () => {
    projectsState.loadProjects.mockImplementation(() => {
      projectsState.projects = listedProjects;
      contextState.accountEpoch += 1;
      return Promise.resolve();
    });

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow(
      'A newer request replaced opening the copy.',
    );
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
  });

  it('drops a reveal when the context changes independently during the reload', async () => {
    scoping = PERSONAL;
    projectsState.loadProjects.mockImplementation(() => {
      projectsState.projects = listedProjects;
      scoping = ORG_2;
      return Promise.resolve();
    });

    await expect(openForkedContainer(CODE_COPY)).rejects.toThrow(
      'The workspace context changed while opening the copy.',
    );
    expect(contextState.setContext).not.toHaveBeenCalled();
    expect(chatState.selectWorktree).not.toHaveBeenCalled();
  });
});
