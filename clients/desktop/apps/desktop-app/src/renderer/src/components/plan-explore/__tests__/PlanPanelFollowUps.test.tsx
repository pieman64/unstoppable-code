/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TrackedPlanData,
  TrackedPlanFileVisibilityRequest,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineData,
} from '@canopy/desktop-shared/types/pipeline';
import type { PlanReadyPipelineModalOnRun } from '@/components/chat/PlanReadyPipelineModal';

// The follow-up actions of a Plan panel's header (Share, the plan_ready
// pipeline, Implement) with the real header, follow-up hook, and share
// dialog. The document, the diagram, search, and the pipeline picker are
// stubbed; the picker offers two runs, with and without configured inputs.
jest.mock('@/components/chat/PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: ({
    onRun,
  }: {
    onRun: PlanReadyPipelineModalOnRun;
  }): JSX.Element => {
    const pipeline: PipelineData = {
      info: {
        id: 'pipeline-1',
        name: 'Pipeline',
        filename: 'pipeline-1.yaml',
        description: '',
        icon: '',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        source: 'bundled',
        readonly: true,
      },
      content: { name: 'Pipeline', on: 'plan_ready', jobs: {} },
    };
    const context = {
      preferences: {},
      modelConfig: { fastMode: true },
    };
    return (
      <div data-testid="mock-plan-ready-modal">
        <button
          type="button"
          data-testid="mock-plan-ready-run"
          onClick={(): void => {
            void onRun(
              'pipeline-1',
              pipeline,
              {
                continue_on_refine_gate_fail: 'true',
                continue_on_plan_contract_fail: 'true',
              },
              'repo-1',
              context,
            );
          }}
        >
          Run mocked pipeline
        </button>
        <button
          type="button"
          data-testid="mock-plan-ready-run-without-inputs"
          onClick={(): void => {
            void onRun('pipeline-1', pipeline, undefined, 'repo-1', context);
          }}
        >
          Run mocked pipeline without inputs
        </button>
      </div>
    );
  },
}));
jest.mock('@/components/plan-explore/PlanDocumentPanel', () => ({
  PlanDocumentPanel: (): JSX.Element => (
    <div data-testid="mock-plan-document" />
  ),
}));
jest.mock('@/components/plan-explore/lazyPlanVisualizer', () => ({
  LazyPlanVisualizerPanel: (): null => null,
  PlanVisualizer: (): null => null,
  preloadPlanVisualizer: (): Promise<void> => Promise.resolve(),
}));
jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));
const openPipelineExecutionFromUiMock = jest.fn();
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (...args: unknown[]): unknown =>
    openPipelineExecutionFromUiMock(...args),
}));

import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import {
  flushChatPanelSyncForTests,
  initChatPanelSync,
  resetChatPanelSyncForTests,
} from '@/lib/panels/chat-panel-sync';
import { resetActivePlanStoreForTests } from '@/stores/activePlanStore';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  findPanelByInstanceKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { resetPlanViewStoreForTests } from '@/stores/planViewStore';
import { PlanPanelHost } from '../PlanPanelHost';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const PLAN_PANEL_ID = 'panel-plan-plan-1';

const originalActivityActions = {
  loadTrackedPlans: useActivityStore.getState().loadTrackedPlans,
  shareTrackedPlan: useActivityStore.getState().shareTrackedPlan,
};
const originalChatActions = {
  sendMessage: useChatStore.getState().sendMessage,
  switchTab: useChatStore.getState().switchTab,
  markTrackedPlanExecuted: useChatStore.getState().markTrackedPlanExecuted,
  loadTabsForTarget: useChatStore.getState().loadTabsForTarget,
  ensureWorktreeHasChatTab: useChatStore.getState().ensureWorktreeHasChatTab,
};

interface ExecuteResult {
  readonly success: boolean;
  readonly error?: string;
  readonly data?: Record<string, unknown>;
}
let executeMock: jest.Mock<
  Promise<ExecuteResult>,
  [unknown, Record<string, unknown>]
