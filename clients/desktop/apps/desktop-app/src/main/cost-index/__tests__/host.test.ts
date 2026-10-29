/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Jest host fixtures use deliberately minimal async mocks. */
import { getDesktopCostIndexHost } from '../host';

const loadExecutionState = jest.fn();
const listExecutionSummaries = jest.fn();
const readChatTabsFile = jest.fn();
const readChatArchivesFile = jest.fn();
const getWorkspaceWorktreeCreatedAt = jest.fn();
const readWorkEntriesFile = jest.fn();
const getChatState = jest.fn();
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: () => ({ getState: getChatState }),
}));
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  loadExecutionState: (...args: unknown[]) => loadExecutionState(...args),
  listExecutionSummaries: (...args: unknown[]) =>
    listExecutionSummaries(...args),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]) => readChatTabsFile(...args),
}));
jest.mock('../../lib/chat-archives', () => ({
  readChatArchivesFile: (...args: unknown[]) => readChatArchivesFile(...args),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: (...args: unknown[]) =>
    getWorkspaceWorktreeCreatedAt(...args),
}));
jest.mock('../../lib/cowork-work-entries-file', () => ({
  readWorkEntriesFile: (...args: unknown[]) => readWorkEntriesFile(...args),
}));
jest.mock('../../lib/paths', () => ({
  getDataDir: () => '/local-data',
  getWorkspacesRootDir: () => '/local-data/workspaces',
  getEntryCostDir: (projectId: string, id: string) =>
    `/local-data/${projectId}/cost/${id}`,
  getCostIndexCheckpointPath: () => '/local-data/cost-index/checkpoint.json',
  getAgentObservabilityAuditDir: () => '/local-data/audit',
  getArchivedContainerCostDir: () => '/local-data/archive/cost',
  getArchivedContainerExecutionsDir: () =>
    '/local-data/archive/pipeline-executions',
}));

