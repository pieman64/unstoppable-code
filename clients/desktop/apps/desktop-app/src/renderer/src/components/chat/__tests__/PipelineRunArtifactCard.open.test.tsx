/**
 * @jest-environment jsdom
 *
 * The chat run card opens runs through the shared opener: beside its own
 * chat (origin), with the breadcrumb stack and job the row supplied. The App
 * Advisor window hands off to the main window with the run's owner and job;
 * that boundary carries no breadcrumb stack, so a child row binds the child.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineRunReceiptCardProps } from '@canopy/ui-app/agent-activity';
import { toPipelineRunRowState } from '@/lib/pipelineRunRowState';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { PipelineRunArtifactCard } from '../PipelineRunArtifactCard';

const openPipelineExecutionFromUi = jest.fn<
  Promise<unknown>,
  [request: unknown]
>(() => Promise.resolve({ status: 'applied' }));
const openAgentArtifactNavigation = jest.fn<Promise<void>, [request: unknown]>(
  () => Promise.resolve(),
);
const revealChatPanel = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
const reportModalProps: Array<Record<string, unknown>> = [];
const detectChatStoreSurface = jest.fn(() => 'main');
let cardProps: PipelineRunReceiptCardProps | null = null;

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUi(request),
}));
jest.mock('@/lib/panels/reveal-chat-panel', () => ({
  revealChatPanel: (target: unknown): Promise<boolean> =>
    revealChatPanel(target),
}));
jest.mock('../agent-artifact-navigation', () => ({
  openAgentArtifactNavigation: (request: unknown): Promise<void> =>
    openAgentArtifactNavigation(request),
}));
jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => detectChatStoreSurface(),
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));
const planReadyModalProps: Array<Record<string, unknown>> = [];
jest.mock('../PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (props: Record<string, unknown>): null => {
    planReadyModalProps.push(props);
    return null;
  },
}));
jest.mock('@/components/activity/PipelineReportModal', () => ({
  PipelineReportModal: (props: Record<string, unknown>): null => {
    reportModalProps.push(props);
    return null;
  },
}));
jest.mock('@canopy/ui-app/code/agent-activity/PipelineRunReceiptCard', () => ({
  PipelineRunReceiptCard: (props: PipelineRunReceiptCardProps): JSX.Element => {
    cardProps = props;
    return <div data-testid="row" />;
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const receipt: PipelineRunArtifactReceiptV1 = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: 'pipeline_run:run-root',
  createdAt: '2026-09-29T00:00:00.000Z',
  executionId: 'run-root',
  pipelineId: 'pipeline-1',
  pipelineName: 'Deploy',
  initialStatus: 'running',
  queuedAt: '2026-09-29T00:00:00.000Z',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'run-root',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  },
};

const CHILD_STACK = [{ executionId: 'run-child', label: 'Child pipeline' }];

describe('PipelineRunArtifactCard run links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    cardProps = null;
    openPipelineExecutionFromUi.mockClear();
    openAgentArtifactNavigation.mockClear();
    detectChatStoreSurface.mockReturnValue('main');
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: {},
      rowStatesById: {},
      advisorSnapshotsByExecutionId: {},
      loadExecutionRowState: jest.fn(() => Promise.resolve(null)),
      loadExecutionDetails: jest.fn(() => Promise.resolve(null)),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <PipelineRunArtifactCard
          receipt={receipt}
          chatTarget={{
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-7',
          }}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('opens a child job beside its chat with the breadcrumb stack and job', () => {
    act(() => {
      cardProps?.actions?.onOpenDetail?.('run-root', CHILD_STACK, 'deploy');
    });

    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'run-root',
      owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
      target: { viewStack: CHILD_STACK, jobId: 'deploy' },
      origin: { chatTabId: 'chat-7', ownerKey: 'project-1/worktree-1' },
    });
  });

  it('opens a rerun source from its own record rather than the card owner', () => {
    act(() => {
      cardProps?.actions?.onOpenSource?.('run-source');
    });

    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'run-source',
      target: { viewStack: [] },
      origin: { chatTabId: 'chat-7', ownerKey: 'project-1/worktree-1' },
    });
  });

  it('hands off from the App Advisor window with the owner and job', () => {
    detectChatStoreSurface.mockReturnValue('app-advisor');

    act(() => {
      cardProps?.actions?.onOpenDetail?.('run-root', CHILD_STACK, 'deploy');
    });

    expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
    expect(openAgentArtifactNavigation).toHaveBeenCalledWith({
      kind: 'pipeline_execution',
      executionId: 'run-child',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      jobId: 'deploy',
    });
  });

  describe('follow-ups', () => {
    const sendMessage = jest.fn<
      Promise<void>,
      Parameters<ReturnType<typeof useChatStore.getState>['sendMessage']>
    >(() => Promise.resolve());
    const CHAT_TARGET = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-7',
    };

    beforeEach(() => {
      sendMessage.mockClear();
      revealChatPanel.mockClear();
      reportModalProps.length = 0;
      useChatStore.setState({ sendMessage });
      const state: ExecutionState = {
        version: 8,
        id: 'run-root',
        pipeline_id: 'pipeline-1',
        pipeline_snapshot: { name: 'Deploy', scope: ['directory'], jobs: {} },
        status: 'success',
        jobs: {},
        job_definitions: {},
        job_groups: {},
        pending_pauses: [],
        status_reasons: [],
        started_at: '2026-09-29T00:00:00.000Z',
        cwd: '/workspaces/project-1/worktree-1',
        env: {},
        inputs: {},
        event_name: 'plan_ready',
        event_data: { plan_ready: { plan_path: '/plans/p.md' } },
        planId: 'plan-1',
        rerun_source_id: 'run-source',
        trigger_source: {
          kind: 'hook',
          hook_key: 'pull-request',
          hook_label: 'Pull request',
          trigger_name: 'pr:create',
          target: 'project',
          action_index: 0,
          triggered_at: '2026-09-29T00:00:00.000Z',
        },
        project_id: 'project-1',
        worktree_id: 'worktree-1',
        report_outputs: { report_file: '/reports/r.md' },
      };
      usePipelineRunsStore.setState({
        statesById: {},
        rowStatesById: { 'run-root': toPipelineRunRowState(state) },
        loadExecutionDetails: jest.fn(() => Promise.resolve(state)),
      });
    });

    it('uses live row metadata without a matching summary or full-state cache', () => {
      expect(usePipelineRunsStore.getState().summaries).toEqual([]);
      expect(cardProps?.statesById).toMatchObject({
        'run-root': { id: 'run-root', status: 'success' },
      });
      expect(cardProps?.liveOverride).toMatchObject({
        status: 'success',
        planId: 'plan-1',
        rerun_source_id: 'run-source',
        trigger_source: { kind: 'hook', hook_label: 'Pull request' },
      });
      expect(cardProps?.actions?.onOpenPlan).toBeDefined();
      expect(cardProps?.actions?.onRerun).toBeDefined();
    });

    it('updates an off-scope receipt from a live row event', () => {
      const row = usePipelineRunsStore.getState().rowStatesById['run-root'];
      if (row === undefined) {
        throw new Error('Expected a projected row for the receipt run');
      }
      act(() => {
        usePipelineRunsStore.setState({
          rowStatesById: { 'run-root': { ...row, status: 'failure' } },
        });
      });

      expect(cardProps?.liveOverride?.status).toBe('failure');
      expect(cardProps?.liveOverride?.planId).toBe('plan-1');
      expect(cardProps?.liveOverride?.rerun_source_id).toBe('run-source');
    });

    it('loads full state on demand for an action even when only a row is cached', async () => {
      await act(async () => {
        cardProps?.actions?.onChatFollowUp?.('run-root');
        await Promise.resolve();
      });

      expect(
        usePipelineRunsStore.getState().loadExecutionDetails,
      ).toHaveBeenCalledWith('run-root');
      expect(sendMessage).toHaveBeenCalledWith(
        'Review this plan: /plans/p.md',
        undefined,
        CHAT_TARGET,
      );
    });

    it('reveals its own chat after a plan Chat follow-up', async () => {
      await act(async () => {
        cardProps?.actions?.onChatFollowUp?.('run-root');
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'Review this plan: /plans/p.md',
        undefined,
        CHAT_TARGET,
      );
      expect(revealChatPanel).toHaveBeenCalledWith(CHAT_TARGET);
    });

    it('reveals its own chat after a report Chat follow-up', async () => {
      await act(async () => {
        cardProps?.actions?.onReportChatFollowUp?.('run-root');
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'Review this report: /reports/r.md',
        undefined,
        CHAT_TARGET,
      );
      expect(revealChatPanel).toHaveBeenCalledWith(CHAT_TARGET);
    });

    it.each([
      ['its scope', { scope: 'global' as const }],
      [
        'only its target',
        { scope: undefined, target: { scope: 'global' as const } },
      ],
    ])(
      'refuses a pipeline follow-up from a run with no project named by %s',
      async (_label, globalFields) => {
        const addToast = jest.fn();
        useGitHubStore.setState({ addToast });
        // The card caches only rows; the action loads the full state on demand.
        const global = await usePipelineRunsStore
          .getState()
          .loadExecutionDetails('run-root');
        if (!global) throw new Error('Expected the run state');
        act(() => {
          usePipelineRunsStore.setState({
            loadExecutionDetails: jest.fn(() =>
              Promise.resolve({
                ...global,
                ...globalFields,
                project_id: undefined,
                worktree_id: undefined,
              }),
            ),
          });
        });
        planReadyModalProps.length = 0;

        await act(async () => {
          cardProps?.actions?.onPipelineFollowUp?.('run-root');
          await Promise.resolve();
        });

        // A run with no project starts only by dispatch, never from a plan.
        expect(planReadyModalProps).toHaveLength(0);
        expect(addToast).toHaveBeenCalledWith(
          "A run with no project can't start a follow-up pipeline.",
          'error',
          undefined,
          { category: 'Pipeline' },
        );
      },
    );

    it('still opens the report modal from View report', () => {
      act(() => {
        cardProps?.actions?.onViewReport?.('run-root');
      });

      expect(reportModalProps.at(-1)).toMatchObject({
        executionId: 'run-root',
      });
      expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
    });
  });
});
