/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationArtifactReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { createAgentArtifactDedupeKey } from '@canopy/desktop-shared/lib/agent-artifacts';
import type * as GitHubWorkflowRunRowModule from '@canopy/ui-app/code/activity/github/GitHubWorkflowRunRow';
import type * as PipelineRunReceiptModule from '@canopy/ui-app/code/agent-activity/pipeline-run-receipt';
import type { PipelineRunReceiptCardProps } from '@canopy/ui-app/code/agent-activity/PipelineRunReceiptCard';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { DesktopAgentActivitySection } from '../DesktopAgentActivitySection';
import {
  hasPipelineSummaryInterest,
  isPipelineExecutionLeased,
} from '@/lib/pipelineDetailLeases';

const openSkillViewer = jest.fn();
const openPipelineExecutionFromUi = jest.fn();
let mockPipelineRunsState: Record<string, unknown>;
let reportModalProps: Record<string, unknown> | null;
let planReadyModalProps: Record<string, unknown> | null;

jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn().mockResolvedValue({ status: 'placed' }),
}));
const openTrackedPlanMock = jest.mocked(openTrackedPlan);

jest.mock('@/components/activity/WorkflowRunView', () => ({
  WorkflowRunView: (): null => null,
}));

jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => 'main',
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): {
      openSkillViewer: typeof openSkillViewer;
    } => ({
      openSkillViewer,
    }),
  },
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): unknown =>
    openPipelineExecutionFromUi(request),
}));
jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (value: Record<string, unknown>) => unknown,
  ): unknown => selector(mockPipelineRunsState),
}));
jest.mock('@canopy/ui-app', () => ({
  // The GitHub row is pure display; render the real one so the card's job
  // dots and open affordances are exercised end to end.
  GitHubWorkflowRunRow: jest.requireActual<typeof GitHubWorkflowRunRowModule>(
    '@canopy/ui-app/code/activity/github/GitHubWorkflowRunRow',
  ).GitHubWorkflowRunRow,
}));
jest.mock('@canopy/ui-app/code/agent-activity/PipelineRunReceiptCard', () => ({
  PipelineRunReceiptCard: ({
    receipt,
    summaries,
    liveOverride,
    actions,
  }: PipelineRunReceiptCardProps): JSX.Element => {
    const { summary } = jest
      .requireActual<
        typeof PipelineRunReceiptModule
      >('@canopy/ui-app/code/agent-activity/pipeline-run-receipt')
      .pipelineRunReceiptView(receipt, summaries ?? [], liveOverride);
    const { onPipelineFollowUp, onViewReport, onOpenPlan } = actions ?? {};
    return (
      <div
        data-testid={`pipeline-run-card-${summary.id}`}
        data-has-hide-toggle="false"
      >
        {summary.pipeline_name} {summary.status}
        {onPipelineFollowUp && (
          <button
            data-testid={`pipeline-follow-up-${summary.id}`}
            onClick={() => onPipelineFollowUp(summary.id)}
          >
            Follow up
          </button>
        )}
        {onViewReport && (
          <button
            data-testid={`pipeline-view-report-${summary.id}`}
            onClick={() => onViewReport(summary.id)}
          >
            View report
          </button>
        )}
        {onOpenPlan && (
          <button
            data-testid={`pipeline-view-plan-${summary.id}`}
            onClick={() => onOpenPlan(summary.id)}
          >
            View plan
          </button>
        )}
      </div>
    );
  },
}));
const handleSdkSystemEvent = jest.fn();
jest.mock('@/stores/activityStore', () => ({
  useActivityStore: (
    selector: (value: { handleSdkSystemEvent: jest.Mock }) => unknown,
  ): unknown => selector({ handleSdkSystemEvent }),
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: (
    selector: (value: { addToast: jest.Mock }) => unknown,
  ): unknown => selector({ addToast: jest.fn() }),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { sendMessage: jest.Mock } => ({ sendMessage: jest.fn() }),
  },
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));
jest.mock('@/components/activity/PipelineReportModal', () => ({
  PipelineReportModal: (props: Record<string, unknown>): JSX.Element => {
    reportModalProps = props;
    return <div data-testid="pipeline-report-modal" />;
  },
}));
jest.mock('../PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (props: Record<string, unknown>): JSX.Element => {
    planReadyModalProps = props;
    return <div data-testid="plan-ready-pipeline-modal" />;
  },
}));
jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: (
    selector: (value: { watchers: []; completedWatchers: [] }) => unknown,
  ): unknown => selector({ watchers: [], completedWatchers: [] }),
}));
// jsdom has no layout: the progress bar centers the active dot with
// `scrollTo`, which the element prototype does not implement there.
Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value: (): void => undefined,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
const openLink = jest.fn().mockResolvedValue(undefined);
Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    browser: { openLink },
  },
});

