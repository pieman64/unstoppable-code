/** @jest-environment jsdom */

import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { openAgentArtifactNavigation } from '../agent-artifact-navigation';

const getWorktreePath = jest.fn();
const discoverProject = jest.fn();
const openAgentArtifact = jest.fn();
const detectChatStoreSurface = jest.fn(() => 'main');
const addToast = jest.fn();
const openLink = jest.fn(() => Promise.resolve());

const openPipelineExecutionFromUi = jest.fn(() =>
  Promise.resolve({ status: 'applied' }),
);

jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => detectChatStoreSurface(),
}));
jest.mock('@/lib/navigation/page-availability', () => ({
  ...jest.requireActual<object>('@/lib/navigation/page-availability'),
  getPageAvailability: (page: string): { available: true; page: string } => ({
    available: true,
    page,
  }),
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUi(request),
}));

function setSharedCustomAgentsEnabled(enabled: boolean): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.getState().setSnapshot({
    ...base,
    values: {
      ...base.values,
      [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
    },
    status: 'ready',
    initialized: true,
  });
}

describe('openAgentArtifactNavigation', () => {
  afterAll(() => {
    useFeatureFlagsStore
      .getState()
      .setSnapshot(getDefaultFeatureFlagSnapshot());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    detectChatStoreSurface.mockReturnValue('main');
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
      pendingAutomationRunFocus: undefined,
      pendingPluginsNavigation: undefined,
    });
    setSharedCustomAgentsEnabled(true);
    useGitHubStore.setState({ addToast });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getWorktreePath,
        appAdvisor: { openAgentArtifact },
        browser: { openLink },
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { discoverProject },
    });
  });

  it('opens a workflow run on this computer from a window showing another one', async () => {
    detectChatStoreSurface.mockReturnValue('app-advisor');
    const openLink = jest.fn();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: { openAgentArtifact },
        browser: { openLink },
        remoteControl: {
          getContext: () => ({
            mode: 'remote',
            deviceId: 'device-b',
            name: 'Studio',
            platform: 'darwin',
          }),
        },
      },
    });

    await openAgentArtifactNavigation({
      kind: 'github_workflow_run',
      repository: 'unstoppabledomains/canopy',
      runId: '42',
      htmlUrl: 'https://github.com/unstoppabledomains/canopy/actions/runs/42',
    });

    expect(open).toHaveBeenCalledWith(
      'https://github.com/unstoppabledomains/canopy/actions/runs/42',
      '_blank',
      'noopener,noreferrer',
    );
    expect(openAgentArtifact).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('shows App Advisor navigation failures as an error toast', async () => {
    detectChatStoreSurface.mockReturnValue('app-advisor');
    openAgentArtifact.mockResolvedValue({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Shared pipeline not found.',
        retryable: false,
      },
    });

    await openAgentArtifactNavigation({
      kind: 'pipeline_editor',
      pipelineId: 'shared:canopy-cloud:missing',
      source: 'shared',
      sharedRemoteId: 'missing',
    });

    expect(addToast).toHaveBeenCalledWith(
      'Shared pipeline not found.',
      'error',
    );
  });

  it("opens a pipeline run in its own panel with the receipt's owner and job", async () => {
    await openAgentArtifactNavigation({
      kind: 'pipeline_execution',
      executionId: 'run-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      jobId: 'deploy',
    });

    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'run-1',
      owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
      target: { jobId: 'deploy' },
    });
    expect(openAgentArtifact).not.toHaveBeenCalled();
  });

  it('hands a pipeline run off to the main window with its owner and job from App Advisor', async () => {
    detectChatStoreSurface.mockReturnValue('app-advisor');
    openAgentArtifact.mockResolvedValue({ ok: true });
    const request = {
      kind: 'pipeline_execution' as const,
      executionId: 'run-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      jobId: 'deploy',
    };

    await openAgentArtifactNavigation(request);

    expect(openAgentArtifact).toHaveBeenCalledWith(request);
    expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
  });

  it('opens shared pipelines by their remote identity', async () => {
    await openAgentArtifactNavigation({
      kind: 'pipeline_editor',
      pipelineId: 'shared:canopy-cloud:remote-1',
      source: 'shared',
      sharedRemoteId: 'remote-1',
    });

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: null,
      sharedRemoteId: 'remote-1',
    });
  });

  it('resolves project pipeline cwd and file locators before opening', async () => {
    getWorktreePath.mockResolvedValue('/repo');
    discoverProject.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'project--build.yaml',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/build.yaml',
        },
      ],
    });

    await openAgentArtifactNavigation({
      kind: 'pipeline_editor',
      pipelineId: 'project--build.yaml',
      source: 'project',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });

    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'project--build.yaml',
      cwd: '/repo',
      filePath: '/repo/.canopy/pipelines/build.yaml',
    });
  });

  it('shows project pipeline lookup failures as an error toast', async () => {
    getWorktreePath.mockResolvedValue('/repo');
    discoverProject.mockResolvedValue({ success: true, data: [] });

    await openAgentArtifactNavigation({
      kind: 'pipeline_editor',
      pipelineId: 'project--missing.yaml',
      source: 'project',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    expect(addToast).toHaveBeenCalledWith(
      'Project pipeline project--missing.yaml not found.',
      'error',
    );
  });

  it("opens an automation run's Runs section and stages the run selection", async () => {
    await openAgentArtifactNavigation({
      kind: 'automation_editor',
      activityId: 'act-1',
      section: 'runs',
      runId: 'run-1',
    });

    const state = useNavigationStore.getState();
    expect(state.workflowEdit).toMatchObject({
      kind: 'automation',
      activityId: 'act-1',
      section: 'runs',
    });
    expect(state.pendingAutomationRunFocus).toEqual({
      activityId: 'act-1',
      runId: 'run-1',
    });
  });

  it("opens a local agent's editor over its Marketplace detail", async () => {
    await openAgentArtifactNavigation({
      kind: 'agent_editor',
      agentId: 'agent-1',
    });

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'agent:local:agent-1',
      intent: 'edit',
    });
    expect(addToast).not.toHaveBeenCalled();
  });

  it('refuses a local agent editor while agents are switched off', async () => {
    setSharedCustomAgentsEnabled(false);

    await openAgentArtifactNavigation({
      kind: 'agent_editor',
      agentId: 'agent-1',
    });

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('overview');
    expect(state.pendingPluginsNavigation).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('Agents are not available.', 'error');
  });

  it('opens shared agents and capability entries as Plugins entry details', async () => {
    await openAgentArtifactNavigation({ kind: 'shared_agent', agentId: 'a1' });
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'agent:shared:a1',
    });

    await openAgentArtifactNavigation({
      kind: 'capability_entry',
      entry: {
        type: 'marketplace-plugin',
        marketplaceId: 'mk',
        pluginName: 'lint',
      },
    });
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'mkt:mk/lint',
    });
  });

  it('opens only validated HTTPS references in the browser', async () => {
    await openAgentArtifactNavigation({
      kind: 'external_url',
      url: 'https://example.com/skill',
    });
    expect(openLink).toHaveBeenCalledWith({ url: 'https://example.com/skill' });

    await openAgentArtifactNavigation({
      kind: 'external_url',
      url: 'http://example.com/skill',
    });
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      'This link cannot be opened.',
      'error',
    );
  });
});
