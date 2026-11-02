/**
 * @jest-environment jsdom
 *
 * A live run belongs to the composer's background drawer, so turn records
 * skip it (background drawer D3). A tab kept read-only (a replaced stale
 * session) mounts no composer and so no drawer, nor does a viewer with no
 * live tab (an archived transcript): their runs stay in their turns.
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to size agent artifact receipts.
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { CanopyClientProvider } from '@canopy/app-state';
import { CompactQueueProvider } from '@canopy/ui-shared/components';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildGitHubWorkflowRunArtifactReceipt,
  buildPipelineRunArtifactReceipt,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import type { AgentArtifactReceiptV1 } from '@canopy/desktop-shared/types';
import {
  chatBackgroundWorkKey,
  markChatBackgroundRunsSeenLive,
  publishChatBackgroundRuns,
  resetChatBackgroundWorkStoreForTests,
} from '@/stores/chatBackgroundWorkStore';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-runs';
const mockRun = buildGitHubWorkflowRunArtifactReceipt({
  operation: 'github.watch',
  createdAt: '2026-07-20T00:00:00.000Z',
  watcherId: 'watcher-ci',
  repository: 'acme/api',
  runId: '101',
  runAttempt: 1,
  htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  navigationTarget: {
    kind: 'github_workflow_run',
    repository: 'acme/api',
    runId: '101',
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  },
  state: { kind: 'intermediate', status: 'in_progress' },
  observedAt: '2026-07-20T00:01:00.000Z',
});
// A run the turn launched, recorded in its messages.
const mockPipelineRun = buildPipelineRunArtifactReceipt({
  operation: 'pipeline.run',
  createdAt: '2026-07-20T00:00:00.000Z',
  executionId: 'exec-1',
  pipelineId: 'pipe-1',
  pipelineName: 'Build',
  initialStatus: 'running',
  queuedAt: '2026-07-20T00:00:00.000Z',
  projectId: 'project',
  worktreeId: 'worktree',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'exec-1',
    projectId: 'project',
    worktreeId: 'worktree',
  },
});
const mockLiveKeys = { current: true };
const mockTabOpen = { current: true };
const mockTab: {
  id: string;
  readOnly?: boolean;
  agentArtifactCarryByTurn: object;
} = {
  id: mockChatId,
  agentArtifactCarryByTurn: { request: [mockRun] },
};
const mockTurnArtifacts = new Map<string, readonly AgentArtifactReceiptV1[]>();

jest.mock('@/stores/chatStore', () => {
  const state = {
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    // Read lazily: the factory runs before the module's constants exist.
    get worktreeChats(): object {
      return {
        'project/worktree': {
          activeTabId: mockChatId,
          tabs: mockTabOpen.current ? [mockTab] : [],
        },
      };
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
    recordAgentArtifactCarry: (): void => undefined,
  };
  const useChatStore = (selector: (value: typeof state) => unknown): unknown =>
    selector(state);
  useChatStore.getState = (): typeof state => state;
  return {
    useChatStore,
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(() => state),
  };
});

// Both runs are still going: they are live.
jest.mock('../useLiveAgentRunKeys', () => ({
  useLiveAgentRunKeys: (): ReadonlySet<string> =>
    new Set(
      mockLiveKeys.current
        ? [mockRun.dedupeKey, mockPipelineRun.dedupeKey]
        : [],
    ),
}));

jest.mock('@/stores/appAdvisorWatchersStore', () => {
  const state = {
    watchers: [],
    completedWatchers: [],
    hydrated: true,
    loading: false,
    subscribeBridge: (): (() => void) => () => undefined,
    hydrate: (): Promise<void> => Promise.resolve(),
  };
  const useAppAdvisorWatchersStore = (
    selector: (value: typeof state) => unknown,
  ): unknown => selector(state);
  useAppAdvisorWatchersStore.getState = (): typeof state => state;
  return {
    useAppAdvisorWatchersStore,
    retainAppAdvisorWatchersBridge: (): (() => void) => () => undefined,
  };
});

jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (value: { summaries: readonly never[] }) => unknown,
  ): unknown => selector({ summaries: [] }),
}));

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, never>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: ({
    group,
    completedAgentArtifacts,
  }: {
    group: { userMessage: { id: string } };
    completedAgentArtifacts: readonly AgentArtifactReceiptV1[];
  }): null => {
    mockTurnArtifacts.set(group.userMessage.id, completedAgentArtifacts);
    return null;
  },
}));
jest.mock('../ChatMessageItem', () => ({ ChatMessageItem: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
}));
jest.mock('../QueuedMessageEditor', () => ({
  QueuedMessageEditor: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

Object.assign(globalThis, { TextEncoder: NodeTextEncoder });

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const TIMESTAMP = 1789490000000;
const TURN: ChatMessage[] = [
  {
    id: 'request',
    role: 'user',
    timestamp: TIMESTAMP,
    blocks: [{ type: 'text', text: 'Watch the CI run for me.' }],
  },
  {
    id: 'launch',
    role: 'assistant',
    timestamp: TIMESTAMP + 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        toolName: 'DispatchAction',
        input: '{}',
      },
    ],
  },
  {
    id: 'launch-result',
    role: 'assistant',
    timestamp: TIMESTAMP + 2,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        toolName: 'DispatchAction',
        output: JSON.stringify({
          ok: true,
          result: { agentArtifacts: [mockPipelineRun] },
        }),
        isError: false,
      },
    ],
  },
  {
    id: 'answer',
    role: 'assistant',
    timestamp: TIMESTAMP + 10,
    blocks: [{ type: 'text', text: 'The watcher is set.' }],
  },
  {
    id: 'timer',
    role: 'system',
    timestamp: TIMESTAMP + 11,
    blocks: [
      { type: 'turn_timer', startedAt: TIMESTAMP, completedAt: TIMESTAMP + 11 },
    ],
  },
];

let root: Root | null = null;

function renderTurnArtifacts(
  grouped = true,
): readonly AgentArtifactReceiptV1[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CompactQueueProvider value={grouped}>
        <CanopyClientProvider client={ipcCanopyClient}>
          <ChatMessageList
            messages={TURN}
            queuedMessages={[]}
            chatId={mockChatId}
            targetOverride={{
              projectId: 'project',
              worktreeId: 'worktree',
              chatId: mockChatId,
            }}
            onClearQueuedMessage={(): void => undefined}
          />
        </CanopyClientProvider>
      </CompactQueueProvider>,
    );
  });
  return mockTurnArtifacts.get('request') ?? [];
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  mockTurnArtifacts.clear();
  mockLiveKeys.current = true;
  resetChatBackgroundWorkStoreForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  delete mockTab.readOnly;
  mockTabOpen.current = true;
  document.body.innerHTML = '';
});

describe('live runs and the drawer', () => {
  it('keeps a finished run owned by the legacy drawer until dismissed', () => {
    mockLiveKeys.current = false;
    const chatKey = chatBackgroundWorkKey('project', 'worktree', mockChatId);
    publishChatBackgroundRuns(chatKey, [mockPipelineRun]);
    markChatBackgroundRunsSeenLive(chatKey, [mockPipelineRun.dedupeKey]);
    expect(
      renderTurnArtifacts(false).map((receipt) => receipt.dedupeKey),
    ).not.toContain(mockPipelineRun.dedupeKey);
  });

  it('keeps finished records in chat after the drawer saw them live', () => {
    mockLiveKeys.current = false;
    const chatKey = chatBackgroundWorkKey('project', 'worktree', mockChatId);
    publishChatBackgroundRuns(chatKey, [mockPipelineRun]);
    markChatBackgroundRunsSeenLive(chatKey, [mockPipelineRun.dedupeKey]);
    expect(renderTurnArtifacts().map((receipt) => receipt.dedupeKey)).toContain(
      mockPipelineRun.dedupeKey,
    );
  });

  it('leaves live runs to the drawer of a writable tab', () => {
    const keys = renderTurnArtifacts().map((receipt) => receipt.dedupeKey);
    expect(keys).not.toContain(mockRun.dedupeKey);
    expect(keys).not.toContain(mockPipelineRun.dedupeKey);
  });

  it('keeps a live run in its turn when the tab is read-only and has no drawer', () => {
    mockTab.readOnly = true;
    expect(renderTurnArtifacts().map((receipt) => receipt.dedupeKey)).toContain(
      mockRun.dedupeKey,
    );
  });

  it('keeps a live run in its turn with no live tab (an archived viewer)', () => {
    mockTabOpen.current = false;
    expect(renderTurnArtifacts().map((receipt) => receipt.dedupeKey)).toContain(
      mockPipelineRun.dedupeKey,
    );
  });
});
