/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SubagentKind,
  SubagentNode,
  SubagentTree,
} from '@canopy/agent-transcript';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { createEmptyCostTotals } from '@canopy/protocol/cost-view';
import type { WorkflowRunState } from '@canopy/desktop-shared/types';
import {
  useChatStore,
  type ChatMessage,
  type ChatTab,
} from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useActivityStore } from '@/stores/activityStore';
import { DesktopSubagentChatPanelHost } from '../DesktopSubagentChatPanelHost';
import { useSubagentTranscriptPages } from '../useSubagentTranscriptPages';
import { useSubagentTree } from '../useSubagentTree';
import type { SubagentTreeQuery } from '../useSubagentTree';
import { useSubagentWorktreeSummary } from '../useSubagentWorktreeSummary';
import { resetSubagentTreeStoreForTests } from '../subagent-tree-store';
import { resetWorkflowRunCacheForTests } from '../workflow-run-cache';
import type { SubagentHostScope } from '../subagent-scope';
import { buildSubagentChatTranscript } from '@canopy/agent-transcript';
import { parseAgentTranscriptLines } from '@/lib/transcript-parser';

let mockCostInsightsCapability = true;
const mockOpenSessionBreakdown = jest.fn();

jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCapabilities: (): { readonly costInsights: boolean } => ({
    costInsights: mockCostInsightsCapability,
  }),
}));
jest.mock('@/lib/cost/cost-navigator', () => ({
  DESKTOP_COST_NAVIGATOR: {
    openSessionBreakdown: (...args: unknown[]): void => {
      mockOpenSessionBreakdown(...args);
    },
  },
}));

jest.mock('../useSubagentTree', () => ({
  useSubagentTree: jest.fn(),
}));
jest.mock('../useSubagentTranscriptPages', () => ({
  useSubagentTranscriptPages: jest.fn(),
}));
jest.mock('../useSubagentWorktreeSummary', () => ({
  useSubagentWorktreeSummary: jest.fn(),
}));
jest.mock('@canopy/agent-transcript', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/agent-transcript'),
  buildSubagentChatTranscript: jest.fn(),
}));
jest.mock('@/lib/transcript-parser', () => ({
  parseAgentTranscriptLines: jest.fn(() => ({ displayMessages: [] })),
}));
jest.mock('../WorkflowRunDialog', () => ({
  WorkflowRunDialog: ({
    target,
  }: {
    readonly target: {
      readonly runId: string;
      readonly transcriptDir: string;
      readonly title: string;
    } | null;
  }): JSX.Element | null =>
    target ? (
      <div data-testid="workflow-dialog">
        {target.runId}|{target.transcriptDir}|{target.title}
      </div>
    ) : null,
}));
jest.mock('@canopy/ui-app/subagents', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/ui-app/subagents'),
  subagentCapabilitiesForKind: jest.fn(
    (capabilities: SubagentViewerCapabilities) => capabilities,
  ),
}));
jest.mock('../subagent-capabilities', () => ({
  useSubagentViewerCapabilities: jest.fn(() => ({
    stop: true,
    messaging: true,
    worktreeDetails: true,
    nativeInterrupt: true,
    openWorkflow: true,
    stopWorkflow: true,
  })),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const scope: SubagentHostScope = {
  projectId: 'host-project',
  worktreeId: 'host-worktree',
};
const scopeKey = `${scope.projectId}/${scope.worktreeId}`;

const emptyQuery: SubagentTreeQuery = {
  tree: null,
  treeState: { status: 'loading' },
  settled: false,
  rootChatOpen: false,
  hydrated: false,
  managedEntries: new Map(),
};

const props = {
  scope,
  rootChatId: 'root-chat',
  subagentId: 'delegate',
  subagentKind: 'managed' as SubagentKind,
  panelId: 'panel-1',
  isVisible: true,
  isActive: false,
};

function installIpcSpies(): {
  readonly transcript: jest.Mock;
  readonly worktreeSummary: jest.Mock;
  readonly changes: jest.Mock;
  readonly message: jest.Mock;
  readonly interrupt: jest.Mock;
} {
  const transcript = jest.fn();
  const worktreeSummary = jest.fn();
  const changes = jest.fn();
  const message = jest.fn();
  const interrupt = jest.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedDelegation: {
        transcriptPage: transcript,
        worktreeSummary,
        changes,
        message,
      },
      nativeSubagents: { interrupt },
    },
  });
  return { transcript, worktreeSummary, changes, message, interrupt };
}

