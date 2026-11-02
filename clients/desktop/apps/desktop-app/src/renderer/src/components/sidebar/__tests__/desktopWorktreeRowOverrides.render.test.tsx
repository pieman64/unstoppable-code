/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeRowSlotContext } from '@canopy/ui-app';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type AppAdvisorWatcherSummary,
  type ScheduledActivity,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  chatStoreRenderView,
  useChatStore,
  type ChatTab,
} from '@/stores/chatStore';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useHooksStore } from '@/stores/hooksStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import {
  setDesktopRowLiveKeys,
  useDesktopWorktreeRowOverrides,
  type DesktopWorktreeRowLiveKeys,
} from '../desktopWorktreeRowOverrides';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/*
 * `useDesktopWorktreeRowOverrides` is the shared rail's per-row live-state
 * hook (see the module docstring in `desktopWorktreeRowOverrides.tsx`). It
 * previously had only pure-function coverage for its extracted derivations
 * (`deriveDesktopRowAttention`, `deriveWorktreeSplitRowStatus`); this file
 * exercises the HOOK itself: the fallback-to-snapshot branch, the plan-chat
 * unread subscription, hover/focus popover open + Escape-to-close, and (CAN-3053
 * finding 1) that the per-row store actually isolates re-renders between rows.
 */

type SnapshotWorktree = PortalSessionShellState['worktrees'][number];
type SnapshotWorkspace = PortalSessionShellState['workspaces'][number];

function makeTrackedPlan(
  projectId: string,
  worktreeId: string,
): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId,
    worktreeId,
    source: 'claude',
    title: 'Plan explore safety',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Plan',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
  };
}

function makeChatTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: 'Plan explore chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function makeKeys(
  partial: Partial<DesktopWorktreeRowLiveKeys> = {},
): DesktopWorktreeRowLiveKeys {
  return {
    statusByKey: new Map(),
    streaming: new Set(),
    awaitingApproval: new Set(),
    pendingQuestion: new Set(),
    toolApproval: new Set(),
    unread: new Set(),
    pipelineRunning: new Set(),
    pipelineUnseen: new Set(),
    pipelineUnseenFailed: new Set(),
    pipelinePaused: new Set(),
    backgroundTasks: new Map(),
    ...partial,
  };
}

function slotContext(
  workspaceLocalId: string,
  worktreeLocalId: string,
  workspaceType: SnapshotWorkspace['type'] = 'single-repo',
  worktreeOverrides: Partial<SnapshotWorktree> = {},
): WorktreeRowSlotContext {
  const workspace: SnapshotWorkspace = {
    localId: workspaceLocalId,
    name: workspaceLocalId,
    type: workspaceType,
  };
  const worktree: SnapshotWorktree = {
    localId: worktreeLocalId,
    workspaceLocalId,
    branch: 'main',
    ...worktreeOverrides,
  };
  return {
    workspace,
    worktree,
    selected: false,
    hidden: false,
    sortable: false,
    worktreeRemoval: undefined,
  };
}

interface RowProbe {
  overrides: ReturnType<typeof useDesktopWorktreeRowOverrides>;
  renderCount: number;
}

function Row({
  workspaceLocalId,
  worktreeLocalId,
  workspaceType,
  worktreeOverrides,
  probe,
}: {
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  readonly workspaceType?: SnapshotWorkspace['type'];
  readonly worktreeOverrides?: Partial<SnapshotWorktree>;
  readonly probe: RowProbe;
}): JSX.Element {
  probe.renderCount += 1;
  const overrides = useDesktopWorktreeRowOverrides(
    slotContext(
      workspaceLocalId,
      worktreeLocalId,
      workspaceType,
      worktreeOverrides,
    ),
  );
  probe.overrides = overrides;
  return (
    <span
      data-testid="row"
      tabIndex={0}
      onFocus={overrides?.onUnreadIconFocus}
      onBlur={overrides?.onUnreadIconBlur}
      onKeyDown={overrides?.onUnreadIconKeyDown}
    >
      {overrides?.unreadPopoverSlot}
    </span>
  );
}

