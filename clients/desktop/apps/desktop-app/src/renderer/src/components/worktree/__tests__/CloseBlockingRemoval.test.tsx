/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import type {
  ActivityLiveBgTasksRequest,
  ActivityLiveBgTasksResponse,
  CanopyApi,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { ProjectSettingsModal } from '../ProjectSettingsModal';
import { WorkspaceSettingsModal } from '../WorkspaceSettingsModal';
import { DesktopProjectDeletionDiscardHost } from '../DesktopProjectDeletionDiscardHost';
import { PROJECT_DELETION_DISCARD_DIALOG_TEST_ID } from '@canopy/ui-shared/components/ProjectDeletionDiscardDialog';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/portal/project-deletion-discard';
import { TeardownFailedError, useProjectsStore } from '@/stores/projectsStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const worktrees: WorktreeData[] = [
  {
    id: 'wt-idle',
    branchName: 'feature/idle',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'wt-busy',
    branchName: 'feature/busy',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

function singleRepoProject(): SingleRepoSidebarItem {
  return {
    id: 'single-project',
    type: 'single-repo',
    name: 'Single project',
    repoPath: '/repos/single-project',
    color: '#123456',
    worktrees,
    collapsed: false,
    order: 0,
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

function multiRepoWorkspace(): MultiRepoSidebarItem {
  return {
    id: 'multi-workspace',
    type: 'multi-repo',
    name: 'Multi workspace',
    color: '#123456',
    repos: [],
    worktrees,
    collapsed: false,
    order: 0,
  };
}

function snapshot(
  taskType?: 'local_agent' | 'local_bash',
): ActivityLiveBgTasksResponse {
  return taskType
    ? {
        chats: {
          'chat-root': {
            sessionActive: true,
            liveTasks: [{ taskId: 'task-1', taskType }],
          },
        },
      }
    : { chats: {} };
}

let container: HTMLDivElement;
let root: Root;
let archiveWorktree: jest.Mock;
let forceArchiveWorktree: jest.Mock;
let loadProjects: jest.Mock;
let removeProject: jest.Mock;
let deleteProject: jest.Mock;
let deleteWorkspace: jest.Mock;
let describeProjectDeletionDiscard: jest.Mock;
let discardWorktree: jest.Mock;
let checkWorktreeRemovalAdmission: jest.Mock<
  ReturnType<CanopyApi['checkWorktreeRemovalAdmission']>,
  Parameters<CanopyApi['checkWorktreeRemovalAdmission']>
>;
let listLiveBgTasks: jest.Mock<
  Promise<ActivityLiveBgTasksResponse>,
  [ActivityLiveBgTasksRequest]
>;

function installWindowApi(): void {
  listLiveBgTasks = jest.fn<
    Promise<ActivityLiveBgTasksResponse>,
    [ActivityLiveBgTasksRequest]
  >(() => Promise.resolve(snapshot()));
  deleteProject = jest.fn().mockResolvedValue(undefined);
  deleteWorkspace = jest.fn().mockResolvedValue(undefined);
  describeProjectDeletionDiscard = jest
    .fn()
    .mockResolvedValue({ status: 'refused', items: [] });
  discardWorktree = jest.fn().mockResolvedValue({
    status: 'discarded',
    removed: ['live-checkout'],
    gitCleanup: [],
    warnings: [],
  });
  checkWorktreeRemovalAdmission = jest.fn<
    ReturnType<CanopyApi['checkWorktreeRemovalAdmission']>,
    Parameters<CanopyApi['checkWorktreeRemovalAdmission']>
  >(() => Promise.resolve({ status: 'admitted' }));
  const api: Record<string, unknown> = {
    activity: { listLiveBgTasks },
    checkWorktreeRemovalAdmission,
    deleteProject,
    deleteWorkspace,
    describeProjectDeletionDiscard,
    discardWorktree,
    getRemoteUrl: jest.fn().mockResolvedValue({ remoteUrl: null }),
    getDefaultCloneDirectory: jest.fn().mockResolvedValue('/repos'),
    getWorkspaceSettingsData: jest
      .fn()
      .mockRejectedValue(new Error('settings data is not needed')),
    onProjectSourceChangesApplied: jest.fn(() => (): void => undefined),
    onWorkspaceSourceChangesApplied: jest.fn(() => (): void => undefined),
  };
  const fallback = new Proxy(api, {
    get(target, key: string): unknown {
      return key in target
        ? target[key]
        : jest.fn(() => Promise.resolve(undefined));
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: fallback,
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function clickButton(label: string): void {
  // The last match: an open dialog renders after the page it covers.
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  )
    .filter((candidate) => candidate.textContent?.trim() === label)
    .pop();
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

/** Removing the project is the last row of General, where the page opens. */
async function openProjectDangerTab(): Promise<void> {
  act(() => {
    root.render(
      <CanopyClientProvider client={createFakeClient().client}>
        <ProjectSettingsModal
          isOpen
          onClose={jest.fn()}
          project={singleRepoProject()}
        />
      </CanopyClientProvider>,
    );
  });
  await flush();
}

async function openWorkspaceDangerTab(): Promise<void> {
  act(() => {
    root.render(
      <CanopyClientProvider client={createFakeClient().client}>
        <WorkspaceSettingsModal
          isOpen
          onClose={jest.fn()}
          workspace={multiRepoWorkspace()}
        />
      </CanopyClientProvider>,
    );
  });
  await flush();
  clickButton('Danger');
  await flush();
}

beforeEach(() => {
  installWindowApi();
  archiveWorktree = jest.fn().mockResolvedValue(undefined);
  forceArchiveWorktree = jest
    .fn()
    .mockRejectedValue(new Error(SOURCE_UNAVAILABLE));
  loadProjects = jest.fn().mockResolvedValue(undefined);
  removeProject = jest.fn();
  useProjectsStore.setState({
    projects: [singleRepoProject(), multiRepoWorkspace()],
    archiveWorktree,
    forceArchiveWorktree,
    loadProjects,
    removeProject,
  });
  resetDelegationActivityStoreForTests();
  resetLiveBackgroundTaskStoreForTests();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const SOURCE_UNAVAILABLE =
  "Couldn't verify the worktree's source repositories. Check repository access and retry.";

function teardownFailure(projectId: string): TeardownFailedError {
  return new TeardownFailedError({
    projectId,
    worktreeId: 'wt-idle',
    output: '',
    timedOut: false,
  });
}

describe('ProjectSettingsModal close-blocking deletion', () => {
  it('checks every worktree source before the first archive and stops when a later one is refused', async () => {
    checkWorktreeRemovalAdmission.mockResolvedValue({
      status: 'refused',
      worktreeId: 'wt-busy',
      reason: 'source-unavailable',
      message: SOURCE_UNAVAILABLE,
    });
    await openProjectDangerTab();

    clickButton('Remove…');
    clickButton('Remove');
    await flush();

    expect(checkWorktreeRemovalAdmission).toHaveBeenCalledWith({
      workspaceId: 'single-project',
      worktreeIds: ['wt-idle', 'wt-busy'],
      expectedKind: 'single-repo',
    });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(SOURCE_UNAVAILABLE);
  });

  it.each(['Delete without teardown', 'Try again'])(
    'shows a refusal from %s after a teardown failure',
    async (action) => {
      archiveWorktree
        .mockRejectedValueOnce(teardownFailure('single-project'))
        .mockRejectedValueOnce(new Error(SOURCE_UNAVAILABLE));
      await openProjectDangerTab();

      clickButton('Remove…');
      clickButton('Remove');
      await flush();
      clickButton(action);
      await flush();

      expect(document.body.textContent).toContain(SOURCE_UNAVAILABLE);
      expect(deleteProject).not.toHaveBeenCalled();
    },
  );

  it('does not archive or delete the project when the source check fails', async () => {
    checkWorktreeRemovalAdmission.mockRejectedValue(new Error('IPC failed'));
    await openProjectDangerTab();

    clickButton('Remove…');
    clickButton('Remove');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    // Settings show our own sentence, never the raw exception.
    expect(document.body.textContent).toContain(
      'Couldn’t delete the project. Try again.',
    );
    expect(document.body.textContent).not.toContain('IPC failed');
  });

  it('does not archive any worktree or delete the project when a target cannot be checked', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      request.worktreeId === 'wt-busy'
        ? Promise.reject(new Error('live-task pull failed'))
        : Promise.resolve(snapshot()),
    );
    await openProjectDangerTab();

    clickButton('Remove…');
    clickButton('Remove');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Couldn't check for running background agents or workflows. Try again.",
    );
  });
  it('does not archive any worktree or delete the project when an unvisited worktree has a live agent', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      Promise.resolve(
        request.worktreeId === 'wt-busy' ? snapshot('local_agent') : snapshot(),
      ),
    );
    await openProjectDangerTab();

    clickButton('Remove…');
    clickButton('Remove');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Background agents or workflows are still running here. Stop them first.',
    );
  });

  it('allows project deletion when a worktree only has shell work', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      Promise.resolve(
        request.worktreeId === 'wt-busy' ? snapshot('local_bash') : snapshot(),
      ),
    );
    await openProjectDangerTab();

    clickButton('Remove…');
    clickButton('Remove');
    await flush();

    expect(archiveWorktree).toHaveBeenCalledTimes(2);
    expect(deleteProject).toHaveBeenCalledWith({ projectId: 'single-project' });
  });

  it('prefers delegate removal copy and does not archive when delegates are live', async () => {
    await openProjectDangerTab();
    clickButton('Remove…');
    act(() => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'single-project',
        worktreeId: 'wt-busy',
        chatId: 'chat-root',
        live: 1,
        queued: 0,
      });
    });
    clickButton('Remove');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Delegates are still running here. Stop them first.',
    );
  });

  it('reactively disables project deletion when a known provider task is live', async () => {
    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'single-project',
      worktreeId: 'wt-busy',
      chatId: 'chat-root',
      sessionActive: true,
      liveTasks: [{ taskId: 'task-1', taskType: 'local_agent' }],
    });
    await openProjectDangerTab();

    const trigger = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Remove…');
    expect(trigger?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'Background agents or workflows are still running here. Stop them first.',
    );
  });
});

