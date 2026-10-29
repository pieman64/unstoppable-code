import {
  SINGLE_REPO_USAGE_REPO_ID,
  type AgentAuditEntry,
  type UsageMetricsViewResponse,
} from '@canopy/desktop-shared/types';
import { buildTodayData } from '../today-statistics-data';

function metrics(
  rows: UsageMetricsViewResponse['rows'],
): UsageMetricsViewResponse {
  return {
    rows,
    resolvedWindow: {
      start: '2026-05-27T00:00:00.000Z',
      end: '2026-05-28T00:00:00.000Z',
    },
    earliestEventAt: '2026-05-27T00:00:00.000Z',
  };
}

function entry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'codex',
    label: 'Chat',
    startedAt: '2026-05-27T12:00:00.000Z',
    durationMs: 10,
    tokens: {
      input: 1,
      output: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 99,
    subAgentCount: 0,
    toolCounts: {
      thinking: 0,
      bash: 0,
      read: 0,
      readLines: 0,
      writeEdit: 0,
      fileEdit: 0,
      fileAdd: 0,
      fileDelete: 0,
      search: 0,
      grep: 0,
      web: 0,
      agent: 0,
      workflow: 0,
      tasks: 0,
      taskStop: 0,
      skills: 0,
      monitor: 0,
      claude: 0,
      scheduleWakeup: 0,
      askUser: 0,
      scriptOutput: 0,
      watcher: 0,
      canopy: 0,
      appAdvisor: 0,
      mcp: 0,
      other: 0,
    },
    hasTranscript: false,
    ...overrides,
  };
}

describe('buildTodayData', () => {
  it('uses local PR generation entries for PR repo activity', () => {
    const data = buildTodayData(
      [
        entry({
          eventType: 'pr_generation',
          repoId: 'workspace-repo-id',
          repoLabel: 'org/app',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.prs).toBe(1);
    expect(data.stats.repos).toBe(1);
    expect(data.repoRows).toEqual([
      {
        key: 'workspace-repo-id',
        label: 'org/app',
        count: 1,
      },
    ]);
  });

  it('keeps PR repo activity separate when labels collide', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pr_generation',
          repoId: 'frontend-api',
          repoLabel: 'api',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pr_generation',
          repoId: 'backend-api',
          repoLabel: 'api',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.prs).toBe(2);
    expect(data.stats.repos).toBe(2);
    expect(data.repoRows).toEqual([
      {
        key: 'backend-api',
        label: 'api',
        count: 1,
      },
      {
        key: 'frontend-api',
        label: 'api',
        count: 1,
      },
    ]);
  });

  it('groups single-repo PR activity by the underlying repo label', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pr_generation',
          projectId: 'workspace-a',
          worktreeId: 'worktree-a',
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoLabel: 'app',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pr_generation',
          projectId: 'workspace-a',
          worktreeId: 'worktree-b',
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoLabel: 'app',
        }),
        entry({
          id: 'entry-3',
          eventType: 'pr_generation',
          projectId: 'workspace-b',
          worktreeId: 'worktree-c',
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoLabel: 'api',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.prs).toBe(3);
    expect(data.stats.repos).toBe(2);
    expect(data.repoRows).toEqual([
      {
        key: 'workspace-a::app',
        label: 'app',
        count: 2,
      },
      {
        key: 'workspace-b::api',
        label: 'api',
        count: 1,
      },
    ]);
  });

  it('counts local PR-generation events without repo metadata', () => {
    const data = buildTodayData(
      [entry({ eventType: 'pr_generation' })],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.prs).toBe(1);
    expect(data.stats.repos).toBe(0);
    expect(data.repoRows).toEqual([]);
  });

  it('excludes PR-content helper entries from PR activity counts', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'helper-entry',
          eventType: 'pr_generation',
          label: 'PR Content Generation',
          repoId: 'repo-canopy',
          repoLabel: 'canopy',
        }),
        entry({
          id: 'created-entry-1',
          eventType: 'pr_generation',
          label: 'PR Created',
          repoId: 'repo-canopy',
          repoLabel: 'canopy',
        }),
        entry({
          id: 'created-entry-2',
          eventType: 'pr_generation',
          label: 'PR Created',
          repoId: 'repo-canopy',
          repoLabel: 'canopy',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.prs).toBe(2);
    expect(data.stats.repos).toBe(1);
    expect(data.repoRows).toEqual([
      {
        key: 'repo-canopy',
        label: 'canopy',
        count: 2,
      },
    ]);
  });

  it('uses tool metric rows as the canonical tools total', () => {
    const data = buildTodayData(
      [entry()],
      metrics([]),
      metrics([{ key: 'shell', label: 'Shell', count: 3 }]),
    );

    expect(data.stats.tools).toBe(3);
  });

  it('uses a readable fallback for pipeline rows without a pipeline id', () => {
    const data = buildTodayData(
      [
        entry({
          eventType: 'pipeline_step',
          pipelineExecutionId: 'execution-1234567890',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.pipelineRows).toEqual([
      {
        key: 'untitled-pipeline',
        label: 'Untitled pipeline',
        count: 1,
      },
    ]);
  });

  it('uses the pipeline name for pipeline detail rows when available', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pipeline_step',
          pipelineId: 'project--deploy.yaml',
          pipelineExecutionId: 'execution-1234567890',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pipeline_step',
          pipelineId: 'project--deploy.yaml',
          pipelineName: 'Deploy to Staging',
          pipelineExecutionId: 'execution-0987654321',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.pipelineRows).toEqual([
      {
        key: 'project--deploy.yaml',
        label: 'Deploy to Staging',
        count: 2,
      },
    ]);
  });

  it('counts each pipeline execution once in pipeline detail rows', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pipeline_step',
          pipelineId: 'project--deploy.yaml',
          pipelineName: 'Deploy to Staging',
          pipelineExecutionId: 'execution-1234567890',
          jobId: 'job-1',
          stepId: 'step-1',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pipeline_step',
          pipelineId: 'project--deploy.yaml',
          pipelineName: 'Deploy to Staging',
          pipelineExecutionId: 'execution-1234567890',
          jobId: 'job-2',
          stepId: 'step-2',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.pipelines).toBe(1);
    expect(data.pipelineRows).toEqual([
      {
        key: 'project--deploy.yaml',
        label: 'Deploy to Staging',
        count: 1,
      },
    ]);
  });

  it('upgrades a pipeline execution row when later audit entries include metadata', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pipeline_step',
          pipelineExecutionId: 'execution-1234567890',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pipeline_step',
          pipelineId: 'project--deploy.yaml',
          pipelineName: 'Deploy to Staging',
          pipelineExecutionId: 'execution-1234567890',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.pipelineRows).toEqual([
      {
        key: 'project--deploy.yaml',
        label: 'Deploy to Staging',
        count: 1,
      },
    ]);
  });

  it('merges orphaned pipeline executions into one fallback row', () => {
    const data = buildTodayData(
      [
        entry({
          id: 'entry-1',
          eventType: 'pipeline_step',
          pipelineExecutionId: 'execution-a',
        }),
        entry({
          id: 'entry-2',
          eventType: 'pipeline_step',
          pipelineExecutionId: 'execution-b',
        }),
      ],
      metrics([]),
      metrics([]),
    );

    expect(data.stats.pipelines).toBe(2);
    expect(data.pipelineRows).toEqual([
      {
        key: 'untitled-pipeline',
        label: 'Untitled pipeline',
        count: 2,
      },
    ]);
  });
});
