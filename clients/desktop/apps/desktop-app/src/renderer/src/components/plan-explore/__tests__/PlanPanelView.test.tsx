/**
 * @jest-environment jsdom
 */
import type * as ReactNamespace from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PlanCommentThread,
  type SaveTrackedPlanCommentsRequest,
  type TrackedPlanData,
  type TrackedPlanFileVisibilityRequest,
} from '@canopy/desktop-shared/types';
import type * as SubmitWorkspaceCommentsModule from '@/components/chat/submitWorkspaceComments';
import type { PlanDocumentPanelProps } from '@/components/plan-explore/PlanDocumentPanel';
import type { PlanVisualizerPanelProps } from '@/components/plan-explore/PlanVisualizerPanel';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';

jest.mock('@/components/chat/PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: (): null => null,
}));
jest.mock('@/components/shared/SharePlanModal', () => ({
  SharePlanModal: (): null => null,
}));
// The real dispatch, observed so tests can read the options a submit passes.
jest.mock('@/components/chat/submitWorkspaceComments', () => {
  const actual = jest.requireActual<typeof SubmitWorkspaceCommentsModule>(
    '@/components/chat/submitWorkspaceComments',
  );
  return {
    ...actual,
    dispatchWorkspaceComments: jest.fn(actual.dispatchWorkspaceComments),
  };
});
jest.mock('@/components/plan-explore/PlanDocumentPanel', () => ({
  PlanDocumentPanel: (props: PlanDocumentPanelProps): JSX.Element => {
    mockDocumentProps.current = props;
    return (
      <div
        data-testid="mock-plan-document"
        data-read-only={String(props.readOnly)}
      />
    );
  },
}));
jest.mock('@/components/plan-explore/PlanVisualizerPanel', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PlanVisualizerPanel: react.forwardRef(function MockVisualizer(
      props: PlanVisualizerPanelProps,
      ref: ReactNamespace.ForwardedRef<DiagramSearchHandle>,
    ): JSX.Element {
      react.useImperativeHandle(ref, () => ({
        search: (): string[] => [],
        reveal: (): void => undefined,
        clear: (): void => undefined,
      }));
      mockVisualizerProps.push(props);
      return react.createElement('div', {
        'data-testid': 'plan-explore-visualizer-panel',
        'data-reveal-node': props.revealNodeRequest?.nodeId ?? '',
        'data-can-comment': String(props.onAddNodeComment !== undefined),
      });
    }),
  };
});

import { useSurfaceFindStore } from '@canopy/ui-app/find';
import { dispatchWorkspaceComments } from '@/components/chat/submitWorkspaceComments';
import { PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT } from '@/components/plan-explore/usePlanComments';
import { OWNING_CHAT_UNAVAILABLE_MESSAGE } from '@/lib/chat/owningWorktreeChat';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { resetChatPanelSyncForTests } from '@/lib/panels/chat-panel-sync';
import { revealPlanDiagramNode } from '@/lib/panels/plan-panel-open';
import {
  captureActivePlanContext,
  resetActivePlanStoreForTests,
  useActivePlanStore,
} from '@/stores/activePlanStore';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  findPanelByInstanceKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  planViewKey,
  resetPlanViewStoreForTests,
  usePlanViewStore,
} from '@/stores/planViewStore';
import {
  PlanDiagramPanelHost,
  PlanPanelHost,
  type PlanPanelHostProps,
} from '../PlanPanelHost';

jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));

const mockDocumentProps: { current: PlanDocumentPanelProps | null } = {
  current: null,
};
const mockVisualizerProps: PlanVisualizerPanelProps[] = [];

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const VIEW_KEY = planViewKey(PROJECT_ID, WORKTREE_ID, 'plan-1');

let getMock: jest.Mock;
let listMock: jest.Mock;
let refreshCommentsMock: jest.Mock;
let updateMock: jest.Mock;
let saveCommentsMock: jest.Mock<
  Promise<TrackedPlanData | null>,
  [SaveTrackedPlanCommentsRequest]
>;
let setFileVisibilityMock: jest.Mock<
  Promise<void>,
  [TrackedPlanFileVisibilityRequest]
>;
let addToastMock: jest.Mock;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const originalLoadTrackedPlans = useActivityStore.getState().loadTrackedPlans;
const originalChatActions = {
  sendMessage: useChatStore.getState().sendMessage,
  switchTab: useChatStore.getState().switchTab,
  markTrackedPlanExecuted: useChatStore.getState().markTrackedPlanExecuted,
  loadTabsForTarget: useChatStore.getState().loadTabsForTarget,
  ensureWorktreeHasChatTab: useChatStore.getState().ensureWorktreeHasChatTab,
};