>;
let updateMock: jest.Mock;
let shareTrackedPlanMock: jest.Mock;
let loadTrackedPlansMock: jest.Mock;
let addToastMock: jest.Mock;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function resetFeatureFlags(): void {
  useFeatureFlagsStore.setState({
    snapshot: { ...getDefaultFeatureFlagSnapshot(), status: 'ready' },
  });
}

/** A plan whose latest revision is 2, with revision 1 still selectable. */
function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'My Plan',
    content: '# My Plan\n\nLatest body',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    latestRevisionNumber: 2,
    revisions: [
      {
        revisionNumber: 1,
        content: '# My Plan\n\nOld body',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        revisionNumber: 2,
        content: '# My Plan\n\nLatest body',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-02T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function chatTab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

/** The chat, the plan beside it, and a collapsed Activity rail. */
const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-owning-chat',
      instance: { chatTabId: 'owning-chat' },
    },
    {
      kind: 'plan',
      groupId: 'group-plan',
      panelId: PLAN_PANEL_ID,
      title: 'My Plan',
      instance: { planId: 'plan-1' },
    },
    {
      kind: 'activity-section',
      groupId: 'group-activity',
      panelId: 'panel-activity',
    },
  ],
  containerSize: { width: 1600, height: 800 },
};

function seedPlan(plan: TrackedPlanData = makePlan()): void {
  useActivityStore.setState({
    trackedPlans: { [KEY]: [plan] },
    trackedPlanInventoryLoaded: { [KEY]: true },
  });
}

function renderPanel(): void {
  act(() => {
    root?.render(
      <PlanPanelHost
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        planId="plan-1"
        panelId={PLAN_PANEL_ID}
        isActive
        isVisible
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string): Promise<void> {
  const element = query(testId);
  if (!element) {
    throw new Error(`Missing ${testId}`);
  }
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

async function startPlanReadyRun(runTestId: string): Promise<void> {
  await click('plan-panel-execute');
  await click('plan-panel-execute-pipeline');
  await click(runTestId);
  await flush();
}

function planPanelInLayout(): boolean {
  return findPanelByInstanceKey(KEY, 'plan:plan-1')?.panelId === PLAN_PANEL_ID;
}

beforeEach(() => {
  resetFeatureFlags();
  executeMock = jest
    .fn<Promise<ExecuteResult>, [unknown, Record<string, unknown>]>()
    .mockResolvedValue({ success: true, data: {} });
  updateMock = jest
    .fn()
    .mockResolvedValue(makePlan({ reviewStatus: 'approved' }));
  shareTrackedPlanMock = jest.fn().mockResolvedValue(makePlan());
  loadTrackedPlansMock = jest.fn().mockResolvedValue(undefined);
  addToastMock = jest.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['teams-v1', 'organizations-v1', 'plans-crud-v1'],
        account: { id: 'account-1', email: 'user@example.test' },
        storageAvailable: true,
      }),
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test'),
      getWorktreePath: jest.fn().mockResolvedValue('/repo'),
      activity: {
        plans: {
          get: jest.fn().mockResolvedValue(null),
          list: jest.fn().mockResolvedValue([]),
          refreshComments: jest.fn().mockResolvedValue(null),
          update: updateMock,
          saveComments: jest.fn().mockResolvedValue(null),
          setFileVisibility: jest
            .fn<Promise<void>, [TrackedPlanFileVisibilityRequest]>()
            .mockResolvedValue(undefined),
        },
      },
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      execute: executeMock,
      listSharedTeams: jest
        .fn()
        .mockResolvedValue({ success: true, data: { data: [] } }),
      listSharedOrganizations: jest
        .fn()
        .mockResolvedValue({ success: true, data: { data: [] } }),
    },
  });
  seedPlan();
  useActivityStore.setState({
    loadTrackedPlans: loadTrackedPlansMock,
    shareTrackedPlan: shareTrackedPlanMock,
  });
  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    worktreeChats: {
      [KEY]: { tabs: [chatTab('owning-chat')], activeTabId: 'owning-chat' },
    },
    markTrackedPlanExecuted: jest.fn(),
    switchTab: jest.fn(),
  });
  usePipelineRunsStore.setState({ summaries: [] });
  useGitHubStore.setState({ addToast: addToastMock });
  usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
  usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) {
    store.disposeLayout(key);
  }
  useActivityStore.setState({
    trackedPlans: {},
    trackedPlanInventoryLoaded: {},
    ...originalActivityActions,
  });
  useChatStore.setState({
    ...originalChatActions,
    worktreeChats: {},
    selectedWorktree: null,
  });
  resetPlanViewStoreForTests();
  resetActivePlanStoreForTests();
  resetChatPanelSyncForTests();
});

