/** @jest-environment jsdom */
import {
  collectLoadedSubagentInputs,
  loadedSubagentSummary,
} from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CodexAgentCallBlock,
  DelegatedAgentCallBlock,
  SubagentTree,
} from '@canopy/agent-transcript';
import { buildSubagentTree } from '@canopy/agent-transcript';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { LifetimeLimitState } from '@canopy/app-state/delegation/lifetime-limit-store';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { LifetimeLimitNoticeProps } from '@canopy/ui-app';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type {
  ManagedDelegationRootEntry,
  ManagedDelegationTreeEntry,
} from '@canopy/desktop-shared/types';
import {
  useSubagentComposerStore,
  useSubagentViewStateStore,
  type SubagentViewerCapabilities,
} from '@canopy/ui-app/subagents';
import {
  useChatStore,
  type ChatMessage,
  type ChatTab,
} from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useActivityStore } from '@/stores/activityStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import { DesktopSubagentsPanelHost } from '../DesktopSubagentsPanelHost';
import { resetSubagentTreeStoreForTests } from '../subagent-tree-store';
import { resetSubagentRootChatsForTests } from '../useSubagentRootChats';
import { createSubagentViewStatePersistence } from '../subagent-view-state-persistence';
import {
  buildDesktopSubagentTreeInput,
  subagentTreeInputFingerprint,
} from '../subagent-tree-input';
import type { SubagentTreeQuery } from '../useSubagentTree';
import { useSubagentTree } from '../useSubagentTree';
import { useSubagentRootChats } from '../useSubagentRootChats';
import type { SubagentHostScope } from '../subagent-scope';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';

let mockLifetimeState: LifetimeLimitState = {
  entries: {},
  load: jest.fn(() => Promise.resolve()),
  extend: jest.fn(() => Promise.resolve()),
};
const mockLifetimeNotice = jest.fn(
  (props: LifetimeLimitNoticeProps): JSX.Element => {
    void props;
    return <div data-testid="lifetime-panel-mount" />;
  },
);
jest.mock('@canopy/ui-app', () => ({
  LifetimeLimitNotice: (props: LifetimeLimitNoticeProps): JSX.Element =>
    mockLifetimeNotice(props),
}));
jest.mock('@canopy/app-state/delegation/lifetime-limit-store', () => ({
  ...jest.requireActual<object>(
    '@canopy/app-state/delegation/lifetime-limit-store',
  ),
  useLifetimeLimitStore: <T,>(selector: (state: LifetimeLimitState) => T): T =>
    selector(mockLifetimeState),
}));
jest.mock('@canopy/app-state/CanopyClientProvider', () => ({
  ...jest.requireActual<object>('@canopy/app-state/CanopyClientProvider'),
  useWorkspaceCapabilities: (): CanopyCapabilities => ({
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'crud-only',
    routing: 'url',
    overviewNotifications: false,
    delegationLifetimeLimitExtension: true,
  }),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock(
  '../SubagentChangesDialog',
  (): Record<string, unknown> => ({
    SubagentChangesDialog: jest.fn((): null => null),
  }),
  { virtual: true },
);
jest.mock('../subagent-capabilities', () => ({
  useSubagentViewerCapabilities: (): SubagentViewerCapabilities => ({
    stop: true,
    messaging: true,
    worktreeDetails: true,
    nativeInterrupt: true,
    openWorkflow: true,
    stopWorkflow: true,
  }),
}));
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: jest.fn(
    (): Promise<{ status: 'placed' }> => Promise.resolve({ status: 'placed' }),
  ),
  openSubagentsPanel: jest.fn(
    (): Promise<{ status: 'placed' }> => Promise.resolve({ status: 'placed' }),
  ),
}));

const SCOPE: SubagentHostScope = {
  projectId: 'viewer-project',
  worktreeId: 'viewer-worktree',
};
const SCOPE_KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;
const ROOT_ID = 'root-chat';
const mountedRoots: Root[] = [];

interface TreeProbe {
  current: SubagentTreeQuery | null;
}

interface RootChatsProbe {
  current: ReturnType<typeof useSubagentRootChats> | null;
}

function snapshot(
  delegationId: string,
  status: AgentDelegationSnapshot['status'],
  parentDelegationId?: string,
): AgentDelegationSnapshot {
  return {
    delegationId,
    status,
    outputTruncated: false,
    ...(parentDelegationId ? { parentDelegationId } : {}),
  };
}