/** The dispatch callbacks `dispatchWorkspaceComments` hands `sendMessage`. */
type SendMessage = ReturnType<typeof useChatStore.getState>['sendMessage'];
type DispatchCallbacks = NonNullable<Parameters<SendMessage>[4]>;

/**
 * Parks `text` in the owning chat's renderer-local queue, as `sendMessage`
 * does when a Claude terminal launch fails: the queued copy is the message's
 * only representation and is not saved with the chat tab.
 */
function parkInRendererQueue(text: string, options: DispatchCallbacks): void {
  useChatStore.setState((state) => {
    const scope = state.worktreeChats[KEY];
    if (!scope) return state;
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...scope,
          tabs: scope.tabs.map((entry) =>
            entry.id === 'chat-1'
              ? {
                  ...entry,
                  queuedMessages: [
                    ...entry.queuedMessages,
                    {
                      text,
                      dispatchOptions: { hiddenContext: options.hiddenContext },
                    },
                  ],
                }
              : entry,
          ),
        },
      },
    };
  });
}

/** A `sendMessage` that reports `outcome` through the dispatch callbacks. */
function sendMessageReporting(
  outcome: 'accepted' | 'rejected' | 'launch-failed',
): jest.Mock<ReturnType<SendMessage>, Parameters<SendMessage>> {
  return jest.fn<ReturnType<SendMessage>, Parameters<SendMessage>>(
    (...args: Parameters<SendMessage>): Promise<void> => {
      const [text, , , , options] = args;
      if (outcome === 'accepted') {
        options?.onDispatchAccepted?.();
      } else if (outcome === 'launch-failed') {
        // The terminal launch is fire-and-forget: it fails after sendMessage
        // returns and leaves the prompt in the renderer queue for retry.
        if (options) parkInRendererQueue(text, options);
        void Promise.resolve().then(() => {
          options?.onQueuedWithoutDispatch?.('renderer');
        });
      } else {
        options?.onPreDispatchRejected?.();
      }
      return Promise.resolve();
    },
  );
}

/** An open general thread with a teammate comment and a local draft. */
function pendingThread(): PlanCommentThread {
  return {
    id: 'thread-1',
    status: 'open',
    createdAt: '2026-06-01T00:00:00.000Z',
    anchorState: 'matched',
    anchor: { quote: '', unanchored: true },
    comments: [
      {
        id: 'remote-1',
        author: 'remote',
        remoteAuthor: { userId: 'u-2', displayName: 'Ada Lovelace' },
        body: 'Can we split this?',
        createdAt: '2026-06-01T00:01:00.000Z',
      },
      {
        id: 'draft-1',
        author: 'user',
        body: 'Yes, into two phases',
        createdAt: '2026-06-01T00:02:00.000Z',
        staged: true,
      },
    ],
  };
}

function submitFromDocument(): void {
  const onSubmit = mockDocumentProps.current?.onSubmit;
  if (!onSubmit) {
    throw new Error('Expected the document to offer Submit');
  }
  act(() => {
    onSubmit();
  });
}

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Importer plan',
    content: '# Importer plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

/** A plan whose latest revision is 2, with revision 1 still selectable. */
function makeRevisedPlan(
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return makePlan({
    latestRevisionNumber: 2,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Importer plan\n\nOld body',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        revisionNumber: 2,
        content: '# Importer plan\n\nBody',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-02T00:00:00.000Z',
      },
    ],
    ...overrides,
  });
}

function selectRevision(value: string): void {
  const select = query('plan-panel-revision-select');
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Expected the revision select');
  }
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The lease requests sent so far. */
function leaseRequests(): TrackedPlanFileVisibilityRequest[] {
  return setFileVisibilityMock.mock.calls.map(([request]) => request);
}

/** The plan a composer send from the plan's worktree would carry. */
function activePlan(): ReturnType<typeof captureActivePlanContext> {
  return captureActivePlanContext({
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  });
}

function pointerDown(testId: string): void {
  const element = query(testId);
  if (!element) {
    throw new Error(`Missing ${testId}`);
  }
  act(() => {
    element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

function focusIn(testId: string): void {
  const element = query(testId);
  if (!element) {
    throw new Error(`Missing ${testId}`);
  }
  act(() => {
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function makeChatTab(): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat One',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
  };
}

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-chat-1',
      instance: { chatTabId: 'chat-1' },
    },
    {
      kind: 'plan',
      groupId: 'group-plan',
      panelId: 'panel-plan-plan-1',
      title: 'Importer plan',
      instance: { planId: 'plan-1' },
    },
  ],
  containerSize: { width: 1600, height: 800 },
};

function hostProps(
  overrides: Partial<PlanPanelHostProps> = {},
): PlanPanelHostProps {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    planId: 'plan-1',
    panelId: 'panel-plan-plan-1',
    isActive: true,
    isVisible: true,
    ...overrides,
  };
}

