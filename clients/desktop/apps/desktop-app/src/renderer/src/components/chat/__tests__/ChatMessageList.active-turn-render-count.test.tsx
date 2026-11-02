/**
 * @jest-environment jsdom
 *
 * Phase 12 (P2 renderer quick wins) render-count guard. Appending one tool
 * result to the ACTIVE turn must re-render O(1) transcript blocks, not every
 * block of that turn.
 *
 * The list renders the real `TurnGroupRenderer` and `ChatMessageItem`; only
 * `ChatBlockRenderer` is replaced by a probe that keeps the production
 * component's memo boundary (default shallow prop comparison) and counts its
 * renders per block. A React Profiler around the list counts commits.
 *
 * Before phase 12, `mergeToolResults` rebuilt every display message and every
 * tool block on each run, so each appended result re-rendered every block of
 * the active turn (and every message of it).
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to size agent artifact receipts.
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { act, Profiler, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import type * as ReactNamespace from 'react';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';
import {
  buildPipelineRunArtifactReceipt,
  createAgentArtifactDedupeKey,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type {
  AgentArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import {
  chatBackgroundRunKey,
  chatBackgroundWorkKey,
  dismissChatBackgroundRun,
  markChatBackgroundRunsSeenLive,
  publishChatBackgroundRuns,
  resetChatBackgroundWorkStoreForTests,
  useChatBackgroundWorkStore,
} from '@/stores/chatBackgroundWorkStore';

import {
  COMPLETED_CREDIT_RETRY_MESSAGES as CREDIT_RETRY_MESSAGES,
  nativeStoppedCreditRetry,
  cancelledCreditRetry,
} from '../../../../../../../../packages/ui-shared/src/lib/__tests__/fixtures/credit-retry';

const mockChatId = 'chat-render-count';
let mockCancelledRetry = false;
const mockBlockRenders: Record<string, number> = {};
let mockLiveRunKeys: ReadonlySet<string> = new Set();
const mockCarryRecorderRenders = { count: 0 };

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-render',
      worktreeId: 'worktree-render',
    },
    worktreeChats: {
      'project-render/worktree-render': {
        activeTabId: mockChatId,
        tabs: [
          {
            id: mockChatId,
            messages: [],
            queuedMessages: [],
            turnEnds: mockCancelledRetry
              ? {
                  'can4450-qa-original-1793228699314': { outcome: 'cancelled' },
                }
              : {},
          },
        ],
      },
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
  });
  return {
    useChatStore: (selector: (state: unknown) => unknown): unknown =>
      selector(mockState()),
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(mockState),
  };
});

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

jest.mock('../ChatBlockRenderer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  // Same memo boundary as the production `ChatBlockRenderer`: a block whose
  // props are all identical (block object included) is skipped.
  const ChatBlockRenderer = react.memo(function ChatBlockRenderer({
    block,
  }: {
    block: { type: string; toolUseId?: string; text?: string; turnId?: string };
  }): JSX.Element {
    const key =
      block.type === 'tool_use' && block.toolUseId
        ? `tool:${block.toolUseId}`
        : `${block.type}:${block.text ?? ''}`;
    mockBlockRenders[key] = (mockBlockRenders[key] ?? 0) + 1;
    return react.createElement('div', {
      'data-block-probe': key,
      'data-timer-id': block.turnId,
    });
  });
  const WaitingDelegationsContext = react.createContext<ReadonlySet<string>>(
    new Set(),
  );
  return { ChatBlockRenderer, WaitingDelegationsContext };
});
jest.mock('../UserBubble', () => ({ UserBubble: (): null => null }));
jest.mock('../TurnFeedbackHosts', () => ({
  TurnFeedbackSlot: (): null => null,
}));
jest.mock('../AutoArchiveToggleButton', () => ({
  AutoArchiveToggleButton: (): null => null,
}));
jest.mock('../RunCommentsButton', () => ({
  RunCommentsButton: (): null => null,
}));
jest.mock('@/components/shared/ShareSessionControl', () => ({
  ShareSessionControl: (): null => null,
}));
jest.mock('@/components/watchers/ChatWatcherButton', () => ({
  ChatWatcherButton: (): null => null,
}));
jest.mock('../useRecordWatchedRunCarry', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  // Same memo boundary as the production recorder; counts its renders.
  const WatchedRunCarryRecorder = react.memo(
    function WatchedRunCarryRecorder(): null {
      mockCarryRecorderRenders.count += 1;
      return null;
    },
  );
  return { WatchedRunCarryRecorder };
});
jest.mock('../DesktopAgentActivitySection', () => ({
  DesktopAgentActivitySection: ({
    artifacts,
    variant,
    ownerUserMessageId,
  }: {
    artifacts: ReadonlyArray<{ executionId?: string; kind: string }>;
    variant: string;
    ownerUserMessageId?: string;
  }): JSX.Element => (
    <div
      data-activity-section={variant}
      data-owner={ownerUserMessageId}
      data-artifacts={artifacts.map((a) => a.executionId ?? a.kind).join(',')}
    />
  ),
}));
jest.mock('../useLiveAgentRunKeys', () => ({
  useLiveAgentRunKeys: (): ReadonlySet<string> => mockLiveRunKeys,
}));
jest.mock('../TurnDiffSummary', () => ({ TurnDiffSummary: (): null => null }));
jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
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

const ACTIVE_TOOL_COUNT = 8;

function toolCall(turn: number, index: number): ChatMessage {
  return {
    id: `assistant-${turn}-${index}`,
    role: 'assistant',
    blocks: [
      { type: 'text', text: `Step ${turn}.${index}` },
      {
        type: 'tool_use',
        toolUseId: `tool-${turn}-${index}`,
        toolName: 'Bash',
        input: JSON.stringify({ command: `echo ${turn}.${index}` }),
      },
    ],
    timestamp: turn * 1000 + index * 10 + 1,
  };
}

function toolResult(turn: number, index: number): ChatMessage {
  return {
    id: `result-${turn}-${index}`,
    // Persisted tool-result carriers are assistant rows; a `user` row is a
    // turn boundary.
    role: 'assistant',
    blocks: [
      {
        type: 'tool_result',
        toolUseId: `tool-${turn}-${index}`,
        toolName: 'Bash',
        output: `output ${turn}.${index}`,
        isError: false,
      },
    ],
    timestamp: turn * 1000 + index * 10 + 2,
  };
}

function completedTurn(turn: number): ChatMessage[] {
  const rows: ChatMessage[] = [
    {
      id: `user-${turn}`,
      role: 'user',
      blocks: [{ type: 'text', text: `Ask ${turn}` }],
      timestamp: turn * 1000,
    },
  ];
  for (let index = 0; index < 3; index += 1) {
    rows.push(toolCall(turn, index), toolResult(turn, index));
  }
  rows.push({
    id: `timer-${turn}`,
    role: 'system',
    blocks: [
      {
        type: 'turn_timer',
        startedAt: turn * 1000,
        completedAt: turn * 1000 + 900,
      },
    ],
    timestamp: turn * 1000 + 900,
  });
  return rows;
}

/**
 * Two completed turns, then an active turn with `ACTIVE_TOOL_COUNT` tool
 * calls; results exist for the first `resultCount` of them. The rows are
 * built once and reused, as the store keeps unchanged message objects.
 */
