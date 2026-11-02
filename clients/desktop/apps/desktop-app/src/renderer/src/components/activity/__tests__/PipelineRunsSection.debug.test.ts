/**
 * @jest-environment jsdom
 */
const mockAppAdvisorState = {
  openDialog: jest.fn(),
  hydrate: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  createTab: jest.fn(() => 'debug-chat-id'),
  sendMessage: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  syncWindowState: jest.fn(),
};
const mockCreateStandaloneChatWithMessage = jest.fn();

jest.mock('@/stores/appAdvisorStore', () => ({
  useAppAdvisorStore: {
    getState: (): typeof mockAppAdvisorState => mockAppAdvisorState,
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): {
      createStandaloneChatWithMessage: typeof mockCreateStandaloneChatWithMessage;
    } => ({
      createStandaloneChatWithMessage: mockCreateStandaloneChatWithMessage,
    }),
  },
}));

jest.mock('@/lib/pipelineFailureDebugContext', () => ({
  buildPipelineFailureDebugContext: jest.fn(),
  buildPipelineFailureDebugPromptForExecution: jest.fn(),
}));

jest.mock('../PipelineExecutionDetailModal', () => ({
  PipelineExecutionDetailModal: (): null => null,
}));

jest.mock('../PipelineAdvisorMarkdown', () => ({
  PipelineAdvisorMarkdownText: (): null => null,
}));

jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));

jest.mock('../RunOutputControls', () => ({
  ChevronIcon: (): null => null,
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  dispatchAppAction,
  __resetAppActionDispatcherForTests,
} from '@/lib/app-actions/dispatcher';
import {
  buildPipelineFailureDebugContext,
  buildPipelineFailureDebugPromptForExecution,
} from '@/lib/pipelineFailureDebugContext';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type {
  AppAdvisorWindowOpenRequest,
  AppAdvisorWindowState,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineRunsSection } from '../PipelineRunsSection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockedBuildContext = jest.mocked(buildPipelineFailureDebugContext);
const mockedBuildPrompt = jest.mocked(
  buildPipelineFailureDebugPromptForExecution,
);
const appAdvisorOpenWindowMock = jest.fn<
  Promise<AppAdvisorWindowState>,
  [AppAdvisorWindowOpenRequest?]
>();

function expectPipelineDebugWindowOpenRequest(
  request: AppAdvisorWindowOpenRequest | undefined,
): string {
  expect(request).toMatchObject({
    focus: true,
    focusComposer: true,
    quickPrompt: 'Please debug this failed Canopy pipeline run.',
    quickPromptTitle: 'Debug Build pipeline',
  });
  expect(typeof request?.quickPromptChatId).toBe('string');
  return request?.quickPromptChatId ?? '';
}

const failedSummary: ExecutionSummary = {
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Build pipeline',
  status: 'failure',
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

const failedState: ExecutionState = {
  version: 4,
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Build pipeline',
    scope: ['directory'],
    jobs: {},
  },
  status: 'failure',
  jobs: {},
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  env: {},
  inputs: {},
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

describe('PipelineRunsSection failed-run Debug action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetAppActionDispatcherForTests();
    appAdvisorOpenWindowMock.mockResolvedValue({ open: true, focused: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          openWindow: appAdvisorOpenWindowMock,
        },
      },
    });
    mockAppAdvisorState.hydrate.mockResolvedValue(undefined);
    mockAppAdvisorState.createTab.mockReturnValue('debug-chat-id');
    mockAppAdvisorState.sendMessage.mockResolvedValue(undefined);
    mockAppAdvisorState.syncWindowState.mockClear();
    useCurrentUiStateStore.setState({
      revision: 1,
      envelope: {
        version: 1,
        revision: 1,
        capturedAt: new Date(0).toISOString(),
        digest: 'digest',
        snapshot: {
          activePage: 'workflows',
          archivedContainers: { count: 0, viewerOpen: false },
          overlays: {
            commandPaletteOpen: false,
            fileSearchPaletteOpen: false,
            prPickerOpen: false,
            canopyPortalOpen: false,
            appAdvisorOpen: false,
          },
        },
      },
      slices: {},
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    });
    usePipelineRunsStore.setState({
      summaries: [failedSummary],
      statesById: { 'execution-1': failedState },
      advisorSnapshotsByExecutionId: {},
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(),
      unseenFailedPipelineWorktreeKeys: new Set(),
      pipelineSummariesByWorktree: {},
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(failedState),
      ),
    });
  });

  it('opens App Advisor and sends the failed pipeline debug prompt instead of creating standalone chat', async () => {
    mockedBuildContext.mockResolvedValue({
      executionId: 'execution-1',
      pipelineId: 'pipeline-1',
      pipelineName: 'Build pipeline',
      status: 'failure',
    });
    mockedBuildPrompt.mockResolvedValue(
      'Please debug this failed Canopy pipeline run.',
    );

    const response = await dispatchAppAction({
      requestId: 'pipeline-debug-request',
      source: 'ui',
      action: { type: 'pipeline.debug_run', executionId: 'execution-1' },
    });

    expect(response.ok).toBe(true);
    const openRequest = appAdvisorOpenWindowMock.mock.calls[0]?.[0];
    const chatId = expectPipelineDebugWindowOpenRequest(openRequest);
    expect(response.result).toEqual({ chatId });
    expect(mockAppAdvisorState.syncWindowState).toHaveBeenCalledWith({
      open: true,
      focused: true,
    });
    expect(mockAppAdvisorState.openDialog).not.toHaveBeenCalled();
    expect(mockAppAdvisorState.hydrate).not.toHaveBeenCalled();
    expect(mockAppAdvisorState.createTab).not.toHaveBeenCalled();
    expect(mockAppAdvisorState.sendMessage).not.toHaveBeenCalled();
  });

  it('dispatches the failed-run Debug button through App Advisor from the rendered section', async () => {
    mockedBuildContext.mockResolvedValue({
      executionId: 'execution-1',
      pipelineId: 'pipeline-1',
      pipelineName: 'Build pipeline',
      status: 'failure',
    });
    mockedBuildPrompt.mockResolvedValue(
      'Please debug this failed Canopy pipeline run.',
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      act(() => {
        root.render(createElement(PipelineRunsSection));
      });

      const debugButton = container.querySelector(
        '[data-testid="pipeline-run-debug-failure-execution-1"]',
      );
      expect(debugButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        debugButton?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });

      expectPipelineDebugWindowOpenRequest(
        appAdvisorOpenWindowMock.mock.calls[0]?.[0],
      );
      expect(mockAppAdvisorState.openDialog).not.toHaveBeenCalled();
      expect(mockAppAdvisorState.hydrate).not.toHaveBeenCalled();
      expect(mockAppAdvisorState.createTab).not.toHaveBeenCalled();
      expect(mockAppAdvisorState.sendMessage).not.toHaveBeenCalled();
      expect(mockCreateStandaloneChatWithMessage).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
