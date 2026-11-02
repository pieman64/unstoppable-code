/** @jest-environment jsdom */
/**
 * The desktop's composer background tray reads its chat's background
 * processes and its live subagents from the renderer stores (turn-state
 * phase 39a, background drawer Phase 04).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { ComposerWorkDrawer, type BackgroundTrayAgent } from '@canopy/ui-app';
import type {
  AppAdvisorWatcherSummary,
  BackgroundProcess,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { buildGitHubWorkflowRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import { useActivityStore } from '@/stores/activityStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import { ChatBackgroundTray, trayRunStatus } from '../ChatBackgroundTray';
import {
  chatBackgroundWorkKey,
  publishChatBackgroundAgentLive,
  publishChatBackgroundAgents,
  publishChatBackgroundRuns,
  resetChatBackgroundWorkStoreForTests,
  useChatBackgroundWorkStore,
} from '@/stores/chatBackgroundWorkStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { BACKGROUND_PROCESSES_UI_STATE_KEY } from '@/lib/current-ui-state/backgroundProcessesUiState';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';

const mockOpenPipelineExecution = jest.fn(
  (): Promise<{ status: 'opened' }> => Promise.resolve({ status: 'opened' }),
);
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (...args: unknown[]): Promise<unknown> =>
    mockOpenPipelineExecution(...(args as [])),
}));

const mockOpenSubagentChatPanel = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: (...args: unknown[]): Promise<void> =>
    mockOpenSubagentChatPanel(...(args as [])),
  openSubagentsPanel: (): Promise<void> => Promise.resolve(),
}));

const mockOpenAgentArtifactNavigation = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../agent-artifact-navigation', () => ({
  openAgentArtifactNavigation: (...args: unknown[]): Promise<void> =>
    mockOpenAgentArtifactNavigation(...(args as [])),
}));

jest.mock('@/stores/pipelineDetailCoordinator', () => ({
  ...jest.requireActual<object>('@/stores/pipelineDetailCoordinator'),
  usePipelineExecutionSummaryInterest: (): void => undefined,
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const TARGET = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat-1',
};

function process(over: Partial<BackgroundProcess>): BackgroundProcess {
  return {
    id: 'p1',
    chatId: 'chat-1',
    toolUseId: 'tool-1',
    taskId: 'task-1',
    toolName: 'Bash',
    kind: 'bash',
    description: 'npm run dev',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    outputLines: [],
    canStop: true,
    ...over,
  };
}

const CHAT_KEY = chatBackgroundWorkKey(
  TARGET.projectId,
  TARGET.worktreeId,
  TARGET.chatId,
);

function agent(
  over: Partial<BackgroundTrayAgent> &
    Pick<BackgroundTrayAgent, 'id' | 'kind' | 'title'>,
): BackgroundTrayAgent {
  return {
    status: 'running',
    activity: null,
    startedAt: null,
    steps: [],
    prompt: null,
    meta: null,
    taskId: null,
    canStop: over.kind === 'delegate',
    target: null,
    ...over,
  };
}

const DELEGATE = agent({
  id: 'managed:d1',
  kind: 'delegate',
  title: 'Fix flaky e2e',
  target: { kind: 'managed', id: 'd1', title: 'Fix flaky e2e' },
});

function client(): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: false,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
  };
  return {
    capabilities,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command(): Promise<never> {
      return Promise.reject(new Error('Unexpected command'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

// jsdom has no CSS.escape or Element.scrollTo; the job bar centres its
// running job with them.
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = (): void => undefined;
}

/** The execution state fields the tray reads. */
function runState(
  status: string,
  pendingPauses: readonly { kind: string }[] = [],
): object {
  return {
    id: 'run-1',
    status,
    pending_pauses: pendingPauses,
    pipeline_snapshot: { jobs: {} },
    jobs: {},
    job_groups: {},
  };
}