function buildTranscript(): {
  base: ChatMessage[];
  activeCalls: ChatMessage[];
  activeResults: ChatMessage[];
} {
  const base: ChatMessage[] = [
    ...completedTurn(1),
    ...completedTurn(2),
    {
      id: 'user-3',
      role: 'user',
      blocks: [{ type: 'text', text: 'Ask 3' }],
      timestamp: 3000,
    },
    {
      id: 'timer-3',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 3000, completedAt: null }],
      timestamp: 3000,
    },
  ];
  const activeCalls: ChatMessage[] = [];
  const activeResults: ChatMessage[] = [];
  for (let index = 0; index < ACTIVE_TOOL_COUNT; index += 1) {
    activeCalls.push(toolCall(3, index));
    activeResults.push(toolResult(3, index));
  }
  return { base, activeCalls, activeResults };
}

function rows(
  transcript: ReturnType<typeof buildTranscript>,
  resultCount: number,
): ChatMessage[] {
  const out = [...transcript.base];
  transcript.activeCalls.forEach((call, index) => {
    out.push(call);
    if (index < resultCount) out.push(transcript.activeResults[index]);
  });
  return out;
}

const mountedRoots: Root[] = [];
let commits = 0;

function renderList(messages: ChatMessage[]): {
  host: HTMLElement;
  rerender: (next: ChatMessage[]) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const queuedMessages: never[] = [];
  const target = {
    projectId: 'project-render',
    worktreeId: 'worktree-render',
    chatId: mockChatId,
  };
  const onClear = (): void => undefined;
  const render = (next: ChatMessage[]): void => {
    act(() => {
      root.render(
        <CanopyClientProvider client={ipcCanopyClient}>
          <Profiler
            id="chat-message-list"
            onRender={(): void => {
              commits += 1;
            }}
          >
            <ChatMessageList
              messages={next}
              queuedMessages={queuedMessages}
              chatId={mockChatId}
              targetOverride={target}
              onClearQueuedMessage={onClear}
            />
          </Profiler>
        </CanopyClientProvider>,
      );
    });
  };
  render(messages);
  return { host, rerender: render };
}

