/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import { watchersForPipelineExecution } from '@/components/watchers/watcherFilters';

const PIPELINE_RUNS_SOURCE = readFileSync(
  join(__dirname, '..', 'PipelineRunsSection.tsx'),
  'utf-8',
);
const PIPELINE_RUN_ROWS_SOURCE = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-app/src/code/activity/pipeline/PipelineRunRows.tsx',
  ),
  'utf-8',
);

function pipelineWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? 'watcher-1',
    trigger: overrides.trigger ?? 'worktree_pipeline_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'Pipeline watcher',
    target:
      overrides.target ??
      ({
        kind: 'worktree_pipeline',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      } as AppAdvisorWatcherSummary['target']),
    destination:
      overrides.destination ??
      ({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
      } as AppAdvisorWatcherSummary['destination']),
    createdAt: overrides.createdAt ?? '2026-05-27T00:00:00.000Z',
  };
}

describe('PipelineRunsSection watcher indicators', () => {
  it('uses the shared active execution gate for run-row cancellation so paused runs can be cancelled', () => {
    expect(PIPELINE_RUN_ROWS_SOURCE).toContain(
      'isPipelineExecutionActiveStatus(summary.status) && (',
    );
    expect(PIPELINE_RUN_ROWS_SOURCE).not.toContain(
      "summary.status === 'running' && (",
    );
  });

  it('hydrates watcher data once for the activity panel and filters each row by execution scope', () => {
    // The shared ref-counted bridge hydrates the store; rows filter through
    // the shared execution watcher hook.
    expect(PIPELINE_RUNS_SOURCE).toContain(
      'useEffect(() => retainAppAdvisorWatchersBridge(), []);',
    );
    expect(PIPELINE_RUNS_SOURCE).not.toContain('.subscribeBridge()');
    expect(PIPELINE_RUNS_SOURCE).toContain('usePipelineExecutionWatchers({');
    expect(PIPELINE_RUNS_SOURCE).toContain('projectId: summary.project_id');
    expect(PIPELINE_RUNS_SOURCE).toContain('worktreeId: summary.worktree_id');
    expect(PIPELINE_RUNS_SOURCE).toContain('executionId: summary.id');
    expect(PIPELINE_RUNS_SOURCE).toContain('pipelineId: summary.pipeline_id');
  });

  it('renders WatcherManagementButton on active and completed rows immediately after the Advisor badge', () => {
    const advisorFirst = PIPELINE_RUN_ROWS_SOURCE.indexOf(
      '{renderAdvisorBadge?.(summary)}',
    );
    const watcherAfterAdvisor = PIPELINE_RUN_ROWS_SOURCE.indexOf(
      '{renderWatcherButton?.(summary)}',
      advisorFirst,
    );
    expect(advisorFirst).toBeGreaterThan(-1);
    expect(watcherAfterAdvisor).toBeGreaterThan(advisorFirst);
    expect(PIPELINE_RUNS_SOURCE).toContain('modalTitle="Pipeline watchers"');
    expect(PIPELINE_RUNS_SOURCE).toContain(
      'modalEmptyMessage="No active watchers for this pipeline."',
    );
    expect(PIPELINE_RUNS_SOURCE).toContain(
      'ariaLabel="Manage pipeline watchers"',
    );
    expect(PIPELINE_RUNS_SOURCE).toContain(
      'dataTestId={`pipeline-run-watchers-${summary.id}`}',
    );
  });

  it('matches exact execution, pipeline-wide, and worktree-wide pipeline watcher scopes while excluding unrelated watchers', () => {
    const watchers = [
      pipelineWatcher({
        id: 'exact',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          executionId: 'execution-1',
        },
      }),
      pipelineWatcher({
        id: 'pipeline',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'pipeline-1',
        },
      }),
      pipelineWatcher({ id: 'worktree' }),
      pipelineWatcher({
        id: 'other-execution',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          executionId: 'execution-2',
        },
      }),
      pipelineWatcher({
        id: 'fired',
        status: 'fired',
      }),
    ];

    expect(
      watchersForPipelineExecution(watchers, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        executionId: 'execution-1',
        pipelineId: 'pipeline-1',
      }).map((watcher) => watcher.id),
    ).toEqual(['exact', 'pipeline', 'worktree']);
  });
});
