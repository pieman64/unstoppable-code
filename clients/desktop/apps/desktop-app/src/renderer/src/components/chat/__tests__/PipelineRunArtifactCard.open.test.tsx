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
import type { PipelineRunTreeRowProps } from '@canopy/ui-app';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { PipelineRunArtifactCard } from '../PipelineRunArtifactCard';

const openPipelineExecutionFromUi = jest.fn(() =>
  Promise.resolve({ status: 'applied' }),
);
const openAgentArtifactNavigation = jest.fn(() => Promise.resolve());
const revealChatPanel = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
const reportModalProps: Array<Record<string, unknown>> = [];
const detectChatStoreSurface = jest.fn(() => 'main');
let rowProps: PipelineRunTreeRowProps | null = null;

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
jest.mock('../PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (): null => null,
}));
jest.mock('@/components/activity/PipelineReportModal', () => ({
  PipelineReportModal: (props: Record<string, unknown>): null => {
    reportModalProps.push(props);
    return null;
  },
}));
jest.mock('@canopy/ui-app', () => ({
  PipelineRunTreeRow: (props: PipelineRunTreeRowProps): JSX.Element => {
    rowProps = props;
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
    rowProps = null;
    openPipelineExecutionFromUi.mockClear();
    openAgentArtifactNavigation.mockClear();
    detectChatStoreSurface.mockReturnValue('main');
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: {},
      advisorSnapshotsByExecutionId: {},
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
      rowProps?.onOpenDetail('run-root', CHILD_STACK, 'deploy');
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
      rowProps?.onOpenSource('run-source');
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
      rowProps?.onOpenDetail('run-root', CHILD_STACK, 'deploy');
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
        pipeline_snapshot: { name: 'Deploy', jobs: {} },
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
        project_id: 'project-1',
        worktree_id: 'worktree-1',
        report_outputs: { report_file: '/reports/r.md' },
      };
      usePipelineRunsStore.setState({ statesById: { 'run-root': state } });
    });

    it('reveals its own chat after a plan Chat follow-up', async () => {
      await act(async () => {
        rowProps?.onChatFollowUp('run-root');
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
        rowProps?.onReportChatFollowUp('run-root');
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'Review this report: /reports/r.md',
        undefined,
        CHAT_TARGET,
      );
      expect(revealChatPanel).toHaveBeenCalledWith(CHAT_TARGET);
    });

    it('still opens the report modal from View report', () => {
      act(() => {
        rowProps?.onViewReport('run-root');
      });

      expect(reportModalProps.at(-1)).toMatchObject({
        executionId: 'run-root',
      });
      expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
    });
  });
});