function activitySections(
  host: HTMLElement,
): Array<[string | null, string | null]> {
  return Array.from(host.querySelectorAll('[data-activity-section]')).map(
    (el) => [
      el.getAttribute('data-activity-section'),
      el.getAttribute('data-owner'),
    ],
  );
}

function totalBlockRenders(): number {
  return Object.values(mockBlockRenders).reduce((sum, count) => sum + count, 0);
}

function activeTurnBlockRenders(): number {
  return Object.entries(mockBlockRenders)
    .filter(
      ([key]) =>
        key.startsWith('tool:tool-3-') || key.startsWith('text:Step 3.'),
    )
    .reduce((sum, [, count]) => sum + count, 0);
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  for (const key of Object.keys(mockBlockRenders)) delete mockBlockRenders[key];
  commits = 0;
  mockLiveRunKeys = new Set();
  mockCarryRecorderRenders.count = 0;
  resetChatBackgroundWorkStoreForTests();
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('ChatMessageList active-turn render count', () => {
  it('renders every active-turn block on mount', () => {
    const transcript = buildTranscript();
    renderList(rows(transcript, ACTIVE_TOOL_COUNT - 1));

    // Text and tool block per active call, all mounted once.
    expect(activeTurnBlockRenders()).toBe(ACTIVE_TOOL_COUNT * 2);
  });

  it('re-renders O(1) blocks when one tool result is appended to the active turn', () => {
    const transcript = buildTranscript();
    const { rerender } = renderList(rows(transcript, ACTIVE_TOOL_COUNT - 1));
    const blocksBefore = totalBlockRenders();
    const commitsBefore = commits;

    rerender(rows(transcript, ACTIVE_TOOL_COUNT));

    const rerendered = Object.entries(mockBlockRenders)
      .filter(([key]) => mockBlockRenders[key] > 1)
      .map(([key]) => key);
    // Only the tool block that received the result changes.
    expect(rerendered).toEqual([`tool:tool-3-${ACTIVE_TOOL_COUNT - 1}`]);
    expect(totalBlockRenders() - blocksBefore).toBe(1);
    expect(commits).toBeGreaterThan(commitsBefore);
  });

  it('keeps per-append block work constant as the active turn grows', () => {
    const transcript = buildTranscript();
    const { rerender } = renderList(rows(transcript, 0));

    const perAppend: number[] = [];
    for (let count = 1; count <= ACTIVE_TOOL_COUNT; count += 1) {
      const before = totalBlockRenders();
      rerender(rows(transcript, count));
      perAppend.push(totalBlockRenders() - before);
    }

    expect(perAppend).toEqual(new Array<number>(ACTIVE_TOOL_COUNT).fill(1));
  });
});

function pipelineRun(
  operation: string,
  executionId: string,
): PipelineRunArtifactReceiptV1 {
  return buildPipelineRunArtifactReceipt({
    operation,
    createdAt: '2026-09-18T00:00:00.000Z',
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: '2026-09-18T00:00:00.000Z',
    projectId: 'project-render',
    worktreeId: 'worktree-render',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project-render',
      worktreeId: 'worktree-render',
    },
  });
}