function managedBlock(
  delegationId: string,
  status: AgentDelegationSnapshot['status'] = 'running',
  parentDelegationId?: string,
  generation = 1,
  sequence = 1,
): DelegatedAgentCallBlock {
  return {
    ...snapshot(delegationId, status, parentDelegationId),
    type: 'delegated_agent_call',
    agentBlockId: `managed-block-${delegationId}`,
    runGeneration: generation,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn-1',
    parentToolCallId: 'tool-1',
    createdAt: 20,
    selectedModelId: 'model-1',
    runtimeModelId: 'model-1',
    targetHarnessId: 'claude',
    description: `Task ${delegationId}`,
    prompt: `Prompt ${delegationId}`,
    executionMode: 'background',
  };
}

function codexBlock(
  agentBlockId: string,
  senderThreadId: string,
  receiverThreadIds: string[],
  status = 'inProgress',
): CodexAgentCallBlock {
  const agentsStates: CodexAgentCallBlock['agentsStates'] = {};
  for (const threadId of receiverThreadIds) {
    agentsStates[threadId] = { status: 'running' };
  }
  return {
    type: 'codex_agent_call',
    agentBlockId,
    callId: agentBlockId,
    tool: 'spawnAgent',
    status,
    senderThreadId,
    receiverThreadIds,
    prompt: 'Review the code',
    agentsStates,
    receiverAgents: Object.fromEntries(
      receiverThreadIds.map((threadId) => [threadId, { nickname: threadId }]),
    ),
  };
}

function chatMessage(
  id: string,
  blocks: ChatMessage['blocks'],
  timestamp: number,
  parent: Pick<
    ChatMessage,
    'parentBlockId' | 'parentToolUseId' | 'codexThreadId'
  > = {},
): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp,
    ...parent,
  };
}

function makeChatTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    createdAt: '2026-10-06T00:00:00.000Z',
    messages: [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function rootEntry(
  chatId: string,
  total: number,
  live: number,
  lastActivityAt = 100,
): ManagedDelegationRootEntry {
  return { chatId, total, live, lastActivityAt };
}

function treeEntry(
  delegationId: string,
  status: AgentDelegationSnapshot['status'] = 'running',
): ManagedDelegationTreeEntry {
  return {
    snapshot: snapshot(delegationId, status),
    description: `Task ${delegationId}`,
    prompt: `Prompt ${delegationId}`,
    executionMode: 'background',
    runGeneration: 1,
    sequence: 1,
    createdAt: 20,
    parentHarnessId: 'claude',
  };
}

function installApi(
  options: {
    readonly tree?: jest.Mock;
    readonly roots?: jest.Mock;
    readonly stop?: jest.Mock;
  } = {},
): void {
  const tree =
    options.tree ?? jest.fn(() => Promise.resolve({ ok: true, entries: [] }));
  const roots = options.roots ?? jest.fn(() => Promise.resolve([]));
  const stop = options.stop ?? jest.fn(() => Promise.resolve({ ok: true }));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedDelegation: { tree, roots, stop },
      activity: {
        startOutputPolling: jest.fn(() => Promise.resolve()),
        stopOutputPolling: jest.fn(() => Promise.resolve()),
      },
    },
  });
}

function TreeProbeHarness({
  probe,
  enabled,
}: {
  readonly probe: TreeProbe;
  readonly enabled: boolean;
}): JSX.Element {
  probe.current = useSubagentTree(SCOPE, ROOT_ID, { enabled });
  return <></>;
}

function RootChatsProbeHarness({
  probe,
  enabled,
}: {
  readonly probe: RootChatsProbe;
  readonly enabled: boolean;
}): JSX.Element {
  probe.current = useSubagentRootChats(SCOPE, { enabled });
  return <></>;
}

function mount(element: JSX.Element): {
  readonly container: HTMLElement;
  unmount(): void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(element));
  return {
    container,
    unmount: (): void => act(() => root.unmount()),
  };
}