describe('Plan panel share', () => {
  it('disables execution for Cursor plans pending safe admission', async () => {
    seedPlan(makePlan({ source: 'cursor' }));
    renderPanel();
    await flush();
    await click('plan-panel-execute');
    for (const action of ['implement', 'pipeline']) {
      const item = query(`plan-panel-execute-${action}`);
      expect(item instanceof HTMLButtonElement && item.disabled).toBe(true);
    }
    // Copy plan stays available beside Share, outside the Execute menu.
    expect(query('plan-panel-execute-copy')).toBeNull();
    const copy = query('plan-panel-copy');
    expect(copy instanceof HTMLButtonElement && !copy.disabled).toBe(true);
    expect(copy?.getAttribute('aria-disabled')).toBeNull();
  });

  it('enables sharing on the latest revision', async () => {
    renderPanel();
    await flush();

    const share = query('plan-panel-share');
    if (!(share instanceof HTMLButtonElement)) {
      throw new Error('Expected the Share button');
    }
    expect(share.disabled).toBe(false);
    expect(share.textContent).toContain('Share');
  });

  it('treats a private-only share as not shared and opens the scope picker', async () => {
    // Private is a storage value, not an audience, so a private-only cloud
    // copy must not read as Shared or resync on click.
    seedPlan(
      makePlan({
        share: {
          serverId: 'server-1',
          remoteId: 'remote-1',
          shareScope: 'private',
          syncStatus: 'synced',
        },
      }),
    );
    renderPanel();
    await flush();

    const share = query('plan-panel-share');
    expect(share?.textContent).toContain('Share');
    expect(share?.textContent).not.toContain('Shared');

    await click('plan-panel-share');
    await flush();

    expect(query('share-plan-modal')).not.toBeNull();
    expect(shareTrackedPlanMock).not.toHaveBeenCalled();
    expect(query('plan-panel-view')).not.toBeNull();
  });

  it('disables sharing while an older revision is shown, with a guidance tooltip', async () => {
    renderPanel();
    await flush();

    const select = query('plan-panel-revision-select');
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('Expected the revision select');
    }
    act(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const share = query('plan-panel-share');
    if (!(share instanceof HTMLButtonElement)) {
      throw new Error('Expected the Share button');
    }
    expect(share.disabled).toBe(true);
    // CAN-2799: the guidance is a rich hover tooltip, never a native title.
    expect(share.hasAttribute('title')).toBe(false);
    act(() => {
      share.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Switch to Latest to share this plan.',
    );
  });
});

describe('Plan panel plan_ready pipeline', () => {
  it('closes a successful launch after refresh failure and offers a refresh-only retry', async () => {
    const recovery: { retry?: () => void } = {};
    addToastMock.mockImplementation(
      (_message: string, _type: string, retry?: () => void): void => {
        recovery.retry = retry;
      },
    );
    loadTrackedPlansMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    renderPanel();
    await flush();
    await startPlanReadyRun('mock-plan-ready-run');
    expect(query('mock-plan-ready-modal')).toBeNull();
    expect(addToastMock).toHaveBeenCalledWith(
      expect.stringContaining('refresh'),
      'error',
      expect.any(Function),
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
    const retry = recovery.retry;
    if (retry === undefined) throw new Error('Missing refresh recovery');
    retry();
    await flush();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(loadTrackedPlansMock).toHaveBeenCalledTimes(2);
  });
  it('forwards configured plan_ready inputs', async () => {
    renderPanel();
    await flush();

    await startPlanReadyRun('mock-plan-ready-run');

    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cwd: '/repo',
        pipelineId: 'pipeline-1',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: '# My Plan\n\nLatest body' },
        },
        inputs: {
          continue_on_refine_gate_fail: 'true',
          continue_on_plan_contract_fail: 'true',
        },
        modelConfig: { fastMode: true },
      }),
    );
  });

  it('omits plan_ready inputs when none are configured', async () => {
    renderPanel();
    await flush();

    await startPlanReadyRun('mock-plan-ready-run-without-inputs');

    const payload = executeMock.mock.lastCall?.[1];
    expect(payload).not.toHaveProperty('inputs');
    expect(payload).toEqual(
      expect.objectContaining({
        cwd: '/repo',
        pipelineId: 'pipeline-1',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: '# My Plan\n\nLatest body' },
        },
        modelConfig: { fastMode: true },
      }),
    );
  });

  it('reveals the Activity panel for the started run and keeps the plan panel', async () => {
    const store = usePanelLayoutStore.getState();
    expect(store.collapseGroup(KEY, 'group-activity')).toBe(true);
    store.focusGroup(KEY, 'group-plan');
    renderPanel();
    await flush();

    await startPlanReadyRun('mock-plan-ready-run');

    expect(loadTrackedPlansMock).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    const layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.groups['group-activity'].collapsed).toBeUndefined();
    expect(layout.activeGroupId).toBe('group-activity');
    // The dialog closed and the plan stayed open.
    expect(query('mock-plan-ready-modal')).toBeNull();
    expect(planPanelInLayout()).toBe(true);
    expect(query('plan-panel-view')).not.toBeNull();
  });

  it('leaves the layout alone when the run fails to start', async () => {
    executeMock.mockResolvedValue({ success: false, error: 'No runner' });
    const store = usePanelLayoutStore.getState();
    expect(store.collapseGroup(KEY, 'group-activity')).toBe(true);
    store.focusGroup(KEY, 'group-plan');
    renderPanel();
    await flush();

    await startPlanReadyRun('mock-plan-ready-run');

    const layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.groups['group-activity'].collapsed).toBeDefined();
    expect(layout.activeGroupId).toBe('group-plan');
    expect(query('mock-plan-ready-modal')).not.toBeNull();
  });
});

