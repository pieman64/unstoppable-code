/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import {
  ActiveRunRow,
  CompletedRunRow,
  PipelineRunDagProgressBar,
  PipelineRunTreeRow,
  type PipelineRunSummary,
} from '../pipeline/PipelineRunRows';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});

const baseSummary: PipelineRunSummary = {
  id: 'run-1',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Quality gate',
  status: 'running',
  status_reasons: [],
  started_at: '2026-07-26T10:00:00.000Z',
  planId: 'plan-1',
  plan_modified: true,
};

describe('PipelineRunRows', () => {
  it('renders DAG progress for legacy execution state without job groups', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    expect(() => {
      act(() => {
        root.render(
          <PipelineRunDagProgressBar
            executionState={{
              pipeline_snapshot: {
                jobs: {
                  build: {
                    name: 'Build',
                    needs: [],
                    steps: [],
                  },
                },
              },
              jobs: {
                build: {
                  status: 'pending',
                  steps: {},
                },
              },
              event_name: 'manual',
            }}
          />,
        );
      });
    }).not.toThrow();
    expect(container.querySelector('[data-job-id="build"]')).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('renders an active row and dispatches detail, plan, and cancel callbacks', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onOpenDetail = jest.fn();
    const onOpenPlan = jest.fn();
    const onCancel = jest.fn();
    const onResume = jest.fn();

    act(() => {
      root.render(
        <ActiveRunRow
          summary={baseSummary}
          cancellingId={null}
          onOpenDetail={onOpenDetail}
          onCancel={onCancel}
          onResume={onResume}
          resumingId={null}
          onJobClick={jest.fn()}
          onOpenPlan={onOpenPlan}
          summaryLookup={{ 'run-1': baseSummary }}
          onOpenSource={jest.fn()}
          renderAdvisorBadge={() => <span>Advisor pending</span>}
          renderWatcherButton={(run) => (
            <button data-testid={`pipeline-run-watchers-${run.id}`}>
              Watchers
            </button>
          )}
        />,
      );
    });

    expect(container.textContent).toContain('Plan updated');
    // Light mode must stay readable: no dark-tuned literal violet, use the
    // shared merged status tokens instead (same fix as the CAN-1911 advisor
    // badge).
    const planBadge = Array.from(container.querySelectorAll('span')).find(
      (candidate) => candidate.textContent === 'Plan updated',
    );
    expect(planBadge).not.toBeUndefined();
    expect(planBadge?.className).toContain(
      OPERATIONAL_STATUS_COLORS.merged.foreground,
    );
    expect(planBadge?.className).toContain(
      OPERATIONAL_STATUS_COLORS.merged.backgroundSubtle,
    );
    expect(planBadge?.className).not.toContain('text-violet-300');
    expect(planBadge?.className).not.toContain('bg-violet-500');
    expect(
      container.querySelector('[data-testid="pipeline-run-watchers-run-1"]'),
    ).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-run-plan-run-1"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-run-cancel-run-1"]',
        )
        ?.click();
      container
        .querySelector<HTMLElement>('[data-testid="pipeline-run-card-run-1"]')
        ?.click();
    });
    expect(onOpenPlan).toHaveBeenCalledWith('run-1');
    expect(onCancel).toHaveBeenCalledWith('run-1');
    expect(onResume).not.toHaveBeenCalled();
    expect(onOpenDetail).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  it('resumes every current non-input pause from the preview', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onResume = jest.fn();
    const summary: PipelineRunSummary = { ...baseSummary, status: 'paused' };

    act(() => {
      root.render(
        <ActiveRunRow
          summary={summary}
          executionState={{
            pipeline_snapshot: { jobs: {} },
            jobs: {},
            job_groups: {},
            status_reasons: [
              {
                id: 'provider-recovery-1',
                kind: 'provider_recovery',
                provider: 'codex',
                code: 'usage_limit',
              },
            ],
            pending_pauses: [
              {
                id: 'checkpoint-1',
                kind: 'action',
                job_id: 'review',
                logical_job_id: 'review',
                step_id: 'approval',
              },
            ],
          }}
          cancellingId={null}
          resumingId={null}
          onOpenDetail={jest.fn()}
          onCancel={jest.fn()}
          onResume={onResume}
          onJobClick={jest.fn()}
          onOpenPlan={jest.fn()}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });

    const resume = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-run-resume-run-1"]',
    );
    expect(resume).not.toBeNull();
    act(() => resume?.click());
    expect(onResume).toHaveBeenCalledWith('run-1');

    act(() => root.unmount());
    container.remove();
  });

  it('keeps active controls disabled for existing per-action pending props', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const summary: PipelineRunSummary = { ...baseSummary, status: 'paused' };

    act(() => {
      root.render(
        <ActiveRunRow
          summary={summary}
          executionState={{
            pipeline_snapshot: { jobs: {} },
            jobs: {},
            job_groups: {},
            pending_pauses: [
              {
                id: 'checkpoint-1',
                kind: 'action',
                job_id: 'review',
                logical_job_id: 'review',
                step_id: 'approval',
              },
            ],
          }}
          cancellingId="run-1"
          resumingId="run-1"
          onOpenDetail={jest.fn()}
          onCancel={jest.fn()}
          onResume={jest.fn()}
          onJobClick={jest.fn()}
          onOpenPlan={jest.fn()}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="pipeline-run-resume-run-1"]',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="pipeline-run-cancel-run-1"]',
      )?.disabled,
    ).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('shows Input Required and withholds direct resume while input is pending', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const summary: PipelineRunSummary = { ...baseSummary, status: 'paused' };

    act(() => {
      root.render(
        <ActiveRunRow
          summary={summary}
          executionState={{
            pipeline_snapshot: { jobs: {} },
            jobs: {},
            job_groups: {},
            pending_pauses: [
              {
                id: 'checkpoint-1',
                kind: 'input',
                job_id: 'review',
                logical_job_id: 'review',
                step_id: 'approval',
                request: {
                  title: 'Approval required',
                  message: 'Choose a reviewer.',
                  fields: [],
                },
              },
            ],
          }}
          cancellingId={null}
          resumingId={null}
          onOpenDetail={jest.fn()}
          onCancel={jest.fn()}
          onResume={jest.fn()}
          onJobClick={jest.fn()}
          onOpenPlan={jest.fn()}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });

    const badge = Array.from(container.querySelectorAll('span')).find(
      (candidate) => candidate.textContent === 'Input required',
    );
    expect(badge).not.toBeUndefined();
    expect(badge?.className).toContain('bg-warning-subtle');
    expect(badge?.className).toContain('fg-warning');
    expect(badge?.className).not.toContain('text-amber-300');
    expect(
      container.querySelector('[data-testid="pipeline-run-resume-run-1"]'),
    ).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('withholds direct resume when an oversized input request is unavailable', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const summary: PipelineRunSummary = { ...baseSummary, status: 'paused' };

    act(() => {
      root.render(
        <ActiveRunRow
          summary={summary}
          executionState={{
            pipeline_snapshot: { jobs: {} },
            jobs: {},
            job_groups: {},
            pending_pauses: [
              {
                id: 'checkpoint-1',
                kind: 'input',
                job_id: 'review',
                logical_job_id: 'review',
                step_id: 'approval',
              },
            ],
          }}
          cancellingId={null}
          resumingId={null}
          onOpenDetail={jest.fn()}
          onCancel={jest.fn()}
          onResume={jest.fn()}
          onJobClick={jest.fn()}
          onOpenPlan={jest.fn()}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });

    expect(
      Array.from(container.querySelectorAll('span')).some(
        (candidate) => candidate.textContent === 'Input required',
      ),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="pipeline-run-resume-run-1"]'),
    ).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('renders completed actions and dispatches every enabled callback', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const callbacks = {
      onChatFollowUp: jest.fn(),
      onReportChatFollowUp: jest.fn(),
      onViewReport: jest.fn(),
      onPipelineFollowUp: jest.fn(),
      onOpenPlan: jest.fn(),
      onRetry: jest.fn(),
      onRerun: jest.fn(),
      onDebugFailure: jest.fn(),
      onToggleHidden: jest.fn(),
    };
    const summary: PipelineRunSummary = {
      ...baseSummary,
      status: 'failure',
      has_plan: true,
      has_report: true,
    };

    act(() => {
      root.render(
        <CompletedRunRow
          summary={summary}
          executionState={{
            pipeline_snapshot: { jobs: {} },
            jobs: {},
            event_name: 'manual',
          }}
          onOpenDetail={jest.fn()}
          {...callbacks}
          onResumePauseReason={jest.fn()}
          onJobClick={jest.fn()}
          retrying={false}
          rerunning={false}
          debuggingFailureId={null}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });

    // Follow-up buttons are neutral action chips on the quaternary surface,
    // not a dark-tuned literal sky tint that washes out in light mode.
    const followUpButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-run-chat-follow-up-run-1"]',
    );
    expect(followUpButton).not.toBeNull();
    expect(followUpButton?.className).toContain('bg-quaternary');
    expect(followUpButton?.className).toContain('ring-line-secondary');
    expect(followUpButton?.className).not.toContain('sky-500');

    const testIds = [
      'pipeline-run-toggle-hidden-run-1',
      'pipeline-run-debug-failure-run-1',
      'pipeline-run-retry-run-1',
      'pipeline-run-rerun-run-1',
      'pipeline-run-chat-follow-up-run-1',
      'pipeline-run-pipeline-follow-up-run-1',
      'pipeline-run-plan-run-1',
      'pipeline-run-report-follow-up-run-1',
      'pipeline-run-view-report-run-1',
    ];
    act(() => {
      for (const testId of testIds) {
        container
          .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.click();
      }
    });

    expect(callbacks.onToggleHidden).toHaveBeenCalledTimes(1);
    expect(callbacks.onDebugFailure).toHaveBeenCalledWith('run-1');
    expect(callbacks.onRetry).toHaveBeenCalledWith('run-1');
    expect(callbacks.onRerun).toHaveBeenCalledWith('run-1');
    expect(callbacks.onChatFollowUp).toHaveBeenCalledWith('run-1');
    expect(callbacks.onPipelineFollowUp).toHaveBeenCalledWith('run-1');
    expect(callbacks.onOpenPlan).toHaveBeenCalledWith('run-1');
    expect(callbacks.onReportChatFollowUp).toHaveBeenCalledWith('run-1');
    expect(callbacks.onViewReport).toHaveBeenCalledWith('run-1');

    act(() => root.unmount());
    container.remove();
  });

  it('dispatches the paused-run reason action independently from card detail', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onResumePauseReason = jest.fn();
    const summary: PipelineRunSummary = {
      ...baseSummary,
      status: 'paused',
    };

    act(() => {
      root.render(
        <CompletedRunRow
          summary={summary}
          onOpenDetail={jest.fn()}
          onChatFollowUp={jest.fn()}
          onReportChatFollowUp={jest.fn()}
          onViewReport={jest.fn()}
          onPipelineFollowUp={jest.fn()}
          onOpenPlan={jest.fn()}
          onRetry={jest.fn()}
          onRerun={jest.fn()}
          onDebugFailure={jest.fn()}
          onResumePauseReason={onResumePauseReason}
          onJobClick={jest.fn()}
          retrying={false}
          rerunning={false}
          debuggingFailureId={null}
          summaryLookup={{ 'run-1': summary }}
          onOpenSource={jest.fn()}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-run-needs-input-run-1"]',
        )
        ?.click();
    });
    expect(onResumePauseReason).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  describe('row chip standard', () => {
    const STATUS_BADGE_GEOMETRY = [
      'h-5',
      'rounded-full',
      'text-3xs',
      'ring-[length:var(--border-hairline)]',
    ];
    const ACTION_BUTTON_GEOMETRY = [
      'h-6',
      'rounded-md',
      'text-2xs',
      'ring-[length:var(--border-hairline)]',
    ];
    // `border-<color>` utilities are inert under the unlayered base border
    // rule (CAN-2734) and raw palette literals wash out in light mode, so a
    // standardized chip may carry neither.
    const FORBIDDEN_CLASS = /(^|\s)border(-|\s|$)|\b(sky|violet|amber|rose)-/;

    function expectGeometry(
      element: Element | null | undefined,
      geometry: readonly string[],
    ): void {
      expect(element).not.toBeNull();
      expect(element).not.toBeUndefined();
      const className = element?.className ?? '';
      for (const token of geometry) {
        expect(className.split(/\s+/)).toContain(token);
      }
      expect(className).not.toMatch(FORBIDDEN_CLASS);
    }

    function findSpan(
      container: HTMLElement,
      text: string,
    ): Element | undefined {
      return Array.from(container.querySelectorAll('span')).find(
        (candidate) => candidate.textContent === text,
      );
    }

    it('gives every status badge in an active row the same geometry and tint', () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const summary: PipelineRunSummary = {
        ...baseSummary,
        status: 'paused',
        plan_modified: true,
      };

      act(() => {
        root.render(
          <ActiveRunRow
            summary={summary}
            executionState={{
              pipeline_snapshot: { jobs: {} },
              jobs: {},
              job_groups: {},
              pending_pauses: [
                {
                  id: 'checkpoint-1',
                  kind: 'input',
                  job_id: 'review',
                  logical_job_id: 'review',
                  step_id: 'approval',
                  request: { title: 'Approval', message: '', fields: [] },
                },
              ],
            }}
            cancellingId={null}
            resumingId={null}
            onOpenDetail={jest.fn()}
            onCancel={jest.fn()}
            onResume={jest.fn()}
            onJobClick={jest.fn()}
            onOpenPlan={jest.fn()}
            summaryLookup={{ 'run-1': summary }}
            onOpenSource={jest.fn()}
          />,
        );
      });

      const statusPill = findSpan(container, 'paused');
      expectGeometry(statusPill, STATUS_BADGE_GEOMETRY);
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle,
      );
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.paused.foreground,
      );
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.paused.ring,
      );

      const planBadge = findSpan(container, 'Plan updated');
      expectGeometry(planBadge, STATUS_BADGE_GEOMETRY);
      expect(planBadge?.className).toContain(
        OPERATIONAL_STATUS_COLORS.merged.ring,
      );

      const inputBadge = findSpan(container, 'Input required');
      expectGeometry(inputBadge, STATUS_BADGE_GEOMETRY);
      expect(inputBadge?.className).toContain('bg-warning-subtle');
      expect(inputBadge?.className).toContain('fg-warning');
      expect(inputBadge?.className).toContain('ring-line-attention/30');

      // The cancel control is an action chip on the shared secondary
      // surface (quaternary shell + shadow + hairline) with destructive ink.
      const cancel = container.querySelector(
        '[data-testid="pipeline-run-cancel-run-1"]',
      );
      expectGeometry(cancel, ACTION_BUTTON_GEOMETRY);
      expect(cancel?.className).toContain('bg-quaternary');
      expect(cancel?.className).toContain('shadow-sm');
      expect(cancel?.className).toContain('ring-line-secondary');
      expect(cancel?.className).toContain('fg-destructive');
      expect(cancel?.className).not.toContain('bg-destructive-subtle');
      expect(cancel?.className).not.toContain('ring-line-destructive');

      act(() => root.unmount());
      container.remove();
    });

    it('renders the preview resume control as a warning action chip', () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const summary: PipelineRunSummary = { ...baseSummary, status: 'paused' };

      act(() => {
        root.render(
          <ActiveRunRow
            summary={summary}
            executionState={{
              pipeline_snapshot: { jobs: {} },
              jobs: {},
              job_groups: {},
              pending_pauses: [
                {
                  id: 'checkpoint-1',
                  kind: 'action',
                  job_id: 'deploy',
                  logical_job_id: 'deploy',
                  step_id: 'approve',
                },
              ],
            }}
            cancellingId={null}
            resumingId={null}
            onOpenDetail={jest.fn()}
            onCancel={jest.fn()}
            onResume={jest.fn()}
            onJobClick={jest.fn()}
            onOpenPlan={jest.fn()}
            summaryLookup={{ 'run-1': summary }}
            onOpenSource={jest.fn()}
          />,
        );
      });

      const resume = container.querySelector(
        '[data-testid="pipeline-run-resume-run-1"]',
      );
      expectGeometry(resume, ACTION_BUTTON_GEOMETRY);
      expect(resume?.className).toContain('bg-quaternary');
      expect(resume?.className).toContain('shadow-sm');
      expect(resume?.className).toContain('ring-line-secondary');
      expect(resume?.className).toContain('fg-warning');
      expect(resume?.className).not.toContain('bg-warning-subtle');
      expect(resume?.className).not.toContain('ring-line-attention');

      act(() => root.unmount());
      container.remove();
    });

    it('gives every action button in a completed row the same geometry and a tone', () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const sourceSummary: PipelineRunSummary = {
        ...baseSummary,
        id: 'run-0',
        status: 'success',
        plan_modified: false,
      };
      const summary: PipelineRunSummary = {
        ...baseSummary,
        status: 'failure',
        has_plan: true,
        has_report: true,
        rerun_source_id: 'run-0',
      };

      act(() => {
        root.render(
          <CompletedRunRow
            summary={summary}
            executionState={{
              pipeline_snapshot: { jobs: {} },
              jobs: {},
              event_name: 'manual',
            }}
            onOpenDetail={jest.fn()}
            onChatFollowUp={jest.fn()}
            onReportChatFollowUp={jest.fn()}
            onViewReport={jest.fn()}
            onPipelineFollowUp={jest.fn()}
            onOpenPlan={jest.fn()}
            onRetry={jest.fn()}
            onRerun={jest.fn()}
            onDebugFailure={jest.fn()}
            onResumePauseReason={jest.fn()}
            onJobClick={jest.fn()}
            retrying={false}
            rerunning={false}
            debuggingFailureId={null}
            summaryLookup={{ 'run-0': sourceSummary, 'run-1': summary }}
            onOpenSource={jest.fn()}
          />,
        );
      });

      // Muted status pill: same geometry, quiet colour set.
      const statusPill = findSpan(container, 'failure');
      expectGeometry(statusPill, STATUS_BADGE_GEOMETRY);
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.failed.backgroundQuiet,
      );
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.failed.foregroundQuiet,
      );
      expect(statusPill?.className).toContain(
        OPERATIONAL_STATUS_COLORS.failed.ringQuiet,
      );

      const byTestId = (testId: string): Element | null =>
        container.querySelector(`[data-testid="${testId}"]`);
      const neutral = [
        'pipeline-run-debug-failure-run-1',
        'pipeline-run-chat-follow-up-run-1',
        'pipeline-run-pipeline-follow-up-run-1',
        'pipeline-run-plan-run-1',
        'pipeline-run-report-follow-up-run-1',
        'pipeline-run-view-report-run-1',
      ];
      for (const testId of neutral) {
        const button = byTestId(testId);
        expectGeometry(button, ACTION_BUTTON_GEOMETRY);
        expect(button?.className).toContain('bg-quaternary');
        expect(button?.className).toContain('fg-primary');
        expect(button?.className).toContain('ring-line-secondary');
      }

      // Retry and Start over sit on the same secondary shell as the neutral
      // chips and differ by ink only, like the git actions' accent ink on a
      // neutral shell.
      const retry = byTestId('pipeline-run-retry-run-1');
      expectGeometry(retry, ACTION_BUTTON_GEOMETRY);
      expect(retry?.className).toContain('bg-quaternary');
      expect(retry?.className).toContain('shadow-sm');
      expect(retry?.className).toContain('ring-line-secondary');
      expect(retry?.className).toContain('fg-warning');
      expect(retry?.className).not.toContain('bg-warning-subtle');
      expect(retry?.className).not.toContain('ring-line-attention');

      const rerun = byTestId('pipeline-run-rerun-run-1');
      expectGeometry(rerun, ACTION_BUTTON_GEOMETRY);
      expect(rerun?.className).toContain('bg-quaternary');
      expect(rerun?.className).toContain('shadow-sm');
      expect(rerun?.className).toContain('ring-line-secondary');
      expect(rerun?.className).toContain('fg-destructive');
      expect(rerun?.className).not.toContain('bg-destructive-subtle');
      expect(rerun?.className).not.toContain('ring-line-destructive');

      // The clickable lineage chip is a neutral action button too.
      const lineage = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.startsWith('Started over from'),
      );
      expectGeometry(lineage, ACTION_BUTTON_GEOMETRY);
      expect(lineage?.className).toContain('bg-quaternary');

      act(() => root.unmount());
      container.remove();
    });

    it('renders the sub-pipeline disclosure as a neutral action button', () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const child: PipelineRunSummary = {
        ...baseSummary,
        id: 'run-2',
        status: 'success',
        parent_execution_id: 'run-1',
      };
      const parent: PipelineRunSummary = { ...baseSummary, status: 'success' };

      act(() => {
        root.render(
          <PipelineRunTreeRow
            node={{
              summary: parent,
              depth: 0,
              children: [{ summary: child, depth: 1, children: [] }],
            }}
            expandedIds={new Set()}
            onToggleExpand={jest.fn()}
            statesById={{}}
            cancellingId={null}
            resumingId={null}
            onOpenDetail={jest.fn()}
            onCancel={jest.fn()}
            onResume={jest.fn()}
            onChatFollowUp={jest.fn()}
            onReportChatFollowUp={jest.fn()}
            onViewReport={jest.fn()}
            onPipelineFollowUp={jest.fn()}
            onOpenPlan={jest.fn()}
            onRetry={jest.fn()}
            onRerun={jest.fn()}
            onDebugFailure={jest.fn()}
            chatFollowUpDisabled={false}
            retryingIds={new Set()}
            rerunningIds={new Set()}
            debuggingFailureId={null}
            summaryLookup={{ 'run-1': parent, 'run-2': child }}
            onOpenSource={jest.fn()}
            parentChain={[]}
          />,
        );
      });

      const disclosure = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('sub-pipeline'),
      );
      expectGeometry(disclosure, ACTION_BUTTON_GEOMETRY);
      expect(disclosure?.className).toContain('bg-quaternary');

      act(() => root.unmount());
      container.remove();
    });
  });
});