function seedPlans(plans: TrackedPlanData[] = [makePlan()]): void {
  useActivityStore.setState({
    trackedPlans: { [KEY]: plans },
    trackedPlanInventoryLoaded: { [KEY]: true },
  });
}

function render(node: JSX.Element): void {
  act(() => {
    root?.render(node);
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
  return host?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

function click(testId: string): void {
  const element = query(testId);
  if (!element) {
    throw new Error(`Missing ${testId}`);
  }
  act(() => {
    element.click();
  });
}

/** The find-bar surfaces registered, keyed `<mode>:<scope>`, with titles. */
function registeredFindSurfaces(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(useSurfaceFindStore.getState().controllers).map(
      ([key, entry]) => [key, entry.title],
    ),
  );
}

beforeEach(() => {
  mockDocumentProps.current = null;
  mockVisualizerProps.length = 0;
  getMock = jest.fn().mockResolvedValue(null);
  listMock = jest.fn().mockResolvedValue([]);
  refreshCommentsMock = jest.fn().mockResolvedValue(null);
  updateMock = jest.fn().mockResolvedValue(undefined);
  saveCommentsMock = jest
    .fn<Promise<TrackedPlanData | null>, [SaveTrackedPlanCommentsRequest]>()
    .mockResolvedValue(null);
  setFileVisibilityMock = jest
    .fn<Promise<void>, [TrackedPlanFileVisibilityRequest]>()
    .mockResolvedValue(undefined);
  addToastMock = jest.fn();
  jest.mocked(dispatchWorkspaceComments).mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      activity: {
        plans: {
          get: getMock,
          list: listMock,
          refreshComments: refreshCommentsMock,
          update: updateMock,
          saveComments: saveCommentsMock,
          setFileVisibility: setFileVisibilityMock,
        },
      },
    },
  });
  usePipelineRunsStore.setState({ summaries: [] });
  useGitHubStore.setState({ addToast: addToastMock });
  seedPlans();
  usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
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
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) {
    store.disposeLayout(key);
  }
  useActivityStore.setState({
    trackedPlans: {},
    trackedPlanInventoryLoaded: {},
    loadTrackedPlans: originalLoadTrackedPlans,
  });
  useChatStore.setState({ ...originalChatActions, worktreeChats: {} });
  resetPlanViewStoreForTests();
  resetActivePlanStoreForTests();
  resetChatPanelSyncForTests();
});