function renderRows(
  rows: ReadonlyArray<{
    readonly workspaceLocalId: string;
    readonly worktreeLocalId: string;
    readonly workspaceType?: SnapshotWorkspace['type'];
    readonly worktreeOverrides?: Partial<SnapshotWorktree>;
    readonly probe: RowProbe;
  }>,
): { container: HTMLElement; root: Root; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <>
        {rows.map((row) => (
          <Row
            key={`${row.workspaceLocalId}/${row.worktreeLocalId}`}
            workspaceLocalId={row.workspaceLocalId}
            worktreeLocalId={row.worktreeLocalId}
            workspaceType={row.workspaceType}
            worktreeOverrides={row.worktreeOverrides}
            probe={row.probe}
          />
        ))}
      </>,
    );
  });
  return {
    container,
    root,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useDesktopWorktreeRowOverrides', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(makeKeys());
    useActivityStore.setState({ trackedPlans: {} });
    useChatStore.setState({ worktreeChats: {} });
  });

  it('leaves the row to its snapshot before any key sets are published (fallback branch)', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides).toBeUndefined();
    cleanup();
  });

  it('leaves the row to its snapshot when the store does not know it', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/other', 'idle']]) }),
    );
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides).toBeUndefined();
    cleanup();
  });

  it('overrides the row once the store knows it', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'working']]) }),
    );
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.uiStatus).toBe('working');
    cleanup();
  });

  it('folds a finished plan-explore chat into hasUnread even when the live unread set does not carry the row', () => {
    const key = 'workspace/a';
    useActivityStore.setState({
      trackedPlans: { [key]: [makeTrackedPlan('workspace', 'a')] },
    });
    useChatStore.setState({
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'tab-1',
          tabs: [makeChatTab('tab-1', { unread: true })],
        },
      },
    });
    setDesktopRowLiveKeys(makeKeys({ statusByKey: new Map([[key, 'idle']]) }));
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.hasUnread).toBe(true);
    cleanup();
  });

  it('opens the unread popover on focus and closes it on Escape', () => {
    setDesktopRowLiveKeys(
      makeKeys({
        statusByKey: new Map([['workspace/a', 'idle']]),
        unread: new Set(['workspace/a']),
      }),
    );
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { container, cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    const row = container.querySelector<HTMLElement>('[data-testid="row"]');
    expect(row).not.toBeNull();
    expect(probe.overrides?.unreadPopoverSlot).toBeUndefined();

    act(() => {
      row?.focus();
    });
    expect(probe.overrides?.unreadPopoverSlot).not.toBeUndefined();

    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(probe.overrides?.unreadPopoverSlot).toBeUndefined();

    cleanup();
  });
});

function ToolApprovalRow({ probe }: { readonly probe: RowProbe }): JSX.Element {
  probe.renderCount += 1;
  const overrides = useDesktopWorktreeRowOverrides(
    slotContext('workspace', 'a'),
  );
  probe.overrides = overrides;
  return (
    <span
      data-testid="tool-approval-dot"
      tabIndex={0}
      onFocus={overrides?.onToolApprovalIconFocus}
      onBlur={overrides?.onToolApprovalIconBlur}
    >
      {overrides?.toolApprovalPopoverSlot}
    </span>
  );
}

describe('useDesktopWorktreeRowOverrides tool-approval popover', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(
      makeKeys({
        statusByKey: new Map([['workspace/a', 'idle']]),
        toolApproval: new Set(['workspace/a']),
      }),
    );
    useChatStore.setState({
      worktreeChats: {},
      pendingApprovals: {
        'req-1': {
          requestId: 'req-1',
          projectId: 'workspace',
          worktreeId: 'a',
          chatId: 'chat-1',
          provider: 'claude',
          title: 'Run a command',
          details: { kind: 'command', command: 'npm run build' },
        },
      },
    });
  });

  afterEach(() => {
    useChatStore.setState({ worktreeChats: {}, pendingApprovals: {} });
  });

  // The approval can arrive before the worktree's chats hydrate (an unopened
  // worktree, or startup hydration still in flight). A popover opened in that
  // window must pick up the chat's title once it lands instead of naming the
  // placeholder for as long as it stays open.
  it('names the blocked chat once its worktree hydrates while the popover is open', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<ToolApprovalRow probe={probe} />);
    });
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="tool-approval-dot"]',
    );

    act(() => {
      dot?.focus();
    });
    expect(document.body.textContent).toContain('Approval needed');
    expect(document.body.textContent).toContain('New Chat');

    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'workspace/a': {
            activeTabId: 'chat-1',
            tabs: [
              makeChatTab('chat-1', {
                title: 'Approval Blocked',
                providerType: 'claude',
              }),
            ],
          },
        },
      });
    });

    expect(document.body.textContent).toContain('Approval Blocked');
    expect(document.body.textContent).not.toContain('New Chat');
    expect(document.body.textContent).toContain('npm run build');

    act(() => root.unmount());
    container.remove();
  });

  // Following the store is scoped to the open popover: a closed one must not
  // pay for streaming updates, and closing it must drop its listener.
  it('subscribes to the chat store only while the popover is open', () => {
    const originalSubscribe = chatStoreRenderView.subscribe;
    const unsubscribes: jest.Mock[] = [];
    const subscribeSpy = jest
      .spyOn(chatStoreRenderView, 'subscribe')
      .mockImplementation((listener) => {
        const unsubscribe = jest.fn(originalSubscribe(listener));
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      });
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(<ToolApprovalRow probe={probe} />);
      });
      const dot = container.querySelector<HTMLElement>(
        '[data-testid="tool-approval-dot"]',
      );
      // Other store readers on the row subscribe at mount; count from here.
      const subscriptionsWhileClosed = subscribeSpy.mock.calls.length;

      act(() => {
        dot?.focus();
      });
      expect(subscribeSpy.mock.calls.length).toBe(subscriptionsWhileClosed + 1);
      const popoverUnsubscribe = unsubscribes[subscriptionsWhileClosed];
      expect(popoverUnsubscribe).not.toHaveBeenCalled();

      act(() => {
        dot?.blur();
      });
      expect(popoverUnsubscribe).toHaveBeenCalledTimes(1);
      expect(subscribeSpy.mock.calls.length).toBe(subscriptionsWhileClosed + 1);
    } finally {
      act(() => root.unmount());
      container.remove();
      subscribeSpy.mockRestore();
    }
  });
});

