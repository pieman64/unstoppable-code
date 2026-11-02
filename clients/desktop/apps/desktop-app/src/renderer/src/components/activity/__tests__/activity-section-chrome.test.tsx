/**
 * @jest-environment jsdom
 */
/**
 * Frameless section chrome (standalone `activity-card` panels).
 *
 * Every activity section funnels through the desktop `PanelSection` wrapper
 * (`@/components/shared/panel-section` — the single chrome choke point), so
 * providing `ActivitySectionChromeContext` as `'frameless'` at the panel
 * boundary must drop the card box and the expand/collapse UX for ALL
 * sections. The icon and title move to the panel tab, so the frameless header
 * carries only the subtitle and any header actions (like refresh) above the
 * always-expanded content. These are render smokes over a representative set
 * of REAL sections (summary, todo, changed-files, pipeline-runs), plus the
 * default-card control confirming the stacked ActivityPanel (no provider) is
 * unchanged.
 */
import { act } from 'react';
jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  useTryItAccount: (): { status: 'signed-in'; accountId: string } => ({
    status: 'signed-in',
    accountId: 'account:1',
  }),
}));
import { createRoot, type Root } from 'react-dom/client';
import type {
  TrackedPlanData,
  WorktreeSummaryData,
} from '@canopy/desktop-shared/types';

// The modal/markdown satellites are irrelevant to this chrome-focused suite,
// so stub them while mounting the real section and ActivitySection wrapper.
jest.mock('../PipelineAdvisorMarkdown', () => ({
  PipelineAdvisorMarkdownText: (): null => null,
}));
jest.mock('../PipelineExecutionDetailModal', () => ({
  PipelineExecutionDetailModal: (): null => null,
}));
jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));
jest.mock('@/components/chat/PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (): null => null,
}));

import {
  ActivitySectionChromeContext,
  PanelSection,
} from '@/components/shared/panel-section';
import { PanelSection as SharedPanelSection } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  WorkspaceAttachmentItem,
  WorkspaceNoteItem,
} from '@canopy/desktop-shared/types/workspace-items';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { SummarySection } from '../SummarySection';
import { TodoSection } from '../TodoSection';
import { ChangedFilesSection } from '../ChangedFilesSection';
import { getActivitySectionDefinition } from '../activity-sections';
import { AttachmentsSection } from '../AttachmentsSection';
import { NotesSection } from '../NotesSection';
import { PipelineRunsSection } from '../PipelineRunsSection';
import { PlansSection } from '../PlansSection';
import { PromptsSection } from '../PromptsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const WORKTREE_KEY = 'project-1/worktree-1';

const SUMMARY: WorktreeSummaryData = {
  title: 'Recent work summary',
  description: 'A short description of the worktree state.',
  highlights: [],
  generatedAt: '2026-07-01T00:00:00.000Z',
  turnCountAtGeneration: 3,
  lastFullRefreshAt: '2026-07-01T00:00:00.000Z',
  lastFullRefreshTurnCount: 3,
};

