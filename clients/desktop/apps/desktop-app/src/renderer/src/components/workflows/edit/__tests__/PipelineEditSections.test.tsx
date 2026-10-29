/**
 * @jest-environment jsdom
 *
 * CAN-4072: a pipeline's Trigger section lists the automations that run it,
 * and each opens that automation with Back returning here. Its Runs section
 * is the Runs feed narrowed to the pipeline.
 */
import type { WorkflowRunFeed } from '../../runs/useWorkflowRunFeed';

const mockFeed: { current: WorkflowRunFeed | null } = { current: null };
const mockOpenExecution = jest.fn<Promise<void>, [{ executionId: string }]>(
  () => Promise.resolve(),
);

jest.mock('../../runs/useWorkflowRunFeed', () => ({
  ...jest.requireActual<object>('../../runs/useWorkflowRunFeed'),
  useWorkflowRunFeed: (): WorkflowRunFeed => {
    if (!mockFeed.current) throw new Error('No mock run feed');
    return mockFeed.current;
  },
}));
jest.mock('../../../activity/usePipelineExecutionActions', () => ({
  usePipelineExecutionActions: (): object => ({
    cancel: jest.fn(() => Promise.resolve()),
    retry: jest.fn(() => Promise.resolve()),
    rerun: jest.fn(() => Promise.resolve()),
    dialogs: null,
    dialogAnchorRef: { current: null },
  }),
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: {
    executionId: string;
  }): Promise<void> => mockOpenExecution(request),
}));
jest.mock('../../../watchers/WatcherManagementModal', () => ({
  WatcherManagementModal: (): null => null,
}));
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<object>('@canopy/app-state'),
  useCapabilities: (): { automations: boolean; watchers: boolean } => ({
    automations: true,
    watchers: true,
  }),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { WorkflowRunRow } from '@canopy/ui-app/workflows';
import type { WorkflowEditTarget } from '@/lib/workflows/edit-target';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  PipelineRunsSection,
  PipelineTriggerSection,
} from '../PipelineEditSections';
import { automationsApi, pipelineInfo } from './pipelineEditMocks';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const REVIEW = pipelineInfo({ id: 'review', name: 'Review' });
const RELEASE = pipelineInfo({ id: 'release', name: 'Release' });
const PIPELINES: readonly PipelineInfo[] = [REVIEW, RELEASE];
const RETURN_TO: WorkflowEditTarget = {
  kind: 'pipeline',
  pipelineId: 'review',
  source: 'user',
};

function activity(
  id: string,
  name: string,
  action: AutomationAction,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function runsPipeline(pipelineId: string): AutomationAction {
  return {
    type: 'worktree_pipeline',
    workspaceId: 'storefront',
    pipelineId,
    pipelineSource: 'user',
  };
}

function execution(id: string, pipelineId: string): ExecutionSummary {
  return {
    id,
    pipeline_id: pipelineId,
    pipeline_name: pipelineId,
    status: 'success',
    status_reasons: [],
    started_at: '2026-10-12T10:00:00.000Z',
    cwd: '/tmp',
  };
}

function executionRow(summary: ExecutionSummary): WorkflowRunRow {
  const started = Date.parse(summary.started_at);
  return {
    kind: 'pipeline',
    key: `pipeline-run:${summary.id}`,
    name: summary.pipeline_name,
    status: 'success',
    startedAt: started,
    endedAt: started + 60_000,
    actions: [],
    result: { available: true },
    summary,
  };
}

function feed(rows: readonly WorkflowRunRow[]): WorkflowRunFeed {
  return {
    rows,
    activeCount: 0,
    executionsById: new Map(),
    runsById: new Map(),
    watchersById: new Map(),
    error: null,
    loading: false,
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    loadMore: jest.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  useNavigationStore.setState({
    activePage: 'workflows-library',
    workflowEdit: RETURN_TO,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mockFeed.current = null;
  useExecutionFeedStore.setState({ executions: [] });
  useNavigationStore.setState({ workflowEdit: undefined });
});

describe('PipelineTriggerSection', () => {
  const nightly = activity(
    'a-nightly',
    'Nightly review',
    runsPipeline('review'),
  );
  const weekly = activity('a-weekly', 'Weekly review', runsPipeline('review'), {
    enabled: false,
  });
  const release = activity(
    'a-release',
    'Release train',
    runsPipeline('release'),
  );
  const chat = activity('a-chat', 'Triage', {
    type: 'standalone_prompt',
    chatProjectId: 'storefront',
    prompt: 'Triage new tickets',
  });

  function renderTrigger(activities: readonly ScheduledActivity[]): void {
    act(() => {
      root.render(
        <PipelineTriggerSection
          pipeline={REVIEW}
          pipelines={PIPELINES}
          automations={automationsApi({ activities })}
          returnTo={RETURN_TO}
        />,
      );
    });
  }

  it('lists only the automations that run this pipeline, with schedule and state', () => {
    renderTrigger([release, weekly, chat, nightly]);

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="pipeline-trigger-automation"]',
      ),
    );
    expect(rows.map((row) => row.dataset.activityId)).toEqual([
      'a-nightly',
      'a-weekly',
    ]);
    expect(rows[0]?.textContent).toContain('Nightly review');
    expect(rows[0]?.textContent).toContain('On');
    expect(rows[1]?.textContent).toContain('Off');
    expect(byTestId('pipeline-trigger-automations-empty')).toBeNull();
  });

  it('says so when no automation runs it', () => {
    renderTrigger([release, chat]);

    expect(byTestId('pipeline-trigger-automations-empty')?.textContent).toBe(
      'No automations run this pipeline.',
    );
    expect(byTestId('pipeline-trigger-automation')).toBeNull();
  });

  it('opens an automation whose Back returns to this Trigger section', () => {
    renderTrigger([nightly]);

    act(() => {
      byTestId('pipeline-trigger-automation')?.click();
    });

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'a-nightly',
      returnTo: { ...RETURN_TO, section: 'trigger' },
    });
  });
});

