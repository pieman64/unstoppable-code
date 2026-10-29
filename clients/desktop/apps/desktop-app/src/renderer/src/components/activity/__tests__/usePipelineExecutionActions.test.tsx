/**
 * @jest-environment jsdom
 */
interface MockChatState {
  selectedWorktree: { projectId: string; worktreeId: string } | null;
  worktreeChats: Record<string, unknown>;
  selectWorktree: jest.Mock<void, [string, string]>;
  sendMessage: jest.Mock<Promise<void>, [string]>;
}

const mockChatState: MockChatState = {
  selectedWorktree: null,
  worktreeChats: {},
  selectWorktree: jest.fn<void, [string, string]>(),
  sendMessage: jest.fn<Promise<void>, [string]>(),
};
const mockRevealChatPanel = jest.fn<
  Promise<boolean>,
  [{ projectId: string; worktreeId: string; chatId: string }]
>();
const mockOpenTrackedPlan = jest.fn<
  Promise<unknown>,
  [{ projectId: string; worktreeId: string; planId: string }]
>();
const mockAddToast = jest.fn();
const mockDispatchAppAction = jest.fn();
const mockReportModalProps: Array<Record<string, unknown>> = [];
interface MockPlanReadyModalProps {
  projectId?: string;
  worktreeId?: string;
  isRunning?: boolean;
  onRun: PlanReadyPipelineModalOnRun;
}
const mockPlanReadyModalProps: MockPlanReadyModalProps[] = [];

jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: (): MockChatState => mockChatState },
}));
jest.mock('@/lib/panels/reveal-chat-panel', () => ({
  revealChatPanel: (target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }): Promise<boolean> => mockRevealChatPanel(target),
}));
jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: (ref: {
    projectId: string;
    worktreeId: string;
    planId: string;
  }): Promise<unknown> => mockOpenTrackedPlan(ref),
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: (...args: unknown[]): unknown =>
    mockDispatchAppAction(...args),
}));
jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (props: Record<string, unknown>): null => {
    mockReportModalProps.push(props);
    return null;
  },
}));
jest.mock('@/components/chat/PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (props: MockPlanReadyModalProps): null => {
    mockPlanReadyModalProps.push(props);
    return null;
  },
}));

import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  PipelineData,
} from '@canopy/desktop-shared/types/pipeline';
import type { PlanReadyPipelineModalOnRun } from '@/components/chat/PlanReadyPipelineModal';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  resetPipelineExecutionActionsStoreForTests,
  usePipelineExecutionActionsStore,
} from '@/stores/pipelineExecutionActionsStore';
import {
  usePipelineExecutionActions,
  type PipelineExecutionActions,
  type UsePipelineExecutionActionsOptions,
} from '../usePipelineExecutionActions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const PLAN_PATH = '/data/plans/plan-1.md';

/** A failed run owned by `project-1/owner-wt`, with a plan and a report. */
function ownedExecution(
  overrides: Partial<ExecutionState> = {},
): ExecutionState {
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Build pipeline', jobs: {} },
    status: 'failure',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-05-19T00:00:00.000Z',
    completed_at: '2026-05-19T00:01:00.000Z',
    cwd: '/workspaces/project-1/owner-wt',
    env: {},
    inputs: {},
    event_name: 'plan_ready',
    event_data: { plan_ready: { plan_path: PLAN_PATH } },
    project_id: 'project-1',
    worktree_id: 'owner-wt',
    planId: 'plan-1',
    report_outputs: { report_file: '/data/reports/report.md' },
    ...overrides,
  };
}

function Consumer({
  options,
  onActions,
}: {
  options?: UsePipelineExecutionActionsOptions;
  onActions: (actions: PipelineExecutionActions) => void;
}): JSX.Element {
  const actions = usePipelineExecutionActions(options);
  useEffect(() => {
    onActions(actions);
  });
  return (
    <>
      <span ref={actions.dialogAnchorRef} />
      {actions.dialogs}
    </>
  );
}