describe('Plan panel Implement', () => {
  it("sends Implement to the plan's worktree chat while another worktree is selected and keeps the panel", async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      sendMessage,
      selectedWorktree: { projectId: 'proj-other', worktreeId: 'wt-other' },
      worktreeChats: {
        'proj-other/wt-other': {
          tabs: [chatTab('other-chat')],
          activeTabId: 'other-chat',
        },
        [KEY]: { tabs: [chatTab('owning-chat')], activeTabId: 'owning-chat' },
      },
    });
    renderPanel();
    await flush();

    await click('plan-panel-execute');
    await click('plan-panel-execute-implement');
    await flush();

    expect(addToastMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'Implement this plan:\n\n# My Plan\n\nLatest body',
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, chatId: 'owning-chat' },
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    // The plan is approved in its own worktree, its chat comes forward, and
    // the plan panel stays open.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        reviewStatus: 'approved',
      }),
    );
    expect(loadTrackedPlansMock).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(usePanelLayoutStore.getState().layouts[KEY].activeGroupId).toBe(
      'group-chat',
    );
    expect(planPanelInLayout()).toBe(true);
    expect(query('plan-panel-view')).not.toBeNull();
  });

  /** A send that stays in flight until the test settles it. */
  function slowSend(): { sendMessage: jest.Mock; settle: () => void } {
    let settle: () => void = () => undefined;
    const sendMessage = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    return { sendMessage, settle: () => settle() };
  }

  it('shows the chat right away, before the send settles, and only once', async () => {
    const send = slowSend();
    useChatStore.setState({ sendMessage: send.sendMessage });
    const store = usePanelLayoutStore.getState();
    expect(store.collapseGroup(KEY, 'group-chat')).toBe(true);
    store.focusGroup(KEY, 'group-plan');
    renderPanel();
    await flush();

    await click('plan-panel-execute');
    await click('plan-panel-execute-implement');
    await flush();

    // The send is still in flight, yet the chat is already in view.
    expect(send.sendMessage).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    let layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    expect(layout.groups['group-chat'].activePanelId).toBe(
      'panel-chat-owning-chat',
    );
    expect(layout.activeGroupId).toBe('group-chat');

    // The user moves on; finishing the send does not pull focus back.
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    send.settle();
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(1);
    layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.activeGroupId).toBe('group-plan');
    expect(addToastMock).not.toHaveBeenCalled();
    expect(planPanelInLayout()).toBe(true);
  });

  it('shows a chat whose panel does not exist yet once the layout places it', async () => {
    // The worktree has no chat yet: Implement creates one, whose panel the
    // chat/panel bridge places on its next pass. The plan is maximized.
    const send = slowSend();
    useChatStore.setState({
      sendMessage: send.sendMessage,
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
      ensureWorktreeHasChatTab: jest.fn((): Promise<void> => {
        useChatStore.setState({
          worktreeChats: {
            [KEY]: { tabs: [chatTab('new-chat')], activeTabId: 'new-chat' },
          },
        });
        return Promise.resolve();
      }),
    });
    const store = usePanelLayoutStore.getState();
    store.disposeLayout(KEY);
    store.initializeLayout(KEY, {
      ...LAYOUT,
      groups: [{ groupId: 'group-chat' }, ...LAYOUT.groups.slice(1)],
    });
    initChatPanelSync();
    flushChatPanelSyncForTests();
    usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-plan', true);
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    renderPanel();
    await flush();

    await click('plan-panel-execute');
    await click('plan-panel-execute-implement');
    await flush();

    expect(send.sendMessage).toHaveBeenCalledWith(
      'Implement this plan:\n\n# My Plan\n\nLatest body',
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, chatId: 'new-chat' },
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    const location = findPanelByInstanceKey(KEY, 'chat:new-chat');
    expect(location?.groupId).toBe('group-chat');
    const layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(location?.panelId);
    // One chat, one panel: nothing was duplicated.
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs).toHaveLength(1);
    expect(
      Object.values(layout.groups).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === 'chat'),
      ),
    ).toHaveLength(1);
    send.settle();
    await flush();
  });
});