describe('cost trusted host read facts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readWorkEntriesFile.mockResolvedValue({ entries: [] });
    getChatState.mockResolvedValue({ runtimeByChatId: {} });
  });

  it('resolves Code, Cowork and Advisor incarnations from their own registries', async () => {
    const host = getDesktopCostIndexHost();
    getWorkspaceWorktreeCreatedAt.mockResolvedValue('2026-10-01T00:00:00.000Z');
    expect(
      (
        await host.resolveScope({
          kind: 'entry',
          projectId: 'code-1',
          worktreeId: 'entry-1',
        })
      )?.incarnation,
    ).toBe('2026-10-01T00:00:00.000Z');
    getWorkspaceWorktreeCreatedAt.mockResolvedValue(null);
    readWorkEntriesFile.mockResolvedValue({
      entries: [{ id: 'entry-1', createdAt: '2026-10-02T00:00:00.000Z' }],
    });
    expect(
      (
        await host.resolveScope({
          kind: 'entry',
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
        })
      )?.incarnation,
    ).toBe('2026-10-02T00:00:00.000Z');
    expect(
      (
        await host.resolveScope({
          kind: 'entry',
          projectId: 'app-advisor',
          worktreeId: 'entry-1',
        })
      )?.incarnation,
    ).toBe('2026-10-02T00:00:00.000Z');
    readWorkEntriesFile.mockResolvedValue({ entries: [] });
    expect(
      await host.resolveScope({
        kind: 'entry',
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
      }),
    ).toBeNull();
  });

  it('joins renamed and archived chats at read time, without persisting their labels', async () => {
    getChatState.mockResolvedValue({
      runtimeByChatId: { 'chat-1': { status: 'streaming' } },
    });
    readChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat-1',
          title: 'Original',
          description: 'New title',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    readChatArchivesFile.mockResolvedValue({
      archived: [{ tab: { id: 'chat-2', title: 'Archived title' } }],
    });
    expect(
      await getDesktopCostIndexHost().readChats({
        kind: 'entry',
        projectId: 'code-1',
        worktreeId: 'entry-1',
      }),
    ).toEqual([
      {
        chatId: 'chat-1',
        label: 'New title',
        state: 'open',
        running: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        chatId: 'chat-2',
        label: 'Archived title',
        state: 'archived',
        running: false,
      },
    ]);
  });

  function run(
    id: string,
    steps: Record<string, object>,
    definitions: object[],
    status = 'success',
  ): object {
    return {
      id,
      project_id: 'code-1',
      worktree_id: 'entry-1',
      status,
      pipeline_snapshot: { name: 'Pipeline' },
      jobs: { job: { steps } },
      job_definitions: { job: { steps: definitions } },
    };
  }

  it('reads non-agent counts from root and child execution states, including scripts with no audit record', async () => {
    loadExecutionState.mockImplementation(async (id: string) =>
      id === 'root-1'
        ? run(
            id,
            {
              agent: { agent_provider: 'claude' },
              script: {},
              child: { child_execution_id: 'child-1' },
            },
            [
              { id: 'agent', uses: 'builtin/agent-prompt' },
              { id: 'script', run: 'echo hi' },
              { id: 'child', uses: 'pipeline/example' },
            ],
          )
        : run(id, { script: {}, agent: {} }, [
            { id: 'script', run: 'echo child' },
            { id: 'agent', log_format_hint: 'agent' },
          ]),
    );
    expect(
      await getDesktopCostIndexHost().readPipelineRun(
        { kind: 'entry', projectId: 'code-1', worktreeId: 'entry-1' },
        'root-1',
      ),
    ).toEqual({
      nonAgentStepCount: 3,
      status: 'succeeded',
      pipelineName: 'Pipeline',
    });
    expect(loadExecutionState).toHaveBeenCalledWith(
      'child-1',
      '/local-data/pipeline-executions',
    );
  });

  it('omits the count when a child or a physical step definition is unavailable', async () => {
    loadExecutionState.mockImplementation(async (id: string) =>
      id === 'root-1'
        ? run(id, { child: { child_execution_id: 'missing-1' } }, [
            { id: 'child', uses: 'pipeline/example' },
          ])
        : null,
    );
    expect(
      await getDesktopCostIndexHost().readPipelineRun(
        { kind: 'entry', projectId: 'code-1', worktreeId: 'entry-1' },
        'root-1',
      ),
    ).toEqual({ status: 'succeeded', pipelineName: 'Pipeline' });
    loadExecutionState.mockResolvedValue(run('root-1', { missing: {} }, []));
    expect(
      await getDesktopCostIndexHost().readPipelineRun(
        { kind: 'entry', projectId: 'code-1', worktreeId: 'entry-1' },
        'root-1',
      ),
    ).toEqual({ status: 'succeeded', pipelineName: 'Pipeline' });
    loadExecutionState.mockResolvedValue(null);
    expect(
      await getDesktopCostIndexHost().readPipelineRun(
        { kind: 'entry', projectId: 'code-1', worktreeId: 'entry-1' },
        'root-1',
      ),
    ).toBeNull();
  });

  it("reads root run states for one entry's runs from the execution summaries", async () => {
    listExecutionSummaries.mockResolvedValue([
      {
        id: 'run-running',
        pipeline_name: 'Release review',
        status: 'running',
        project_id: 'code-1',
        worktree_id: 'entry-1',
      },
      {
        id: 'run-failed',
        pipeline_name: ' Build ',
        status: 'failure',
        project_id: 'code-1',
        worktree_id: 'entry-1',
      },
      {
        id: 'run-elsewhere',
        pipeline_name: 'Other',
        status: 'success',
        project_id: 'code-1',
        worktree_id: 'entry-2',
      },
    ]);
    const host = getDesktopCostIndexHost();

    const states = await host.readPipelineRunStates?.({
      kind: 'entry',
      projectId: 'code-1',
      worktreeId: 'entry-1',
    });

    expect(listExecutionSummaries).toHaveBeenCalledWith(
      '/local-data/pipeline-executions',
    );
    expect(Array.from(states?.entries() ?? [])).toEqual([
      ['run-running', { status: 'running', pipelineName: 'Release review' }],
      ['run-failed', { status: 'failed', pipelineName: 'Build' }],
    ]);
    // A retained scope's runs are sealed with their final status.
    expect(
      Array.from(
        (
          await host.readPipelineRunStates?.({
            kind: 'retained',
            projectId: 'code-1',
            containerId: 'entry-1',
          })
        )?.entries() ?? [],
      ),
    ).toEqual([]);
  });
});