const SKILL_TILE: SkillArtifactReceiptV1 = {
  version: 1,
  kind: 'skill',
  operation: 'skills.create',
  dedupeKey: createAgentArtifactDedupeKey(
    'skill',
    'installed',
    'custom',
    'review',
  ),
  createdAt: '2026-09-18T00:00:00.000Z',
  source: 'installed',
  sourceId: 'custom',
  installedName: 'review',
  name: 'Review',
  description: 'Reviews changes',
  canUpdate: true,
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom',
    skillName: 'review',
  },
};

/** A completed turn whose first tool result returned `receipts`. */
function turnWithReceipt(
  turn: number,
  ...receipts: AgentArtifactReceiptV1[]
): ChatMessage[] {
  const dispatchTool =
    CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.claudeToolName;
  return completedTurn(turn).map((message) =>
    message.id === `assistant-${turn}-0` || message.id === `result-${turn}-0`
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'tool_use'
              ? { ...block, toolName: dispatchTool }
              : block.type === 'tool_result'
                ? {
                    ...block,
                    toolName: dispatchTool,
                    agentArtifacts: receipts,
                  }
                : block,
          ),
        }
      : message,
  );
}

/** `turn` still streaming: its timer has not completed. */
function streaming(turn: number, rows: ChatMessage[]): ChatMessage[] {
  return rows.map((message) =>
    message.id === `timer-${turn}`
      ? {
          ...message,
          blocks: [
            { type: 'turn_timer', startedAt: turn * 1000, completedAt: null },
          ],
        }
      : message,
  );
}

function completedBoxes(host: HTMLElement): Array<[string | null, string]> {
  return Array.from(
    host.querySelectorAll('[data-activity-section="completed"]'),
  ).map((el) => [
    el.getAttribute('data-owner'),
    el.getAttribute('data-artifacts') ?? '',
  ]);
}

const CHAT_KEY = chatBackgroundWorkKey(
  'project-render',
  'worktree-render',
  mockChatId,
);

// Background drawer D2: the pinned section lists only the streaming turn's
// capability tiles; background work and runs are the drawer's.
describe('pinned agent activity section', () => {
  it('mounts no pinned section while a turn without tiles streams', () => {
    const transcript = buildTranscript();
    const { host } = renderList(rows(transcript, 0));
    expect(activitySections(host)).toEqual([]);
  });

  it('lists the streaming turn’s capability tiles, and only them', () => {
    const run = pipelineRun('pipeline.run', 'exec-1');
    // The live-run hook owns its status. An empty set means the run has
    // finished, so its record is allowed before the parent turn ends.
    mockLiveRunKeys = new Set([run.dedupeKey]);
    const { host } = renderList([
      ...completedTurn(1),
      ...streaming(2, turnWithReceipt(2, SKILL_TILE, run)),
    ]);
    expect(activitySections(host)).toEqual([['active', 'user-2']]);
    expect(
      host
        .querySelector('[data-activity-section="active"]')
        ?.getAttribute('data-artifacts'),
    ).toBe('skill');
  });

  it('mounts no pinned section once every turn completes, even with a live run', () => {
    mockLiveRunKeys = new Set(['run-live']);
    const { host } = renderList([
      ...completedTurn(1),
      ...completedTurn(2),
      ...completedTurn(3),
    ]);
    expect(activitySections(host)).toEqual([]);
  });

  // Perf guard (stress-transcript typing): a list render that changes nothing
  // the carry recorder reads must not re-render it.
  it('skips the carry recorder on unrelated list renders', () => {
    mockLiveRunKeys = new Set(['run-live']);
    const messages = [...completedTurn(1), ...completedTurn(2)];
    const { rerender } = renderList(messages);
    expect(mockCarryRecorderRenders.count).toBe(1);
    rerender(messages);
    rerender(messages);
    expect(mockCarryRecorderRenders.count).toBe(1);
  });
});