describe('DesktopSubagentChatPanelHost', () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    jest.clearAllMocks();
    mockCostInsightsCapability = true;
    useChatStore.setState(useChatStore.getInitialState());
    jest.mocked(useSubagentTree).mockReturnValue(emptyQuery);
    jest.mocked(useSubagentTranscriptPages).mockReturnValue({
      runs: new Map(),
      hasOlder: false,
      loadingOlder: false,
      onLoadOlder: (): void => undefined,
    });
    jest.mocked(useSubagentWorktreeSummary).mockReturnValue({});
    jest.mocked(buildSubagentChatTranscript).mockReturnValue({
      items: [],
      missingBeginning: false,
    });
  });

  afterEach(() => {
    act((): void => roots.forEach((root) => root.unmount()));
    useChatStore.setState(useChatStore.getInitialState());
    hydratedKeys.delete(scopeKey);
    useActivityStore.setState({ bgProcesses: {} });
    resetSubagentTreeStoreForTests();
    resetWorkflowRunCacheForTests();
  });

  function mount(container: HTMLElement, visibleProps = props): void {
    const root = createRoot(container);
    roots.push(root);
    act((): void => {
      root.render(<DesktopSubagentChatPanelHost {...visibleProps} />);
    });
  }

  function rootChatTab(messages: readonly ChatMessage[]): ChatTab {
    return {
      id: 'root-chat',
      title: 'Root chat',
      description: 'Root chat description',
      createdAt: '2026-10-06T00:00:00.000Z',
      messages: [...messages],
      status: 'idle',
      error: null,
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
    };
  }

  function workflowLaunchMessages(): ChatMessage[] {
    return [
      {
        id: 'workflow-launch',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'workflow-tool-1',
            toolName: 'Workflow',
            input: JSON.stringify({ script: 'meta:\n  name: Report review' }),
          },
        ],
      },
      {
        id: 'workflow-receipt',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'workflow-tool-1',
            toolName: 'Workflow',
            output:
              'Workflow launched in background. Task ID: task-1\nRun ID: wf_1\nTranscript dir: /tmp/workflow',
            isError: false,
          },
        ],
      },
    ];
  }

  it('shows a neutral unavailable state when the root chat has closed', () => {
    const unavailableQuery: SubagentTreeQuery = {
      ...emptyQuery,
      hydrated: true,
      rootChatOpen: false,
    };
    jest.mocked(useSubagentTree).mockReturnValue(unavailableQuery);
    const container = document.createElement('div');

    mount(container);

    expect(
      container.querySelector('[data-testid="subagent-chat-unavailable"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "This subagent's chat is no longer available",
    );
    expect(useSubagentTranscriptPages).not.toHaveBeenCalled();
    expect(buildSubagentChatTranscript).not.toHaveBeenCalled();
  });

  it('shows the unavailable state after a settled tree no longer contains the subagent', () => {
    jest.mocked(useSubagentTree).mockReturnValue({
      ...emptyQuery,
      settled: true,
      rootChatOpen: true,
      hydrated: true,
    });
    const container = document.createElement('div');

    mount(container);

    expect(
      container.querySelector('[data-testid="subagent-chat-unavailable"]'),
    ).not.toBeNull();
    expect(useSubagentTranscriptPages).not.toHaveBeenCalled();
  });

  it('keeps hidden panels inert and does not read transcript or worktree IPC', () => {
    const ipc = installIpcSpies();
    const container = document.createElement('div');

    mount(container, { ...props, isVisible: false });

    expect(useSubagentTree).toHaveBeenCalledWith(scope, 'root-chat', {
      enabled: false,
    });
    expect(container.textContent).toBe('');
    expect(useSubagentTranscriptPages).not.toHaveBeenCalled();
    expect(useSubagentWorktreeSummary).not.toHaveBeenCalled();
    expect(buildSubagentChatTranscript).not.toHaveBeenCalled();
    expect(ipc.transcript).not.toHaveBeenCalled();
    expect(ipc.worktreeSummary).not.toHaveBeenCalled();
    expect(ipc.changes).not.toHaveBeenCalled();
    expect(ipc.message).not.toHaveBeenCalled();
    expect(ipc.interrupt).not.toHaveBeenCalled();
  });

  it('mounts subagent cost and opens the root breakdown', async () => {
    const node: SubagentNode = {
      id: 'delegate',
      kind: 'managed',
      parentId: null,
      depth: 1,
      title: 'Write stories',
      status: 'completed',
      childIds: [],
      liveDescendantCount: 0,
      approvalPending: false,
      runs: [{ runGeneration: 1 }],
    };
    const tree: SubagentTree = {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes: new Map([[node.id, node]]),
      rootChildIds: [node.id],
      complete: true,
    };
    const query: SubagentTreeQuery = {
      ...emptyQuery,
      tree,
      settled: true,
      rootChatOpen: true,
      hydrated: true,
    };
    jest.mocked(useSubagentTree).mockReturnValue(query);
    const getChat = jest.fn().mockResolvedValue({
      status: 'ok',
      value: {
        kind: 'subagent',
        chat: {
          chatId: 'root-chat',
          label: 'Root chat',
          state: 'open',
          totals: createEmptyCostTotals(),
          turnCount: 1,
          lastActivityAt: '2026-10-08T12:00:00.000Z',
          running: false,
          models: ['Sonnet'],
        },
        item: {
          id: 'delegate',
          kind: 'delegation',
          label: 'Write stories',
          billingBasis: 'ai_credits',
          tokens: {
            input: 12,
            output: 4,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          usd: 0.9,
          costStatus: 'estimated',
          inclusion: 'additional',
          runCount: 2,
        },
      },
    });
    const windowApi = {
      managedDelegation: {
        transcriptPage: jest.fn(),
        worktreeSummary: jest.fn(),
        changes: jest.fn(),
        message: jest.fn(),
      },
      nativeSubagents: { interrupt: jest.fn() },
      cost: {
        getChat,
        refresh: jest.fn().mockResolvedValue({
          status: 'ok',
          value: {
            ran: true,
            updatedAt: '2026-10-08T12:00:00.000Z',
            revision: 1,
          },
        }),
        watchScope: jest.fn(() => (): void => undefined),
        onUpdated: jest.fn(() => (): void => undefined),
      },
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: windowApi,
    });
    const container = document.createElement('div');

    mount(container);
    const detailsToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-details-toggle"]',
    );
    if (!detailsToggle) throw new Error('Missing cost details toggle');
    act(() => detailsToggle.click());
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(getChat).toHaveBeenCalledWith({
      scope: {
        kind: 'entry',
        projectId: 'host-project',
        worktreeId: 'host-worktree',
      },
      chatId: 'root-chat',
      subagentId: 'delegate',
    });
    expect(
      container.querySelector('[data-testid="subagent-cost-details"]'),
    ).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-cost-details-open-breakdown"]',
        )
        ?.click();
    });
    expect(mockOpenSessionBreakdown).toHaveBeenCalledWith(
      {
        kind: 'entry',
        projectId: 'host-project',
        worktreeId: 'host-worktree',
      },
      'root-chat',
    );

    // A host that cannot read cost shows no section and reads nothing.
    const readsWithCost = getChat.mock.calls.length;
    mockCostInsightsCapability = false;
    const disabledContainer = document.createElement('div');
    mount(disabledContainer);
    expect(
      disabledContainer.querySelector('[data-testid="subagent-cost-details"]'),
    ).toBeNull();
    expect(getChat).toHaveBeenCalledTimes(readsWithCost);
  });

  it('shows workflow task and truncation without offering interrupt', async () => {
    const actualUseSubagentTree = jest.requireActual<{
      readonly useSubagentTree: typeof useSubagentTree;
    }>('../useSubagentTree').useSubagentTree;
    jest.mocked(useSubagentTree).mockImplementation(actualUseSubagentTree);
    const messages = workflowLaunchMessages();
    hydratedKeys.add(scopeKey);
    useChatStore.setState({
      worktreeChats: {
        [scopeKey]: {
          tabs: [rootChatTab(messages)],
          activeTabId: 'root-chat',
        },
      },
    });
    const readWorkflowRun = jest.fn(
      (): Promise<WorkflowRunState> =>
        Promise.resolve({
          runId: 'wf_1',
          status: 'running',
          workflowName: 'Report review',
          startedAt: 2,
          lastActivityAt: 2,
          phases: [{ title: 'Review' }],
          agents: [
            {
              index: 0,
              label: 'Fact-check the report',
              phaseIndex: 0,
              phaseTitle: 'Review',
              agentId: 'agent-1',
              agentType: 'worker',
              state: 'running',
              startedAt: 2,
            },
          ],
        }),
    );
    const readManagedTree = jest.fn(() =>
      Promise.resolve({ ok: true, entries: [] }),
    );
    const readWorkflowAgentTranscript = jest.fn(() =>
      Promise.resolve({
        lines: ['workflow transcript line'],
        truncated: true,
        initialPrompt: 'Fact-check the report.',
      }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        managedDelegation: { tree: readManagedTree },
        activity: { readWorkflowAgentTranscript, readWorkflowRun },
      },
    });
    const container = document.createElement('div');

    mount(container, {
      ...props,
      subagentId: 'workflow-agent:wf_1:agent-1',
      subagentKind: 'workflow-agent',
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readWorkflowRun).toHaveBeenCalledWith({
      transcriptDir: '/tmp/workflow',
      runId: 'wf_1',
    });
    expect(readWorkflowAgentTranscript).toHaveBeenCalledWith({
      transcriptDir: '/tmp/workflow',
      agentId: 'agent-1',
    });
    expect(parseAgentTranscriptLines).toHaveBeenCalledWith(
      ['workflow transcript line'],
      'claude',
    );
    expect(container.textContent).toContain('Fact-check the report.');
    expect(
      container.querySelector(
        '[data-testid="subagent-workflow-transcript-truncated"]',
      )?.textContent,
    ).toBe('Earlier messages are not shown.');
    expect(
      container.querySelector('[data-testid="subagent-composer-interrupt"]'),
    ).toBeNull();
    expect(buildSubagentChatTranscript).not.toHaveBeenCalled();
    expect(useSubagentTranscriptPages).toHaveBeenCalledWith(
      scope,
      'root-chat',
      expect.objectContaining({ kind: 'workflow-agent' }),
      messages,
      { enabled: false },
    );

    const detailsToggle = container.querySelector<HTMLElement>(
      '[data-testid="subagent-chat-details-toggle"]',
    );
    if (!detailsToggle) throw new Error('Missing workflow details toggle');
    act(() => detailsToggle.click());
    expect(
      container.querySelector('[data-testid="subagent-chat-details-cost"]'),
    ).toBeNull();
    const openWorkflow = container.querySelector<HTMLElement>(
      '[data-testid="subagent-chat-open-workflow"]',
    );
    if (!openWorkflow) throw new Error('Missing open workflow action');
    act(() => openWorkflow.click());
    expect(
      container.querySelector('[data-testid="workflow-dialog"]')?.textContent,
    ).toBe('wf_1|/tmp/workflow|Report review');
  });
});