describe('useDesktopWorktreeRowOverrides per-row render isolation (CAN-3053 finding 1)', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(makeKeys());
  });

  it('does not re-render row B when only row A publishes a new status', () => {
    setDesktopRowLiveKeys(
      makeKeys({
        statusByKey: new Map([
          ['workspace/a', 'idle'],
          ['workspace/b', 'idle'],
        ]),
      }),
    );
    const probeA: RowProbe = { overrides: undefined, renderCount: 0 };
    const probeB: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe: probeA },
      { workspaceLocalId: 'workspace', worktreeLocalId: 'b', probe: probeB },
    ]);
    expect(probeA.renderCount).toBe(1);
    expect(probeB.renderCount).toBe(1);

    act(() => {
      setDesktopRowLiveKeys(
        makeKeys({
          statusByKey: new Map([
            ['workspace/a', 'working'],
            ['workspace/b', 'idle'],
          ]),
        }),
      );
    });

    expect(probeA.overrides?.uiStatus).toBe('working');
    expect(probeA.renderCount).toBe(2);
    // Row B's own derived attention is unchanged, so it must not re-render
    // even though the published store object itself is a new reference.
    expect(probeB.renderCount).toBe(1);

    cleanup();
  });
});

function scheduledActivity(
  worktreeId: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: `automation-${worktreeId}`,
    name: 'Scheduled message',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2026-06-05T13:00:00.000Z',
      timezone: 'local',
    },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'workspace',
      worktreeId,
      chatId: 'chat',
      prompt: 'hello',
    },
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    nextRunAt: '2026-06-05T13:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

describe('useDesktopWorktreeRowOverrides automations subscription (CAN-3053 finding 5)', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'idle']]) }),
    );
    useAutomationsStore.setState({ activities: [] });
  });

  it('does not re-render when an unrelated worktree gains a schedule', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.renderCount).toBe(1);
    expect(probe.overrides?.hasScheduledMessages).toBe(false);

    act(() => {
      useAutomationsStore.setState({
        activities: [scheduledActivity('other')],
      });
    });

    // A new `activities` array reference, but this row's own boolean is
    // unchanged, so the per-row selector must not trigger a re-render.
    expect(probe.renderCount).toBe(1);

    act(() => {
      useAutomationsStore.setState({
        activities: [scheduledActivity('other'), scheduledActivity('a')],
      });
    });

    expect(probe.renderCount).toBe(2);
    expect(probe.overrides?.hasScheduledMessages).toBe(true);

    cleanup();
  });
});