describe('Plan panel linked runs', () => {
  function runSummary(id: string, startedAt: string): ExecutionSummary {
    return {
      id,
      pipeline_id: 'pipeline-1',
      pipeline_name: `Pipeline ${id}`,
      status: 'success',
      status_reasons: [],
      started_at: startedAt,
      cwd: '/repo',
      planId: 'plan-1',
    };
  }

  function linkedEntry(name: string): HTMLButtonElement | undefined {
    return Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.startsWith(name));
  }

  it('shows when each run with a known start was dispatched', async () => {
    seedPlan(makePlan({ linkedExecutionIds: ['run-1', 'run-2'] }));
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-1', '2026-06-03T01:00:00.000Z')],
    });
    renderPanel();
    await flush();

    await click('plan-panel-executions');

    const loaded = linkedEntry('Pipeline run-1');
    expect(loaded?.textContent).toContain('Dispatched');
    expect(loaded?.querySelector('time')?.dateTime).toBe(
      '2026-06-03T01:00:00.000Z',
    );
    const unknown = linkedEntry('run-2');
    expect(unknown).not.toBeUndefined();
    expect(unknown?.textContent).not.toContain('Dispatched');
    expect(unknown?.querySelector('time')).toBeNull();
  });

  it('omits the time for a run whose start is not reported yet', async () => {
    seedPlan(makePlan({ linkedExecutionIds: ['run-1', 'run-2'] }));
    usePipelineRunsStore.setState({
      summaries: [
        runSummary('run-1', '2026-06-03T01:00:00.000Z'),
        runSummary('run-2', ''),
      ],
    });
    renderPanel();
    await flush();

    await click('plan-panel-executions');

    const pending = linkedEntry('Pipeline run-2');
    expect(pending?.textContent).toContain('success');
    expect(pending?.textContent).not.toContain('Dispatched');
    expect(pending?.querySelector('time')).toBeNull();
  });
});

