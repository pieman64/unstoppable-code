/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionEvent } from '@canopy/desktop-shared/types/pipeline';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { usePipelineCompletionToasts } from '@/hooks/usePipelineCompletionToasts';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: jest.fn(() =>
    Promise.resolve({
      status: 'applied',
      ownerKey: 'project-1/worktree-1',
      layoutKey: 'project-1/worktree-1',
      panelId: 'panel-pipeline-exec-paused',
      outcome: 'placed',
    }),
  ),
}));

const openPipelineExecutionFromUiMock = jest.mocked(
  openPipelineExecutionFromUi,
);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const EXECUTION_ID = 'exec-paused';

type AddToast = ReturnType<typeof useGitHubStore.getState>['addToast'];

let executionListeners: Set<(event: ExecutionEvent) => void>;
let root: Root | null = null;
let addToastMock: jest.Mock<void, Parameters<AddToast>>;

function installPipelineApi(): void {
  executionListeners = new Set();

  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      onExecutionEvent: (listener: (event: ExecutionEvent) => void) => {
        executionListeners.add(listener);
        return (): void => {
          executionListeners.delete(listener);
        };
      },
    },
  });
}

function installCanopyApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        loadTabs: jest.fn().mockResolvedValue({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              messages: [],
              createdAt: '2026-06-02T00:00:00.000Z',
              model: 'gpt-5.5',
              providerType: 'codex',
              thinkingLevel: 'high',
              pluginSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [],
              },
            },
          ],
        }),
        activeSessions: jest
          .fn()
          .mockResolvedValue({ activeChatIds: [], sessions: [] }),
      },
      github: {
        setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
        requestFastRefresh: jest.fn().mockResolvedValue(undefined),
      },
      discoverWorktreeEnv: jest.fn().mockResolvedValue(undefined),
      loadPreferences: jest.fn().mockResolvedValue({
        defaultChatProvider: 'codex',
        defaultChatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        },
        defaultWorktreeProvider: 'codex',
        defaultWorktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
        },
        defaultChatInterfaceMode: 'agent',
        defaultStandaloneChatInterfaceMode: 'agent',
        codexFastModeDefaultEnabled: false,
        providerModelConfigDefaults: {},
      }),
      savePreferences: jest.fn().mockResolvedValue(undefined),
    },
  });
}

function makeProject(): SidebarItem {
  return {
    id: PROJECT_ID,
    name: 'Workspace',
    type: 'multi-repo',
    color: 'blue',
    repos: [],
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/pause',
        createdAt: '2026-06-02T00:00:00.000Z',
      },
    ],
    collapsed: false,
    order: 0,
  } as SidebarItem;
}

type ExecutionEventType = ExecutionEvent['type'];
type ExecutionStatus = ExecutionEvent['state']['status'];

function makeEvent({
  type,
  status,
  executionId = EXECUTION_ID,
  projectId = PROJECT_ID,
  worktreeId = WORKTREE_ID,
}: {
  type: ExecutionEventType;
  status: ExecutionStatus;
  executionId?: string;
  projectId?: string | null;
  worktreeId?: string | null;
}): ExecutionEvent {
  return {
    executionId,
    type,
    timestamp: '2026-06-02T00:00:01.000Z',
    state: {
      version: 1,
      id: executionId,
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Deploy',
        jobs: {},
      } as ExecutionEvent['state']['pipeline_snapshot'],
      status,
      jobs: {},
      started_at: '2026-06-02T00:00:00.000Z',
      cwd: '/tmp/worktree',
      env: {},
      inputs: {},
      status_reasons: [],
      pending_pauses: [],
      ...(projectId !== null ? { project_id: projectId } : {}),
      ...(worktreeId !== null ? { worktree_id: worktreeId } : {}),
    },
  };
}

function Harness(): JSX.Element {
  usePipelineCompletionToasts();
  return <div />;
}