describe('one place per run card', () => {
  const launched = pipelineRun('pipeline.run', 'exec-1');
  const watchedOnly = pipelineRun('pipeline.watch', 'exec-2');
  const transcript = (): ChatMessage[] => [
    ...turnWithReceipt(1, launched),
    ...turnWithReceipt(2, watchedOnly),
    ...turnWithReceipt(3, watchedOnly),
  ];

  it('leaves live runs to the drawer, which the list publishes them to', () => {
    mockLiveRunKeys = new Set([launched.dedupeKey, watchedOnly.dedupeKey]);
    const { host } = renderList(transcript());
    expect(completedBoxes(host)).toEqual([]);
    expect(activitySections(host)).toEqual([]);
    expect(
      Object.keys(useChatBackgroundWorkStore.getState().byChat[CHAT_KEY] ?? {}),
    ).toEqual([launched.dedupeKey, watchedOnly.dedupeKey]);
  });

  it('lists each run in one completed turn once its watcher stops', () => {
    const { host } = renderList(transcript());
    expect(completedBoxes(host)).toEqual([
      ['user-1', 'exec-1'],
      ['user-3', 'exec-2'],
    ]);
  });

  it('keeps a finished run the drawer holds out of records until it is dismissed, then lists it once', () => {
    act(() => {
      publishChatBackgroundRuns(CHAT_KEY, [launched]);
      markChatBackgroundRunsSeenLive(CHAT_KEY, [launched.dedupeKey]);
    });
    const { host } = renderList(transcript());
    expect(completedBoxes(host)).toEqual([['user-3', 'exec-2']]);
    act(() => dismissChatBackgroundRun(CHAT_KEY, launched.dedupeKey));
    expect(completedBoxes(host)).toEqual([
      ['user-1', 'exec-1'],
      ['user-3', 'exec-2'],
    ]);
    expect(
      useChatBackgroundWorkStore.getState().dismissed[
        chatBackgroundRunKey(CHAT_KEY, launched.dedupeKey)
      ],
    ).toBe(true);
  });
});

describe('the latest completed turn while a run is live', () => {
  const launched = pipelineRun('pipeline.run', 'exec-1');
  const watchedOnly = pipelineRun('pipeline.watch', 'exec-2');
  const latestLaunch = pipelineRun('pipeline.run', 'exec-3');
  const transcript = (): ChatMessage[] => [
    ...turnWithReceipt(1, launched),
    ...turnWithReceipt(2, watchedOnly),
    ...turnWithReceipt(3, latestLaunch),
  ];

  it('keeps its own box inline; no pinned section folds it in', () => {
    mockLiveRunKeys = new Set([watchedOnly.dedupeKey]);
    const { host } = renderList(transcript());
    expect(completedBoxes(host)).toEqual([
      ['user-1', 'exec-1'],
      ['user-3', 'exec-3'],
    ]);
    expect(activitySections(host)).toEqual([
      ['completed', 'user-1'],
      ['completed', 'user-3'],
    ]);
  });
});

// Sol review on #6080: the streaming turn's own receipts went to the pinned
// section unplaced, so a run an earlier turn launched, watched by the
// streaming turn and since finished, rendered in both places.
describe('the streaming turn’s receipts are placed too', () => {
  const launched = pipelineRun('pipeline.run', 'exec-1');
  const watchCopy = pipelineRun('pipeline.watch', 'exec-1');

  it('lists a finished run only in the turn that launched it', () => {
    const { host } = renderList([
      ...turnWithReceipt(1, launched),
      ...streaming(2, turnWithReceipt(2, watchCopy)),
    ]);
    expect(completedBoxes(host)).toEqual([['user-1', 'exec-1']]);
    expect(activitySections(host)).toEqual([['completed', 'user-1']]);
  });
});