describe('PlanPanelHost', () => {
  it('shows the document with Document and Diagram tabs and Split', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    expect(query('plan-panel-view')?.dataset.planInnerTab).toBe('document');
    // The panel chrome (plan header, tabs) is recorded; the document and
    // diagram panels block their own content.
    expect(
      query('plan-panel-view')?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(query('plan-panel-tab-document')).not.toBeNull();
    expect(query('plan-panel-tab-diagram')).not.toBeNull();
    expect(query('plan-panel-split')?.textContent).toBe('Split');
    expect(query('plan-panel-show-diagram')).toBeNull();
    expect(query('plan-panel-execute')).not.toBeNull();
    expect(query('plan-panel-status-badge')?.textContent).toBe('Pending');
    expect(query('mock-plan-document')?.dataset.readOnly).toBe('false');
    // The panel submits its comments to the owning worktree's chat.
    expect(mockDocumentProps.current?.onSubmit).toBeDefined();
    expect(mockDocumentProps.current?.onRevealDiagramNode).toBeDefined();
    expect(query('plan-explore-visualizer-panel')).toBeNull();
  });

  it('registers the shown tab with the find bar: plan, then diagram', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    const view = query('plan-panel-view');
    expect(view?.dataset.findSurface).toBe('plan');
    expect(view?.dataset.findScope).toBe(VIEW_KEY);
    expect(view?.tabIndex).toBe(-1);
    expect(view?.classList.contains('outline-none')).toBe(true);
    expect(query('content-search-toggle')).toBeNull();
    expect(registeredFindSurfaces()).toEqual({
      [`plan:${VIEW_KEY}`]: 'Importer plan',
    });

    // Switching tabs moves the surface; an open bar closes as for any panel
    // that is hidden.
    click('plan-panel-tab-diagram');
    await flush();
    expect(view?.dataset.findSurface).toBe('diagram');
    expect(registeredFindSurfaces()).toEqual({
      [`diagram:${VIEW_KEY}`]: 'Importer plan (Diagram)',
    });
    expect(mockVisualizerProps.at(-1)?.onSearchContextChange).toEqual(
      expect.any(Function),
    );

    click('plan-panel-tab-document');
    await flush();
    expect(view?.dataset.findSurface).toBe('plan');
    expect(registeredFindSurfaces()).toEqual({
      [`plan:${VIEW_KEY}`]: 'Importer plan',
    });
  });

  it('does not mount the diagram behind the Document tab', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    expect(query('plan-panel-diagram-body')).toBeNull();
    expect(query('plan-explore-visualizer-panel')).toBeNull();
  });

  it('registers only the plan for a split document', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    click('plan-panel-split');
    await flush();

    expect(registeredFindSurfaces()).toEqual({
      [`plan:${VIEW_KEY}`]: 'Importer plan',
    });
  });

  it('registers nothing while off screen', async () => {
    render(<PlanPanelHost {...hostProps({ isVisible: false })} />);
    await flush();

    expect(registeredFindSurfaces()).toEqual({});
  });

  it('mounts the diagram only while its tab is selected and keeps the document mounted', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    click('plan-panel-tab-diagram');
    await flush();

    expect(usePlanViewStore.getState().entries[VIEW_KEY]?.innerTab).toBe(
      'diagram',
    );
    expect(query('plan-explore-visualizer-panel')).not.toBeNull();
    expect(query('mock-plan-document')).not.toBeNull();
    expect(
      query('mock-plan-document')?.parentElement?.classList.contains('hidden'),
    ).toBe(true);

    click('plan-panel-tab-document');
    await flush();

    expect(query('plan-explore-visualizer-panel')).toBeNull();
    expect(
      query('mock-plan-document')?.parentElement?.classList.contains('hidden'),
    ).toBe(false);
  });

  it('follows the layout: split shows the document only, merge restores Diagram and Split', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    click('plan-panel-tab-diagram');
    await flush();

    click('plan-panel-split');
    await flush();

    const diagram = findPanelByInstanceKey(KEY, 'plan-diagram:plan-1');
    expect(diagram).not.toBeNull();
    expect(query('plan-panel-view')?.dataset.planInnerTab).toBe('document');
    expect(query('plan-panel-tab-diagram')).toBeNull();
    expect(query('plan-panel-split')).toBeNull();
    // The split diagram is on screen beside it, so there is nothing to show.
    expect(query('plan-panel-show-diagram')).toBeNull();
    expect(query('plan-explore-visualizer-panel')).toBeNull();

    // Even a stored Diagram tab stays on the document while split.
    act(() => {
      usePlanViewStore.getState().setInnerTab(VIEW_KEY, 'diagram');
    });
    expect(query('plan-panel-view')?.dataset.planInnerTab).toBe('document');

    act(() => {
      if (diagram) {
        usePanelLayoutStore
          .getState()
          .closeTab(diagram.layoutKey, diagram.groupId, diagram.panelId);
      }
    });
    await flush();

    expect(query('plan-panel-tab-diagram')).not.toBeNull();
    expect(query('plan-panel-split')).not.toBeNull();
    expect(query('plan-panel-show-diagram')).toBeNull();
  });

  it('offers Show diagram only while the split diagram is off screen', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    click('plan-panel-split');
    await flush();
    const diagram = findPanelByInstanceKey(KEY, 'plan-diagram:plan-1');
    if (diagram === null) {
      throw new Error('Expected the split diagram panel');
    }
    expect(query('plan-panel-show-diagram')).toBeNull();

    // Behind another tab in its group.
    const store = usePanelLayoutStore.getState();
    act(() => {
      store.addTab(KEY, diagram.groupId, 'terminal');
    });
    expect(query('plan-panel-show-diagram')).not.toBeNull();
    act(() => {
      store.selectTab(KEY, diagram.groupId, diagram.panelId);
    });
    expect(query('plan-panel-show-diagram')).toBeNull();

    // Hidden by this panel's maximized group.
    act(() => {
      store.maximizeGroup(KEY, 'group-plan', true);
    });
    expect(query('plan-panel-show-diagram')).not.toBeNull();

    click('plan-panel-show-diagram');

    const layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(layout.activeGroupId).toBe(diagram.groupId);
    expect(layout.maximizedGroupId).toBeNull();
    expect(query('plan-panel-show-diagram')).toBeNull();
  });

  it.each([
    [
      'a shared-container recipient',
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: 'c-1' },
      false,
    ],
    ['a read-only workspace', {}, true],
  ])(
    'is read-only for %s',
    async (_label, scope: Partial<PlanPanelHostProps>, readOnlyContext) => {
      const projectId = scope.projectId ?? PROJECT_ID;
      const worktreeId = scope.worktreeId ?? WORKTREE_ID;
      useActivityStore.setState({
        trackedPlans: {
          [`${projectId}/${worktreeId}`]: [makePlan({ projectId, worktreeId })],
        },
        trackedPlanInventoryLoaded: { [`${projectId}/${worktreeId}`]: true },
      });
      const node = <PlanPanelHost {...hostProps(scope)} />;
      render(
        readOnlyContext ? (
          <WorkspaceAccessContext.Provider
            value={{
              mode: 'read-only',
              reason: 'shared-container',
              containerType: 'CODE_WORKTREE',
              runAllowed: false,
            }}
          >
            {node}
          </WorkspaceAccessContext.Provider>
        ) : (
          node
        ),
      );
      await flush();

      expect(query('plan-panel-view')).not.toBeNull();
      expect(query('plan-panel-tab-document')).not.toBeNull();
      expect(query('plan-panel-tab-diagram')).toBeNull();
      expect(query('plan-panel-split')).toBeNull();
      expect(query('plan-panel-show-diagram')).toBeNull();
      expect(query('plan-panel-execute')).toBeNull();
      expect(query('plan-panel-share')).toBeNull();
      expect(query('mock-plan-document')?.dataset.readOnly).toBe('true');
      expect(mockDocumentProps.current?.onRevealDiagramNode).toBeUndefined();
      // Its only find surface is the plan document.
      expect(query('plan-panel-view')?.dataset.findSurface).toBe('plan');
      expect(
        Object.keys(registeredFindSurfaces()).map((key) => key.split(':')[0]),
      ).toEqual(['plan']);
      // Recipients read comments but never submit them to a chat.
      expect(mockDocumentProps.current?.onSubmit).toBeUndefined();
      // Nor do they lease the plan file or become a worktree's active plan.
      pointerDown('plan-panel-view');
      expect(setFileVisibilityMock).not.toHaveBeenCalled();
      expect(useActivePlanStore.getState().viewCounts).toEqual({});
      expect(useActivePlanStore.getState().activeByWorktree).toEqual({});
    },
  );

  it('shows a neutral state once the plan is gone from the loaded inventory', async () => {
    seedPlans([]);
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    expect(query('plan-panel-missing')?.textContent).toBe(
      'This plan is no longer available',
    );
    expect(query('plan-panel-view')).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('offers Try again when its plan fails to load, then shows the plan', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    getMock
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce(makePlan());

    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    expect(query('plan-panel-load-error')?.textContent).toContain(
      "Couldn't load this plan.",
    );
    expect(query('plan-panel-missing')).toBeNull();
    expect(query('plan-panel-retry')?.textContent).toBe('Try again');

    click('plan-panel-retry');
    await flush();

    expect(query('plan-panel-load-error')).toBeNull();
    expect(query('plan-panel-view')).not.toBeNull();
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('fetches only its own plan while the inventory is not loaded', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    let resolvePlan: (plan: TrackedPlanData) => void = () => undefined;
    getMock.mockReturnValue(
      new Promise<TrackedPlanData>((resolve) => {
        resolvePlan = resolve;
      }),
    );

    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    expect(query('plan-panel-loading')).not.toBeNull();
    expect(getMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(listMock).not.toHaveBeenCalled();
    // A plan that is not loaded yet is neither leased nor active.
    expect(setFileVisibilityMock).not.toHaveBeenCalled();
    expect(activePlan()).toBeUndefined();

    await act(async () => {
      resolvePlan(makePlan());
      await Promise.resolve();
    });
    await flush();

    expect(query('plan-panel-view')).not.toBeNull();
    expect(leaseRequests()).toEqual([
      expect.objectContaining({ planId: 'plan-1', visible: true }),
    ]);
    expect(activePlan()).toEqual({ planId: 'plan-1' });
  });

  it('pulls a shared plan’s comments once for its document and diagram', async () => {
    seedPlans([
      makePlan({
        share: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          shareScope: 'team',
          teamId: 'team-1',
          syncStatus: 'synced',
        },
      }),
    ]);

    render(
      <>
        <PlanPanelHost {...hostProps()} />
        <PlanDiagramPanelHost
          {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
        />
      </>,
    );
    await flush();

    expect(query('plan-panel-view')).not.toBeNull();
    expect(query('plan-diagram-panel-view')).not.toBeNull();
    expect(refreshCommentsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel after Implement and reveals the plan’s worktree chat', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab()], activeTabId: 'chat-1' },
      },
      sendMessage,
      switchTab: jest.fn(),
      markTrackedPlanExecuted: jest.fn(),
    });
    useActivityStore.setState({
      loadTrackedPlans: jest.fn().mockResolvedValue(undefined),
    });
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    click('plan-panel-execute');
    click('plan-panel-execute-implement');
    await flush();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Implement this plan'),
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, chatId: 'chat-1' },
      undefined,
      expect.any(Object),
    );
    expect(usePanelLayoutStore.getState().layouts[KEY].activeGroupId).toBe(
      'group-chat',
    );
    expect(query('plan-panel-view')).not.toBeNull();
  });
});