describe('usePipelineExecutionActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: PipelineExecutionActions | null;
  const retryExecution = jest.fn<
    Promise<{ success: boolean; error?: string }>,
    [string]
  >();
  const cancelExecution = jest.fn<Promise<unknown>, [string]>();
  const execute = jest.fn();
  const getWorktreePath = jest.fn();

  function current(): PipelineExecutionActions {
    if (actions === null) throw new Error('actions not rendered');
    return actions;
  }

  async function renderConsumer(
    options?: UsePipelineExecutionActionsOptions,
    target: HTMLElement = container,
  ): Promise<Root> {
    const consumerRoot = target === container ? root : createRoot(target);
    await act(async () => {
      consumerRoot.render(
        <Consumer
          options={options}
          onActions={(next): void => {
            actions = next;
          }}
        />,
      );
      await flushAsyncWork();
    });
    return consumerRoot;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockReportModalProps.length = 0;
    mockPlanReadyModalProps.length = 0;
    resetPipelineExecutionActionsStoreForTests();
    actions = null;
    // Another worktree is selected; the run belongs to project-1/owner-wt.
    mockChatState.selectedWorktree = {
      projectId: 'project-2',
      worktreeId: 'other-wt',
    };
    mockChatState.worktreeChats = {
      'project-1/owner-wt': {
        tabs: [{ id: 'chat-a' }, { id: 'chat-b' }],
        activeTabId: 'chat-b',
      },
    };
    mockChatState.sendMessage.mockResolvedValue(undefined);
    mockRevealChatPanel.mockResolvedValue(true);
    mockOpenTrackedPlan.mockResolvedValue({ status: 'applied' });
    retryExecution.mockResolvedValue({ success: true });
    cancelExecution.mockResolvedValue({ success: true });
    execute.mockResolvedValue({ success: true });
    getWorktreePath.mockResolvedValue('/resolved/project-1/owner-wt');
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { cancelExecution, execute },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getWorktreePath },
    });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { 'exec-1': ownedExecution() },
      retryExecution,
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(null),
      ),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe('captured execution scope', () => {
    it('sends a chat follow-up to the run’s own worktree, not the selected one', async () => {
      await renderConsumer();
      await act(async () => {
        await current().chatFollowUp('exec-1');
      });

      expect(mockChatState.selectWorktree).toHaveBeenCalledWith(
        'project-1',
        'owner-wt',
      );
      expect(mockChatState.selectWorktree).not.toHaveBeenCalledWith(
        'project-2',
        'other-wt',
      );
      expect(mockChatState.sendMessage).toHaveBeenCalledWith(
        `Review this plan: ${PLAN_PATH}`,
      );
    });

    it('sends a report follow-up to the run’s own worktree', async () => {
      await renderConsumer();
      await act(async () => {
        await current().reportChatFollowUp('exec-1');
      });

      expect(mockChatState.selectWorktree).toHaveBeenCalledWith(
        'project-1',
        'owner-wt',
      );
      expect(mockChatState.sendMessage).toHaveBeenCalledWith(
        'Review this report: /data/reports/report.md',
      );
    });

    it('reveals the chat that receives a plan follow-up', async () => {
      await renderConsumer();
      await act(async () => {
        await current().chatFollowUp('exec-1');
      });

      // The worktree's active chat receives the message, so that chat is
      // the one brought into view, in the run's own worktree.
      expect(mockRevealChatPanel).toHaveBeenCalledTimes(1);
      expect(mockRevealChatPanel).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        chatId: 'chat-b',
      });
    });

    it('reveals the chat that receives a report follow-up', async () => {
      await renderConsumer();
      await act(async () => {
        await current().reportChatFollowUp('exec-1');
      });

      expect(mockRevealChatPanel).toHaveBeenCalledTimes(1);
      expect(mockRevealChatPanel).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        chatId: 'chat-b',
      });
    });

    it('reveals the first writable chat when the active tab is a file', async () => {
      mockChatState.worktreeChats = {
        'project-1/owner-wt': {
          tabs: [{ id: 'file-1', kind: 'file' }, { id: 'chat-a' }],
          activeTabId: 'file-1',
        },
      };
      await renderConsumer();
      await act(async () => {
        await current().chatFollowUp('exec-1');
      });

      expect(mockRevealChatPanel).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        chatId: 'chat-a',
      });
    });

    it('reveals the chat the send creates when the worktree has none', async () => {
      mockChatState.worktreeChats = {
        'project-1/owner-wt': { tabs: [], activeTabId: '' },
      };
      mockChatState.sendMessage.mockImplementation(() => {
        mockChatState.worktreeChats = {
          'project-1/owner-wt': {
            tabs: [{ id: 'chat-new' }],
            activeTabId: 'chat-new',
          },
        };
        return Promise.resolve();
      });
      await renderConsumer();
      await act(async () => {
        await current().chatFollowUp('exec-1');
      });

      expect(mockRevealChatPanel).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        chatId: 'chat-new',
      });
    });

    describe('when the send waits before creating the chat', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      it('still reveals the chat it creates', async () => {
        // sendMessage can wait up to 15 seconds for a chat-state refresh
        // before it creates the chat, so the reveal must not give up first.
        mockChatState.worktreeChats = {
          'project-1/owner-wt': { tabs: [], activeTabId: '' },
        };
        mockChatState.sendMessage.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                mockChatState.worktreeChats = {
                  'project-1/owner-wt': {
                    tabs: [{ id: 'chat-late' }],
                    activeTabId: 'chat-late',
                  },
                };
                resolve();
              }, 5000);
            }),
        );
        await renderConsumer();
        jest.useFakeTimers();
        await act(async () => {
          const followUp = current().chatFollowUp('exec-1');
          await jest.advanceTimersByTimeAsync(5100);
          await followUp;
        });

        expect(mockRevealChatPanel).toHaveBeenCalledWith({
          projectId: 'project-1',
          worktreeId: 'owner-wt',
          chatId: 'chat-late',
        });
      });
    });

    it('reveals no chat when the run has nothing to send', async () => {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': ownedExecution({ event_data: {}, report_outputs: {} }),
        },
      });
      await renderConsumer();
      await act(async () => {
        await current().chatFollowUp('exec-1');
      });

      expect(mockChatState.sendMessage).not.toHaveBeenCalled();
      expect(mockRevealChatPanel).not.toHaveBeenCalled();
    });

    it('opens the run’s tracked plan in its own worktree', async () => {
      await renderConsumer();
      await act(async () => {
        await current().openPlan('exec-1');
      });

      expect(mockOpenTrackedPlan).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        planId: 'plan-1',
      });
    });

    it('runs a plan-ready follow-up in the run’s own worktree', async () => {
      await renderConsumer();
      await act(async () => {
        await current().pipelineFollowUp('exec-1');
        await flushAsyncWork();
      });
      await act(async () => {
        await flushAsyncWork();
      });

      const modalProps = mockPlanReadyModalProps.at(-1);
      expect(modalProps).toMatchObject({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        isRunning: false,
      });
      if (modalProps === undefined) throw new Error('follow-up not opened');
      const { onRun } = modalProps;
      const pipeline: PipelineData = {
        info: {
          id: 'review',
          name: 'Review',
          source: 'user',
          triggers: ['plan_ready'],
        },
        content: 'name: Review',
      };
      await act(async () => {
        await onRun('review', pipeline, undefined, undefined, {
          preferences: {},
        });
      });

      expect(getWorktreePath).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'owner-wt',
        repoId: undefined,
      });
      expect(execute).toHaveBeenCalledWith(
        'name: Review',
        expect.objectContaining({
          cwd: '/resolved/project-1/owner-wt',
          projectId: 'project-1',
          worktreeId: 'owner-wt',
          eventName: 'plan_ready',
          eventData: { plan_ready: { plan_path: PLAN_PATH } },
        }),
      );
    });
  });

  describe('in-flight guards', () => {
    it('starts one retry per run and shares the guard across surfaces', async () => {
      const pending = deferred<{ success: boolean }>();
      retryExecution.mockReturnValue(pending.promise);
      let other: PipelineExecutionActions | null = null;
      const otherContainer = document.createElement('div');
      document.body.appendChild(otherContainer);
      const otherRoot = createRoot(otherContainer);
      await act(async () => {
        otherRoot.render(
          <Consumer
            onActions={(next): void => {
              other = next;
            }}
          />,
        );
        await flushAsyncWork();
      });
      await renderConsumer();

      let first: Promise<void> = Promise.resolve();
      await act(async () => {
        first = current().retry('exec-1');
        void current().retry('exec-1');
        await flushAsyncWork();
      });
      expect(retryExecution).toHaveBeenCalledTimes(1);
      expect(current().retryingIds.has('exec-1')).toBe(true);
      // Another surface's controller sees the same in-flight retry.
      expect(other).not.toBeNull();
      expect((other ?? current()).retryingIds.has('exec-1')).toBe(true);
      await act(async () => {
        void (other ?? current()).retry('exec-1');
        await flushAsyncWork();
      });
      expect(retryExecution).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve({ success: true });
        await first;
        await flushAsyncWork();
      });
      expect(current().retryingIds.has('exec-1')).toBe(false);
      expect(usePipelineExecutionActionsStore.getState().retryingIds.size).toBe(
        0,
      );

      act(() => {
        otherRoot.unmount();
      });
      otherContainer.remove();
    });

    it('cancels a run once while its cancel is in flight', async () => {
      const pending = deferred<unknown>();
      cancelExecution.mockReturnValue(pending.promise);
      await renderConsumer();

      await act(async () => {
        void current().cancel('exec-1');
        void current().cancel('exec-1');
        await flushAsyncWork();
      });
      expect(cancelExecution).toHaveBeenCalledTimes(1);
      expect(current().cancellingId).toBe('exec-1');

      await act(async () => {
        pending.resolve({ success: true });
        await flushAsyncWork();
      });
      expect(current().cancellingId).toBeNull();
    });

    it('opens App Advisor debug once at a time', async () => {
      const pending = deferred<{ ok: boolean }>();
      mockDispatchAppAction.mockReturnValue(pending.promise);
      await renderConsumer();

      let first: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        first = current().debugFailure('exec-1');
        void current().debugFailure('exec-1');
        await flushAsyncWork();
      });
      expect(mockDispatchAppAction).toHaveBeenCalledTimes(1);
      expect(mockDispatchAppAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { type: 'pipeline.debug_run', executionId: 'exec-1' },
        }),
      );
      expect(current().debuggingFailureId).toBe('exec-1');

      let opened = false;
      await act(async () => {
        pending.resolve({ ok: true });
        opened = await first;
      });
      expect(opened).toBe(true);
      expect(current().debuggingFailureId).toBeNull();
    });

    it('runs one chat follow-up at a time', async () => {
      const pending = deferred<undefined>();
      mockChatState.sendMessage.mockReturnValue(pending.promise);
      await renderConsumer();

      await act(async () => {
        void current().chatFollowUp('exec-1');
        void current().reportChatFollowUp('exec-1');
        await flushAsyncWork();
      });
      expect(mockChatState.sendMessage).toHaveBeenCalledTimes(1);
      expect(current().chatFollowUpInProgress).toBe(true);

      await act(async () => {
        pending.resolve(undefined);
        await flushAsyncWork();
      });
      expect(current().chatFollowUpInProgress).toBe(false);
    });
  });

  describe('dialog owner document', () => {
    it('opens the report dialog in the document its surface renders in', async () => {
      const auxDocument = document.implementation.createHTMLDocument('aux');
      const auxContainer = auxDocument.createElement('div');
      auxDocument.body.appendChild(auxContainer);
      const auxRoot = await renderConsumer(undefined, auxContainer);

      await act(async () => {
        current().openReport('exec-1');
        await flushAsyncWork();
      });
      expect(mockReportModalProps.at(-1)).toMatchObject({
        executionId: 'exec-1',
        pipelineName: 'Build pipeline',
      });
      expect(mockReportModalProps.at(-1)?.ownerDocument).toBe(auxDocument);

      act(() => {
        auxRoot.unmount();
      });
    });

    it('uses an explicit owner document when given', async () => {
      const explicitDocument =
        document.implementation.createHTMLDocument('explicit');
      await renderConsumer({ ownerDocument: explicitDocument });

      await act(async () => {
        current().openReport('exec-1');
        await flushAsyncWork();
      });
      expect(mockReportModalProps.at(-1)?.ownerDocument).toBe(explicitDocument);
    });
  });
});