describe('ChatBackgroundTray', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useActivityStore.setState({ bgProcesses: {} });
    resetChatBackgroundWorkStoreForTests();
    resetDelegationActivityStoreForTests();
    usePipelineRunsStore.setState({
      statesById: {},
      rowStatesById: {},
      summaries: [],
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [],
      completedWatchers: [],
    });
  });

  function pipelineReceipt(
    owner: { projectId: string; worktreeId: string },
    operation: PipelineRunArtifactReceiptV1['operation'] = 'pipeline.run',
  ): PipelineRunArtifactReceiptV1 {
    return {
      version: 1,
      kind: 'pipeline_run',
      operation,
      dedupeKey: 'pipeline:run-1',
      createdAt: '2026-10-20T00:00:00.000Z',
      executionId: 'run-1',
      pipelineId: 'review',
      pipelineName: 'Code review',
      initialStatus: 'running',
      queuedAt: '2026-10-20T00:00:00.000Z',
      projectId: owner.projectId,
      worktreeId: owner.worktreeId,
      navigationTarget: {
        kind: 'pipeline_execution',
        executionId: 'run-1',
        projectId: owner.projectId,
        worktreeId: owner.worktreeId,
      },
    };
  }

  function publishRun(
    owner: { projectId: string; worktreeId: string } = TARGET,
    operation?: PipelineRunArtifactReceiptV1['operation'],
  ): void {
    publishChatBackgroundRuns(CHAT_KEY, [pipelineReceipt(owner, operation)]);
  }

  function byTestId(testId: string): HTMLElement | undefined {
    // Run keys hold characters a selector would need escaped.
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid]'),
    ).find((element) => element.dataset.testid === testId);
  }

  function click(testId: string): void {
    act(() => byTestId(testId)?.click());
  }

  function summary(): string | null | undefined {
    return container.querySelector('[data-testid="background-tray-summary"]')
      ?.textContent;
  }

  function setRunStatus(status: string): void {
    act(() => {
      usePipelineRunsStore.setState({
        statesById: {
          'run-1': runState(status) as never,
        },
      });
    });
  }

  function render(): void {
    act(() => {
      root.render(
        <CanopyClientProvider client={client()}>
          <ChatBackgroundTray target={TARGET} />
        </CanopyClientProvider>,
      );
    });
  }

  it('shows the chat’s own background processes and agents, not another chat’s', () => {
    act(() => {
      useActivityStore.setState({
        bgProcesses: {
          'project/worktree': [
            process({}),
            process({ id: 'p2', chatId: 'chat-2', description: 'Other chat' }),
          ],
        },
      });
      publishChatBackgroundAgents(CHAT_KEY, [DELEGATE]);
      publishChatBackgroundAgents(
        chatBackgroundWorkKey(TARGET.projectId, TARGET.worktreeId, 'chat-2'),
        [agent({ id: 'managed:other', kind: 'delegate', title: 'Other' })],
      );
    });
    render();
    expect(
      container.querySelector('[data-testid="background-tray-summary"]')
        ?.textContent,
    ).toBe('2 running in the background');
  });

  it('lists a Claude agent once, with its task, and stops and opens a delegate through the chat', async () => {
    const stop = jest.fn(() => Promise.resolve({ ok: true }));
    Reflect.set(window, 'api', { managedDelegation: { stop } });
    try {
      act(() => {
        useActivityStore.setState({
          bgProcesses: {
            'project/worktree': [
              process({}),
              process({
                id: 'p3',
                toolUseId: 'toolu-review',
                toolName: 'Agent',
                kind: 'agent',
                description: 'Review the diff',
              }),
            ],
          },
        });
        publishChatBackgroundAgents(CHAT_KEY, [
          agent({
            id: 'claude:toolu-review',
            kind: 'claude',
            title: 'Review the diff',
            taskId: 'p3',
          }),
          DELEGATE,
        ]);
      });
      render();
      expect(
        container.querySelector('[data-testid="background-tray-summary"]')
          ?.textContent,
      ).toBe('3 running in the background');
      act(() =>
        container
          .querySelector<HTMLElement>('[data-testid="background-tray-toggle"]')
          ?.click(),
      );
      expect(
        container.querySelectorAll('[data-testid="background-tray-agent"]'),
      ).toHaveLength(2);
      expect(
        container.querySelectorAll('[data-testid="background-tray-row"]'),
      ).toHaveLength(1);

      const delegateRow = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="background-tray-agent"]',
        ),
      ).find((row) => row.textContent?.includes('Fix flaky e2e'));
      await act(async () => {
        delegateRow
          ?.querySelector<HTMLElement>(
            '[data-testid="background-tray-agent-stop"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(stop).toHaveBeenCalledWith({ ...TARGET, delegationId: 'd1' });

      act(() =>
        delegateRow
          ?.querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      act(() =>
        container
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-inspector-open"]',
          )
          ?.click(),
      );
      expect(mockOpenSubagentChatPanel).toHaveBeenCalledWith(
        { projectId: TARGET.projectId, worktreeId: TARGET.worktreeId },
        {
          rootChatId: TARGET.chatId,
          subagentId: 'd1',
          subagentKind: 'managed',
          title: 'Fix flaky e2e',
        },
      );
    } finally {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it("shows a delegate's steps read from its own transcript", () => {
    act(() => {
      publishChatBackgroundAgents(CHAT_KEY, [DELEGATE]);
      publishChatBackgroundAgentLive(CHAT_KEY, DELEGATE.id, {
        status: 'running',
        steps: [
          {
            id: 'read-1',
            toolName: 'Read',
            input: '{"file_path":"checkout.spec.ts"}',
          },
        ],
      });
    });
    render();
    click('background-tray-toggle');
    click('background-tray-row-toggle');
    expect(
      container.querySelector('[data-testid="background-tray-agent-steps"]')
        ?.textContent,
    ).toContain('checkout.spec.ts');
  });

  it('shows a delegate waiting on an approval its own transcript reports', () => {
    // The parent's saved card has no approvalPending; the delegate's live
    // snapshot does.
    act(() => {
      publishChatBackgroundAgents(CHAT_KEY, [DELEGATE]);
      publishChatBackgroundAgentLive(CHAT_KEY, DELEGATE.id, {
        status: 'approval',
        steps: [],
      });
    });
    render();
    expect(summary()).toBe('1 needs input');
  });

  it('reports the background-process detail modal it opens to App Advisor', () => {
    Reflect.set(window, 'api', {
      activity: {
        readFullOutput: (): Promise<null> => Promise.resolve(null),
        onBgProcessOutput: (): (() => void) => (): void => undefined,
      },
    });
    try {
      act(() => {
        useActivityStore.setState({
          bgProcesses: { 'project/worktree': [process({})] },
        });
      });
      render();
      click('background-tray-toggle');
      click('background-tray-row-toggle');
      click('background-tray-inspector-open');
      expect(
        useCurrentUiStateStore.getState().slices[
          BACKGROUND_PROCESSES_UI_STATE_KEY
        ],
      ).toMatchObject({
        projectId: TARGET.projectId,
        worktreeId: TARGET.worktreeId,
        detailModalOpen: true,
        selectedTaskId: 'task-1',
      });
    } finally {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps an opened output modal when the composer background tab disappears', async () => {
    const unsubscribe = jest.fn();
    Reflect.set(window, 'api', {
      activity: {
        readFullOutput: (): Promise<null> => Promise.resolve(null),
        onBgProcessOutput: (): (() => void) => unsubscribe,
      },
    });
    try {
      act(() => {
        useActivityStore.setState({
          bgProcesses: { 'project/worktree': [process({})] },
        });
        root.render(
          <CanopyClientProvider client={client()}>
            <ChatBackgroundTray target={TARGET}>
              {(panel, counts) => (
                <ComposerWorkDrawer
                  queuedCount={0}
                  background={{
                    count: counts.items,
                    needsYou: counts.needsYou,
                    running: counts.running,
                    panel,
                  }}
                />
              )}
            </ChatBackgroundTray>
          </CanopyClientProvider>,
        );
      });
      click('composer-work-drawer-tab-background');
      click('background-tray-row-toggle');
      await act(async () => {
        byTestId('background-tray-inspector-open')?.click();
        await Promise.resolve();
      });
      const modal = document.querySelector(
        '[data-testid="bg-process-detail-modal"]',
      );
      expect(modal).not.toBeNull();
      act(() =>
        useActivityStore.setState({
          bgProcesses: {
            'project/worktree': [
              process({ status: 'completed', canStop: false }),
            ],
          },
        }),
      );
      expect(byTestId('composer-work-drawer')).toBeUndefined();
      expect(
        document.querySelector('[data-testid="bg-process-detail-modal"]'),
      ).toBe(modal);
      expect(modal?.textContent).toContain('completed');
      expect(unsubscribe).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('counts live delegates its transcript has not listed', () => {
    // A delegate from a turn outside the loaded transcript page, after a
    // reload: main still counts it.
    act(() => {
      publishChatBackgroundAgents(CHAT_KEY, [DELEGATE]);
      useDelegationActivityStore.getState().applyActivity({
        ...TARGET,
        live: 2,
        queued: 1,
      });
    });
    render();
    expect(
      container.querySelector('[data-testid="background-tray-summary"]')
        ?.textContent,
    ).toBe('3 running in the background');
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="background-tray-toggle"]')
        ?.click(),
    );
    expect(
      container.querySelector(
        '[data-testid="background-tray-unlisted-delegates"]',
      )?.textContent,
    ).toBe('2 more delegates');
  });

  it('publishes agent rows only when one changes', () => {
    publishChatBackgroundAgents(CHAT_KEY, [DELEGATE]);
    const first = useChatBackgroundWorkStore.getState();
    publishChatBackgroundAgents(CHAT_KEY, [{ ...DELEGATE, steps: [] }]);
    expect(useChatBackgroundWorkStore.getState()).toBe(first);
    publishChatBackgroundAgents(CHAT_KEY, [
      { ...DELEGATE, status: 'approval' },
    ]);
    expect(useChatBackgroundWorkStore.getState()).not.toBe(first);
  });

  it("lists the agent's run, and keeps it once finished until it is dismissed", () => {
    act(() => publishRun());
    setRunStatus('running');
    render();
    const summary = (): string | null | undefined =>
      container.querySelector('[data-testid="background-tray-summary"]')
        ?.textContent;
    expect(summary()).toBe('1 running in the background');
    setRunStatus('success');
    expect(summary()).toBe('1 finished');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-toggle"]',
        )
        ?.click(),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-run-pipeline:run-1-dismiss"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector('[data-testid="background-tray"]'),
    ).toBeNull();
  });

  it('lists a run by its receipt until its state loads, as the transcript places it, and never holds it once it loads finished', async () => {
    let finishLoad = (): void => undefined;
    const load = jest.fn(
      (): Promise<null> =>
        new Promise((resolve) => {
          finishLoad = (): void => {
            usePipelineRunsStore.setState({
              rowStatesById: { 'run-1': runState('success') as never },
            });
            resolve(null);
          };
        }),
    );
    usePipelineRunsStore.setState({ loadExecutionRowState: load });
    act(() => publishRun());
    render();
    // Its receipt says it is running, as the transcript's placement reads
    // it, so no surface would show it otherwise.
    expect(summary()).toBe('1 running in the background');
    expect(load).toHaveBeenCalledWith('run-1');
    // Its state says it finished long ago: it was never seen live.
    await act(async () => {
      finishLoad();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="background-tray"]'),
    ).toBeNull();
  });

  it("shows a run's job dots from its row state, before anyone opens the run", () => {
    // Only an open run's full state is cached; every listed run has a row
    // state with its jobs (develop 9665eb91a5).
    const loadRow = jest.fn(() => new Promise<null>(() => undefined));
    const loadDetails = jest.fn(() => new Promise<null>(() => undefined));
    usePipelineRunsStore.setState({
      loadExecutionRowState: loadRow,
      loadExecutionDetails: loadDetails,
      rowStatesById: {
        'run-1': {
          ...runState('running'),
          pipeline_snapshot: {
            jobs: { build: { name: 'Build', needs: [], steps: [] } },
          },
          jobs: { build: { status: 'running', steps: {} } },
        } as never,
      },
    });
    act(() => publishRun());
    render();
    expect(loadDetails).not.toHaveBeenCalled();
    expect(loadRow).not.toHaveBeenCalled();
    click('background-tray-toggle');
    const row = byTestId('background-tray-run-pipeline:run-1');
    expect(
      row?.querySelector('[data-testid="dag-progress-dots"]'),
    ).not.toBeNull();
    act(() =>
      row
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-row-toggle"]',
        )
        ?.click(),
    );
    expect(
      row
        ?.querySelector('[data-testid="background-tray-inspector"]')
        ?.querySelector('[data-job-id="build"]')
        ?.getAttribute('aria-label'),
    ).toBe('Build: running');
  });

  it('loads an unloaded run as a row, not as a full state', () => {
    const loadRow = jest.fn(() => new Promise<null>(() => undefined));
    const loadDetails = jest.fn(() => new Promise<null>(() => undefined));
    usePipelineRunsStore.setState({
      loadExecutionRowState: loadRow,
      loadExecutionDetails: loadDetails,
    });
    act(() => publishRun());
    render();
    expect(loadRow).toHaveBeenCalledWith('run-1');
    expect(loadDetails).not.toHaveBeenCalled();
  });

  it('lists a run by its summary while its state loads', () => {
    usePipelineRunsStore.setState({
      loadExecutionRowState: jest.fn(() => new Promise<null>(() => undefined)),
      summaries: [{ id: 'run-1', status: 'paused' } as never],
    });
    act(() => publishRun());
    render();
    expect(summary()).toBe('1 paused');
  });

  it("opens a run waiting for input with the run's own owner", () => {
    act(() =>
      publishRun({ projectId: 'other-project', worktreeId: 'other-worktree' }),
    );
    act(() => {
      usePipelineRunsStore.setState({
        statesById: {
          'run-1': runState('paused', [{ kind: 'input' }]) as never,
        },
      });
    });
    render();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-toggle"]',
        )
        ?.click(),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-run-pipeline:run-1-respond"]',
        )
        ?.click(),
    );
    expect(mockOpenPipelineExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'run-1',
        owner: { projectId: 'other-project', worktreeId: 'other-worktree' },
      }),
    );
  });

  it('lists a watched run another chat started, and opens it with its own owner', () => {
    act(() =>
      publishRun(
        { projectId: 'other-project', worktreeId: 'other-worktree' },
        'pipeline.watch',
      ),
    );
    setRunStatus('running');
    render();
    expect(summary()).toBe('1 running in the background');
    click('background-tray-toggle');
    click('background-tray-row-toggle');
    click('background-tray-inspector-open');
    expect(mockOpenPipelineExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'run-1',
        owner: { projectId: 'other-project', worktreeId: 'other-worktree' },
      }),
    );
  });

  describe('GitHub runs', () => {
    const RECEIPT = buildGitHubWorkflowRunArtifactReceipt({
      operation: 'github.watch',
      createdAt: '2026-10-22T15:41:48.571Z',
      watcherId: 'gh-watch-1',
      repository: 'acme/api',
      runId: '101',
      runAttempt: 1,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      state: { kind: 'intermediate', status: 'in_progress' },
      observedAt: '2026-10-22T15:42:00.000Z',
      navigationTarget: {
        kind: 'github_workflow_run',
        repository: 'acme/api',
        runId: '101',
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      },
    });
    const ROW = `background-tray-run-${RECEIPT.dedupeKey}`;

    function watcher(
      status: AppAdvisorWatcherSummary['status'],
      observedAt: string,
      state: GitHubWorkflowRunArtifactReceiptV1['state'],
    ): AppAdvisorWatcherSummary {
      return {
        id: 'gh-watch-1',
        trigger: 'github_workflow_runs_changed',
        status,
        label: 'CI',
        target: {
          kind: 'github_workflow_runs',
          items: [
            { kind: 'workflow_run', repository: 'acme/api', runId: '101' },
          ],
          notifyOn: { statuses: [], conclusions: [], jobConclusions: [] },
          display: {
            repositories: ['acme/api'],
            sample: [{ repository: 'acme/api', runId: '101', runAttempt: 1 }],
          },
        },
        destination: TARGET,
        createdAt: '2026-10-22T15:41:48.571Z',
        githubProgress: {
          runs: [
            {
              repository: 'acme/api',
              runId: '101',
              runAttempt: 1,
              htmlUrl: 'https://github.com/acme/api/actions/runs/101',
              state,
              observedAt,
            },
          ],
        },
      };
    }

    it('lists a watched run, without Stop, and opens it on GitHub', () => {
      act(() => {
        useAppAdvisorWatchersStore.setState({
          watchers: [
            watcher('active', '2026-10-22T15:43:00.000Z', {
              kind: 'intermediate',
              status: 'in_progress',
            }),
          ],
        });
        publishChatBackgroundRuns(CHAT_KEY, [RECEIPT]);
      });
      render();
      expect(summary()).toBe('1 running in the background');
      click('background-tray-toggle');
      // Listed, with no action while it runs.
      expect(byTestId(ROW)).toBeDefined();
      expect(byTestId(`${ROW}-dismiss`)).toBeUndefined();
      expect(byTestId(`${ROW}-stop`)).toBeUndefined();
      click('background-tray-row-toggle');
      click('background-tray-inspector-open');
      expect(mockOpenAgentArtifactNavigation).toHaveBeenCalledWith(
        RECEIPT.navigationTarget,
      );
    });

    it('keeps its final state after its watcher retires, until dismissed', () => {
      act(() => {
        useAppAdvisorWatchersStore.setState({
          watchers: [
            watcher('active', '2026-10-22T15:43:00.000Z', {
              kind: 'intermediate',
              status: 'in_progress',
            }),
          ],
        });
        publishChatBackgroundRuns(CHAT_KEY, [RECEIPT]);
      });
      render();
      expect(summary()).toBe('1 running in the background');
      // The watcher fires on success, then leaves the fire history too.
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [
            watcher('fired', '2026-10-22T15:50:00.000Z', {
              kind: 'terminal',
              conclusion: 'success',
            }),
          ],
        }),
      );
      expect(summary()).toBe('1 finished');
      act(() => useAppAdvisorWatchersStore.setState({ completedWatchers: [] }));
      expect(summary()).toBe('1 finished');
      click('background-tray-toggle');
      click(`${ROW}-dismiss`);
      expect(
        container.querySelector('[data-testid="background-tray"]'),
      ).toBeNull();
    });

    it('keeps a running run while its watcher delivers an update', () => {
      act(() => {
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [
            watcher('firing', '2026-10-22T15:43:00.000Z', {
              kind: 'intermediate',
              status: 'in_progress',
            }),
          ],
        });
        publishChatBackgroundRuns(CHAT_KEY, [RECEIPT]);
      });
      render();
      expect(summary()).toBe('1 running in the background');
    });

    it('drops an unwatched run whose snapshot still says it runs', () => {
      act(() => publishChatBackgroundRuns(CHAT_KEY, [RECEIPT]));
      render();
      expect(
        container.querySelector('[data-testid="background-tray"]'),
      ).toBeNull();
    });
  });

  describe('watched pull requests (D1b)', () => {
    const ROW = 'background-tray-run-github-pr:acme/api#12';

    function prWatcher(
      id: string,
      status: AppAdvisorWatcherSummary['status'],
      state: 'open' | 'merged' | 'closed',
      destination: typeof TARGET = TARGET,
      observedAt = '2026-10-26T10:05:00.000Z',
    ): AppAdvisorWatcherSummary {
      return {
        id,
        trigger: 'github_pull_requests_changed',
        status,
        label: 'PR #12',
        target: {
          kind: 'github_pull_requests',
          items: [{ kind: 'pull_request', repository: 'acme/api', number: 12 }],
          display: {
            repositories: ['acme/api'],
            sample: [{ repository: 'acme/api', number: 12 }],
          },
        },
        destination,
        createdAt: '2026-10-26T10:00:00.000Z',
        githubPullRequestProgress: {
          pullRequests: [
            {
              repository: 'acme/api',
              number: 12,
              url: 'https://github.com/acme/api/pull/12',
              title: 'Fix checkout',
              state,
              baseRefName: 'develop',
              queue:
                state === 'open'
                  ? { phase: 'awaiting_checks', position: 2 }
                  : null,
              observedAt,
            },
          ],
        },
      };
    }

    it("lists the pull requests its chat's watchers follow, and opens one on GitHub", () => {
      const openLink = jest.fn(() => Promise.resolve());
      Reflect.set(window, 'api', { browser: { openLink } });
      try {
        act(() =>
          useAppAdvisorWatchersStore.setState({
            watchers: [
              prWatcher('w-12', 'active', 'open'),
              prWatcher('w-other', 'active', 'open', {
                ...TARGET,
                chatId: 'chat-2',
              }),
            ],
          }),
        );
        render();
        expect(summary()).toBe('1 running in the background');
        click('background-tray-toggle');
        expect(byTestId(ROW)?.textContent).toContain('#12 Fix checkout');
        expect(byTestId(ROW)?.textContent).toContain('In merge queue');
        expect(byTestId(`${ROW}-stop`)).toBeUndefined();
        click('background-tray-row-toggle');
        click('background-tray-inspector-open');
        expect(openLink).toHaveBeenCalledWith({
          url: 'https://github.com/acme/api/pull/12',
        });
      } finally {
        Reflect.deleteProperty(window, 'api');
      }
    });

    it('keeps a pull request it saw open once it merges, until dismissed', () => {
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [prWatcher('w-12', 'active', 'open')],
        }),
      );
      render();
      expect(summary()).toBe('1 running in the background');
      // The watcher fires on the merge and leaves the active list.
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [prWatcher('w-12', 'fired', 'merged')],
        }),
      );
      expect(summary()).toBe('1 finished');
      // Then it leaves the fire history too (capped across chats).
      act(() => useAppAdvisorWatchersStore.setState({ completedWatchers: [] }));
      expect(summary()).toBe('1 finished');
      click('background-tray-toggle');
      expect(byTestId(ROW)?.textContent).toContain('Merged');
      click(`${ROW}-dismiss`);
      expect(
        container.querySelector('[data-testid="background-tray"]'),
      ).toBeNull();
    });

    it("shows a reopened pull request's new result after its earlier one was dismissed", () => {
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [prWatcher('w-first', 'active', 'open')],
        }),
      );
      render();
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [prWatcher('w-first', 'fired', 'closed')],
        }),
      );
      click('background-tray-toggle');
      click(`${ROW}-dismiss`);
      expect(
        container.querySelector('[data-testid="background-tray"]'),
      ).toBeNull();
      // Reopened and watched again.
      const later = '2026-10-26T11:00:00.000Z';
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [prWatcher('w-second', 'active', 'open', TARGET, later)],
        }),
      );
      expect(summary()).toBe('1 running in the background');
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [
            prWatcher('w-first', 'fired', 'closed'),
            prWatcher(
              'w-second',
              'fired',
              'merged',
              TARGET,
              '2026-10-26T11:05:00.000Z',
            ),
          ],
        }),
      );
      expect(summary()).toBe('1 finished');
    });

    it('keeps the watcher button while another watcher still follows the pull request', () => {
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [
            prWatcher(
              'w-older',
              'active',
              'open',
              TARGET,
              '2026-10-26T10:00:00.000Z',
            ),
            prWatcher('w-newer', 'active', 'open'),
          ],
        }),
      );
      render();
      click('background-tray-toggle');
      click('background-tray-row-toggle');
      expect(byTestId('background-tray-run-watchers-pr-12')).toBeDefined();
      // The watcher that supplied the newest snapshot is deleted.
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [
            prWatcher(
              'w-older',
              'active',
              'open',
              TARGET,
              '2026-10-26T10:00:00.000Z',
            ),
          ],
        }),
      );
      expect(byTestId('background-tray-run-watchers-pr-12')).toBeDefined();
    });

    it('keeps an open pull request while its watcher delivers an update', () => {
      act(() =>
        useAppAdvisorWatchersStore.setState({
          watchers: [],
          completedWatchers: [prWatcher('w-12', 'firing', 'open')],
        }),
      );
      render();
      expect(summary()).toBe('1 running in the background');
    });

    it('does not list a pull request that had merged before the tray saw it open', () => {
      act(() =>
        useAppAdvisorWatchersStore.setState({
          completedWatchers: [prWatcher('w-12', 'fired', 'merged')],
        }),
      );
      render();
      expect(
        container.querySelector('[data-testid="background-tray"]'),
      ).toBeNull();
    });
  });

  it('does not list a run that had finished before the tray saw it running', () => {
    act(() => publishRun());
    setRunStatus('failure');
    render();
    expect(
      container.querySelector('[data-testid="background-tray"]'),
    ).toBeNull();
  });

  it('is absent while the chat has no background work', () => {
    act(() => {
      useActivityStore.setState({
        bgProcesses: {
          'project/worktree': [process({ status: 'completed' })],
        },
      });
    });
    render();
    expect(
      container.querySelector('[data-testid="background-tray"]'),
    ).toBeNull();
  });
});

describe('trayRunStatus', () => {
  it('tells a run waiting for input from one waiting to be resumed', () => {
    expect(
      trayRunStatus({
        status: 'paused',
        pending_pauses: [{ kind: 'input' }] as never,
      }),
    ).toBe('needs-input');
    expect(
      trayRunStatus({
        status: 'paused',
        pending_pauses: [{ kind: 'action' }] as never,
      }),
    ).toBe('paused');
    expect(trayRunStatus({ status: 'failure', pending_pauses: [] })).toBe(
      'failed',
    );
    // Before its live state loads, the run's state is unknown.
    expect(trayRunStatus(undefined)).toBeNull();
  });
});