describe('useDesktopWorktreeRowOverrides (attempt-3 correctness fixes)', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(makeKeys());
  });

  // Finding 1: `splitStatus`/`splitStatusMessage` were unconditionally spread
  // into the override object even when there was no active split lock or
  // session (`split.splitStatus === undefined`), so the KEY was present with
  // an `undefined` value — which clobbers the snapshot's own split status
  // (derived by `projectWorktreeRuntime()` from the main-owned
  // `worktree.splitPrStatus`/`splitPrStatusMessage`) the moment live keys
  // publish. The override must OMIT the key entirely when it has no opinion,
  // the same "key presence" rule `setupPhase`/`lastKnownPrStatus` follow.
  it('does not carry splitStatus/splitStatusMessage keys when there is no active split lock or session', () => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'idle']]) }),
    );
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides).toBeDefined();
    expect(probe.overrides ? 'splitStatus' in probe.overrides : true).toBe(
      false,
    );
    expect(
      probe.overrides ? 'splitStatusMessage' in probe.overrides : true,
    ).toBe(false);
    cleanup();
  });

  // Finding 2: the snapshot applies a deliberate "done" fallback
  // (`isWorktreeDone`) that the live model's own, stricter status check does
  // not replicate. Once live keys publish for a row the snapshot marks done,
  // the live override must not un-mark it.
  it('keeps a snapshot-done row done once live keys publish a non-done status for it', () => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'working']]) }),
    );
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      {
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'a',
        worktreeOverrides: { status: 'done' },
        probe,
      },
    ]);
    expect(probe.overrides?.uiStatus).toBe('done');
    expect(probe.overrides?.runtimeState).toBe('done');
    cleanup();
  });

  it('leaves a non-done row alone when the live status is not done either', () => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'working']]) }),
    );
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.uiStatus).toBe('working');
    expect(probe.overrides?.runtimeState).toBeUndefined();
    cleanup();
  });
});

// CAN-3053 attempt-3 finding 5: the watcher, script, hook and graph-build
// override wiring previously had no coverage that actually drove
// `useDesktopWorktreeRowOverrides` end to end through each source store —
// only the pure derivations were covered. One test per source, each of which
// fails if that store's selector is removed from the hook.
describe('useDesktopWorktreeRowOverrides live-source wiring (CAN-3053 finding 5)', () => {
  beforeEach(() => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'idle']]) }),
    );
    useAppAdvisorWatchersStore.setState({ watchers: [] });
    useScriptsStore.setState({ runs: {} });
    useHooksStore.setState({ runs: {} });
    useCodeGraphBuildStore.setState({ building: {} });
  });

  it('flags hasIdleWatcherChats once an active watcher targets this row', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.hasIdleWatcherChats).toBe(false);

    const watcher: AppAdvisorWatcherSummary = {
      id: 'watcher-1',
      trigger: 'worktree_pipeline_completion',
      status: 'active',
      label: 'Watcher 1',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'workspace',
        worktreeId: 'a',
      },
      destination: {
        projectId: 'workspace',
        worktreeId: 'a',
        chatId: 'chat-1',
        chatTitle: 'Saved chat',
      },
      createdAt: '2026-08-04T12:00:00.000Z',
    };
    act(() => {
      useAppAdvisorWatchersStore.setState({ watchers: [watcher] });
    });

    expect(probe.overrides?.hasIdleWatcherChats).toBe(true);
    cleanup();
  });

  it('reports scriptStatus "running" once the scripts store carries an active run for this row', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.scriptStatus).toBeUndefined();

    act(() => {
      useScriptsStore.setState({
        runs: {
          'workspace/a': {
            'project:launch': {
              label: 'Launch',
              scriptName: 'launch',
              lifecycle: 'launch',
              command: 'npm run dev',
              target: 'project',
              status: 'running',
              outputLines: [],
              exitCode: null,
              timedOut: false,
              durationMs: 0,
              startedAt: Date.now(),
              devServerHits: [],
            },
          },
        },
      });
    });

    expect(probe.overrides?.scriptStatus).toBe('running');
    cleanup();
  });

  it('reports hookStatus "running" once the hooks store carries an active run for this row', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.hookStatus).toBeUndefined();

    act(() => {
      useHooksStore.setState({
        runs: {
          'workspace/a': {
            'project:pr:create': {
              label: 'PR Created',
              triggerName: 'pr:create',
              actions: [{ type: 'command', command: 'echo hello' }],
              target: 'project',
              status: 'running',
              outputLines: [],
              exitCode: null,
              timedOut: false,
              durationMs: 0,
              startedAt: Date.now(),
            },
          },
        },
      });
    });

    expect(probe.overrides?.hookStatus).toBe('running');
    cleanup();
  });

  it('reports graphBuildStatus "building" once the code-graph build store marks this row building', () => {
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(probe.overrides?.graphBuildStatus).toBeUndefined();

    act(() => {
      useCodeGraphBuildStore.setState({ building: { 'workspace/a': true } });
    });

    expect(probe.overrides?.graphBuildStatus).toBe('building');
    cleanup();
  });
});