describe('WorkspaceSettingsModal close-blocking deletion', () => {
  it('checks every worktree source before the first archive and stops when a later one is refused', async () => {
    checkWorktreeRemovalAdmission.mockResolvedValue({
      status: 'refused',
      worktreeId: 'wt-busy',
      reason: 'source-unavailable',
      message: SOURCE_UNAVAILABLE,
    });
    await openWorkspaceDangerTab();

    clickButton('Delete project…');
    clickButton('Confirm delete');
    await flush();

    expect(checkWorktreeRemovalAdmission).toHaveBeenCalledWith({
      workspaceId: 'multi-workspace',
      worktreeIds: ['wt-idle', 'wt-busy'],
      expectedKind: 'multi-repo',
    });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(removeProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(SOURCE_UNAVAILABLE);
  });

  it.each(['Delete without teardown', 'Try again'])(
    'shows a refusal from %s after a teardown failure',
    async (action) => {
      archiveWorktree
        .mockRejectedValueOnce(teardownFailure('multi-workspace'))
        .mockRejectedValueOnce(new Error(SOURCE_UNAVAILABLE));
      await openWorkspaceDangerTab();

      clickButton('Delete project…');
      clickButton('Confirm delete');
      await flush();
      clickButton(action);
      await flush();

      expect(document.body.textContent).toContain(SOURCE_UNAVAILABLE);
      expect(deleteWorkspace).not.toHaveBeenCalled();
    },
  );

  it('does not archive any worktree or delete the workspace when a target cannot be checked', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      request.worktreeId === 'wt-busy'
        ? Promise.reject(new Error('live-task pull failed'))
        : Promise.resolve(snapshot()),
    );
    await openWorkspaceDangerTab();

    clickButton('Delete project…');
    clickButton('Confirm delete');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Couldn't check for running background agents or workflows. Try again.",
    );
  });
  it('does not archive any worktree or delete the workspace when an unvisited worktree has a live agent', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      Promise.resolve(
        request.worktreeId === 'wt-busy' ? snapshot('local_agent') : snapshot(),
      ),
    );
    await openWorkspaceDangerTab();

    clickButton('Delete project…');
    clickButton('Confirm delete');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Background agents or workflows are still running here. Stop them first.',
    );
  });

  it('allows workspace deletion when a worktree only has shell work', async () => {
    listLiveBgTasks.mockImplementation((request: ActivityLiveBgTasksRequest) =>
      Promise.resolve(
        request.worktreeId === 'wt-busy' ? snapshot('local_bash') : snapshot(),
      ),
    );
    await openWorkspaceDangerTab();

    clickButton('Delete project…');
    clickButton('Confirm delete');
    await flush();

    expect(archiveWorktree).toHaveBeenCalledTimes(2);
    expect(deleteWorkspace).toHaveBeenCalledWith({
      workspaceId: 'multi-workspace',
    });
  });

  it('prefers delegate removal copy and does not archive when delegates are live', async () => {
    await openWorkspaceDangerTab();
    clickButton('Delete project…');
    act(() => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'multi-workspace',
        worktreeId: 'wt-busy',
        chatId: 'chat-root',
        live: 1,
        queued: 0,
      });
    });
    clickButton('Confirm delete');
    await flush();

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Delegates are still running here. Stop them first.',
    );
  });

  it('reactively disables workspace deletion when a known provider task is live', async () => {
    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'multi-workspace',
      worktreeId: 'wt-busy',
      chatId: 'chat-root',
      sessionActive: true,
      liveTasks: [{ taskId: 'task-1', taskType: 'local_agent' }],
    });
    await openWorkspaceDangerTab();

    const trigger = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Delete project…');
    expect(trigger?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'Background agents or workflows are still running here. Stop them first.',
    );
  });
});