const CHAT_TARGET = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

const receipt: SkillArtifactReceiptV1 = {
  version: 1,
  kind: 'skill',
  operation: 'skills.create',
  dedupeKey: createAgentArtifactDedupeKey(
    'skill',
    'installed',
    'custom',
    'review',
  ),
  createdAt: '2026-08-04T12:00:00.000Z',
  source: 'installed',
  sourceId: 'custom',
  installedName: 'review',
  name: 'Review',
  description: 'Reviews changes',
  canUpdate: true,
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom',
    skillName: 'review',
  },
};

const sharedReceipt: SkillArtifactReceiptV1 = {
  ...receipt,
  dedupeKey: createAgentArtifactDedupeKey('skill', 'shared', 'shared-1'),
  source: 'shared',
  sourceId: undefined,
  installedName: undefined,
  sharedSkillId: 'shared-1',
  shareScope: 'team',
  owner: { type: 'team', id: 'team-1', name: 'Platform' },
  canUpdate: false,
  navigationTarget: { kind: 'shared_skill', skillId: 'shared-1' },
};

const pipelineReceipt: PipelineArtifactReceiptV1 = {
  version: 1,
  kind: 'pipeline',
  operation: 'pipelines.create',
  dedupeKey: createAgentArtifactDedupeKey('pipeline', 'local', 'pipe-1'),
  createdAt: '2026-08-04T12:00:00.000Z',
  source: 'user',
  localId: 'pipe-1',
  name: 'Build',
  description: 'Builds the app',
  enabled: true,
  scopes: ['worktree'],
  runModes: ['dispatch', 'plan_ready'],
  jobCount: 2,
  stepCount: 5,
  navigationTarget: {
    kind: 'pipeline_editor',
    pipelineId: 'pipe-1',
    source: 'user',
  },
};

const automationReceipt: AutomationArtifactReceiptV1 = {
  version: 1,
  kind: 'automation',
  operation: 'automations.create',
  dedupeKey: createAgentArtifactDedupeKey('automation', 'activity-1'),
  createdAt: '2026-08-04T12:00:00.000Z',
  activityId: 'activity-1',
  name: 'Say hello',
  enabled: true,
  running: false,
  schedule: 'once 2026-08-05T14:53:30.000Z (local)',
  nextRunAt: '2026-08-05T14:53:30.000Z',
  actionKind: 'worktree_pipeline',
  targetSummary: 'pipeline pipe-1 in project project-1',
  ifCommandConfigured: true,
  navigationTarget: { kind: 'automation_editor', activityId: 'activity-1' },
};

const runReceipt: PipelineRunArtifactReceiptV1 = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: createAgentArtifactDedupeKey(
    'pipeline_run',
    'execution',
    'exec-1',
  ),
  createdAt: '2026-08-04T12:00:00.000Z',
  executionId: 'exec-1',
  pipelineId: 'pipe-1',
  pipelineName: 'Build',
  initialStatus: 'running',
  queuedAt: '2026-08-04T12:00:00.000Z',
  startedAt: '2026-08-04T12:00:01.000Z',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'exec-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  },
};