describe('CAN-4450 recovered credit hold in desktop transcript', () => {
  it('keeps the cancelled partial reply footer and warning without a detached prior-attempt timestamp', () => {
    mockCancelledRetry = true;
    try {
      const messages = cancelledCreditRetry();
      const { host } = renderList(messages);
      const blocks = Array.from(
        host.querySelectorAll('[data-block-probe]'),
      ).map((node) => node.getAttribute('data-block-probe'));
      expect(
        blocks.some((block) => block?.includes('CANOPY_AI_CREDITS_PROXY')),
      ).toBe(true);
      expect(blocks).toContain('text:Ready for your project summary');
      expect(
        host.querySelectorAll(
          '[data-chat-turn-group="can4450-qa-original-1793228699314"]',
        ),
      ).toHaveLength(1);
      const footerLabel = host.querySelector(
        `[data-testid="turn-timer-label"][title="Cancelled at ${new Date(1793229281367).toLocaleString()}"]`,
      );
      expect(footerLabel?.textContent).toBe('Cancelled after 0:29');
      expect(
        host.querySelector(
          '[data-timer-id="a2cf1be5-0d48-4d6c-8743-1f636499bcd7"]',
        ),
      ).toBeNull();
      expect(
        host.querySelector(
          `[title="Completed at ${new Date(1793228712687).toLocaleString()}"]`,
        ),
      ).toBeNull();
      expect(
        host.querySelectorAll(
          '[data-block-probe="turn_timer:"], [data-testid="turn-timer"]',
        ),
      ).toHaveLength(3);
    } finally {
      mockCancelledRetry = false;
    }
  });

  it('retains the notice and both attempt timers after partial output and native Stop', () => {
    const { host } = renderList(nativeStoppedCreditRetry());
    expect(
      Array.from(host.querySelectorAll('[data-block-probe]')).some((node) =>
        node
          .getAttribute('data-block-probe')
          ?.includes('CANOPY_AI_CREDITS_PROXY'),
      ),
    ).toBe(true);
    expect(
      host.querySelectorAll(
        '[data-block-probe="turn_timer:"], [data-testid="turn-timer"]',
      ),
    ).toHaveLength(4);
  });

  it('removes the recovered inline credit notice while preserving the answer and historical raw failure', () => {
    const { host } = renderList(CREDIT_RETRY_MESSAGES);
    const blocks = Array.from(host.querySelectorAll('[data-block-probe]')).map(
      (node) => node.getAttribute('data-block-probe'),
    );
    expect(
      blocks.some((block) => block?.includes('CANOPY_AI_CREDITS_PROXY')),
    ).toBe(false);
    expect(blocks).toContain('text:Ready for your project summary');
    expect(blocks).toContain(
      'text:API Error: 402 AI Credits are unavailable for this request.',
    );
    expect(
      host.querySelectorAll(
        '[data-chat-turn-group="can4450-qa-original-1793228699314"]',
      ),
    ).toHaveLength(1);
  });

  it('removes only the obsolete credit-attempt timer, retaining timing for visible historical content and the reply', () => {
    const { host } = renderList(CREDIT_RETRY_MESSAGES);
    expect(
      host.querySelectorAll(
        '[data-block-probe="turn_timer:"], [data-testid="turn-timer"]',
      ),
    ).toHaveLength(3);
  });

  it('keeps the inline notice and failed timer while Retry is still held', () => {
    const { host } = renderList(CREDIT_RETRY_MESSAGES.slice(0, -2));
    expect(
      Array.from(host.querySelectorAll('[data-block-probe]')).some((node) =>
        node
          .getAttribute('data-block-probe')
          ?.includes('CANOPY_AI_CREDITS_PROXY'),
      ),
    ).toBe(true);
    expect(
      host.querySelectorAll(
        '[data-block-probe="turn_timer:"], [data-testid="turn-timer"]',
      ),
    ).toHaveLength(3);
  });
});