describe('CAN-5337 a deletion refused only for discardable worktrees', () => {
  function blockedDescription(
    workspaceId: string,
  ): ProjectDeletionDiscardDescription {
    return {
      version: 1,
      workspaceId,
      status: 'discardable',
      items: [
        {
          worktreeName: 'feature/busy',
          description: {
            version: 1,
            workspaceId,
            worktreeId: 'wt-busy',
            createdAt: '2026-01-02T00:00:00.000Z',
            status: 'discardable',
            causes: ['source-gone'],
            sources: [],
            targets: [
              {
                kind: 'live-checkout',
                path: `/data/${workspaceId}/worktrees/wt-busy`,
                identity: '1:2',
                identityVerified: false,
                reason: 'source-gone',
              },
            ],
            alsoDeleted: ['chats'],
            preserved: ['source-working-files', 'branches'],
            mayRemain: [],
            confirmation: 'token-busy',
          },
        },
      ],
    };
  }

  function discardDialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}"]`,
    );
  }

  it.each([
    {
      kind: 'single-repo project',
      projectId: 'single-project',
      modal: (): JSX.Element => (
        <ProjectSettingsModal
          isOpen
          onClose={jest.fn()}
          project={singleRepoProject()}
        />
      ),
      open: async (): Promise<void> => {
        clickButton('Remove…');
        clickButton('Remove');
        await flush();
      },
      deleted: (): jest.Mock => deleteProject,
    },
    {
      kind: 'multi-repo project',
      projectId: 'multi-workspace',
      modal: (): JSX.Element => (
        <WorkspaceSettingsModal
          isOpen
          onClose={jest.fn()}
          workspace={multiRepoWorkspace()}
        />
      ),
      open: async (): Promise<void> => {
        clickButton('Danger');
        await flush();
        clickButton('Delete project…');
        clickButton('Confirm delete');
        await flush();
      },
      deleted: (): jest.Mock => deleteWorkspace,
    },
  ])(
    'a $kind opens one confirmation, drops each discarded worktree from the store, then archives the rest and deletes',
    async ({ projectId, modal, open, deleted }) => {
      checkWorktreeRemovalAdmission
        .mockResolvedValueOnce({
          status: 'refused',
          worktreeId: 'wt-busy',
          reason: 'source-unavailable',
          message: SOURCE_UNAVAILABLE,
        })
        .mockResolvedValue({ status: 'admitted' });
      describeProjectDeletionDiscard.mockResolvedValue(
        blockedDescription(projectId),
      );
      act(() => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            {modal()}
            <DesktopProjectDeletionDiscardHost />
          </CanopyClientProvider>,
        );
      });
      await flush();
      await open();
      await flush();

      // CAN-5338: the shared store always asks for retained archives too.
      expect(describeProjectDeletionDiscard).toHaveBeenCalledWith({
        workspaceId: projectId,
        retainedArchives: true,
      });
      expect(discardDialog()?.textContent).toContain(
        `/data/${projectId}/worktrees/wt-busy`,
      );
      // The confirmation replaces the refusal; nothing ran yet.
      expect(document.body.textContent).not.toContain(SOURCE_UNAVAILABLE);
      expect(discardWorktree).not.toHaveBeenCalled();
      expect(archiveWorktree).not.toHaveBeenCalled();

      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-confirm"]`,
          )
          ?.click(),
      );
      await flush();
      await flush();

      expect(discardWorktree).toHaveBeenCalledWith({
        projectId,
        worktreeId: 'wt-busy',
        confirmation: 'token-busy',
      });
      // The retry read the store after the discard dropped the worktree.
      expect(archiveWorktree.mock.calls).toEqual([[projectId, 'wt-idle']]);
      expect(deleted()).toHaveBeenCalledTimes(1);
      expect(discardDialog()).toBeNull();
    },
  );

  // Its retry runs only in a mounted modal, so confirming an offer from a
  // closed one would discard and still leave the project in place.
  it.each([
    {
      kind: 'single-repo project',
      projectId: 'single-project',
      modal: (): JSX.Element => (
        <ProjectSettingsModal
          isOpen
          onClose={jest.fn()}
          project={singleRepoProject()}
        />
      ),
      open: (): void => {
        clickButton('Remove…');
        clickButton('Remove');
      },
    },
    {
      kind: 'multi-repo project',
      projectId: 'multi-workspace',
      modal: (): JSX.Element => (
        <WorkspaceSettingsModal
          isOpen
          onClose={jest.fn()}
          workspace={multiRepoWorkspace()}
        />
      ),
      open: (): void => {
        clickButton('Danger');
        clickButton('Delete project…');
        clickButton('Confirm delete');
      },
    },
  ])(
    'a $kind refused after its settings closed offers no discard',
    async ({ projectId, modal, open }) => {
      let refuse: (() => void) | undefined;
      checkWorktreeRemovalAdmission.mockReturnValue(
        new Promise((resolve) => {
          refuse = (): void =>
            resolve({
              status: 'refused',
              worktreeId: 'wt-busy',
              reason: 'source-unavailable',
              message: SOURCE_UNAVAILABLE,
            });
        }),
      );
      describeProjectDeletionDiscard.mockResolvedValue(
        blockedDescription(projectId),
      );
      const render = (withModal: boolean): void =>
        act(() => {
          root.render(
            <CanopyClientProvider client={createFakeClient().client}>
              {withModal ? modal() : null}
              <DesktopProjectDeletionDiscardHost />
            </CanopyClientProvider>,
          );
        });
      render(true);
      await flush();
      open();
      await flush();
      expect(checkWorktreeRemovalAdmission).toHaveBeenCalledTimes(1);

      render(false);
      refuse?.();
      await flush();
      await flush();

      expect(describeProjectDeletionDiscard).not.toHaveBeenCalled();
      expect(discardDialog()).toBeNull();
    },
  );

  it('keeps the refusal when nothing can be discarded', async () => {
    checkWorktreeRemovalAdmission.mockResolvedValue({
      status: 'refused',
      worktreeId: 'wt-busy',
      reason: 'source-unavailable',
      message: SOURCE_UNAVAILABLE,
    });
    act(() => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <ProjectSettingsModal
            isOpen
            onClose={jest.fn()}
            project={singleRepoProject()}
          />
          <DesktopProjectDeletionDiscardHost />
        </CanopyClientProvider>,
      );
    });
    await flush();
    clickButton('Remove…');
    clickButton('Remove');
    await flush();
    await flush();

    expect(describeProjectDeletionDiscard).toHaveBeenCalledTimes(1);
    expect(discardDialog()).toBeNull();
    expect(document.body.textContent).toContain(SOURCE_UNAVAILABLE);
  });
});