describe('PlanPanelHost comment submission', () => {
  function seedOwningChat(
    sendMessage: ReturnType<typeof sendMessageReporting>,
  ): jest.Mock {
    const switchTab = jest.fn();
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab()], activeTabId: 'chat-1' },
      },
      sendMessage,
      switchTab,
    });
    return switchTab;
  }

  it('submits pending comments to the owning worktree chat and reveals it', async () => {
    seedPlans([makePlan({ commentThreads: [pendingThread()] })]);
    const sendMessage = sendMessageReporting('accepted');
    const switchTab = seedOwningChat(sendMessage);
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    expect(mockDocumentProps.current?.stagedCount).toBe(2);

    submitFromDocument();
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, files, target, mode, options] =
      sendMessage.mock.calls[0] ?? [];
    expect(text).toContain(
      'I have 1 comment thread on the plan "Importer plan" (plan plan-1).',
    );
    expect(text).toContain('Comment (from Ada Lovelace): Can we split this?');
    expect(text).toContain('Comment: Yes, into two phases');
    expect(files).toBeUndefined();
    expect(target).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
    });
    expect(mode).toBeUndefined();
    expect(options).toMatchObject({
      hiddenContext: {
        kind: 'file-comment-instructions',
        text: PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT,
      },
    });
    // The submission names its plan as the message's active plan.
    expect(dispatchWorkspaceComments).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      text,
      expect.objectContaining({ kind: 'file-comment-instructions' }),
      { activePlan: { planId: 'plan-1' } },
    );
    expect(switchTab).toHaveBeenCalledWith('chat-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(usePanelLayoutStore.getState().layouts[KEY].activeGroupId).toBe(
      'group-chat',
    );
    expect(addToastMock).not.toHaveBeenCalled();
    // Only the accepted comments are acknowledged.
    const saved = saveCommentsMock.mock.lastCall?.[0].commentThreads;
    expect(saved?.[0]?.comments).toEqual([
      expect.objectContaining({ id: 'remote-1', submittedToChat: true }),
      expect.objectContaining({ id: 'draft-1', staged: false }),
    ]);
    expect(mockDocumentProps.current?.stagedCount).toBe(0);
    expect(query('plan-panel-view')).not.toBeNull();
  });

  it('keeps comments pending and shows an error when the chat refuses them', async () => {
    seedPlans([makePlan({ commentThreads: [pendingThread()] })]);
    const sendMessage = sendMessageReporting('rejected');
    seedOwningChat(sendMessage);
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    submitFromDocument();
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith(
      "Couldn't send comments to chat. Try again.",
      'error',
      undefined,
      { category: 'Chat', projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    expect(saveCommentsMock).not.toHaveBeenCalled();
    expect(mockDocumentProps.current?.stagedCount).toBe(2);
    expect(usePanelLayoutStore.getState().layouts[KEY].activeGroupId).toBe(
      'group-plan',
    );
    expect(usePlanViewStore.getState().entries[VIEW_KEY]?.submitting).toBe(
      false,
    );
  });

  it('keeps comments pending when a failed chat launch leaves them only in the renderer queue', async () => {
    seedPlans([makePlan({ commentThreads: [pendingThread()] })]);
    const sendMessage = sendMessageReporting('launch-failed');
    seedOwningChat(sendMessage);
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    submitFromDocument();
    await flush();
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // A queued copy that is not saved with the chat is not a send: nothing is
    // acknowledged, so a restart cannot drop comments already marked sent.
    expect(saveCommentsMock).not.toHaveBeenCalled();
    expect(mockDocumentProps.current?.stagedCount).toBe(2);
    expect(addToastMock).toHaveBeenCalledWith(
      "Couldn't send comments to chat. Try again.",
      'error',
      undefined,
      { category: 'Chat', projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    // The parked copy is withdrawn so a retry cannot deliver the comments twice.
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.queuedMessages,
    ).toEqual([]);
    expect(usePlanViewStore.getState().entries[VIEW_KEY]?.submitting).toBe(
      false,
    );
  });

  it('says so when the worktree has no chat to send to', async () => {
    seedPlans([makePlan({ commentThreads: [pendingThread()] })]);
    const sendMessage = sendMessageReporting('accepted');
    const loadTabsForTarget = jest.fn().mockResolvedValue(undefined);
    const ensureWorktreeHasChatTab = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      worktreeChats: {},
      sendMessage,
      switchTab: jest.fn(),
      loadTabsForTarget,
      ensureWorktreeHasChatTab,
    });
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    submitFromDocument();
    await flush();

    expect(loadTabsForTarget).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(ensureWorktreeHasChatTab).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(addToastMock).toHaveBeenCalledWith(
      OWNING_CHAT_UNAVAILABLE_MESSAGE,
      'error',
      undefined,
      { category: 'Chat', projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    expect(saveCommentsMock).not.toHaveBeenCalled();
    expect(mockDocumentProps.current?.stagedCount).toBe(2);
  });

  it('still submits while an older revision is shown, naming that revision', async () => {
    seedPlans([makeRevisedPlan({ commentThreads: [pendingThread()] })]);
    const sendMessage = sendMessageReporting('accepted');
    seedOwningChat(sendMessage);
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    selectRevision('1');
    expect(query('mock-plan-document')?.dataset.readOnly).toBe('true');

    submitFromDocument();
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(dispatchWorkspaceComments).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      expect.any(String),
      expect.any(Object),
      { activePlan: { planId: 'plan-1', viewedRevisionNumber: 1 } },
    );
    expect(mockDocumentProps.current?.stagedCount).toBe(0);
  });
});