describe('Plan panel status (CAN-5166)', () => {
  function runSummary(
    id: string,
    status: ExecutionSummary['status'],
    startedAt = '2026-06-03T01:00:00.000Z',
  ): ExecutionSummary {
    return {
      id,
      pipeline_id: 'pipeline-1',
      pipeline_name: `Pipeline ${id}`,
      status,
      status_reasons: [],
      started_at: startedAt,
      cwd: '/repo',
      planId: 'plan-1',
    };
  }

  function executeIsPrimary(): boolean {
    return (
      query('plan-panel-execute')?.className.includes('bg-accent') ?? false
    );
  }

  beforeEach(() => {
    openPipelineExecutionFromUiMock.mockReset();
  });

  it('keeps Pending with primary Execute', async () => {
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Pending');
    expect(executeIsPrimary()).toBe(true);
    expect(query('plan-panel-status-note')).toBeNull();
  });

  it('shows Approved with secondary Execute and a View chat link to the tracking chat', async () => {
    seedPlan(makePlan({ reviewStatus: 'approved' }));
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [{ ...chatTab('owning-chat'), trackedPlanId: 'plan-1' }],
          activeTabId: 'owning-chat',
        },
      },
    });
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
    expect(executeIsPrimary()).toBe(false);
    expect(query('plan-panel-execute')).not.toHaveProperty('disabled', true);

    await click('plan-panel-status-note-chat');
    expect(usePanelLayoutStore.getState().layouts[KEY].activeGroupId).toBe(
      'group-chat',
    );
  });

  it.each(['idle', 'error', 'streaming'] as const)(
    'does not claim implementation from a %s chat with unrelated replies',
    async (status) => {
      seedPlan(makePlan({ reviewStatus: 'approved' }));
      useChatStore.setState({
        worktreeChats: {
          [KEY]: {
            tabs: [
              {
                ...chatTab('owning-chat'),
                trackedPlanId: 'plan-1',
                status,
                messages: [
                  {
                    id: 'unrelated-reply',
                    role: 'assistant',
                    blocks: [
                      { type: 'text', text: 'An unrelated later answer.' },
                    ],
                    timestamp: 1,
                  },
                ],
              },
            ],
            activeTabId: 'owning-chat',
          },
        },
      });
      renderPanel();
      await flush();

      expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
    },
  );

  it.each(['pending', 'running', 'paused'] as const)(
    'shows Implementing for a %s linked run and opens it from View run',
    async (status) => {
      seedPlan(makePlan({ reviewStatus: 'approved' }));
      usePipelineRunsStore.setState({
        summaries: [runSummary('run-1', status)],
      });
      renderPanel();
      await flush();

      expect(query('plan-panel-status-badge')?.textContent).toBe(
        'Implementing',
      );
      expect(executeIsPrimary()).toBe(false);
      await click('plan-panel-status-note-run');
      expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'run-1' }),
      );
    },
  );

  it.each([
    ['failure', 'success', 'Approved'],
    ['success', 'failure', 'Implemented'],
  ] as const)(
    'uses the root %s outcome instead of its nested %s outcome',
    async (rootStatus, childStatus, expectedLabel) => {
      seedPlan(
        makePlan({
          reviewStatus: 'approved',
          linkedExecutionIds: ['root-run', 'child-run'],
        }),
      );
      usePipelineRunsStore.setState({
        summaries: [
          runSummary('root-run', rootStatus),
          {
            ...runSummary('child-run', childStatus, '2026-06-03T02:00:00.000Z'),
            parent_execution_id: 'root-run',
          },
        ],
      });
      renderPanel();
      await flush();

      expect(query('plan-panel-status-badge')?.textContent).toBe(expectedLabel);
      expect(query('plan-panel-status-note-outcome')?.textContent ?? null).toBe(
        rootStatus === 'failure' ? 'Workflow failed·View run' : null,
      );
      await click(
        rootStatus === 'failure'
          ? 'plan-panel-status-note-run-outcome'
          : 'plan-panel-status-note-run',
      );
      expect(openPipelineExecutionFromUiMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionId: 'root-run' }),
      );
    },
  );

  it('shows Implemented for a successful run and reports a later failed retry', async () => {
    seedPlan(makePlan({ reviewStatus: 'approved' }));
    usePipelineRunsStore.setState({
      summaries: [
        runSummary('run-ok', 'success', '2026-06-03T01:00:00.000Z'),
        runSummary('run-retry', 'failure', '2026-06-03T02:00:00.000Z'),
      ],
    });
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Implemented');
    expect(query('plan-panel-status-note-outcome')?.textContent).toBe(
      'Workflow failed·View run',
    );
    await click('plan-panel-status-note-run-outcome');
    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'run-retry' }),
    );
    await click('plan-panel-status-note-run');
    expect(openPipelineExecutionFromUiMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionId: 'run-ok' }),
    );
  });

  it('keeps Approved for a cancelled run on the current revision', async () => {
    seedPlan(makePlan({ reviewStatus: 'approved' }));
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-1', 'cancelled')],
    });
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
    expect(query('plan-panel-status-note-outcome')?.textContent).toBe(
      'Workflow cancelled·View run',
    );
  });

  it('ignores a successful run that started before the current revision', async () => {
    seedPlan(makePlan({ reviewStatus: 'approved' }));
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-1', 'success', '2026-06-01T12:00:00.000Z')],
    });
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
  });

  it('returns to Approved when run evidence unloads or revision metadata is unavailable', async () => {
    seedPlan(makePlan({ reviewStatus: 'approved' }));
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-1', 'success')],
    });
    renderPanel();
    await flush();
    expect(query('plan-panel-status-badge')?.textContent).toBe('Implemented');
    act(() => {
      usePipelineRunsStore.setState({ summaries: [] });
    });
    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
    act(() => {
      seedPlan(makePlan({ reviewStatus: 'approved', revisions: [] }));
      usePipelineRunsStore.setState({
        summaries: [runSummary('run-1', 'success')],
      });
    });
    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
  });

  it('keeps Dismissed with secondary Execute despite a linked run', async () => {
    seedPlan(makePlan({ reviewStatus: 'dismissed' }));
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-1', 'running')],
    });
    renderPanel();
    await flush();

    expect(query('plan-panel-status-badge')?.textContent).toBe('Dismissed');
    expect(executeIsPrimary()).toBe(false);
    expect(query('plan-panel-status-note')).toBeNull();
  });

  it('moves the status off Pending as soon as the store records the approval', async () => {
    renderPanel();
    await flush();
    expect(query('plan-panel-status-badge')?.textContent).toBe('Pending');

    act(() => {
      useActivityStore
        .getState()
        .commitTrackedPlanUpdate(makePlan({ reviewStatus: 'approved' }));
    });

    expect(query('plan-panel-status-badge')?.textContent).toBe('Approved');
    expect(executeIsPrimary()).toBe(false);
  });
});