const TRACKED_PLAN: TrackedPlanData = {
  id: 'plan-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  source: 'imported',
  title: 'Example plan',
  content: '# Example plan',
  reviewStatus: 'pending',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  latestRevisionNumber: 1,
  revisions: [
    {
      revisionNumber: 1,
      content: '# Example plan',
      source: 'imported',
      reviewStatus: 'pending',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  linkedExecutionIds: [],
};

/** One saved note/prompt so the Notes and Prompts cards render with content. */
const MARKDOWN_ITEM: WorkspaceNoteItem = {
  id: 'release-checklist',
  title: 'Release checklist',
  absolutePath: '/tmp/notes/release-checklist.md',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const ATTACHMENT_ITEM: WorkspaceAttachmentItem = {
  filename: 'design.png',
  absolutePath: '/tmp/attachments/design.png',
  sizeBytes: 1024,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const initialWorkspaceItemsState = useWorkspaceItemsStore.getState();

describe('activity section chrome variants', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    useActivityStore.setState({
      worktreeSummaries: { [WORKTREE_KEY]: SUMMARY },
      summaryGenerating: {},
      worktreeSummaryEnabled: true,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ selectedWorktree: null });
    useActivityStore.setState({
      worktreeSummaries: {},
      summaryGenerating: {},
      trackedPlans: {},
      changedFiles: {},
    });
    usePipelineRunsStore.setState({
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
      summaries: [],
      statesById: {},
    });
    useWorkspaceItemsStore.setState(initialWorkspaceItemsState, true);
  });

  function renderFrameless(children: React.ReactNode): void {
    act(() => {
      root.render(
        <ActivitySectionChromeContext.Provider value="frameless">
          {children}
        </ActivitySectionChromeContext.Provider>,
      );
    });
  }

  function renderBodyOnly(
    children: React.ReactNode,
    dataTestId?: string,
  ): void {
    act(() => {
      root.render(
        <div className="relative" data-testid={dataTestId}>
          <SharedPanelSection icon={<span />} title="Shared header">
            <ActivitySectionChromeContext.Provider value="body-only">
              {children}
            </ActivitySectionChromeContext.Provider>
          </SharedPanelSection>
        </div>,
      );
    });
  }

  /** Frameless invariants: no card box, no collapse UX. */
  function expectFramelessSection(): void {
    expect(
      container.querySelector('[data-activity-chrome="frameless"]'),
    ).not.toBeNull();
    // No card chrome (border/background/rounded box).
    expect(container.querySelector('section.rounded-xl')).toBeNull();
    // No expand/collapse affordance in either state.
    expect(
      container.querySelector('[aria-label="Collapse section"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Expand section"]')).toBeNull();
  }

  /** Frameless layout: pinned shrink-0 header outside the scrolling body. */
  function expectFramelessFillLayout(): void {
    const section = container.querySelector(
      '[data-activity-chrome="frameless"]',
    );
    expect(section).not.toBeNull();
    expect(section?.className).toContain('flex');
    expect(section?.className).toContain('h-full');
    expect(section?.className).toContain('min-h-0');
    expect(section?.className).toContain('flex-col');
    const header = container.querySelector(
      '[data-testid="frameless-section-header"]',
    );
    expect(header?.className).toContain('shrink-0');
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body?.className).toContain('flex-1');
    expect(body?.className).toContain('min-h-0');
  }

  it('summary renders frameless with the refresh action and content intact', () => {
    renderFrameless(<SummarySection />);
    expectFramelessSection();
    // Header actions survive (refresh button).
    expect(
      container.querySelector('[aria-label="Refresh summary"]'),
    ).not.toBeNull();
    // Content is always expanded.
    expect(container.textContent).toContain('Recent work summary');
  });

  it('frameless section pins the header and fills with a scrolling body', () => {
    renderFrameless(<SummarySection />);
    const summaryRoot = container.querySelector(
      '[data-testid="activity-summary-section"]',
    );
    expect(summaryRoot?.className).toContain('flex-1');
    expect(summaryRoot?.className).toContain('min-h-0');
    expect(summaryRoot?.className).toContain('flex-col');
    expectFramelessFillLayout();
    // Default 'scroll' body owns the overflow.
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body?.className).toContain('overflow-y-auto');
  });

  it('todo renders frameless', () => {
    renderFrameless(<TodoSection />);
    expectFramelessSection();
    expect(container.textContent).toContain('No agent tasks');
  });

  it('changed-files renders frameless with its content always expanded', () => {
    renderFrameless(
      <ChangedFilesSection
        uncommitted={[
          {
            path: 'src/example.ts',
            status: 'modified',
            insertions: 2,
            deletions: 1,
          },
        ]}
        committed={[]}
        onFileClick={jest.fn()}
        onRevertFile={jest.fn()}
      />,
    );
    expectFramelessSection();
    // Children render without any expand interaction.
    expect(container.textContent).toContain('example.ts');
  });

  it('changed-files drops its inner max-height cap in frameless', () => {
    renderFrameless(
      <ChangedFilesSection
        uncommitted={[
          {
            path: 'src/example.ts',
            status: 'modified',
            insertions: 2,
            deletions: 1,
          },
        ]}
        committed={[]}
        onFileClick={jest.fn()}
        onRevertFile={jest.fn()}
      />,
    );
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body).not.toBeNull();
    // No fixed cap or nested scroll inside the frameless body.
    expect(body?.querySelector('.max-h-\\[280px\\]')).toBeNull();
    expect(body?.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('changed-files drops its inner max-height cap through the real activity-card render path', () => {
    // The standalone `activity-card` panel renders the section via its
    // registered `render` (the host-model path: ChangedFilesActivitySection →
    // ChangedFilesHostSection), NOT the prop-driven ChangedFilesSection used by
    // the cap test above. That host model hardcoded `scrollable: true`, so the
    // real frameless panel trapped long lists in a nested 280px scroller. Guard
    // the actual path so it stays capless and scrolls at the panel body.
    useActivityStore.setState({
      changedFiles: {
        [WORKTREE_KEY]: {
          uncommitted: [
            {
              path: 'src/example.ts',
              status: 'modified',
              insertions: 2,
              deletions: 1,
            },
          ],
          committed: [],
        },
      },
    });
    const definition = getActivitySectionDefinition('changed-files');
    expect(definition).toBeDefined();
    if (!definition) {
      throw new Error('Expected the changed-files section definition');
    }
    renderFrameless(
      definition.render({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    );
    expect(container.textContent).toContain('example.ts');
    // The section root must fill the panel as a flex column so PanelSection's
    // `h-full` frameless body resolves to a bounded height and can scroll;
    // without these classes the list overflows the panel with no scroll.
    const sectionRoot = container.querySelector(
      '[data-testid="changed-files-section"]',
    );
    expect(sectionRoot?.className).toContain('flex-1');
    expect(sectionRoot?.className).toContain('min-h-0');
    expect(sectionRoot?.className).toContain('flex-col');
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body).not.toBeNull();
    // No fixed cap or nested scroll inside the frameless body; the body itself
    // owns the scroll and fills the panel height.
    expect(body?.querySelector('.max-h-\\[280px\\]')).toBeNull();
    expect(body?.querySelector('.overflow-y-auto')).toBeNull();
    expect(body?.className).toContain('overflow-y-auto');
    expect(body?.className).toContain('flex-1');
    expect(body?.className).toContain('min-h-0');
  });

  it('changed-files body-only chrome emits one container test id', () => {
    const definition = getActivitySectionDefinition('changed-files');
    expect(definition).toBeDefined();
    if (!definition) {
      throw new Error('Expected the changed-files section definition');
    }
    renderBodyOnly(
      definition.render({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
      'changed-files-section',
    );
    expect(
      container.querySelectorAll('[data-testid="changed-files-section"]'),
    ).toHaveLength(1);
  });

  it('pipeline-runs renders frameless with its dispatch header action', () => {
    renderFrameless(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);
    expectFramelessSection();
    expect(
      container.querySelector('[aria-label="Dispatch workflow"]'),
    ).not.toBeNull();
  });

  it('frameless header carries the subtitle and action but not the icon/title', () => {
    renderFrameless(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);
    const header = container.querySelector(
      '[data-testid="frameless-section-header"]',
    );
    expect(header).not.toBeNull();
    // The Dispatch action lives in the header row.
    expect(
      header?.querySelector('[data-testid="pipeline-dispatch-open"]'),
    ).not.toBeNull();
    // The redundant title heading is gone (title + icon now live on the tab).
    expect(header?.querySelector('h3')).toBeNull();
    // The empty-state subtitle is surfaced in the header instead of the title.
    expect(header?.textContent).toContain('No workflow runs');
  });

  it('renders empty Plans and Pipeline Runs as full-card actions', () => {
    const onDispatchPipeline = jest.fn();
    useActivityStore.setState({
      trackedPlans: { [WORKTREE_KEY]: [] },
      loadTrackedPlans: jest.fn().mockResolvedValue(undefined),
    });
    renderBodyOnly(
      <>
        <PlansSection />
        <PipelineRunsSection onDispatchPipeline={onDispatchPipeline} />
      </>,
    );

    const importPlan = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-plans-import"]',
    );
    const dispatchPipeline = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-dispatch-open"]',
    );
    expect(importPlan?.textContent).toBe('Import plan');
    expect(dispatchPipeline?.textContent).toBe('Dispatch workflow');
    for (const action of [importPlan, dispatchPipeline]) {
      expect(action?.getAttribute('data-activity-action-card-button')).toBe(
        'true',
      );
      expect(action?.className).toContain('bg-tertiary');
      expect(action?.className).toContain('p-3');
      expect(action?.className).toContain('gap-3');
      expect(action?.className).toContain('fg-primary');
      expect(action?.className).toContain(
        'enabled:hover:bg-[var(--bg-activity-card-hover)]',
      );
    }
    expect(dispatchPipeline?.className).toContain('shadow-sm');
    // Plans attaches its explanation under the action, so the shared
    // container carries the card shadow instead of the button.
    const plansCard = importPlan?.closest(
      '[data-testid="action-card-container"]',
    );
    expect(plansCard?.className).toContain('shadow-sm');
    expect(
      plansCard?.querySelector('[data-testid="activity-plans-empty"]')
        ?.textContent,
    ).toContain('Plans your agent writes appear here.');
    expect(container.textContent).not.toContain('No tracked plans yet');
    expect(container.textContent).not.toContain('No workflow runs');
  });

  it('offers Dispatch with accessible history when all runs are hidden', () => {
    usePipelineRunsStore.setState({
      summaries: [
        {
          id: 'hidden-run',
          pipeline_id: 'review',
          pipeline_name: 'Hidden review',
          status: 'success',
          status_reasons: [],
          started_at: '2026-09-15T10:00:00Z',
          cwd: '/repo',
          hidden: true,
        },
      ],
    });
    const onDispatchPipeline = jest.fn();
    renderBodyOnly(
      <PipelineRunsSection onDispatchPipeline={onDispatchPipeline} />,
    );
    const dispatch = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-dispatch-open"]',
    );
    expect(dispatch?.textContent).toBe('Dispatch workflow');
    expect(dispatch?.getAttribute('data-activity-action-card-button')).toBe(
      'true',
    );
    expect(
      container.querySelector('[data-testid="action-card-body"]'),
    ).not.toBeNull();
    const card = container.querySelector(
      '[data-testid="action-card-container"]',
    );
    expect(card?.contains(dispatch ?? null)).toBe(true);
    expect(
      card?.querySelector('[data-testid="action-card-body"]')?.className,
    ).toBe('p-3');
    expect(dispatch?.className).toContain('rounded-b-none');
    expect(
      card?.querySelector('[data-testid="action-card-divider"]')?.className,
    ).toContain('bg-line-tertiary');
    act(() => dispatch?.click());
    expect(onDispatchPipeline).toHaveBeenCalled();
  });

  it('keeps a failure-only pipeline body instead of replacing it with Dispatch', () => {
    usePipelineRunsStore.setState({
      failedPendingExecutions: {
        [WORKTREE_KEY]: [
          {
            localId: 'failed-1',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            pipelineId: 'pipeline-1',
            pipelineName: 'Review pipeline',
            taskText: 'Review changes',
            error: 'Queue start failed',
            failedAt: 123,
          },
        ],
      },
    });

    renderBodyOnly(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);

    expect(container.textContent).toContain('Queue failed: Queue start failed');
    expect(
      container.querySelector('[data-activity-action-card-button="true"]'),
    ).toBeNull();
  });

  it('lifts body-only actions into the shared header controls slot', () => {
    renderBodyOnly(
      <ChangedFilesSection
        uncommitted={[]}
        committed={[]}
        onReviewChanges={jest.fn()}
      />,
    );

    const action = container.querySelector(
      '[data-testid="body-only-section-header-action"]',
    );
    const controls = container.querySelector('[data-panel-section-controls]');
    const body = container.querySelector('[data-panel-section-body]');
    // The action renders in the title-row grid cell (same slot a
    // `headerAction` prop uses), not as an absolutely positioned overlay
    // measured against a disclosure button that no longer exists.
    expect(action).not.toBeNull();
    expect(controls?.contains(action)).toBe(true);
    expect(body?.contains(action)).toBe(false);
    expect(action?.className).not.toContain('absolute');
    expect(action?.className).not.toContain('right-14');
    expect(action?.className).not.toContain('top-3');
    expect(
      action?.querySelector('[data-testid="view-change-diagram-button"]')
        ?.textContent,
    ).toBe('');
    expect(
      action
        ?.querySelector('[data-testid="view-change-diagram-button"]')
        ?.getAttribute('aria-label'),
    ).toBe('View diagram');
  });

  it.each([
    {
      card: 'Notes',
      actionTestId: 'workspace-notes-add',
      render: (): void => {
        useWorkspaceItemsStore.setState({
          notes: { 'project-1': [MARKDOWN_ITEM] },
          loadNotes: jest.fn(() => Promise.resolve()),
        });
        renderBodyOnly(
          <NotesSection projectId="project-1" worktreeId="worktree-1" />,
        );
      },
    },
    {
      card: 'Prompts',
      actionTestId: 'workspace-prompts-add',
      render: (): void => {
        useWorkspaceItemsStore.setState({
          prompts: { 'project-1': [MARKDOWN_ITEM] },
          loadPrompts: jest.fn(() => Promise.resolve()),
        });
        renderBodyOnly(
          <PromptsSection projectId="project-1" worktreeId="worktree-1" />,
        );
      },
    },
    {
      card: 'Attachments',
      actionTestId: 'workspace-attachments-import',
      render: (): void => {
        useWorkspaceItemsStore.setState({
          attachments: { [WORKTREE_KEY]: [ATTACHMENT_ITEM] },
          loadAttachments: jest.fn(() => Promise.resolve()),
        });
        renderBodyOnly(
          <AttachmentsSection projectId="project-1" worktreeId="worktree-1" />,
        );
      },
    },
    {
      card: 'Plans',
      actionTestId: 'activity-plans-import',
      render: (): void => {
        useActivityStore.setState({
          trackedPlans: { [WORKTREE_KEY]: [TRACKED_PLAN] },
        });
        renderBodyOnly(<PlansSection />);
      },
    },
  ])(
    '$card card action sits in the title-row controls slot, centered like Changed Files',
    ({ actionTestId, render }) => {
      render();

      const controls = container.querySelector('[data-panel-section-controls]');
      const body = container.querySelector('[data-panel-section-body]');
      const action = container.querySelector(`[data-testid="${actionTestId}"]`);
      expect(action).not.toBeNull();
      expect(controls?.contains(action)).toBe(true);
      expect(body?.contains(action)).toBe(false);
      // Mirrors the shared PanelSection contract: the controls cell is a
      // zero-height, self-centered row-1 cell so its button centers on the
      // title row rather than on the title+subtitle block.
      expect(
        controls?.querySelector('[aria-label="Collapse section"]'),
      ).toBeNull();
      expect(controls?.className).toContain('row-start-1');
      expect(controls?.className).toContain('h-0');
      expect(controls?.className).toContain('self-center');
      expect(controls?.className).toContain('items-center');
      expect(controls?.className).toContain('-mr-1');
      expect(controls?.className).not.toContain('self-start');
      const overlay = container.querySelector(
        '[data-testid="body-only-section-header-action"]',
      );
      expect(overlay?.className ?? '').not.toContain('absolute');
      expect(overlay?.className ?? '').not.toContain('right-14');
    },
  );

  it('renders an empty body-only action as an accent ghost button', () => {
    renderBodyOnly(
      <PanelSection
        icon={<svg />}
        title="Plans"
        subtitle="No tracked plans yet"
        hasExpandableContent={false}
        actionOnlyLabel="Import"
        headerAction={
          <button type="button" data-testid="compact-import" className="p-1">
            compact icon
          </button>
        }
      >
        <div data-testid="empty-body">Nothing here</div>
      </PanelSection>,
    );

    const action = container.querySelector(
      '[data-testid="body-only-section-header-action"]',
    );
    const controls = container.querySelector('[data-panel-section-controls]');
    const button = action?.querySelector('[data-testid="compact-import"]');
    expect(controls?.contains(action)).toBe(true);
    expect(action?.className).not.toContain('absolute');
    expect(action?.className).not.toContain('right-14');
    expect(button?.textContent).toBe('Import');
    expect(button?.className).toContain('bg-transparent');
    expect(button?.className).toContain('fg-accent');
    expect(button?.className).not.toContain('shadow-sm');
    expect(button?.classList.contains('p-1')).toBe(false);
    expect(container.querySelector('[data-testid="empty-body"]')).toBeNull();
  });

  it('renders an empty action card as one full-card button with equal insets', () => {
    const onAddNote = jest.fn();
    renderBodyOnly(
      <PanelSection
        icon={<svg data-testid="note-icon" />}
        title="Notes"
        hasExpandableContent={false}
        actionOnlyCard
        actionOnlyLabel="Add note"
        headerAction={
          <button
            type="button"
            data-testid="workspace-notes-add"
            onClick={onAddNote}
          >
            compact icon
          </button>
        }
      >
        <div data-testid="empty-note-body">Nothing here</div>
      </PanelSection>,
    );

    const actionCard = container.querySelector(
      '[data-testid="body-only-section-action-card"]',
    );
    const button = actionCard?.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-notes-add"]',
    );
    expect(actionCard?.className).not.toContain('absolute');
    expect(button?.textContent).toContain('Add note');
    expect(button?.className).toContain('p-3');
    expect(button?.className).toContain('gap-3');
    expect(button?.className).not.toContain('gap-2');
    expect(button?.className).toContain('w-full');
    expect(button?.className).toContain('bg-tertiary');
    expect(button?.className).toContain('shadow-sm');
    expect(button?.className).toContain(
      'enabled:hover:bg-[var(--bg-activity-card-hover)]',
    );
    expect(button?.className).toContain('fg-primary');
    expect(button?.className).not.toContain('fg-accent');
    act(() => button?.click());
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it('pipeline-runs uses a flex body in frameless', () => {
    renderFrameless(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body?.className).toContain('flex-col');
    expect(body?.className).not.toContain('overflow-y-auto');
  });

  it('pipeline-runs keeps queued-only rows inside the frameless primary scroller', () => {
    usePipelineRunsStore.setState({
      queuedExecutionsByWorktree: {
        [WORKTREE_KEY]: [
          {
            queueId: 'queue-1',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            pipelineId: 'pipeline-1',
            pipelineName: 'Queued review pipeline',
            reason: 'pipeline-concurrency',
            reasonLabel: 'Waiting for another pipeline',
            enqueuedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
    });

    renderFrameless(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);

    const primary = container.querySelector(
      '[data-testid="pipeline-runs-primary-list"]',
    );
    expect(primary?.className).toContain('flex-1');
    expect(primary?.className).toContain('overflow-y-auto');
    expect(primary?.textContent).toContain('Queued review pipeline');
  });

  it('plans uses a flex body with a filling primary list in frameless', () => {
    useActivityStore.setState({
      trackedPlans: { [WORKTREE_KEY]: [TRACKED_PLAN] },
      loadTrackedPlans: jest.fn().mockResolvedValue(undefined),
    });
    renderFrameless(<PlansSection />);
    const plansRoot = container.querySelector(
      '[data-testid="activity-plans-section"]',
    );
    expect(plansRoot?.className).toContain('flex-1');
    expect(plansRoot?.className).toContain('min-h-0');
    expect(plansRoot?.className).toContain('flex-col');
    const body = container.querySelector(
      '[data-testid="frameless-section-body"]',
    );
    expect(body?.className).toContain('flex-col');
    // Primary list fills; no max-h-76 on the primary.
    const primary = container.querySelector(
      '[data-testid="plans-primary-list"]',
    );
    expect(primary?.className).toContain('flex-1');
    expect(primary?.className).not.toContain('max-h-76');
  });

  it('records Notes item titles in body-only and frameless chrome', () => {
    useWorkspaceItemsStore.setState({
      notes: { 'project-1': [MARKDOWN_ITEM] },
      loadNotes: jest.fn(() => Promise.resolve()),
    });
    const noteTitle = (): Element | undefined =>
      Array.from(container.querySelectorAll('span')).find(
        (span) => span.textContent === MARKDOWN_ITEM.title,
      );

    // Body-only (the activity panel): the list body carries no block.
    renderBodyOnly(
      <NotesSection projectId="project-1" worktreeId="worktree-1" />,
    );
    expect(noteTitle()).toBeDefined();
    expect(noteTitle()?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();

    // Frameless (an activity-card panel): the section root carries no block.
    renderFrameless(
      <NotesSection projectId="project-1" worktreeId="worktree-1" />,
    );
    const section = container.querySelector(
      '[data-activity-chrome="frameless"]',
    );
    expect(section?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(section?.contains(noteTitle() ?? null)).toBe(true);
    expect(noteTitle()?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('defaults to the card chrome outside a provider (stacked ActivityPanel unchanged)', () => {
    act(() => {
      root.render(<TodoSection />);
    });
    expect(
      container.querySelector('[data-activity-chrome="frameless"]'),
    ).toBeNull();
    const card = container.querySelector('section.rounded-lg');
    expect(card).not.toBeNull();
    expect(card?.className).toContain('bg-tertiary');
    expect(card?.className).toContain('shadow-sm');
    expect(card?.className).not.toContain('border');
    expect(
      container.querySelector('[data-panel-section-hover-chevron]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Expand section"], [aria-label="Collapse section"]',
      ),
    ).toBeNull();
  });
});