function clickTestId(testId: string): void {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing element: ${testId}`);
  act(() => element.click());
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setOpenTabs(tabs: readonly ChatTab[]): void {
  hydratedKeys.add(SCOPE_KEY);
  useChatStore.setState({
    worktreeChats: {
      [SCOPE_KEY]: { tabs: [...tabs], activeTabId: tabs[0]?.id ?? '' },
    },
  });
}

beforeEach(() => {
  mockLifetimeState = { ...mockLifetimeState, entries: {} };
  mockLifetimeNotice.mockClear();
  jest.mocked(useCurrentUiStateReporter).mockClear();
  installApi();
  useChatStore.setState(useChatStore.getInitialState());
  useDelegationActivityStore.getState().reset();
  useActivityStore.setState({ bgProcesses: {} });
  useSubagentViewStateStore.setState(
    useSubagentViewStateStore.getInitialState(),
  );
  useSubagentComposerStore.setState(useSubagentComposerStore.getInitialState());
  resetSubagentTreeStoreForTests();
  resetSubagentRootChatsForTests();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  hydratedKeys.delete(SCOPE_KEY);
  useChatStore.setState(useChatStore.getInitialState());
  useDelegationActivityStore.getState().reset();
  useSubagentViewStateStore.setState(
    useSubagentViewStateStore.getInitialState(),
  );
  useSubagentComposerStore.setState(useSubagentComposerStore.getInitialState());
  resetSubagentTreeStoreForTests();
  resetSubagentRootChatsForTests();
  document.body.replaceChildren();
  jest.useRealTimers();
});

describe('desktop subagent viewer adapters', () => {
  it('mounts the lifetime panel placement using the trusted IPC scope ids', () => {
    installApi({});
    mockLifetimeNotice.mockClear();
    const mounted = mount(
      <DesktopSubagentsPanelHost scope={SCOPE} isVisible isActive />,
    );
    expect(mockLifetimeNotice).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      placement: 'panel',
    });
    expect(
      mounted.container.querySelectorAll(
        '[data-testid="lifetime-panel-mount"]',
      ),
    ).toHaveLength(1);
  });

  it.each(['none', 'full', 'full_at_cap', 'unavailable'] as const)(
    'reports sanitized Advisor lifetime state %s',
    (notice) => {
      installApi({});
      const status =
        notice === 'unavailable'
          ? { kind: 'unavailable' as const, reason: 'uncertain' as const }
          : {
              kind: 'available' as const,
              occupied: notice === 'none' ? 511 : 512,
              retained: 511,
              limit: 512,
              cap: notice === 'full_at_cap' ? 512 : 1024,
              atLimit: notice !== 'none',
              atCap: notice === 'full_at_cap',
              canExtend: notice !== 'full_at_cap',
              refusedChatIds: ['private-chat-id'],
            };
      mockLifetimeState = {
        ...mockLifetimeState,
        entries: {
          '["project-one","worktree-one"]': {
            status,
            loading: false,
            extension: 'idle',
          },
        },
      };
      // Scope is intentionally not encoded using the production key helper.
      const scope = { projectId: 'project-one', worktreeId: 'worktree-one' };
      mount(<DesktopSubagentsPanelHost scope={scope} isVisible isActive />);
      expect(useCurrentUiStateReporter).toHaveBeenCalledWith(
        'subagents.lifetimeLimit',
        {
          ...scope,
          notice,
          atLimit: notice === 'unavailable' ? null : notice !== 'none',
          limit: notice === 'unavailable' ? null : 512,
          canExtend: notice !== 'unavailable' && notice !== 'full_at_cap',
        },
      );
      expect(
        JSON.stringify(jest.mocked(useCurrentUiStateReporter).mock.calls),
      ).not.toContain('private-chat-id');
    },
  );

  it('does not mount or report a lifetime allowance for App Advisor', () => {
    installApi({});
    mockLifetimeNotice.mockClear();
    jest.mocked(useCurrentUiStateReporter).mockClear();
    mount(
      <DesktopSubagentsPanelHost
        scope={{ projectId: 'app-advisor', worktreeId: 'entry' }}
        isVisible
        isActive
      />,
    );
    expect(mockLifetimeNotice).not.toHaveBeenCalled();
    expect(
      jest
        .mocked(useCurrentUiStateReporter)
        .mock.calls.filter(([key]) => key === 'subagents.lifetimeLimit'),
    ).toEqual([]);
  });

  it('collects mixed nested sources and retains run identity from the transcript', () => {
    const managedRoot = managedBlock('managed-root');
    const managedChild = managedBlock(
      'managed-child',
      'running',
      'managed-root',
    );
    const managedInsideClaude = managedBlock('managed-inside-claude');
    const codexOuter = codexBlock('codex-outer-block', 'root-thread', [
      'codex-outer',
    ]);
    const messages: ChatMessage[] = [
      chatMessage(
        'root',
        [
          managedRoot,
          {
            type: 'tool_use',
            toolUseId: 'claude-root',
            toolName: 'Task',
            input: JSON.stringify({
              subagent_type: 'Plan',
              description: 'Plan',
              prompt: 'Plan work',
            }),
          },
          codexOuter,
        ],
        10,
      ),
      chatMessage(
        'managed-child-message',
        [
          managedChild,
          {
            type: 'tool_use',
            toolUseId: 'claude-inside-managed',
            toolName: 'Task',
            input: JSON.stringify({
              subagent_type: 'Explore',
              description: 'Explore',
              prompt: 'Inspect',
            }),
          },
          codexBlock('codex-inside-managed-block', 'provider-thread', [
            'codex-inside-managed',
          ]),
        ],
        20,
        { parentBlockId: managedRoot.agentBlockId },
      ),
      chatMessage(
        'claude-child-message',
        [
          managedInsideClaude,
          codexBlock('codex-inside-claude-block', 'provider-thread', [
            'codex-inside-claude',
          ]),
        ],
        30,
        { parentToolUseId: 'claude-inside-managed' },
      ),
      chatMessage(
        'codex-child-message',
        [
          codexBlock('codex-inside-codex-block', 'codex-outer', [
            'codex-inside-codex',
          ]),
        ],
        40,
        {
          parentBlockId: codexOuter.agentBlockId,
          codexThreadId: 'codex-outer',
        },
      ),
      chatMessage(
        'transient-codex-message',
        [codexBlock('transient-spawn', 'root-thread', [], 'inProgress')],
        50,
      ),
    ];
    const loaded = collectLoadedSubagentInputs(messages);
    const ipcEntry = {
      ...treeEntry('managed-root'),
      runGeneration: managedRoot.runGeneration,
      sequence: managedRoot.sequence,
    };
    const input = buildDesktopSubagentTreeInput({
      root: { id: ROOT_ID, title: 'Root chat' },
      managedEntries: [ipcEntry],
      loaded,
    });
    const tree = buildSubagentTreeForInput(input);

    expect(input.complete).toBe(true);
    expect(loaded.managed.map((entry) => entry.delegationId)).toEqual([
      'managed-root',
      'managed-child',
      'managed-inside-claude',
    ]);
    expect(loaded.claudeNative).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolUseId: 'claude-root', parentId: null }),
        expect.objectContaining({
          toolUseId: 'claude-inside-managed',
          parentId: 'managed-root',
        }),
      ]),
    );
    expect(loaded.codexNative).toHaveLength(4);
    expect(
      loaded.codexNative.find(
        (entry) => entry.callId === 'codex-inside-managed-block',
      )?.senderThreadId,
    ).toBe('managed-root');
    expect(
      loaded.codexNative.find(
        (entry) => entry.callId === 'codex-inside-claude-block',
      )?.senderThreadId,
    ).toBe('claude-inside-managed');
    expect(
      loaded.codexNative.find(
        (entry) => entry.callId === 'codex-inside-codex-block',
      )?.senderThreadId,
    ).toBe('codex-outer');
    expect(tree.nodes.get('managed-child')?.parentId).toBe('managed-root');
    expect(tree.nodes.get('managed-inside-claude')?.parentId).toBe(
      'claude-inside-managed',
    );
    expect(tree.nodes.get('codex-inside-managed')?.parentId).toBe(
      'managed-root',
    );
    expect(tree.nodes.get('codex-inside-claude')?.parentId).toBe(
      'claude-inside-managed',
    );
    expect(tree.nodes.get('codex-inside-codex')?.parentId).toBe('codex-outer');
    expect(tree.nodes.get('managed-root')?.runs[0]?.agentBlockId).toBe(
      managedRoot.agentBlockId,
    );

    const failedFallback = buildDesktopSubagentTreeInput({
      root: { id: ROOT_ID, title: 'Root chat' },
      managedEntries: null,
      loaded,
    });
    expect(failedFallback.complete).toBe(false);
    expect(
      buildDesktopSubagentTreeInput({
        root: { id: ROOT_ID, title: 'Root chat' },
        managedEntries: [],
        loaded,
      }).complete,
    ).toBe(true);
  });

  it('keeps the fingerprint stable for unrelated transcript text churn', () => {
    const call = managedBlock('fingerprint-managed');
    const before = collectLoadedSubagentInputs([
      chatMessage('root', [{ type: 'text', text: 'partial' }, call], 10),
    ]);
    const after = collectLoadedSubagentInputs([
      chatMessage(
        'root',
        [{ type: 'text', text: 'partial response continues' }, call],
        10,
      ),
    ]);
    const makeInput = (
      loaded: ReturnType<typeof collectLoadedSubagentInputs>,
    ): ReturnType<typeof buildDesktopSubagentTreeInput> =>
      buildDesktopSubagentTreeInput({
        root: { id: ROOT_ID, title: 'Root chat' },
        managedEntries: [],
        loaded,
      });

    expect(subagentTreeInputFingerprint(makeInput(before))).toBe(
      subagentTreeInputFingerprint(makeInput(after)),
    );
  });

  it('builds a native root-picker summary with distinct agent counts', () => {
    const summary = loadedSubagentSummary([
      chatMessage(
        'native-root',
        [
          {
            type: 'tool_use',
            toolUseId: 'claude-task',
            toolName: 'Task',
            input: JSON.stringify({
              run_in_background: true,
              description: 'Task',
            }),
          },
          codexBlock('codex-root', 'root-thread', ['codex-task']),
        ],
        99,
      ),
      chatMessage(
        'codex-followup',
        [codexBlock('codex-followup', 'root-thread', ['codex-task'])],
        100,
      ),
    ]);

    expect(summary).toEqual({
      hasNativeAgentBlocks: true,
      total: 2,
      live: 2,
      lastActivityAt: 100,
    });
  });

  it('gives a failed Claude agent its failure text as the node error', () => {
    const messages = [
      chatMessage(
        'dispatch',
        [
          {
            type: 'tool_use',
            toolUseId: 'failing-task',
            toolName: 'Agent',
            input: JSON.stringify({ description: 'Fix the test' }),
          },
          {
            type: 'tool_use',
            toolUseId: 'passing-task',
            toolName: 'Agent',
            input: JSON.stringify({ description: 'Read the docs' }),
          },
        ],
        10,
      ),
      chatMessage(
        'results',
        [
          {
            type: 'tool_result',
            toolUseId: 'failing-task',
            toolName: 'Agent',
            output: '  Could not make the test pass.\n',
            isError: true,
          },
          {
            type: 'tool_result',
            toolUseId: 'passing-task',
            toolName: 'Agent',
            output: 'Docs read.',
            isError: false,
          },
        ],
        11,
      ),
    ];
    const tree = buildSubagentTree({
      root: { id: ROOT_ID, title: 'Root' },
      ...collectLoadedSubagentInputs(messages),
    });
    expect(tree.nodes.get('failing-task')).toMatchObject({
      status: 'failed',
      errorMessage: 'Could not make the test pass.',
    });
    expect(tree.nodes.get('passing-task')?.errorMessage).toBeUndefined();
  });

  it('settles a background Claude agent when it finishes, not at its launch receipt', () => {
    const dispatch = (toolUseId: string, timestamp: number): ChatMessage =>
      chatMessage(
        `${toolUseId}-dispatch`,
        [
          {
            type: 'tool_use',
            toolUseId,
            toolName: 'Agent',
            input: JSON.stringify({
              run_in_background: true,
              description: toolUseId,
            }),
          },
        ],
        timestamp,
      );
    const result = (
      toolUseId: string,
      output: string,
      timestamp: number,
    ): ChatMessage =>
      chatMessage(
        `${toolUseId}-${timestamp}`,
        [
          {
            type: 'tool_result',
            toolUseId,
            toolName: 'Agent',
            output,
            isError: false,
          },
        ],
        timestamp,
      );
    const messages = [
      dispatch('watched', 10),
      result('watched', 'Async agent launched successfully. agentId: a1', 11),
      dispatch('polled', 20),
      result('polled', 'Async agent launched successfully. agentId: b2', 21),
      chatMessage(
        'poll',
        [
          {
            type: 'tool_use',
            toolUseId: 'poll-output',
            toolName: 'TaskOutput',
            input: JSON.stringify({ task_id: 'b2' }),
          },
        ],
        40,
      ),
      chatMessage(
        'poll-result',
        [
          {
            type: 'tool_result',
            toolUseId: 'poll-output',
            toolName: 'TaskOutput',
            output: 'Done polling.',
            isError: false,
          },
        ],
        45,
      ),
    ];
    const settledAt = (
      options: Parameters<typeof collectLoadedSubagentInputs>[1],
    ): Record<string, number | undefined> =>
      Object.fromEntries(
        collectLoadedSubagentInputs(messages, options).claudeNative.map(
          (input) => [input.toolUseId, input.settledAt],
        ),
      );

    expect(
      settledAt({
        backgroundStatusFor: () => 'completed',
        backgroundSettledAtFor: (toolUseId) =>
          toolUseId === 'watched' ? 30 : undefined,
      }),
    ).toEqual({ watched: 30, polled: 45 });
    expect(settledAt({ backgroundStatusFor: () => 'completed' })).toEqual({
      watched: undefined,
      polled: 45,
    });
  });

  it('counts a background Claude task as live only while its process runs', () => {
    const messages = [
      chatMessage(
        'background-dispatch',
        [
          {
            type: 'tool_use',
            toolUseId: 'background-task',
            toolName: 'Task',
            input: JSON.stringify({
              run_in_background: true,
              description: 'Task',
            }),
          },
        ],
        10,
      ),
      chatMessage(
        'background-ack',
        [
          {
            type: 'tool_result',
            toolUseId: 'background-task',
            toolName: 'Task',
            output: 'Async agent launched successfully. agentId: abc-123',
            isError: false,
          },
        ],
        11,
      ),
    ];
    expect(loadedSubagentSummary(messages).live).toBe(1);
    expect(
      loadedSubagentSummary(messages, (toolUseId) =>
        toolUseId === 'background-task' ? 'completed' : undefined,
      ).live,
    ).toBe(0);
    expect(loadedSubagentSummary(messages, () => 'running').live).toBe(1);
  });

  it('deduplicates tree reads across consumers and coalesces activity refreshes', async () => {
    jest.useFakeTimers();
    const tree = jest.fn(() => Promise.resolve({ ok: true, entries: [] }));
    installApi({ tree });
    const left: TreeProbe = { current: null };
    const right: TreeProbe = { current: null };
    const first = mount(<TreeProbeHarness probe={left} enabled />);
    const second = mount(<TreeProbeHarness probe={right} enabled />);
    await flushPromises();
    expect(tree).toHaveBeenCalledTimes(1);
    expect(left.current?.settled).toBe(true);
    expect(left.current?.tree).not.toBeNull();

    act(() => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: ROOT_ID,
        live: 1,
        queued: 0,
      });
      useDelegationActivityStore.getState().applyActivity({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: ROOT_ID,
        live: 2,
        queued: 1,
      });
    });
    await act(async () => {
      jest.advanceTimersByTime(499);
      await Promise.resolve();
    });
    expect(tree).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tree).toHaveBeenCalledTimes(2);
    expect(right.current?.tree).toBe(left.current?.tree);
    first.unmount();
    second.unmount();
  });

  it('settles a background Claude node at its process settle time', async () => {
    setOpenTabs([
      makeChatTab(ROOT_ID, {
        messages: [
          chatMessage(
            'dispatch',
            [
              {
                type: 'tool_use',
                toolUseId: 'watcher',
                toolName: 'Agent',
                input: JSON.stringify({
                  run_in_background: true,
                  description: 'Watch the logs',
                }),
              },
            ],
            10,
          ),
          chatMessage(
            'receipt',
            [
              {
                type: 'tool_result',
                toolUseId: 'watcher',
                toolName: 'Agent',
                output: 'Async agent launched successfully. agentId: c3',
                isError: false,
              },
            ],
            11,
          ),
        ],
      }),
    ]);
    useActivityStore.setState({
      bgProcesses: {
        [SCOPE_KEY]: [
          {
            id: 'watcher',
            chatId: ROOT_ID,
            toolUseId: 'watcher',
            taskId: 'c3',
            toolName: 'Agent',
            kind: 'agent',
            description: 'Watch the logs',
            status: 'completed',
            startedAt: 10,
            updatedAt: 30,
            endedAt: 30,
            outputLines: [],
            canStop: false,
          },
        ],
      },
    });
    const probe: TreeProbe = { current: null };
    const mounted = mount(<TreeProbeHarness probe={probe} enabled />);
    await flushPromises();

    expect(probe.current?.tree?.nodes.get('watcher')).toMatchObject({
      status: 'completed',
      startedAt: 10,
      settledAt: 30,
    });
    mounted.unmount();
  });

  it('rebuilds a Codex node when only its child turn times change (CAN-5203)', async () => {
    const spawned = codexBlock('codex-timed', 'root-thread', ['codex-child']);
    const tab = (block: CodexAgentCallBlock): ChatTab =>
      makeChatTab(ROOT_ID, {
        messages: [
          chatMessage('codex-spawn', [block], 10, {
            codexThreadId: 'root-thread',
          }),
        ],
      });
    setOpenTabs([tab(spawned)]);
    const probe: TreeProbe = { current: null };
    const mounted = mount(<TreeProbeHarness probe={probe} enabled />);
    await flushPromises();
    expect(probe.current?.tree?.nodes.get('codex-child')?.startedAt).toBe(10);

    act(() =>
      setOpenTabs([
        tab({
          ...spawned,
          receiverTimes: { 'codex-child': { startedAt: 40 } },
        }),
      ]),
    );
    await flushPromises();
    expect(probe.current?.tree?.nodes.get('codex-child')?.startedAt).toBe(40);
    mounted.unmount();
  });

  it('keeps a background Claude node settled when output arrives after it ends', async () => {
    setOpenTabs([
      makeChatTab(ROOT_ID, {
        messages: [
          chatMessage(
            'dispatch',
            [
              {
                type: 'tool_use',
                toolUseId: 'watcher',
                toolName: 'Agent',
                input: JSON.stringify({
                  run_in_background: true,
                  description: 'Watch the logs',
                }),
              },
            ],
            10,
          ),
          chatMessage(
            'receipt',
            [
              {
                type: 'tool_result',
                toolUseId: 'watcher',
                toolName: 'Agent',
                output: 'Async agent launched successfully. agentId: c3',
                isError: false,
              },
            ],
            11,
          ),
        ],
      }),
    ]);
    useActivityStore.setState({
      bgProcesses: {
        [SCOPE_KEY]: [
          {
            id: 'watcher',
            chatId: ROOT_ID,
            toolUseId: 'watcher',
            taskId: 'c3',
            toolName: 'Agent',
            kind: 'agent',
            description: 'Watch the logs',
            status: 'running',
            startedAt: 10,
            updatedAt: 20,
            outputFile: '/tasks/c3.output',
            outputLines: [],
            canStop: true,
          },
        ],
      },
    });
    const activity = useActivityStore.getState();
    activity.handleSdkSystemEvent(
      SCOPE.projectId,
      SCOPE.worktreeId,
      ROOT_ID,
      {
        type: 'system',
        subtype: 'task_notification',
        status: 'completed',
        task_id: 'c3',
        tool_use_id: 'watcher',
      },
      30,
    );
    const probe: TreeProbe = { current: null };
    const mounted = mount(<TreeProbeHarness probe={probe} enabled />);
    await flushPromises();
    const settled = probe.current?.tree;
    expect(settled?.nodes.get('watcher')).toMatchObject({
      status: 'completed',
      settledAt: 30,
    });

    // The output poller drains the file for a while after the process ends.
    const now = jest.spyOn(Date, 'now').mockReturnValue(31_500);
    act(() => {
      activity.appendBgProcessOutput({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: ROOT_ID,
        taskId: 'c3',
        outputFile: '/tasks/c3.output',
        lines: ['late line'],
      });
    });
    await flushPromises();
    now.mockRestore();

    expect(
      useActivityStore.getState().bgProcesses[SCOPE_KEY]?.[0]?.updatedAt,
    ).toBe(31_500);
    expect(probe.current?.tree?.nodes.get('watcher')?.settledAt).toBe(30);
    expect(probe.current?.tree).toBe(settled);
    mounted.unmount();
  });

  it('does not query or build a tree while its consumer is disabled', async () => {
    const tree = jest.fn(() => Promise.resolve({ ok: true, entries: [] }));
    installApi({ tree });
    const probe: TreeProbe = { current: null };
    const mounted = mount(<TreeProbeHarness probe={probe} enabled={false} />);
    await flushPromises();

    expect(tree).not.toHaveBeenCalled();
    expect(probe.current?.tree).toBeNull();
    expect(probe.current?.settled).toBe(false);
    mounted.unmount();
  });

  it('lists only open chats and forgets root state and drafts when a listed root closes', async () => {
    const roots = jest.fn(() =>
      Promise.resolve([
        rootEntry('managed-open', 2, 1, 500),
        rootEntry('closed-root', 5, 1, 900),
      ]),
    );
    installApi({ roots });
    const nativeMessages = [
      chatMessage(
        'native-task',
        [
          {
            type: 'tool_use',
            toolUseId: 'native-task-id',
            toolName: 'Agent',
            input: JSON.stringify({ description: 'Native task' }),
          },
        ],
        700,
      ),
    ];
    const managedTab = makeChatTab('managed-open', { title: 'Open managed' });
    const nativeTab = makeChatTab('native-open', {
      title: 'Native title',
      description: 'Native display title',
      messages: nativeMessages,
    });
    const fileTab = makeChatTab('file-tab', {
      kind: 'file',
      messages: nativeMessages,
    });
    setOpenTabs([managedTab, nativeTab, fileTab]);
    useDelegationActivityStore.getState().applyActivity({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: 'managed-open',
      live: 2,
      queued: 1,
    });
    const forgetRoots = jest.fn();
    const forgetDrafts = jest.fn();
    useSubagentViewStateStore.setState({
      forgetSubagentRootChats: forgetRoots,
    });
    useSubagentComposerStore.setState({ forgetRootChat: forgetDrafts });
    const probe: RootChatsProbe = { current: null };
    const mounted = mount(<RootChatsProbeHarness probe={probe} enabled />);
    await flushPromises();

    expect(roots).toHaveBeenCalledTimes(1);
    expect(probe.current?.rootChats).toEqual([
      {
        id: 'managed-open',
        title: 'Description managed-open',
        total: 2,
        live: 3,
        lastActivityAt: 500,
      },
      {
        id: 'native-open',
        title: 'Native display title',
        total: 1,
        live: 1,
        lastActivityAt: 700,
      },
    ]);

    act(() => setOpenTabs([nativeTab]));
    await flushPromises();
    expect(forgetRoots).toHaveBeenCalledWith(SCOPE_KEY, ['managed-open']);
    expect(forgetDrafts).toHaveBeenCalledWith('managed-open');
    mounted.unmount();
  });

  it('persists view state across adapters, ignores corrupt storage and bounds root entries', async () => {
    const storage = new MemoryStorage();
    const snapshot = {
      version: 1 as const,
      filter: 'all' as const,
      view: 'tree' as const,
      selectedRootId: 'root-0',
      roots: { 'root-0': { levels: 5, focusId: 'node-1' } },
    };
    createSubagentViewStatePersistence(storage).save('scope', snapshot);
    const loaded =
      await createSubagentViewStatePersistence(storage).load('scope');
    expect(loaded).toEqual(snapshot);

    storage.setItem('canopy.subagents.viewState.v1:corrupt', '{bad json');
    expect(
      await createSubagentViewStatePersistence(storage).load('corrupt'),
    ).toBeNull();

    const manyRoots: Record<
      string,
      { levels: number; focusId: string | null }
    > = {};
    for (let index = 0; index < 250; index += 1) {
      manyRoots[`root-${index}`] = { levels: 3, focusId: null };
    }
    createSubagentViewStatePersistence(storage).save('bounded', {
      ...snapshot,
      selectedRootId: 'root-249',
      roots: manyRoots,
    });
    const boundedRaw = storage.getItem('canopy.subagents.viewState.v1:bounded');
    if (boundedRaw === null)
      throw new Error('Expected persisted bounded state');
    const bounded: unknown = JSON.parse(boundedRaw);
    if (typeof bounded !== 'object' || bounded === null) {
      throw new Error('Expected an object in persisted state');
    }
    if (
      typeof bounded !== 'object' ||
      bounded === null ||
      !('roots' in bounded) ||
      typeof bounded.roots !== 'object' ||
      bounded.roots === null
    ) {
      throw new Error('Expected a roots map in persisted state');
    }
    expect(Object.keys(bounded.roots)).toHaveLength(200);
    expect('selectedRootId' in bounded ? bounded.selectedRootId : null).toBe(
      'root-249',
    );
  });

  it('keeps hidden host inert and wires visible open-chat and stop actions to IPC identity', async () => {
    const tree = jest.fn(() =>
      Promise.resolve({ ok: true, entries: [treeEntry('delegate-1')] }),
    );
    const roots = jest.fn(() => Promise.resolve([rootEntry(ROOT_ID, 1, 1)]));
    const stop = jest.fn(() => Promise.resolve({ ok: true }));
    installApi({ tree, roots, stop });
    setOpenTabs([
      makeChatTab(ROOT_ID, { title: 'Root chat', description: undefined }),
    ]);
    useSubagentViewStateStore.getState().setSelectedRoot(SCOPE_KEY, ROOT_ID);
    useSubagentViewStateStore.getState().setView(SCOPE_KEY, 'list');
    const hidden = mount(
      <DesktopSubagentsPanelHost
        scope={SCOPE}
        isVisible={false}
        isActive={false}
      />,
    );
    await flushPromises();
    expect(tree).not.toHaveBeenCalled();
    expect(roots).not.toHaveBeenCalled();
    hidden.unmount();

    const visible = mount(
      <DesktopSubagentsPanelHost scope={SCOPE} isVisible isActive />,
    );
    await flushPromises();
    expect(tree).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: ROOT_ID,
    });
    expect(roots).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
    });
    expect(visible.container.textContent).toContain('Root chat');
    clickTestId('subagents-view-list');
    clickTestId('subagents-list-select-delegate-1');
    clickTestId('subagents-inspector-open-chat');
    expect(openSubagentChatPanel).toHaveBeenCalledWith(SCOPE, {
      rootChatId: ROOT_ID,
      subagentId: 'delegate-1',
      subagentKind: 'managed',
      title: 'Task delegate-1',
    });
    await act(async () => {
      clickTestId('subagents-inspector-stop');
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: ROOT_ID,
      delegationId: 'delegate-1',
    });
    visible.unmount();
  });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

function buildSubagentTreeForInput(
  input: ReturnType<typeof buildDesktopSubagentTreeInput>,
): SubagentTree {
  return buildSubagentTree(input);
}