const githubRunReceipt: GitHubWorkflowRunArtifactReceiptV1 = {
  version: 1,
  kind: 'github_workflow_run',
  operation: 'github.watch',
  dedupeKey: createAgentArtifactDedupeKey(
    'github_workflow_run',
    'acme/api',
    '101',
  ),
  createdAt: '2026-08-04T12:00:00.000Z',
  watcherId: 'gh-watch-1',
  repository: 'acme/api',
  runId: '101',
  runAttempt: 1,
  workflowName: 'CI',
  runNumber: 42,
  htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  state: { kind: 'intermediate', status: 'in_progress' },
  startedAt: '2026-08-04T12:00:00.000Z',
  observedAt: '2026-08-04T12:00:05.000Z',
  jobs: [
    {
      jobId: '501',
      name: 'Build macOS',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
      observedAt: '2026-08-04T12:00:05.000Z',
    },
    {
      jobId: '502',
      name: 'Test',
      status: 'in_progress',
      conclusion: null,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/502',
      observedAt: '2026-08-04T12:00:05.000Z',
    },
  ],
  navigationTarget: {
    kind: 'github_workflow_run',
    repository: 'acme/api',
    runId: '101',
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  },
};

describe('DesktopAgentActivitySection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    openSkillViewer.mockReset();
    openPipelineExecutionFromUi.mockReset();
    openTrackedPlanMock.mockClear();
    reportModalProps = null;
    planReadyModalProps = null;
    mockPipelineRunsState = {
      summaries: [],
      statesById: {},
      rowStatesById: {},
      loadExecutionRowState: jest.fn().mockResolvedValue(null),
      loadExecutionDetails: jest.fn().mockResolvedValue(null),
      retryExecution: jest.fn(),
      rerunExecution: jest.fn(),
      advisorSnapshotsByExecutionId: {},
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders pipeline run cards at their own width below create/update cards', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt, receipt]}
          variant="completed"
        />,
      ),
    );
    const items = container.querySelector(
      '[data-testid="agent-activity-items"]',
    );
    const artifactGrid = container.querySelector(
      '[data-testid="agent-activity-artifact-items"]',
    );
    const runGrid = container.querySelector(
      '[data-testid="agent-activity-pipeline-run-items"]',
    );
    if (!items || !artifactGrid || !runGrid) throw new Error('missing grids');
    expect(Array.from(items.children)).toEqual([artifactGrid, runGrid]);
    expect(
      artifactGrid.querySelector('[data-testid="agent-artifact-skill"]'),
    ).not.toBeNull();
    expect(
      runGrid.querySelector('[data-testid="pipeline-run-card-exec-1"]'),
    ).not.toBeNull();
    expect(runGrid.className).toContain('space-y-2');
    expect(runGrid.className).not.toContain('grid-cols');
  });

  it('renders watched GitHub workflow runs with job dots that open on GitHub', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[githubRunReceipt, runReceipt]}
          variant="completed"
        />,
      ),
    );
    const items = container.querySelector(
      '[data-testid="agent-activity-items"]',
    );
    const runGrid = container.querySelector(
      '[data-testid="agent-activity-pipeline-run-items"]',
    );
    const githubGrid = container.querySelector(
      '[data-testid="agent-activity-github-run-items"]',
    );
    if (!items || !runGrid || !githubGrid) throw new Error('missing grids');
    expect(Array.from(items.children)).toEqual([runGrid, githubGrid]);
    const card = githubGrid.querySelector<HTMLElement>(
      '[data-testid="github-workflow-run-card-101"]',
    );
    if (!card) throw new Error('missing GitHub run card');
    expect(card.textContent).toContain('in progress');
    expect(card.textContent).toContain('CI #42');
    expect(card.textContent).toContain('acme/api');
    const dots = Array.from(
      card.querySelectorAll<HTMLButtonElement>('[data-job-id]'),
    );
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Build macOS: success',
      'Test: running',
    ]);

    act(() => dots[1].click());
    expect(openLink).toHaveBeenCalledWith({
      url: 'https://github.com/acme/api/actions/runs/101/job/502',
    });

    const runButton = card.querySelector<HTMLButtonElement>(
      '[data-testid="github-workflow-run-open-101"]',
    );
    if (!runButton) throw new Error('missing GitHub run button');
    act(() => runButton.click());
    expect(openLink).toHaveBeenCalledWith({
      url: 'https://github.com/acme/api/actions/runs/101',
    });
    expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
  });

  it('preserves directory scope for Cowork pipeline follow-ups', async () => {
    mockPipelineRunsState = {
      ...mockPipelineRunsState,
      statesById: {
        'exec-1': {
          id: 'exec-1',
          pipeline_id: 'pipe-1',
          pipeline_snapshot: { name: 'Build', jobs: {} },
          status: 'success',
          jobs: {},
          started_at: '2026-08-04T12:00:01.000Z',
          completed_at: '2026-08-04T12:01:00.000Z',
          cwd: '/cowork/root',
          inputs: {},
          project_id: 'cowork-project',
          worktree_id: 'cowork-root',
          event_data: { plan_ready: { plan_path: '/cowork/plan.md' } },
          scope: 'directory',
          target: { scope: 'directory', path: '/cowork/root' },
        },
      },
    };
    act(() => {
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt]}
          variant="completed"
        />,
      );
    });

    const followUp = container.querySelector(
      '[data-testid="pipeline-follow-up-exec-1"]',
    );
    if (!(followUp instanceof HTMLButtonElement)) {
      throw new Error('missing follow-up action');
    }
    await act(async () => {
      followUp.click();
      await Promise.resolve();
    });

    expect(planReadyModalProps).toMatchObject({
      executionScope: 'directory',
      executionTarget: { scope: 'directory', path: '/cowork/root' },
    });
  });

  it.each([
    ['beside the card’s chat in the plan’s worktree', 'worktree-1', true],
    ['beside the active chat of another worktree', 'worktree-2', false],
  ])(
    'opens a linked run’s plan %s',
    async (_label, runWorktreeId, besideCardChat) => {
      mockPipelineRunsState = {
        ...mockPipelineRunsState,
        statesById: {
          'exec-1': {
            id: 'exec-1',
            pipeline_id: 'pipe-1',
            pipeline_snapshot: { name: 'Build', jobs: {} },
            status: 'success',
            jobs: {},
            started_at: '2026-08-04T12:00:01.000Z',
            completed_at: '2026-08-04T12:01:00.000Z',
            cwd: '/worktree',
            inputs: {},
            project_id: 'project-1',
            worktree_id: runWorktreeId,
            planId: 'plan-1',
          },
        },
      };
      act(() => {
        root.render(
          <DesktopAgentActivitySection
            artifacts={[runReceipt]}
            variant="completed"
            chatTarget={CHAT_TARGET}
          />,
        );
      });

      const viewPlan = container.querySelector(
        '[data-testid="pipeline-view-plan-exec-1"]',
      );
      if (!(viewPlan instanceof HTMLButtonElement)) {
        throw new Error('missing View plan action');
      }
      await act(async () => {
        viewPlan.click();
        await Promise.resolve();
      });

      expect(openTrackedPlanMock).toHaveBeenCalledTimes(1);
      expect(openTrackedPlanMock).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: runWorktreeId,
          planId: 'plan-1',
        },
        besideCardChat ? { origin: { chatTabId: 'chat-1' } } : {},
      );
      expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
    },
  );

  it('portals pipeline run modals into the card owner document', async () => {
    mockPipelineRunsState = {
      ...mockPipelineRunsState,
      statesById: {
        'exec-1': {
          id: 'exec-1',
          pipeline_id: 'pipe-1',
          pipeline_snapshot: { name: 'Build', jobs: {} },
          status: 'success',
          jobs: {},
          started_at: '2026-08-04T12:00:01.000Z',
          completed_at: '2026-08-04T12:01:00.000Z',
          cwd: '/worktree',
          inputs: {},
          project_id: 'project-1',
          worktree_id: 'worktree-1',
          event_data: { plan_ready: { plan_path: '/worktree/plan.md' } },
        },
      },
    };
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const popoutDocument = frame.contentDocument;
    if (!popoutDocument) throw new Error('missing popout document');
    const popoutContainer = popoutDocument.createElement('div');
    popoutDocument.body.appendChild(popoutContainer);
    const popoutRoot = createRoot(popoutContainer);

    try {
      act(() => {
        popoutRoot.render(
          <DesktopAgentActivitySection
            artifacts={[runReceipt]}
            variant="completed"
          />,
        );
      });

      const reportButton = popoutDocument.querySelector<HTMLButtonElement>(
        '[data-testid="pipeline-view-report-exec-1"]',
      );
      const followUpButton = popoutDocument.querySelector<HTMLButtonElement>(
        '[data-testid="pipeline-follow-up-exec-1"]',
      );
      if (!reportButton) throw new Error('missing report action');
      if (!followUpButton) throw new Error('missing follow-up action');
      await act(async () => {
        reportButton.click();
        followUpButton.click();
        await Promise.resolve();
      });

      expect(
        popoutDocument.querySelector('[data-testid="pipeline-report-modal"]'),
      ).not.toBeNull();
      expect(
        popoutDocument.querySelector(
          '[data-testid="plan-ready-pipeline-modal"]',
        ),
      ).not.toBeNull();
      expect(
        document.body.querySelector('[data-testid="pipeline-report-modal"]'),
      ).toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="plan-ready-pipeline-modal"]',
        ),
      ).toBeNull();
      expect(reportModalProps?.ownerDocument).toBe(popoutDocument);
      expect(planReadyModalProps?.ownerDocument).toBe(popoutDocument);
    } finally {
      act(() => popoutRoot.unmount());
      frame.remove();
    }
  });

  it('labels shared updates as updated rather than created', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[{ ...sharedReceipt, operation: 'skills.update_shared' }]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-skill"]',
    );
    expect(card?.textContent).toContain('Updated');
    expect(card?.textContent).not.toContain('Created');
  });

  it('opens the installed skill with click and keyboard activation', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[receipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-artifact-skill"]',
    );
    if (!card) throw new Error('Expected skill artifact card');
    act(() => card.click());
    expect(openSkillViewer).toHaveBeenCalledWith({
      kind: 'installed',
      sourceId: 'custom',
      skillName: 'review',
    });
    act(() => {
      card.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(openSkillViewer).toHaveBeenCalledTimes(2);
  });

  it('shows actual skill ownership separately from update permission', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[sharedReceipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-skill"]',
    );
    if (!(card instanceof HTMLButtonElement)) throw new Error('missing card');
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Owner');
    expect(tooltip?.textContent).toContain('Platform');
    expect(tooltip?.textContent).toContain('Team');
    expect(tooltip?.textContent).toContain('Read only');
  });

  it('badges pipeline source and scope and renders trigger glyphs', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[pipelineReceipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-pipeline"]',
    );
    if (!(card instanceof HTMLButtonElement)) throw new Error('missing card');
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Custom');
    expect(tooltip?.textContent).toContain('Worktree');
    expect(tooltip?.textContent).toContain('2 jobs · 5 steps');
    expect(tooltip?.textContent).not.toContain('Open pipeline');
    // Trigger types render as glyphs labelled for assistive tech, matching the
    // icon-only trigger badges on the pipelines table.
    const triggers = Array.from(
      tooltip?.querySelectorAll('[aria-label]') ?? [],
    ).map((node) => node.getAttribute('aria-label'));
    expect(triggers).toEqual(['Dispatch', 'Plan ready']);
  });

  it('shows automation status, formatted next run, and target', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[automationReceipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-automation"]',
    );
    if (!(card instanceof HTMLButtonElement)) throw new Error('missing card');
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Enabled');
    expect(tooltip?.textContent).toContain('If command');
    expect(tooltip?.textContent).toContain(
      'pipeline pipe-1 in project project-1',
    );
    expect(tooltip?.textContent).toContain(
      new Date('2026-08-05T14:53:30.000Z').toLocaleString(),
    );
    expect(tooltip?.textContent).not.toContain('Open automation');
  });

  it('omits open-affordance copy from artifact tooltips', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[receipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-skill"]',
    );
    if (!(card instanceof HTMLButtonElement)) throw new Error('missing card');
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Review');
    expect(tooltip?.textContent).not.toContain('Open skill');
  });

  it('opens a shared skill using its tagged remote identity', () => {
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[sharedReceipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="agent-artifact-skill"]',
    );
    if (!(card instanceof HTMLButtonElement)) throw new Error('missing card');
    act(() => card.click());
    expect(openSkillViewer).toHaveBeenCalledWith({
      kind: 'shared',
      skillId: 'shared-1',
    });
  });

  it('uses the canonical pipeline row without the panel hide toggle or an extra tooltip', () => {
    mockPipelineRunsState = {
      summaries: [
        {
          id: 'exec-1',
          status: 'success',
          started_at: '2026-08-04T12:00:01.000Z',
          completed_at: '2026-08-04T12:05:00.000Z',
        },
      ],
      statesById: {},
      rowStatesById: {
        'exec-1': {
          status: 'success',
        },
      },
      loadExecutionRowState: jest.fn().mockResolvedValue(null),
      loadExecutionDetails: jest.fn(),
      retryExecution: jest.fn(),
      rerunExecution: jest.fn(),
      advisorSnapshotsByExecutionId: {},
    };
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt]}
          variant="completed"
        />,
      ),
    );
    const card = container.querySelector(
      '[data-testid="pipeline-run-card-exec-1"]',
    );
    if (!(card instanceof HTMLElement)) throw new Error('missing card');
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(card.textContent).toContain('Build success');
    expect(card.dataset.hasHideToggle).toBe('false');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps the canonical fallback row while execution details load', async () => {
    let resolveDetails: (value: null) => void = () => undefined;
    const loadExecutionRowState = jest.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveDetails = resolve;
        }),
    );
    mockPipelineRunsState = {
      summaries: [],
      statesById: {},
      rowStatesById: {},
      loadExecutionRowState,
      loadExecutionDetails: jest.fn(),
      retryExecution: jest.fn(),
      rerunExecution: jest.fn(),
      advisorSnapshotsByExecutionId: {},
    };
    const unavailableReceipt: PipelineRunArtifactReceiptV1 = {
      ...runReceipt,
      executionId: 'exec-unavailable',
      dedupeKey: createAgentArtifactDedupeKey(
        'pipeline_run',
        'execution',
        'exec-unavailable',
      ),
      navigationTarget: {
        ...runReceipt.navigationTarget,
        executionId: 'exec-unavailable',
      },
    };
    act(() => {
      root.render(
        <DesktopAgentActivitySection
          artifacts={[unavailableReceipt]}
          variant="completed"
        />,
      );
    });
    expect(loadExecutionRowState).toHaveBeenCalledWith('exec-unavailable');
    expect(
      container.querySelector(
        '[data-testid="pipeline-run-card-exec-unavailable"]',
      )?.textContent,
    ).toContain('Build running');

    await act(async () => {
      resolveDetails(null);
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps its run live with a summary interest while mounted, never a detail lease', () => {
    mockPipelineRunsState = {
      summaries: [],
      statesById: {},
      rowStatesById: { 'exec-1': { status: 'running' } },
      loadExecutionRowState: jest.fn().mockResolvedValue(null),
      loadExecutionDetails: jest.fn(),
      retryExecution: jest.fn(),
      rerunExecution: jest.fn(),
      advisorSnapshotsByExecutionId: {},
    };
    act(() =>
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt]}
          variant="completed"
        />,
      ),
    );

    expect(hasPipelineSummaryInterest('exec-1')).toBe(true);
    expect(isPipelineExecutionLeased('exec-1')).toBe(false);

    act(() => root.render(<></>));
    expect(hasPipelineSummaryInterest('exec-1')).toBe(false);
  });

  it('allows row state to reload after an earlier request settles', async () => {
    const loadExecutionRowState = jest.fn().mockResolvedValue(null);
    mockPipelineRunsState = {
      summaries: [],
      statesById: {},
      rowStatesById: {},
      loadExecutionRowState,
      loadExecutionDetails: jest.fn(),
      retryExecution: jest.fn(),
      rerunExecution: jest.fn(),
      advisorSnapshotsByExecutionId: {},
    };

    await act(async () => {
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt]}
          variant="completed"
        />,
      );
      await Promise.resolve();
    });
    act(() => root.render(<></>));
    await act(async () => {
      root.render(
        <DesktopAgentActivitySection
          artifacts={[runReceipt]}
          variant="completed"
        />,
      );
      await Promise.resolve();
    });

    expect(loadExecutionRowState).toHaveBeenCalledTimes(2);
  });
});