describe('PlanPanelHost plan file lease and active plan', () => {
  it('leases its plan file while visible and releases it, under one consumer, when hidden or closed', async () => {
    render(<PlanPanelHost {...hostProps()} />);
    await flush();

    const consumerId = leaseRequests()[0]?.consumerId;
    expect(consumerId).toEqual(expect.stringMatching(/.+/));
    expect(leaseRequests()).toEqual([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        consumerId,
        visible: true,
      },
    ]);

    render(<PlanPanelHost {...hostProps({ isVisible: false })} />);
    await flush();
    expect(leaseRequests()[1]).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
      consumerId,
      visible: false,
    });

    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    render(<></>);
    await flush();
    expect(
      leaseRequests()
        .slice(2)
        .map((request) => [request.consumerId, request.visible]),
    ).toEqual([
      [consumerId, true],
      [consumerId, false],
    ]);
  });

  it('becomes the active plan when it is the visible active tab, until it closes', async () => {
    render(<PlanPanelHost {...hostProps({ isVisible: false })} />);
    await flush();
    expect(activePlan()).toBeUndefined();

    render(<PlanPanelHost {...hostProps({ isActive: false })} />);
    await flush();
    expect(activePlan()).toBeUndefined();

    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    expect(activePlan()).toEqual({ planId: 'plan-1' });

    render(<></>);
    await flush();
    expect(activePlan()).toBeUndefined();
  });

  it('becomes the active plan on pointer or focus inside it', async () => {
    const scope = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
    render(<PlanPanelHost {...hostProps({ isActive: false })} />);
    await flush();
    expect(activePlan()).toBeUndefined();

    pointerDown('mock-plan-document');
    expect(activePlan()).toEqual({ planId: 'plan-1' });

    // Another plan's view took focus; focusing this panel takes it back.
    act(() => {
      useActivePlanStore.getState().mountView(scope, 'plan-2');
      useActivePlanStore.getState().markActive(scope, 'plan-2');
    });
    expect(activePlan()).toEqual({ planId: 'plan-2' });

    focusIn('mock-plan-document');
    expect(activePlan()).toEqual({ planId: 'plan-1' });
  });

  it('records the older revision on screen and clears it for the latest or on close', async () => {
    seedPlans([makeRevisedPlan()]);
    render(<PlanPanelHost {...hostProps()} />);
    await flush();
    expect(activePlan()).toEqual({ planId: 'plan-1' });

    selectRevision('1');
    expect(activePlan()).toEqual({ planId: 'plan-1', viewedRevisionNumber: 1 });

    selectRevision('latest');
    expect(activePlan()).toEqual({ planId: 'plan-1' });

    // Picking the latest revision by number is still the latest.
    selectRevision('2');
    expect(activePlan()).toEqual({ planId: 'plan-1' });

    selectRevision('1');
    render(<></>);
    await flush();
    expect(useActivePlanStore.getState().viewedRevisions).toEqual({});
  });
});

