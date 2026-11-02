/** @jest-environment jsdom */
import { create } from 'zustand';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { AutomationProjectCreationRequest } from '@/components/automations/InstallSharedAutomationModal';
jest.mock('../projectsStore', () => {
  const mockLoadProjects = jest.fn();
  const projects: SidebarItem[] = [];
  return {
    useProjectsStore: create(() => ({
      projects,
      loadProjects: mockLoadProjects,
    })),
  };
});
import { useProjectsStore } from '../projectsStore';
import { useNavigationStore } from '../navigationStore';
import {
  closeAutomationInstallContinuation,
  requestAutomationProjectCreation,
  recordAutomationCreatedProject,
  resumeAutomationInstall,
  useAutomationInstallContinuationStore,
} from '../automationInstallContinuationStore';
const mockLoadProjects = jest.mocked(useProjectsStore.getState().loadProjects);
const mockGetShared = jest.fn();

function makeCoworkProject(id: string): SidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#123456',
    collapsed: false,
    order: 0,
  };
}

function makeSingleRepoProject(id: string): SidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function request(): AutomationProjectCreationRequest {
  return {
    context: 'cowork',
    source: 'shared',
    detail: {
      id: 'share',
      contentHash: 'a'.repeat(64),
      automation: {
        version: 1,
        name: 'Daily summary',
        description: '',
        hasRunCondition: false,
        trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Summarize',
          plugins: [],
        },
      },
    },
    draft: {
      workspaceId: '',
      coworkWorkspaceId: '',
      existingBranch: 'develop',
      inputs: { ticket: '42' },
      chosenPipelineId: '',
    },
    onDone: jest.fn(),
  };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
  closeAutomationInstallContinuation();
  useNavigationStore.getState().closeAddWorkspaceModal();
  useProjectsStore.setState({ projects: [] });
  mockLoadProjects.mockReset().mockResolvedValue(undefined);
  mockGetShared.mockReset().mockResolvedValue(request().detail);
  Object.assign(window, {
    api: {
      automations: { getShared: mockGetShared },
      workspaceContext: {
        get: jest.fn().mockResolvedValue({
          context: { kind: 'organization', organizationId: 'org' },
        }),
      },
    },
  });
});
afterEach(() => {
  useNavigationStore.getState().closeAddWorkspaceModal();
  closeAutomationInstallContinuation();
});
it('retains the draft in the retry state when inventory refresh fails after the default loader would resolve', async () => {
  const original = request();
  mockLoadProjects.mockImplementation(
    (options?: { silent?: boolean; requireSuccess?: boolean }) =>
      options?.requireSuccess
        ? Promise.reject(new Error('inventory offline'))
        : Promise.resolve(),
  );
  requestAutomationProjectCreation(original);
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state).toMatchObject({
    status: 'error',
    error: 'inventory offline',
    continuation: { request: original },
  });
  expect(mockGetShared).not.toHaveBeenCalled();
});
it('swaps to creation once and resumes the same draft on cancellation', async () => {
  const original = request();
  requestAutomationProjectCreation(original);
  requestAutomationProjectCreation(request());
  expect(useNavigationStore.getState().addWorkspaceInitialProjectType).toBe(
    'cowork',
  );
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state).toMatchObject({
    status: 'ready',
    continuation: { request: original },
  });
  expect(mockLoadProjects).toHaveBeenCalledTimes(1);
  expect(mockGetShared).toHaveBeenCalledWith('share');
});
it('auto-selects one newly created compatible project after refreshing access and revision', async () => {
  requestAutomationProjectCreation(request());
  mockLoadProjects.mockImplementation(() => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('new'), makeSingleRepoProject('code')],
    });
    return Promise.resolve();
  });
  mockGetShared.mockResolvedValue({
    ...request().detail,
    contentHash: 'b'.repeat(64),
  });
  recordAutomationCreatedProject('new');
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state).toMatchObject({
    status: 'ready',
    createdProjectId: 'new',
    detail: { contentHash: 'b'.repeat(64) },
  });
});
it('leaves an ambiguous new-project choice explicit', async () => {
  requestAutomationProjectCreation(request());
  mockLoadProjects.mockImplementation(() => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('one'), makeCoworkProject('two')],
    });
    return Promise.resolve();
  });
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(
    useAutomationInstallContinuationStore.getState().state,
  ).not.toHaveProperty('createdProjectId');
});
it('retains a draft on refresh failure and retries the authoritative share', async () => {
  requestAutomationProjectCreation(request());
  mockGetShared.mockRejectedValueOnce(
    new Error('Access could not be verified'),
  );
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  const failed = useAutomationInstallContinuationStore.getState().state;
  expect(failed).toMatchObject({
    status: 'error',
    error: 'Access could not be verified',
    continuation: { request: { draft: { inputs: { ticket: '42' } } } },
  });
  if (failed.status !== 'error') throw new Error('expected error');
  await resumeAutomationInstall(failed.continuation);
  expect(useAutomationInstallContinuationStore.getState().state.status).toBe(
    'ready',
  );
});
it('discards a late refresh after the continuation is closed', async () => {
  let finish: ((value: unknown) => void) | undefined;
  mockGetShared.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  requestAutomationProjectCreation(request());
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  closeAutomationInstallContinuation();
  finish?.(request().detail);
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state.status).toBe(
    'closed',
  );
});

it('does not treat a concurrently provisioned default project as creation after cancellation', async () => {
  requestAutomationProjectCreation(request());
  mockLoadProjects.mockImplementation(() => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-default')],
    });
    return Promise.resolve();
  });
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(
    useAutomationInstallContinuationStore.getState().state,
  ).not.toHaveProperty('createdProjectId');
});

it('preserves the authoritative selected organization when the source context is still hydrating', async () => {
  requestAutomationProjectCreation(request());
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state).toMatchObject({
    status: 'ready',
    continuation: {
      workspaceContext: { kind: 'organization', organizationId: 'org' },
    },
  });
});

it('revalidates a stale renderer context against the selected main context', async () => {
  requestAutomationProjectCreation(request());
  const state = useAutomationInstallContinuationStore.getState().state;
  if (state.status !== 'creating') throw new Error('expected creation');
  state.continuation.workspaceContext = { kind: 'personal' };
  useNavigationStore.getState().closeAddWorkspaceModal();
  await settle();
  expect(useAutomationInstallContinuationStore.getState().state).toMatchObject({
    status: 'ready',
    continuation: {
      workspaceContext: { kind: 'organization', organizationId: 'org' },
    },
  });
});