describe('useDesktopWorktreeRowOverrides PR precedence (CAN-3053 finding 8)', () => {
  const originalGitHubState = useGitHubStore.getState();

  beforeEach(() => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'idle']]) }),
    );
    useGitHubStore.setState({
      prStatuses: {},
      livePrStatusWorktreeKeys: new Set(),
      creatingPr: new Set(),
      mergingPr: new Set(),
    });
  });

  afterAll(() => {
    useGitHubStore.setState(originalGitHubState);
  });

  it('keeps the snapshot badge for a hydration-only null (not a live-confirmed none)', () => {
    // `hydratePersistedPrStatuses` writes `null` wholesale from the
    // renderer's own possibly-stale `lastKnownPrStatus` copy; that must NOT
    // be treated as a live-confirmed "no PR" that clears the row's badge.
    useGitHubStore.setState({
      prStatuses: { 'workspace/a': null },
      livePrStatusWorktreeKeys: new Set(),
    });
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(
      probe.overrides ? 'lastKnownPrStatus' in probe.overrides : undefined,
    ).toBe(false);
    cleanup();
  });

  it('clears the badge once the store live-confirms no PR for this row', () => {
    useGitHubStore.setState({
      prStatuses: { 'workspace/a': null },
      livePrStatusWorktreeKeys: new Set(['workspace/a']),
    });
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      { workspaceLocalId: 'workspace', worktreeLocalId: 'a', probe },
    ]);
    expect(
      probe.overrides ? 'lastKnownPrStatus' in probe.overrides : undefined,
    ).toBe(true);
    expect(probe.overrides?.lastKnownPrStatus).toBeUndefined();
    cleanup();
  });
});

describe('useDesktopWorktreeRowOverrides branch-label precedence (CAN-3053 finding 11)', () => {
  const originalProjects = useProjectsStore.getState().projects;
  const originalRepoBranches = useProjectsStore.getState().repoBranches;

  beforeEach(() => {
    setDesktopRowLiveKeys(
      makeKeys({ statusByKey: new Map([['workspace/a', 'idle']]) }),
    );
  });

  afterAll(() => {
    useProjectsStore.setState({
      projects: originalProjects,
      repoBranches: originalRepoBranches,
    });
  });

  it('lets a user-set label win over "Multiple branches" for a divergent multi-repo row', () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace',
          type: 'multi-repo',
          name: 'Workspace',
          color: '#2563eb',
          repos: [],
          collapsed: false,
          order: 0,
          scripts: {},
          effectiveScripts: {},
          hooks: {},
          effectiveHooks: {},
          worktrees: [
            {
              id: 'a',
              branchName: 'main',
              createdAt: '2026-01-01T00:00:00.000Z',
              label: 'My custom label',
            },
          ],
        },
      ],
      repoBranches: {
        'workspace/a': [
          { repoId: 'repo-1', repoName: 'repo-1', branch: 'main' },
          { repoId: 'repo-2', repoName: 'repo-2', branch: 'feature/web' },
        ],
      },
    });
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      {
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'a',
        workspaceType: 'multi-repo',
        probe,
      },
    ]);
    // The override must not force "Multiple branches" over the user's own
    // label — no `branchLabel` opinion at all, so the row falls back to the
    // snapshot's label, which the sidebar projection fills from
    // `worktree.label` (the same user-set custom label).
    expect(probe.overrides ? 'branchLabel' in probe.overrides : undefined).toBe(
      false,
    );
    expect(probe.overrides?.branchLabel).not.toBe('Multiple branches');
    cleanup();
  });

  it('shows "Multiple branches" for the same divergent repos once the user label is cleared', () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace',
          type: 'multi-repo',
          name: 'Workspace',
          color: '#2563eb',
          repos: [],
          collapsed: false,
          order: 0,
          scripts: {},
          effectiveScripts: {},
          hooks: {},
          effectiveHooks: {},
          worktrees: [
            {
              id: 'a',
              branchName: 'main',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
      repoBranches: {
        'workspace/a': [
          { repoId: 'repo-1', repoName: 'repo-1', branch: 'main' },
          { repoId: 'repo-2', repoName: 'repo-2', branch: 'feature/web' },
        ],
      },
    });
    const probe: RowProbe = { overrides: undefined, renderCount: 0 };
    const { cleanup } = renderRows([
      {
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'a',
        workspaceType: 'multi-repo',
        probe,
      },
    ]);
    expect(probe.overrides?.branchLabel).toBe('Multiple branches');
    cleanup();
  });
});