describe('PlanDiagramPanelHost', () => {
  it('shows the diagram with node comments in place of the plan name', async () => {
    render(
      <PlanDiagramPanelHost
        {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
      />,
    );
    await flush();

    expect(query('plan-diagram-panel-view')?.textContent).not.toContain(
      'Importer plan',
    );
    expect(query('content-search-toggle')).toBeNull();
    expect(query('plan-explore-visualizer-panel')?.dataset.canComment).toBe(
      'true',
    );
    // The document is on screen in its own group, so there is nothing to show.
    expect(query('plan-diagram-show-document')).toBeNull();
  });

  it('registers its diagram with the find bar while visible', async () => {
    render(
      <PlanDiagramPanelHost
        {...hostProps({
          panelId: 'panel-plan-diagram-plan-1',
          isVisible: false,
        })}
      />,
    );
    await flush();
    expect(registeredFindSurfaces()).toEqual({});

    render(
      <PlanDiagramPanelHost
        {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
      />,
    );
    await flush();
    const view = query('plan-diagram-panel-view');
    expect(view?.dataset.findSurface).toBe('diagram');
    expect(view?.tabIndex).toBe(-1);
    expect(view?.classList.contains('outline-none')).toBe(true);
    expect(registeredFindSurfaces()).toEqual({
      [`diagram:${VIEW_KEY}`]: 'Importer plan (Diagram)',
    });
    expect(mockVisualizerProps.at(-1)?.onSearchContextChange).toEqual(
      expect.any(Function),
    );
  });

  it('offers Show document only while the document is off screen', async () => {
    const store = usePanelLayoutStore.getState();
    store.splitGroup(KEY, 'group-plan', 'right', {
      kind: 'plan-diagram',
      panelId: 'panel-plan-diagram-plan-1',
      instance: { planId: 'plan-1' },
    });
    render(
      <PlanDiagramPanelHost
        {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
      />,
    );
    await flush();
    expect(query('plan-diagram-show-document')).toBeNull();
    // Without Show document the visualizer's toolbar is the first row.
    expect(query('plan-diagram-panel-top-row')).toBeNull();

    act(() => {
      store.collapseGroup(KEY, 'group-plan');
    });
    expect(query('plan-diagram-show-document')?.textContent).toBe(
      'Show document',
    );
    expect(query('plan-diagram-panel-top-row')).not.toBeNull();

    click('plan-diagram-show-document');
    await flush();

    expect(query('plan-diagram-show-document')).toBeNull();
  });

  it('leases its plan file while visible and makes its plan active on pointer', async () => {
    render(
      <PlanDiagramPanelHost
        {...hostProps({
          panelId: 'panel-plan-diagram-plan-1',
          isActive: false,
        })}
      />,
    );
    await flush();

    expect(leaseRequests()).toEqual([
      expect.objectContaining({ planId: 'plan-1', visible: true }),
    ]);
    expect(activePlan()).toBeUndefined();

    pointerDown('plan-diagram-panel-view');
    expect(activePlan()).toEqual({ planId: 'plan-1' });
  });

  it('Show document reopens a closed document without moving the diagram', async () => {
    const store = usePanelLayoutStore.getState();
    store.closeTab(KEY, 'group-plan', 'panel-plan-plan-1');
    const diagramGroup = store.splitGroup(KEY, 'group-chat', 'right', {
      kind: 'plan-diagram',
      panelId: 'panel-plan-diagram-plan-1',
      instance: { planId: 'plan-1' },
    });
    render(
      <PlanDiagramPanelHost
        {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
      />,
    );
    await flush();

    click('plan-diagram-show-document');
    await flush();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).not.toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')?.groupId).toBe(
      diagramGroup,
    );
  });

  it('applies node reveals made after it mounted, not earlier ones', async () => {
    usePlanViewStore.getState().acquire(VIEW_KEY);
    usePlanViewStore
      .getState()
      .requestDiagramReveal(VIEW_KEY, 'sequence', 'stale-node');
    usePanelLayoutStore.getState().splitGroup(KEY, 'group-plan', 'right', {
      kind: 'plan-diagram',
      panelId: 'panel-plan-diagram-plan-1',
      instance: { planId: 'plan-1' },
    });
    render(
      <PlanDiagramPanelHost
        {...hostProps({ panelId: 'panel-plan-diagram-plan-1' })}
      />,
    );
    await flush();

    expect(query('plan-explore-visualizer-panel')?.dataset.revealNode).toBe('');

    act(() => {
      revealPlanDiagramNode(
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        'plan-1',
        'logicDiff',
        'node-9',
      );
    });

    expect(query('plan-explore-visualizer-panel')?.dataset.revealNode).toBe(
      'node-9',
    );
  });
});
