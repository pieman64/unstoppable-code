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
import { PlansSection, stripPlanTitleLine } from '../sections/PlansSection';
import {
  RepoGroupedItemListSection,
  groupByRepo,
  type RepoGroupedEntry,
} from '../sections/RepoGroupedItemListSection';

describe('rich activity sections', () => {
  it('keeps an unloaded plan Copy visible with an accessible reason beside Load', () => {
    const html = renderToString(
      <PlansSection
        plans={[{ localId: 'unloaded', title: 'Plan', status: 'pending' }]}
        onGetPlan={(): void => undefined}
      />,
    );
    expect(html).toContain('activity-plan-copy-unloaded');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Load');
  });
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

  it.each([
    ['pending', 'Pending', 'warning'],
    ['approved', 'Approved', 'success'],
    ['dismissed', 'Dismissed', 'neutral'],
    ['archived', 'Archived', 'neutral'],
  ])(
    'shows the stored %s review status as the shared badge',
    (reviewStatus, label, tone) => {
      const html = renderToString(
        <PlansSection
          plans={[
            {
              localId: 'plan',
              title: 'Plan',
              content: '# Plan',
              status: 'draft',
              reviewStatus,
            },
          ]}
          onImplementPlan={(): void => undefined}
        />,
      );
      expect(html).toMatch(
        new RegExp(
          `data-testid="activity-plan-status-plan"[^>]*data-badge-tone="${tone}"[^>]*>${label}<`,
        ),
      );
      // Web has no execution evidence, so it never shows derived states.
      expect(html).not.toContain('Implementing');
      expect(html).not.toContain('Implemented');
    },
  );

  it('renders no status badge for a plan without a review status', () => {
    const html = renderToString(
      <PlansSection
        plans={[{ localId: 'plan', title: 'Plan', status: 'draft' }]}
      />,
    );
    expect(html).not.toContain('activity-plan-status-plan');
  });

  it.each(['pending', 'approved', 'dismissed'])(
    'renders the stored %s status from a Portal list summary before details load',
    (status) => {
      const html = renderToString(
        <PlansSection
          plans={[{ localId: 'summary', title: 'Plan', status }]}
        />,
      );
      expect(html).toContain('data-testid="activity-plan-status-summary"');
      expect(html).toContain(
        `>${status.charAt(0).toUpperCase() + status.slice(1)}<`,
      );
      expect(html).not.toContain(`>${status}<`);
    },
  );

  it('shows the review once when the detail also carries its summary status', () => {
    const html = renderToString(
      <PlansSection
        plans={[
          {
            localId: 'detail',
            title: 'Plan',
            status: 'approved',
            reviewStatus: 'approved',
          },
        ]}
      />,
    );
    expect(html).toContain('>Approved<');
    expect(html).not.toContain('>approved<');
  });

  it('explains where plans come from when empty, without an import', () => {
    const html = renderToString(<PlansSection plans={[]} />);
    expect(html).toContain('data-testid="activity-plans-empty"');
    expect(html).toContain('Plans your agent writes appear here.');
    expect(html).not.toContain('Import a Markdown plan');
    expect(html).not.toContain('activity-plans-empty-import');
  });

  it('offers the import in the empty state when the host can import', () => {
    const html = renderToString(
      <PlansSection plans={[]} onImportPlan={(): void => undefined} />,
    );
    expect(html).toContain(
      'Import a Markdown plan to review it, comment on it, and hand it to an agent.',
    );
    expect(html).toContain('data-testid="activity-plans-empty-import"');
    expect(html).toContain('Import plan');
  });

  it('names the source file of an imported plan instead of the source word', () => {
    const html = renderToString(
      <PlansSection
        plans={[
          {
            localId: 'imported',
            title: 'Rollout',
            source: 'imported',
            sourceFilePath: 'docs/rollout.md',
            status: 'pending',
          },
          {
            localId: 'legacy',
            title: 'Legacy',
            source: 'imported',
            status: 'pending',
          },
        ]}
      />,
    );
    expect(html.match(/data-testid="plan-provenance"/g)).toHaveLength(1);
    expect(html).toContain('Imported · docs/rollout.md');
    // An older desktop sends no path, so the card keeps the bare source word.
    expect(html).toMatch(/>imported<\/span>/);
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

  it('renders plan markdown actions with the shared Copy plan', () => {
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
    expect(html).toContain('activity-plan-send-plan');
    // The shared action desktop's plan controls use too (CAN-5354); its
    // clipboard behavior is covered by `PlanCopyAction`'s own suite.
    expect(html).toMatch(
      /aria-label="Copy plan"[^>]*data-testid="activity-plan-copy-plan"[^>]*data-state="ready"/,
    );
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
