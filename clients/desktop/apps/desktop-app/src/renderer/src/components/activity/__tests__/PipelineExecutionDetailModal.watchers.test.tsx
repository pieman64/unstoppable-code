/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const DETAIL_SOURCE = readFileSync(
  join(__dirname, '..', 'details', 'PipelineExecutionDetail.tsx'),
  'utf-8',
);
const ACTION_BAR_SOURCE = readFileSync(
  join(__dirname, '..', 'details', 'PipelineExecutionActionBar.tsx'),
  'utf-8',
);
const ACTIONS_SOURCE = readFileSync(
  join(__dirname, '..', 'usePipelineExecutionActions.tsx'),
  'utf-8',
);

describe('PipelineExecutionDetail watcher controls', () => {
  it('hydrates watcher data and filters against the currently visible execution', () => {
    // One ref-counted bridge (which also hydrates) is shared by every detail
    // and run row instead of one IPC listener each.
    expect(ACTIONS_SOURCE).toContain(
      'return retainAppAdvisorWatchersBridge();',
    );
    expect(ACTIONS_SOURCE).not.toContain('.subscribeBridge()');
    expect(ACTIONS_SOURCE).toContain(
      'watchersForPipelineExecution(s.watchers, {',
    );
    expect(DETAIL_SOURCE).toContain('usePipelineExecutionWatchers(');
    expect(DETAIL_SOURCE).toContain(
      'projectId: summary?.project_id ?? state?.project_id,',
    );
    expect(DETAIL_SOURCE).toContain(
      'worktreeId: summary?.worktree_id ?? state?.worktree_id,',
    );
    expect(DETAIL_SOURCE).toContain('executionId: activeExecutionId,');
    expect(DETAIL_SOURCE).toContain(
      'pipelineId: summary?.pipeline_id ?? state?.pipeline_id,',
    );
  });

  it('keeps the top action bar visible when only watchers are present', () => {
    expect(ACTION_BAR_SOURCE).toContain(
      'const hasWatcherIndicator = watchers.length > 0;',
    );
    expect(ACTION_BAR_SOURCE).toContain(
      'if (!hasFollowUpActions && !hasWatcherIndicator && leading === undefined) {',
    );
  });

  it('inserts the watcher button as the first action before retry/rerun/debug controls', () => {
    // Both bar layouts (with and without a leading cell) render `content`,
    // which leads with the watcher indicator.
    const actionBar = ACTION_BAR_SOURCE.slice(
      ACTION_BAR_SOURCE.indexOf('const content = ('),
    );
    const watcherIdx = actionBar.indexOf('<WatcherManagementButton');
    const retryIdx = actionBar.indexOf('pipeline-detail-retry-');
    const rerunIdx = actionBar.indexOf('pipeline-detail-rerun-');
    const debugIdx = actionBar.indexOf('pipeline-detail-debug-failure-');

    expect(watcherIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(watcherIdx);
    expect(rerunIdx).toBeGreaterThan(watcherIdx);
    expect(debugIdx).toBeGreaterThan(watcherIdx);
    expect(actionBar).toContain('modalTitle="Pipeline watchers"');
    expect(actionBar).toContain(
      'modalEmptyMessage="No active watchers for this pipeline."',
    );
    expect(actionBar).toContain('ariaLabel="Manage pipeline watchers"');
    expect(actionBar).toContain(
      'dataTestId={`pipeline-detail-watchers-${executionId}`}',
    );
  });
});
