import { renderToString } from 'react-dom/server';
import type {
  PortalPipelineRun,
  PortalPipelineRunProjection,
  PortalPlan,
} from '@canopy/protocol/portal';

import {
  PipelineRunsSection,
  buildDagInputs,
  toDagJobStatus,
} from '../sections/PipelineRunsSection';
import {
  PlansSection,
  copyPlanToClipboard,
  stripPlanTitleLine,
} from '../sections/PlansSection';
import {
  RepoGroupedItemListSection,
  groupByRepo,
  type RepoGroupedEntry,
} from '../sections/RepoGroupedItemListSection';

describe('rich activity sections', () => {
  it('keeps Cursor plan execution unavailable on the paired host', () => {
    const html = renderToString(
      <PlansSection
        plans={[
          {
            localId: 'cursor-plan',
            title: 'Plan',
            source: 'cursor',
            status: 'draft',
            content: '# Plan',
          },
        ]}
        onImplementPlan={(): void => undefined}
        onRunPlanPipeline={(): void => undefined}
      />,
    );
    expect(html).not.toContain('activity-plan-send-cursor-plan');
    expect(html).not.toContain('activity-plan-pipeline-cursor-plan');
    expect(html).toContain('activity-plan-copy-cursor-plan');
  });

  it('maps pipeline job statuses and builds DAG progress metadata', () => {
    expect(toDagJobStatus('queued')).toBe('pending');
    expect(toDagJobStatus('failed')).toBe('failure');
    expect(toDagJobStatus('succeeded')).toBe('success');
    const dag = buildDagInputs([
      {
        jobId: 'build',
        name: 'Build',
        status: 'running',
        steps: [
          { stepId: 'one', name: 'One', status: 'success' },
          { stepId: 'two', name: 'Two', status: 'running' },
        ],
      },
    ]);
    expect(dag.tiers).toEqual([['build']]);
    expect(dag.jobs.build).toMatchObject({
      status: 'running',
      stepProgress: '1/2',
    });
  });

  it('shows active progress and keeps completed runs behind disclosure', () => {
    const runs: Array<
      PortalPipelineRunProjection & Pick<PortalPipelineRun, 'progress' | 'jobs'>
    > = [
      {
        localId: 'active',
        pipelineName: 'Build',
        status: 'running',
        worktreeLocalId: 'wt',
        startedAt: '2026-07-17T12:00:00Z',
        progress: { completedSteps: 2, totalSteps: 4 },
        jobs: [{ jobId: 'job', name: 'Job', status: 'running', steps: [] }],
      },
      {
        localId: 'done',
        pipelineName: 'Deploy',
        status: 'success',
        worktreeLocalId: 'wt',
        startedAt: '2026-07-17T11:00:00Z',
      },
    ];
    const html = renderToString(<PipelineRunsSection runs={runs} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(html).toContain('pipeline-run-row-active');
    expect(html).toContain('2/4 steps complete');
    expect(html).toContain('Completed (1)');
    expect(html).not.toContain('pipeline-run-row-done');
  });

  it('renders plan markdown actions and copies through the browser clipboard', async () => {
    const writeText = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const plan: PortalPlan = {
      localId: 'plan',
      title: 'Plan',
      status: 'draft',
      content: '# Plan\n\nRead [docs](https://example.com) and use `code`.',
    };
    const html = renderToString(
      <PlansSection plans={[plan]} onImplementPlan={(): void => undefined} />,
    );
    expect(html).toContain('activity-plan-body-plan');
    expect(html).toContain('activity-plan-copy-plan');
    expect(html).toContain('activity-plan-send-plan');
    await copyPlanToClipboard(plan.content ?? '');
    expect(writeText).toHaveBeenCalledWith(plan.content);
  });

  it('groups repoless entries first and repo entries behind named headers', () => {
    const entries: RepoGroupedEntry[] = [
      { item: { key: 'root', label: 'Root script' } },
      {
        repoId: 'repo-b',
        repoName: 'Beta',
        target: 'workspace-repo',
        item: { key: 'beta', label: 'Beta script' },
      },
      {
        repoId: 'repo-a',
        repoName: 'Alpha',
        target: 'workspace-repo',
        item: { key: 'alpha', label: 'Alpha script' },
      },
    ];
    const grouped = groupByRepo(entries);
    expect(grouped.repoless.map((entry) => entry.item.label)).toEqual([
      'Root script',
    ]);
    expect(grouped.repos.map((bucket) => bucket.repoName)).toEqual([
      'Beta',
      'Alpha',
    ]);
    const html = renderToString(
      <RepoGroupedItemListSection entries={entries} kind="scripts" />,
    );
    expect(html.indexOf('Root script')).toBeLessThan(html.indexOf('Beta'));
    expect(html).toContain('data-testid="portal-scripts-repo-header"');
    expect(html).not.toContain('Beta script');
  });

  it('strips only markdown heading titles from plan previews', () => {
    expect(stripPlanTitleLine('# Title\n\nBody text')).toBe('Body text');
    expect(stripPlanTitleLine('  ## Title\nBody')).toBe('Body');
    expect(stripPlanTitleLine('Opening prose line\nSecond line')).toBe(
      'Opening prose line\nSecond line',
    );
    expect(stripPlanTitleLine('')).toBe('');
  });

  it('auto-expands a repo bucket while a child run is active', () => {
    const entries: RepoGroupedEntry[] = [
      {
        repoId: 'repo-a',
        repoName: 'Alpha',
        target: 'workspace-repo',
        running: true,
        item: { key: 'alpha', label: 'Alpha script', status: 'running' },
      },
      {
        repoId: 'repo-b',
        repoName: 'Beta',
        target: 'workspace-repo',
        item: { key: 'beta', label: 'Beta script' },
      },
    ];
    const html = renderToString(
      <RepoGroupedItemListSection entries={entries} kind="scripts" />,
    );
    expect(html).toContain('Alpha script');
    expect(html).not.toContain('Beta script');
  });
});