async function renderHarness(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function emit(event: ExecutionEvent): void {
  act(() => {
    executionListeners.forEach((listener) => listener(event));
  });
}

function lastToastClick(): () => void {
  const onClick = addToastMock.mock.calls.at(-1)?.[2];
  if (typeof onClick !== 'function') {
    throw new Error('toast has no click handler');
  }
  return onClick;
}

describe('usePipelineCompletionToasts', () => {
  beforeEach(() => {
    installPipelineApi();
    installCanopyApi();
    openPipelineExecutionFromUiMock.mockClear();
    addToastMock = jest.fn<void, Parameters<AddToast>>();
    useGitHubStore.setState({
      toasts: [],
      notifications: [],
      addToast: addToastMock,
    });
    useProjectsStore.setState({
      projects: [makeProject()],
      hasHydratedProjects: true,
    });
    useChatStore.setState({
      selectedWorktree: null,
      selectedWorktreeBeforeStandaloneChat: null,
      worktreeChats: {},
      modelDefaults: null,
    });
    useActivityStore.setState({ panelExpanded: false });
    useNavigationStore.setState({ activePage: 'overview' });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it.each([
    ['completed', 'execution.completed', 'success', 'success'],
    ['failed', 'execution.completed', 'failure', 'error'],
    ['failed', 'execution.failed', 'failure', 'error'],
    ['paused', 'execution.paused', 'paused', 'warning'],
  ] as const)(
    'a %s toast (%s) opens the run panel only when clicked',
    async (label, type, status, toastType) => {
      await renderHarness();

      emit(makeEvent({ type, status }));

      expect(addToastMock).toHaveBeenCalledWith(
        `Pipeline "Deploy" ${label}`,
        toastType,
        expect.any(Function),
        expect.objectContaining({
          category: 'Pipeline',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
        }),
      );
      // Receiving the toast neither navigates nor opens anything.
      expect(openPipelineExecutionFromUiMock).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(useChatStore.getState().selectedWorktree).toBeNull();

      act(() => {
        lastToastClick()();
      });

      expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith({
        executionId: EXECUTION_ID,
        owner: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      });
      // The Activity panel is no longer forced open.
      expect(useActivityStore.getState().panelExpanded).toBe(false);
    },
  );

  it.each([
    ['completed', 'execution.completed', 'success', 'routine'],
    ['failed', 'execution.failed', 'failure', 'failure'],
    ['paused without a typed reason', 'execution.paused', 'paused', 'routine'],
  ] as const)(
    'reports a %s run to its space as %s',
    async (_label, type, status, eventClass) => {
      await renderHarness();
      emit(makeEvent({ type, status }));
      expect(addToastMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({
          notificationScope: {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            eventClass,
          },
        }),
      );
    },
  );

  it.each([
    ['completed', 'execution.completed', 'success', true],
    ['failed', 'execution.failed', 'failure', true],
    ['paused', 'execution.paused', 'paused', undefined],
  ] as const)(
    'marks a %s run as an agent completion: %s',
    async (_label, type, status, agentCompletion) => {
      await renderHarness();
      emit(makeEvent({ type, status }));
      expect(addToastMock.mock.calls.at(-1)?.[3]?.agentCompletion).toBe(
        agentCompletion,
      );
    },
  );

  it('reports a pause waiting on input or credentials as attention', async () => {
    await renderHarness();
    const waiting = makeEvent({ type: 'execution.paused', status: 'paused' });
    waiting.state.status_reasons = [
      {
        id: 'reason-1',
        kind: 'input_required',
        code: 'input_requested',
        detected_at: '2026-06-02T00:00:01.000Z',
        source: { job_id: 'job', step_id: 'step', attempt: 1, iteration: 0 },
      },
    ];
    emit(waiting);
    expect(addToastMock.mock.calls.at(-1)?.[3]?.notificationScope).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      eventClass: 'attention',
    });
  });

  it('still raises a paused toast when the event state has no pause checkpoints', async () => {
    await renderHarness();
    const legacy = makeEvent({ type: 'execution.paused', status: 'paused' });
    Reflect.deleteProperty(legacy.state, 'pending_pauses');
    emit(legacy);
    expect(addToastMock).toHaveBeenCalledWith(
      'Pipeline "Deploy" paused',
      'warning',
      expect.any(Function),
      expect.objectContaining({
        notificationScope: {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          eventClass: 'routine',
        },
      }),
    );
  });

  it('leaves a project-only run unscoped', async () => {
    await renderHarness();
    emit(
      makeEvent({
        type: 'execution.completed',
        status: 'success',
        projectId: 'cowork-workspace',
        worktreeId: null,
      }),
    );
    expect(addToastMock.mock.calls.at(-1)?.[3]?.notificationScope).toBe(
      undefined,
    );
  });

  it('routes a Cowork run to its own Work Entry owner', async () => {
    await renderHarness();

    emit(
      makeEvent({
        type: 'execution.completed',
        status: 'success',
        projectId: 'cowork-workspace',
        worktreeId: 'entry-7',
      }),
    );
    act(() => {
      lastToastClick()();
    });

    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      owner: { projectId: 'cowork-workspace', worktreeId: 'entry-7' },
    });
  });

  it('gives an ownerless run a click that opens it without an owner hint', async () => {
    await renderHarness();

    emit(
      makeEvent({
        type: 'execution.failed',
        status: 'failure',
        projectId: null,
        worktreeId: null,
      }),
    );
    act(() => {
      lastToastClick()();
    });

    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
    });
  });

  it('raises no toast for child runs or non-terminal events', async () => {
    await renderHarness();

    const child = makeEvent({ type: 'execution.completed', status: 'success' });
    child.state.parent_execution_id = 'parent-run';
    emit(child);
    emit(makeEvent({ type: 'execution.started', status: 'running' }));

    expect(addToastMock).not.toHaveBeenCalled();
  });
});