describe('PipelineRunsSection', () => {
  function renderRuns(): void {
    act(() => {
      root.render(
        <PipelineRunsSection
          pipeline={REVIEW}
          pipelines={PIPELINES}
          automations={automationsApi()}
        />,
      );
    });
  }

  function runKeys(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="workflows-run-row"]',
      ),
    ).map((row) => row.dataset.runKey ?? '');
  }

  it("lists this pipeline's runs only, and opens one", () => {
    const reviewRun = execution('exec-review', 'review');
    const releaseRun = execution('exec-release', 'release');
    useExecutionFeedStore.setState({ executions: [reviewRun, releaseRun] });
    mockFeed.current = feed([
      executionRow(reviewRun),
      executionRow(releaseRun),
    ]);
    renderRuns();

    expect(runKeys()).toEqual(['pipeline-run:exec-review']);
    expect(byTestId('workflow-edit-no-runs')).toBeNull();

    act(() => {
      byTestId('workflows-run-name')?.click();
    });
    expect(mockOpenExecution).toHaveBeenCalledWith({
      executionId: 'exec-review',
    });
  });

  it('leaves Open in Library out, since the Library is behind the shell', () => {
    const reviewRun = execution('exec-review', 'review');
    useExecutionFeedStore.setState({ executions: [reviewRun] });
    mockFeed.current = feed([
      { ...executionRow(reviewRun), actions: ['open-library'] },
    ]);
    renderRuns();

    expect(runKeys()).toEqual(['pipeline-run:exec-review']);
    expect(byTestId('workflows-run-menu')).toBeNull();
  });

  it('says No runs yet when it has none', () => {
    const releaseRun = execution('exec-release', 'release');
    mockFeed.current = feed([executionRow(releaseRun)]);
    renderRuns();

    expect(runKeys()).toEqual([]);
    expect(byTestId('workflow-edit-no-runs')?.textContent).toBe('No runs yet');
  });

  it('offers older runs when none of the loaded ones are this pipeline’s', () => {
    const releaseRun = execution('exec-release', 'release');
    const busyFeed = { ...feed([executionRow(releaseRun)]), hasMore: true };
    mockFeed.current = busyFeed;
    renderRuns();

    expect(byTestId('workflow-edit-no-runs')?.textContent).toBe(
      'No recent runs',
    );
    const loadMore = byTestId('workflows-runs-load-more');
    expect(loadMore).not.toBeNull();
    act(() => {
      loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(busyFeed.loadMore).toHaveBeenCalledTimes(1);
  });
});
