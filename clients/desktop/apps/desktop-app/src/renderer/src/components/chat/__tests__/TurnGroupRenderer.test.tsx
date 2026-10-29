/** @jest-environment jsdom */
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ComponentProps, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { BRAND } from '@canopy/brand/current';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  AppAdvisorIcon,
  CodeBracketsIcon,
  PlanModeIcon,
} from '@canopy/ui-shared/icons';
import { TurnGroupRenderer } from '../TurnGroupRenderer';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import type { TurnGroup } from '../types';
import type * as TurnTimerModule from '../TurnTimer';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';
import {
  displayMessageHasVisual,
  visualOnlyDisplayMessage,
} from '@canopy/desktop-shared/lib/display-message-visual';
import type { ChatVisualOwner } from '@canopy/ui-app';
import type * as UiAppModule from '@canopy/ui-app';

jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<typeof UiAppModule>('@canopy/ui-app'),
  ChatVisualBlock: ({
    variant,
  }: {
    owner: ChatVisualOwner;
    variant: string;
  }): JSX.Element => (
    <span data-testid="chat-visual-block" data-variant={variant} />
  ),
  ChatVisualSourceButton: (): null => null,
}));

const forkTabMock = jest.fn();
const branchTabMock = jest.fn();
let mockBranchAction: (() => void) | undefined;

jest.mock('../TurnTimer', () => {
  const actual = jest.requireActual<typeof TurnTimerModule>('../TurnTimer');
  return {
    ...actual,
    TurnTimer: (
      props: ComponentProps<typeof actual.TurnTimer>,
    ): JSX.Element => {
      mockBranchAction = props.onBranch;
      return <actual.TurnTimer {...props} />;
    },
  };
});

let chatStoreState: Record<string, unknown> = {};
let mockEarlyAccess = false;

let mockSubagentsView = false;

jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (id: string): boolean =>
    id === 'subagents-view' ? mockSubagentsView : mockEarlyAccess,
}));

let mockLiveStepWindow = false;

jest.mock('@/stores/chatLiveStepWindowStore', () => ({
  useChatLiveStepWindowEnabled: (): boolean => mockLiveStepWindow,
}));

let mockGroupToolCalls = false;

jest.mock('@/stores/chatGroupToolCallsStore', () => ({
  useChatGroupToolCallsEnabled: (): boolean => mockGroupToolCalls,
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      forkTab: forkTabMock,
      branchTab: branchTabMock,
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      ...chatStoreState,
    }),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => chatStoreState),
}));

jest.mock('@/components/watchers/ChatWatcherButton', () => ({
  ChatWatcherButton: ({ chatId }: { chatId: string }): JSX.Element => (
    <button type="button" data-testid={`chat-watcher-button-${chatId}`}>
      Watch this chat
    </button>
  ),
}));

jest.mock('../ActiveAgentActivitySection', () => ({
  ActiveAgentActivitySection: ({
    variant,
    knownPipelineRuns,
  }: {
    variant?: string;
    knownPipelineRuns?: Record<string, unknown>;
  }): JSX.Element => (
    <div
      data-testid="live-watcher-activity"
      data-variant={variant}
      data-known-pipeline-runs={Object.keys(knownPipelineRuns ?? {}).join(',')}
    />
  ),
}));

function activeTurnGroup(): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Keep working' }],
      timestamp: 1,
    },
    assistantMessages: [],
    timerMessage: {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
      timestamp: 2,
    },
    isComplete: false,
  };
}

/** A completed turn whose only intermediate tool call is the shared
 * plan/review comment tool `GetReviewComments`, so it collapses into the
 * `plan`-category summary chip — the surface under test for the icon swap. */
function completedTurnGroupWithReviewToolCall(): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Check the review comments' }],
      timestamp: 1,
    },
    assistantMessages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'GetReviewComments',
            input: '{}',
            result: { output: '[]', isError: false },
          },
        ],
        timestamp: 2,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Done reviewing' }],
        timestamp: 3,
      },
    ],
    timerMessage: {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
      timestamp: 5,
    },
    isComplete: true,
  };
}

function completedTurnGroupWithSetBaseBranchToolCall(): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Change the base branch' }],
      timestamp: 1,
    },
    assistantMessages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'app_advisor_dispatch_action',
            input:
              '{"action":{"type":"worktree.set_base_branch","projectId":"project-1","worktreeId":"worktree-1","baseBranch":"release/next"}}',
            result: { output: '{}', isError: false },
          },
        ],
        timestamp: 2,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Base branch updated' }],
        timestamp: 3,
      },
    ],
    timerMessage: {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
      timestamp: 5,
    },
    isComplete: true,
  };
}

function completedTurnGroupWithWorktreeSetBaseBranchToolCall(): TurnGroup {
  const group = completedTurnGroupWithSetBaseBranchToolCall();
  const firstAssistant = group.assistantMessages[0];
  if (firstAssistant?.blocks[0]?.type === 'tool_use') {
    firstAssistant.blocks[0].toolName = 'canopy_set_base_branch';
    firstAssistant.blocks[0].input = '{"baseBranch":"release/next"}';
  }
  return group;
}

function completedTurnGroup(): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Do the thing' }],
      timestamp: 1,
    },
    assistantMessages: [],
    timerMessage: {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
      timestamp: 2,
    },
    isComplete: true,
  };
}

describe('clean chat look summary', () => {
  function finishedWorkTurn(): TurnGroup {
    const group = completedTurnGroup();
    group.assistantMessages = [
      {
        id: 'work',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'bash-1',
            toolName: 'Bash',
            input: '{"command":"ls"}',
            result: { output: 'ok', isError: false },
          },
          {
            type: 'tool_use',
            toolUseId: 'read-1',
            toolName: 'Read',
            input: '{"file_path":"a.ts"}',
            result: { output: 'ok', isError: false },
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ];
    return group;
  }

  function renderIn(look: 'classic' | 'clean'): string {
    return renderToStaticMarkup(
      <ChatLookProvider value={look}>
        <TurnGroupRenderer
          group={finishedWorkTurn()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );
  }

  it('keeps icon chips under the classic look', () => {
    const html = renderIn('classic');
    expect(html).toContain('title="bash"');
    expect(html).not.toContain('data-testid="turn-work-header"');
  });

  it('folds the steps under a "Worked for" header under the clean look', () => {
    const html = renderIn('clean');
    expect(html).toContain('data-testid="turn-work-header"');
    expect(html).toContain('data-turn-header="done"');
    expect(html).toContain('Worked');
    // What the steps did reads as words on hover.
    expect(html).toContain('title="Ran 1 command, read 1 file"');
    expect(html).not.toContain('title="bash"');
  });

  it('offers one Copy message in the reply row under either look', () => {
    // CAN-4704: every finished reply keeps a visible Copy, not just clean.
    for (const look of ['classic', 'clean'] as const) {
      const html = renderIn(look);
      expect(html.match(/data-testid="turn-copy-message"/g)).toHaveLength(1);
      expect(html).toContain('aria-label="Copy message"');
    }
  });
});

describe('collapsed visual retention', () => {
  it('does not duplicate a visual already in the final message', () => {
    const group = completedTurnGroup();
    group.assistantMessages = [
      {
        id: 'final-visual',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'final-tool',
            toolName: 'canopy_show_visual',
            input: '{}',
            result: {
              output: 'Shown',
              isError: false,
              messageId: 'final-visual',
              toolUseId: 'final-tool',
              visualRef: {
                version: 1,
                visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
                artifactId: `sha256-v1-${'a'.repeat(64)}`,
                sha256: 'a'.repeat(64),
                byteLength: 4,
                mediaType: 'text/html',
                title: 'Final visual',
                maxHeight: 320,
              },
            },
          },
          { type: 'text', text: 'Final answer' },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        group={group}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
    expect(html.match(/data-testid="chat-visual-block"/g)).toHaveLength(1);
    expect(html).toContain('data-variant="inline"');
  });

  it('keeps an intermediate visual but hides its tool row and prose', () => {
    const group = completedTurnGroupWithReviewToolCall();
    const visualMessage = {
      id: 'visual-result',
      role: 'assistant' as const,
      timestamp: 2,
      blocks: [
        {
          type: 'tool_use' as const,
          toolUseId: 'visual-tool',
          toolName: 'mcp__canopy__ShowVisual',
          input: '{}',
          result: {
            output: 'Shown',
            isError: false,
            messageId: 'visual-result',
            toolUseId: 'visual-tool',
            visualRef: {
              version: 1 as const,
              visualId: 'vis_123e4567-e89b-12d3-a456-426614174000',
              artifactId: `sha256-v1-${'a'.repeat(64)}`,
              sha256: 'a'.repeat(64),
              byteLength: 4,
              mediaType: 'text/html' as const,
              title: 'Retained chart',
              maxHeight: 320,
            },
          },
        },
        { type: 'thinking' as const, text: 'Hidden intermediate reasoning' },
      ],
    };
    group.assistantMessages.splice(1, 0, visualMessage);
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        group={group}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
    expect(html).toContain('data-variant="visual-only"');
    expect(html).not.toContain('Hidden intermediate reasoning');
    expect(html).toContain('Done reviewing');
    expect(displayMessageHasVisual(visualMessage)).toBe(true);
    expect(visualOnlyDisplayMessage(visualMessage)).toBe(
      visualOnlyDisplayMessage(visualMessage),
    );
    expect(visualOnlyDisplayMessage(visualMessage).blocks).toHaveLength(1);
  });

  it('admits visual messages through progressive batches after expansion', () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const group = completedTurnGroup();
    group.assistantMessages = Array.from({ length: 110 }, (_, index) => ({
      id: `tool-message-${index}`,
      role: 'assistant' as const,
      timestamp: index + 2,
      blocks: [
        {
          type: 'tool_use' as const,
          toolUseId: `tool-${index}`,
          toolName: 'Read',
          input: '{}',
          result: {
            output: 'ok',
            isError: false,
            ...(index === 70
              ? {
                  messageId: `tool-message-${index}`,
                  toolUseId: `tool-${index}`,
                  visualRef: {
                    version: 1 as const,
                    visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
                    artifactId: `sha256-v1-${'a'.repeat(64)}`,
                    sha256: 'a'.repeat(64),
                    byteLength: 4,
                    mediaType: 'text/html' as const,
                    title: 'Batched visual',
                    maxHeight: 320,
                  },
                }
              : {}),
          },
        },
      ],
    }));
    group.assistantMessages.push({
      id: 'final',
      role: 'assistant',
      timestamp: 200,
      blocks: [{ type: 'text', text: 'Finished' }],
    });
    const frames: FrameRequestCallback[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelFrame = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <TurnGroupRenderer
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />,
        ),
      );
      expect(
        container.querySelector('[data-chat-message-id="tool-message-70"]'),
      ).not.toBeNull();
      const summary = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Agent steps:"]',
      );
      expect(summary).not.toBeNull();
      act(() => summary?.click());
      expect(
        container.querySelector('[data-chat-message-id="tool-message-70"]'),
      ).toBeNull();
      for (let index = 0; index < 12; index += 1) {
        const next = frames.shift();
        if (!next) break;
        act(() => next(index * 16));
      }
      expect(
        container.querySelector('[data-chat-message-id="tool-message-70"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});

describe('TurnGroupRenderer collapsed summary icon', () => {
  it('shows the code-flavored icon for the plan-category chip in Code Review chats', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroupWithReviewToolCall()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        targetOverride={{
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        }}
      />,
    );
    expect(html).toContain(renderToStaticMarkup(<CodeBracketsIcon />));
  });

  it('keeps the Plan Explore map icon for the plan-category chip in Plan Explore chats', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroupWithReviewToolCall()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        targetOverride={{
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: 'plan-1',
          chatId: 'chat-1',
        }}
      />,
    );
    expect(html).toContain(renderToStaticMarkup(<PlanModeIcon />));
    expect(html).not.toContain(renderToStaticMarkup(<CodeBracketsIcon />));
  });

  it('maps set-base-branch calls to the App Advisor summary block', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroupWithSetBaseBranchToolCall()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );

    expect(html).toContain(renderToStaticMarkup(<AppAdvisorIcon />));
    expect(html).toContain('1 app advisor');
    expect(html).not.toContain('1 other');
  });

  it('maps the worktree SetBaseBranch tool to the branded app summary block', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroupWithWorktreeSetBaseBranchToolCall()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];

    expect(html).toContain('1 app');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).not.toContain('1 app advisor');
    expect(html).not.toContain('1 other');
  });
});

function withWorktreeChatTab(
  projectId = 'project',
  worktreeId = 'worktree',
): void {
  chatStoreState = {
    worktreeChats: {
      [`${projectId}/${worktreeId}`]: {
        tabs: [
          {
            id: 'chat-1',
            kind: 'chat',
            title: 'My session',
            messages: [{ id: 'm1' }],
            queuedMessages: [],
            status: 'idle',
          },
        ],
      },
    },
  };
}

describe('recorded turn outcome visibility (CAN-4278)', () => {
  it.each(['failed', 'cancelled', 'completed', undefined] as const)(
    'applies the label reveal policy for outcome %s',
    (outcome) => {
      chatStoreState = {
        worktreeChats: {
          'project/worktree': {
            tabs: [
              {
                id: 'chat-1',
                kind: 'chat',
                title: 'My session',
                messages: [],
                queuedMessages: [],
                status: 'idle',
                turnEnds:
                  outcome === undefined
                    ? {}
                    : { 'user-1': { outcome, endedAt: 5 } },
              },
            ],
          },
        },
      };
      try {
        const html = renderToStaticMarkup(
          <TurnGroupRenderer
            chatId="chat-1"
            group={completedTurnGroup()}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup={false}
          />,
        );
        const host = document.createElement('div');
        host.innerHTML = html;
        const label = host.querySelector('[data-testid="turn-timer-label"]');
        expect(label).not.toBeNull();
        if (outcome === 'failed' || outcome === 'cancelled') {
          expect(label?.className).not.toContain('opacity-0');
        } else {
          expect(label?.className).toContain('opacity-0');
        }
      } finally {
        chatStoreState = {};
      }
    },
  );
});

describe('TurnGroupRenderer active fork action', () => {
  beforeEach(() => {
    forkTabMock.mockReset();
    branchTabMock.mockReset();
    mockBranchAction = undefined;
    chatStoreState = {};
    registerCoworkWorkspaceIds([]);
  });

  it('branches the panel owner when another worktree is selected', () => {
    withWorktreeChatTab('owner-project', 'owner-worktree');
    renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        targetOverride={{
          projectId: 'owner-project',
          worktreeId: 'owner-worktree',
          chatId: 'chat-1',
        }}
      />,
    );

    expect(mockBranchAction).toBeDefined();
    mockBranchAction?.();
    expect(branchTabMock).toHaveBeenCalledWith(
      'chat-1',
      { projectId: 'owner-project', worktreeId: 'owner-worktree' },
      { forkAfterUserMessageId: 'user-1' },
    );
  });

  it('shows the inline active fork action for non-terminal sessions', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        sourceSdkSessionId="session-1"
      />,
    );

    expect(html).toContain('aria-label="Fork');
  });

  it('hides the inline active fork action for Claude terminal sessions', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        sourceSdkSessionId="session-1"
        suppressActiveForkAction
      />,
    );

    expect(html).not.toContain('aria-label="Fork');
  });

  it('shows the watcher button for active real worktree turns', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );

    expect(html).toContain('data-testid="chat-watcher-button-chat-1"');
  });

  it('hides the watcher button for synthetic plan-explore turns', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        targetOverride={{
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: 'plan-1',
          chatId: 'chat-1',
        }}
      />,
    );

    expect(html).not.toContain('data-testid="chat-watcher-button-chat-1"');
  });

  // Shared-container recipients read the same transcript; no footer control
  // forks, branches, shares, rates or watches a turn in a read-only scope.
  it('drops every footer turn action in a read-only scope', () => {
    withWorktreeChatTab();
    const readOnly = {
      mode: 'read-only',
      reason: 'shared-container',
      containerType: 'CODE_WORKTREE',
      runAllowed: false,
    } as const;
    const completed = renderToStaticMarkup(
      <WorkspaceAccessContext.Provider value={readOnly}>
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </WorkspaceAccessContext.Provider>,
    );
    const active = renderToStaticMarkup(
      <WorkspaceAccessContext.Provider value={readOnly}>
        <TurnGroupRenderer
          chatId="chat-1"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          sourceSdkSessionId="session-1"
        />
      </WorkspaceAccessContext.Provider>,
    );

    expect(completed).not.toContain('data-testid="turn-share-session"');
    expect(completed).not.toContain('aria-label="Fork');
    expect(active).not.toContain('aria-label="Fork');
    expect(active).not.toContain('data-testid="chat-watcher-button-chat-1"');
  });

  it('shows the Share control on the last forkable completed turn', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );

    expect(html).toContain('data-testid="turn-share-session"');
  });

  it('shows the Share control on the last completed Cowork turn', () => {
    registerCoworkWorkspaceIds(['cowork-project']);
    withWorktreeChatTab('cowork-project', 'cowork-entry');
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        targetOverride={{
          projectId: 'cowork-project',
          worktreeId: 'cowork-entry',
          chatId: 'chat-1',
        }}
      />,
    );

    expect(html).toContain('data-testid="turn-share-session"');
  });

  it('hides the Share control while the turn is still active', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        sourceSdkSessionId="session-1"
      />,
    );

    expect(html).not.toContain('data-testid="turn-share-session"');
  });
});

/**
 * A completed turn whose timer message is NOT exactly one `turn_timer` block.
 *
 * `timerBlock` is derived as `blocks.length === 1 && blocks[0].type ===
 * 'turn_timer'`, so this shape falls to the `else` branch. The feedback control
 * normally rides inside `TurnTimer`'s pinned-end slot, and before CAN-1521's
 * follow-up that branch dropped it silently — this turn would render no thumbs
 * at all.
 */
function completedTurnGroupWithoutTimerBlock(): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Do the thing' }],
      timestamp: 1,
    },
    assistantMessages: [],
    timerMessage: {
      id: 'timer-1',
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: 1, completedAt: 5 },
        { type: 'text', text: 'trailing system note' },
      ],
      timestamp: 2,
    },
    isComplete: true,
  };
}

describe('TurnGroupRenderer reply Copy (CAN-4704)', () => {
  function withReply(
    group: TurnGroup,
    text = '# Plan\n\n- **one**',
  ): TurnGroup {
    group.assistantMessages = [
      {
        id: 'final',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text }],
      },
    ];
    return group;
  }

  function renderIn(look: 'classic' | 'clean', group: TurnGroup): string {
    withWorktreeChatTab();
    return renderToStaticMarkup(
      <ChatLookProvider value={look}>
        <TurnGroupRenderer
          chatId="chat-1"
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup={false}
          isLastForkableTurnGroup={false}
        />
      </ChatLookProvider>,
    );
  }

  function copyCount(html: string): number {
    return html.match(/data-testid="turn-copy-message"/g)?.length ?? 0;
  }

  it.each(['classic', 'clean'] as const)(
    'gives a %s reply under an alternate timer message one Copy beside its thumbs',
    (look) => {
      const html = renderIn(
        look,
        withReply(completedTurnGroupWithoutTimerBlock()),
      );
      expect(copyCount(html)).toBe(1);
      const row = html.slice(html.indexOf('data-testid="turn-feedback-row"'));
      expect(row.indexOf('data-testid="turn-copy-message"')).toBeGreaterThan(
        -1,
      );
      expect(row.indexOf('data-testid="turn-copy-message"')).toBeLessThan(
        row.indexOf('data-testid="turn-feedback-up"'),
      );
    },
  );

  it("keeps a historical classic reply's Copy visible at rest in the timer row", () => {
    const html = renderIn('classic', withReply(completedTurnGroup()));
    expect(copyCount(html)).toBe(1);
    expect(html).not.toContain('data-testid="turn-feedback-row"');
    const host = document.createElement('div');
    host.innerHTML = html;
    const copy = host.querySelector('[data-testid="turn-copy-message"]');
    const row = host.querySelector('[data-testid="turn-timer"]');
    for (let node = copy; node && node !== row; node = node.parentElement) {
      expect(node.className).not.toContain('opacity-0');
    }
  });

  it('offers no Copy for a running turn or a turn without reply text', () => {
    const running = withReply(completedTurnGroupWithoutTimerBlock());
    running.isComplete = false;
    expect(copyCount(renderIn('classic', running))).toBe(0);
    const incomplete = withReply(completedTurnGroup());
    incomplete.isComplete = false;
    expect(copyCount(renderIn('classic', incomplete))).toBe(0);
    expect(
      copyCount(
        renderIn(
          'classic',
          withReply(completedTurnGroupWithoutTimerBlock(), ' \n '),
        ),
      ),
    ).toBe(0);
    expect(
      copyCount(renderIn('classic', completedTurnGroupWithoutTimerBlock())),
    ).toBe(0);
  });
});

describe('TurnGroupRenderer turn feedback placement (CAN-1521)', () => {
  it('still renders the feedback control when there is no single turn_timer block', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroupWithoutTimerBlock()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );

    // The fallback row exists, and the thumbs are inside it.
    expect(html).toContain('data-testid="turn-feedback-row"');
    expect(html).toContain('data-testid="turn-feedback-up"');
    expect(html).toContain('data-testid="turn-feedback-down"');
    // CAN-4278: like the thumbs in the timer row, the fallback row stays
    // visible at rest.
    const rowClasses =
      /data-testid="turn-feedback-row"[^>]*class="([^"]*)"/.exec(html)?.[1];
    expect(rowClasses).toBeDefined();
    expect(rowClasses).not.toContain('opacity-0');
  });

  it('renders the control inside the timer row (not the fallback row) for a normal turn', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat-1"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );

    // Exactly one control, and the fallback row must NOT also appear —
    // the two branches are mutually exclusive, so this pins "no duplication".
    expect(html).toContain('data-testid="turn-feedback-up"');
    expect(html).not.toContain('data-testid="turn-feedback-row"');
  });
});

describe('unanswered async questions in collapsed turns', () => {
  it.each(
    ['pending', 'answered', 'dismissed', 'missing'].flatMap((state) => [
      { state, sparse: false },
      { state, sparse: true },
    ]),
  )(
    'leaves waiting questions to the composer ($state, sparse=$sparse)',
    ({ state, sparse }) => {
      const group = completedTurnGroupWithReviewToolCall();
      group.assistantMessages.unshift({
        id: 'question-message',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'thinking', text: 'Hidden question reasoning' },
          {
            type: 'text',
            text: 'Which scope?',
            asyncQuestion: {
              requestId: 'pending-question',
              questions: [{ title: 'Which scope?', options: ['Full'] }],
            },
          },
        ],
      });
      const fullSummary = computeTurnSummary(
        group.assistantMessages.slice(0, -1),
      );
      if (sparse)
        group.assistantMessages = group.assistantMessages.filter(
          (message) => message.id !== 'assistant-1',
        );
      const html = renderToStaticMarkup(
        <TurnGroupRenderer
          group={group}
          transcriptTurn={
            sparse
              ? {
                  id: group.userMessage.id,
                  start: 0,
                  end: 1000,
                  complete: true,
                  before: 984,
                  finalMessageIds: ['assistant-2'],
                  summary: fullSummary,
                }
              : undefined
          }
          chatPendingQuestions={
            state === 'missing'
              ? []
              : [
                  {
                    requestId: 'pending-question',
                    projectId: 'project',
                    worktreeId: 'worktree',
                    chatId: 'chat-1',
                    delivery: 'async',
                    questions: [
                      {
                        question: 'Which scope?',
                        options: ['Full'],
                        allowOther: true,
                      },
                    ],
                    ...(state === 'answered'
                      ? {
                          answeredAt: 5,
                          answers: [
                            {
                              question: 'Which scope?',
                              selectedOptions: ['Full'],
                            },
                          ],
                        }
                      : {}),
                    ...(state === 'dismissed' ? { dismissedAt: 5 } : {}),
                  },
                ]
          }
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
      // A waiting question asks in the composer, not in the transcript.
      expect(html).not.toContain('data-testid="ask-user-question-card"');
      expect(html).not.toContain('Hidden question reasoning');
      expect(html).toContain('Done reviewing');
      if (state === 'pending') expect(html).not.toContain('Which scope?');
    },
  );
});

describe('background watcher activity recovery', () => {
  it('hydrates watched activity on the latest completed turn without saved artifacts', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="background-chat"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
    expect(html).toContain('data-testid="live-watcher-activity"');
    expect(html).toContain('data-variant="completed"');
  });

  it('recovers a pipeline-id-only watcher from known chat-initiated runs', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="background-chat"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        knownPipelineRuns={{
          'exec-1': {
            version: 1,
            kind: 'pipeline_run',
            operation: 'pipeline.run',
            dedupeKey: 'canopy:pipeline_run:execution:exec-1',
            createdAt: '2026-09-18T00:00:00.000Z',
            executionId: 'exec-1',
            pipelineId: 'pipe-1',
            pipelineName: 'Build',
            initialStatus: 'running',
            queuedAt: '2026-09-18T00:00:00.000Z',
            projectId: 'project',
            worktreeId: 'worktree',
            navigationTarget: {
              kind: 'pipeline_execution',
              executionId: 'exec-1',
              projectId: 'project',
              worktreeId: 'worktree',
            },
          },
        }}
      />,
    );

    expect(html).toContain('data-known-pipeline-runs="exec-1"');
  });

  it('shows the running latest turn’s activity in the turn under the Subagents view', () => {
    // No pinned section: its background tasks, runs and artifacts list in
    // the turn while it runs; subagents live in the top bar's running count.
    mockSubagentsView = true;
    try {
      const html = renderToStaticMarkup(
        <TurnGroupRenderer
          chatId="background-chat"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
      expect(html).toContain('data-testid="live-watcher-activity"');
      expect(html).toContain('data-variant="completed"');
    } finally {
      mockSubagentsView = false;
    }
  });

  it('leaves a running latest turn’s activity to the pinned section while the view is off', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="background-chat"
        group={activeTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
    expect(html).not.toContain('data-testid="live-watcher-activity"');
  });

  it('does not attach current watchers to older completed turns', () => {
    const html = renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="background-chat"
        group={completedTurnGroup()}
        chatPendingQuestions={[]}
        isLastTurnGroup={false}
        isLastForkableTurnGroup={false}
      />,
    );
    expect(html).not.toContain('data-testid="live-watcher-activity"');
  });
});

it('renders only a spinner and Working label while the submitted turn awaits its real timer', () => {
  const markup = renderToStaticMarkup(
    <TurnGroupRenderer
      chatId="chat"
      group={activeTurnGroup()}
      pendingTimer
      chatPendingQuestions={[]}
      isLastTurnGroup
      isLastForkableTurnGroup
      sourceSdkSessionId="session"
    />,
  );
  expect(markup).toContain('data-testid="turn-timer-label"');
  expect(markup).toContain('>Working…</span>');
  expect(markup).not.toContain('chat-watcher-button-chat');
  expect(markup).not.toContain('aria-label="Fork chat');
});

describe('grouped tool calls (Group tool calls setting)', () => {
  function runningTurnWithToolCalls(): TurnGroup {
    const read = (
      id: string,
      path: string,
    ): TurnGroup['assistantMessages'][number] => ({
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `tool-${id}`,
          toolName: 'Read',
          input: JSON.stringify({ file_path: path }),
          result: { output: 'ok', isError: false },
        },
      ],
      timestamp: 2,
    });
    return {
      ...activeTurnGroup(),
      assistantMessages: [
        {
          id: 'intro',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Reading the files first.' }],
          timestamp: 2,
        },
        read('read-1', '/repo/a.ts'),
        read('read-2', '/repo/b.ts'),
        read('read-3', '/repo/c.ts'),
      ],
    };
  }

  function renderTurn(): string {
    return renderToStaticMarkup(
      <TurnGroupRenderer
        chatId="chat"
        group={runningTurnWithToolCalls()}
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
      />,
    );
  }

  afterEach(() => {
    mockEarlyAccess = false;
    mockGroupToolCalls = false;
    mockLiveStepWindow = false;
  });

  it('shows every tool call as its own row by default', () => {
    const html = renderTurn();
    expect(html).not.toContain('data-testid="chat-tool-step-group"');
    expect(html.match(/data-testid="chat-tool-call"/g)).toHaveLength(3);
    expect(html).toContain('Reading the files first.');
  });

  it('keeps every row with early access on, as grouping is its own setting', () => {
    mockEarlyAccess = true;
    const html = renderTurn();
    expect(html).not.toContain('data-testid="chat-tool-step-group"');
    expect(html.match(/data-testid="chat-tool-call"/g)).toHaveLength(3);
  });

  it('folds back-to-back tool calls into one row when the setting is on', () => {
    mockGroupToolCalls = true;
    const html = renderTurn();
    expect(html).toContain('data-testid="chat-tool-step-group"');
    expect(html.match(/data-testid="chat-tool-step-group"/g)).toHaveLength(1);
    expect(html).toContain('Read 3 files');
    expect(html).toContain('Reading the files first.');
    expect(html).not.toContain('data-testid="chat-tool-call"');
  });
});

describe('live step window (CAN-4274)', () => {
  type Message = TurnGroup['assistantMessages'][number];

  function thought(id: string, text = `Thinking about ${id}`): Message {
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'thinking', text }],
      timestamp: 2,
    };
  }

  function calls(id: string, names: string[], running = false): Message {
    return {
      id,
      role: 'assistant',
      blocks: names.map((name, index) => ({
        type: 'tool_use' as const,
        toolUseId: `${id}-${index}`,
        toolName: name,
        input: JSON.stringify(
          name === 'Bash'
            ? { command: 'npm test', description: `Run ${id}` }
            : { file_path: `/repo/${id}-${index}.ts`, pattern: id },
        ),
        ...(running && index === names.length - 1
          ? {}
          : { result: { output: 'ok', isError: false } }),
      })),
      timestamp: 2,
    };
  }

  function say(id: string, text: string): Message {
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: 3,
    };
  }

  function turn(messages: Message[], isComplete = false): TurnGroup {
    const base = activeTurnGroup();
    return isComplete
      ? {
          ...base,
          assistantMessages: messages,
          timerMessage: {
            id: 'timer-1',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 9 }],
            timestamp: 9,
          },
          isComplete: true,
        }
      : { ...base, assistantMessages: messages };
  }

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockEarlyAccess = false;
    mockLiveStepWindow = false;
    mockGroupToolCalls = false;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function show(group: TurnGroup): void {
    act(() =>
      root.render(
        <TurnGroupRenderer
          chatId="chat"
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      ),
    );
  }

  function groups(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="chat-tool-step-group"]',
      ),
    );
  }

  /** Message ids of the rows shown in a group's live window. */
  function liveIds(group: HTMLElement | undefined): string[] {
    const live = group?.querySelector('[data-testid="chat-tool-step-live"]');
    return Array.from(
      live?.querySelectorAll('[data-chat-message-id]') ?? [],
      (row) => row.getAttribute('data-chat-message-id') ?? '',
    );
  }

  function liveToolRows(group: HTMLElement | undefined): number {
    return (
      group
        ?.querySelector('[data-testid="chat-tool-step-live"]')
        ?.querySelectorAll('[data-testid="chat-tool-call"]').length ?? 0
    );
  }

  function toggle(group: HTMLElement | undefined): HTMLButtonElement {
    const button = group?.querySelector('button');
    if (!button) throw new Error('Group row not rendered');
    return button;
  }

  it.each([false, true])(
    'shows only the newest three steps while the turn runs (early access %p)',
    (earlyAccess) => {
      mockEarlyAccess = earlyAccess;
      mockLiveStepWindow = true;
      const messages: Message[] = [thought('think-1')];
      show(turn(messages));
      expect(groups()).toHaveLength(1);
      expect(liveIds(groups()[0])).toEqual(['think-1']);

      messages.push(calls('read-1', ['Read']), thought('think-2'));
      show(turn([...messages]));
      expect(liveIds(groups()[0])).toEqual(['think-1', 'read-1', 'think-2']);

      messages.push(calls('bash-1', ['Bash'], true));
      show(turn([...messages]));
      expect(liveIds(groups()[0])).toEqual(['read-1', 'think-2', 'bash-1']);
      expect(groups()).toHaveLength(1);
      expect(
        container.querySelectorAll('[data-chat-message-id="think-1"]'),
      ).toHaveLength(0);
    },
  );

  it('counts each call in a message that holds several and never repeats one', () => {
    mockLiveStepWindow = true;
    show(
      turn([
        thought('think-1'),
        calls('multi', ['Read', 'Grep', 'Read', 'Glob']),
      ]),
    );
    const [group] = groups();
    expect(liveIds(group)).toEqual(['multi']);
    expect(liveToolRows(group)).toBe(3);
    // Nothing outside the window renders a second copy of a call.
    expect(
      container.querySelectorAll('[data-testid="chat-tool-call"]'),
    ).toHaveLength(3);
    expect(
      container.querySelectorAll('[data-chat-message-id="multi"]'),
    ).toHaveLength(1);
  });

  it('keeps the same group element while steps stream in', () => {
    mockLiveStepWindow = true;
    const messages: Message[] = [thought('think-1'), calls('read-1', ['Read'])];
    show(turn(messages));
    const [first] = groups();
    for (let index = 2; index <= 6; index += 1) {
      messages.push(calls(`read-${index}`, ['Read']));
      show(turn([...messages]));
      expect(groups()[0]).toBe(first);
      expect(liveIds(groups()[0])).toEqual([
        index === 2 ? 'think-1' : `read-${index - 2}`,
        `read-${index - 1}`,
        `read-${index}`,
      ]);
    }
  });

  it('expands to every step live and collapses back to the window', () => {
    mockLiveStepWindow = true;
    const messages: Message[] = [
      thought('think-1'),
      calls('read-1', ['Read']),
      calls('read-2', ['Read']),
      calls('read-3', ['Read']),
    ];
    show(turn(messages));
    act(() => toggle(groups()[0]).click());
    expect(toggle(groups()[0]).getAttribute('aria-expanded')).toBe('true');
    expect(liveIds(groups()[0])).toEqual([]);
    expect(
      groups()[0]?.querySelectorAll('[data-chat-message-id]'),
    ).toHaveLength(4);

    messages.push(calls('read-4', ['Read'], true));
    show(turn([...messages]));
    expect(
      groups()[0]?.querySelectorAll('[data-chat-message-id]'),
    ).toHaveLength(5);

    act(() => toggle(groups()[0]).click());
    expect(liveIds(groups()[0])).toEqual(['read-2', 'read-3', 'read-4']);
  });

  it('shows agent text in full and compresses the steps before it', () => {
    mockLiveStepWindow = true;
    const message =
      'Let me check what Anthropic actually returns for your account.';
    show(
      turn([
        thought('think-1'),
        thought('think-2'),
        thought('think-3'),
        say('say-1', message),
        thought('think-4'),
        thought('think-5'),
        thought('think-6'),
        thought('think-7'),
      ]),
    );
    const [before, after] = groups();
    expect(groups()).toHaveLength(2);
    expect(liveIds(before)).toEqual([]);
    expect(
      before?.querySelector('[data-testid="chat-tool-step-summary"]')
        ?.textContent,
    ).toBe('Thought 3 times');
    expect(container.textContent).toContain(message);
    expect(liveIds(after)).toEqual(['think-5', 'think-6', 'think-7']);

    act(() => toggle(before).click());
    expect(before?.querySelectorAll('[data-chat-message-id]')).toHaveLength(3);
  });

  it('compresses every group when the turn finishes, and each still opens', () => {
    mockLiveStepWindow = true;
    const messages: Message[] = [
      thought('think-1'),
      calls('read-1', ['Read', 'Read']),
      say('say-1', 'Found the store.'),
      calls('read-2', ['Grep']),
      thought('think-2'),
      say('final', 'The tooltip is cached on start.'),
    ];
    show(turn(messages, true));
    const steps = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Agent steps:"]',
    );
    act(() => steps?.click());
    expect(groups()).toHaveLength(2);
    for (const group of groups()) {
      expect(liveIds(group)).toEqual([]);
      expect(group.querySelectorAll('[data-chat-message-id]')).toHaveLength(0);
    }
    act(() => toggle(groups()[1]).click());
    expect(
      groups()[1]?.querySelectorAll('[data-chat-message-id]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain('The tooltip is cached on start.');
  });

  it('shows no empty thinking shell in the window', () => {
    mockLiveStepWindow = true;
    show(
      turn([
        calls('read-1', ['Read']),
        calls('read-2', ['Read']),
        calls('read-3', ['Read']),
        thought('shell', ''),
      ]),
    );
    expect(liveIds(groups()[0])).toEqual(['read-1', 'read-2', 'read-3']);
  });

  it('keeps a thought row as the window slides inside one message', () => {
    // Cursor and OpenCode put thinking and calls in one activity message.
    mockLiveStepWindow = true;
    const activity = (count: number): Message => ({
      id: 'activity',
      role: 'assistant',
      blocks: Array.from({ length: count }, (_, index) =>
        index % 2 === 0
          ? { type: 'thinking' as const, text: `Thought number ${index}` }
          : {
              type: 'tool_use' as const,
              toolUseId: `call-${index}`,
              toolName: 'Read',
              input: JSON.stringify({ file_path: `/repo/${index}.ts` }),
              result: { output: 'ok', isError: false },
            },
      ),
      timestamp: 2,
    });
    const thoughtButton = (): HTMLButtonElement | undefined =>
      Array.from(
        groups()[0]?.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-tool-step-live"] button',
        ) ?? [],
      ).find((button) => button.textContent?.includes('Thought number 4'));

    show(turn([activity(5)]));
    const button = thoughtButton();
    const row = button?.parentElement;
    if (!button || !row) throw new Error('Thought row not rendered');
    act(() => button.click());
    expect(row.querySelector('pre')?.textContent).toBe('Thought number 4');

    // One more call slides the window by one step inside the same message.
    show(turn([activity(6)]));
    expect(row.isConnected).toBe(true);
    expect(row.querySelector('pre')?.textContent).toBe('Thought number 4');
  });

  it('compresses every group when the turn finishes, including ones opened while it ran', () => {
    mockLiveStepWindow = true;
    // A search reveal on the text keeps the finished turn expanded, so the
    // groups stay mounted across completion.
    const showSearching = (group: TurnGroup): void =>
      act(() =>
        root.render(
          <TurnGroupRenderer
            chatId="chat"
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
            searchMessageId="say-1"
          />,
        ),
      );
    const messages: Message[] = [
      thought('think-1'),
      calls('read-1', ['Read', 'Read']),
      say('say-1', 'Found the store.'),
      calls('read-2', ['Grep']),
    ];
    showSearching(turn(messages));
    const [closed, live] = groups();
    act(() => toggle(closed).click());
    act(() => toggle(live).click());
    expect(toggle(groups()[0]).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(groups()[1]).getAttribute('aria-expanded')).toBe('true');

    showSearching(turn([...messages, say('final', 'Done.')], true));
    expect(groups()).toHaveLength(2);
    for (const group of groups()) {
      expect(toggle(group).getAttribute('aria-expanded')).toBe('false');
      expect(group.querySelectorAll('[data-chat-message-id]')).toHaveLength(0);
    }
    act(() => toggle(groups()[0]).click());
    expect(
      groups()[0]?.querySelectorAll('[data-chat-message-id]'),
    ).toHaveLength(2);
  });

  describe('a message with text between its steps', () => {
    const agentText =
      'Let me check what Anthropic actually returns for your account.';

    /** A Claude assistant event: thinking, calls, text and more calls. */
    function mixed(running: boolean): Message {
      const call = (
        id: string,
        toolName: string,
        input: object,
        done = true,
      ): Message['blocks'][number] => ({
        type: 'tool_use',
        toolUseId: id,
        toolName,
        input: JSON.stringify(input),
        ...(done ? { result: { output: 'ok', isError: false } } : {}),
      });
      return {
        id: 'claude-1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'Planning the lookup' },
          call('c1', 'Read', { file_path: '/repo/a.ts' }),
          call('c2', 'Grep', { pattern: 'tooltip' }),
          { type: 'text', text: agentText },
          call('c3', 'Read', { file_path: '/repo/b.ts' }),
          call('c4', 'Glob', { pattern: '*.ts' }),
          { type: 'thinking', text: 'Comparing' },
          call(
            'c5',
            'Bash',
            { command: 'npm test', description: 'Run tests' },
            !running,
          ),
        ],
        timestamp: 2,
      };
    }

    let consoleError: jest.SpiedFunction<typeof console.error>;
    beforeEach(() => {
      consoleError = jest.spyOn(console, 'error');
    });
    afterEach(() => {
      const keyWarnings = consoleError.mock.calls.filter((call) =>
        String(call[0]).includes('same key'),
      );
      consoleError.mockRestore();
      expect(keyWarnings).toEqual([]);
    });

    it('shows the text once, in place, and windows the steps after it', () => {
      mockLiveStepWindow = true;
      show(turn([mixed(true)]));
      const [before, after] = groups();
      expect(groups()).toHaveLength(2);
      expect(liveIds(before)).toEqual([]);
      expect(liveToolRows(before)).toBe(0);
      expect(container.textContent?.split(agentText)).toHaveLength(2);
      // Text sits between the compressed group and the live one.
      const textRow = Array.from(
        container.querySelectorAll('[data-chat-message-id="claude-1"]'),
      ).find((row) => row.textContent?.includes(agentText));
      if (!before || !after || !textRow) throw new Error('Missing rows');
      expect(
        before.compareDocumentPosition(textRow) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        textRow.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Four steps after the text: the window shows the newest three.
      expect(liveToolRows(after)).toBe(2);
      expect(after.textContent).toContain('Comparing');
      expect(after.textContent).not.toContain('a.ts');
      expect(
        container.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(2);

      act(() => toggle(before).click());
      expect(
        before.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(2);
      expect(before.textContent).not.toContain(agentText);

      act(() => toggle(after).click());
      expect(liveIds(after)).toEqual([]);
      expect(
        after.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(3);
    });

    it('keeps the live group mounted as the message grows, and compresses it on completion', () => {
      mockLiveStepWindow = true;
      show(turn([mixed(true)]));
      const live = groups()[1];
      const grown = mixed(false);
      grown.blocks.push({
        type: 'tool_use',
        toolUseId: 'c6',
        toolName: 'Read',
        input: JSON.stringify({ file_path: '/repo/c.ts' }),
      });
      show(turn([grown]));
      expect(groups()[1]).toBe(live);
      expect(liveToolRows(live)).toBe(2);
      expect(live?.textContent).toContain('c.ts');

      show(turn([grown, say('final', 'Done.')], true));
      const steps = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Agent steps:"]',
      );
      act(() => steps?.click());
      expect(groups()).toHaveLength(2);
      for (const group of groups()) expect(liveIds(group)).toEqual([]);
      expect(container.textContent).toContain(agentText);
    });

    it('compresses a group the user opened when text ends its run, and it reopens', () => {
      mockLiveStepWindow = true;
      const opening = mixed(true);
      opening.blocks = opening.blocks.slice(0, 2);
      show(turn([opening]));
      act(() => toggle(groups()[0]).click());
      // More steps in the same live group keep it open.
      opening.blocks = mixed(true).blocks.slice(0, 3);
      show(turn([{ ...opening }]));
      expect(toggle(groups()[0]).getAttribute('aria-expanded')).toBe('true');
      expect(
        groups()[0]?.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(2);

      show(turn([mixed(true)]));
      const [before] = groups();
      expect(toggle(before).getAttribute('aria-expanded')).toBe('false');
      expect(
        before?.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(0);
      act(() => toggle(before).click());
      expect(toggle(groups()[0]).getAttribute('aria-expanded')).toBe('true');
      expect(
        groups()[0]?.querySelectorAll('[data-testid="chat-tool-call"]'),
      ).toHaveLength(2);
    });

    it('follows the OpenCode shape: text, then a call', () => {
      mockLiveStepWindow = true;
      show(
        turn([
          {
            id: 'opencode-message',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Inspected the project.' },
              {
                type: 'tool_use',
                toolUseId: 'read-1',
                toolName: 'Read',
                input: JSON.stringify({ file_path: 'README.md' }),
              },
            ],
            timestamp: 2,
          },
        ]),
      );
      expect(groups()).toHaveLength(1);
      expect(liveToolRows(groups()[0])).toBe(1);
      expect(container.textContent).toContain('Inspected the project.');
    });

    it.each([false, true])(
      'leaves the message whole with the setting off (early access %p)',
      (earlyAccess) => {
        mockEarlyAccess = earlyAccess;
        show(turn([mixed(true)]));
        expect(groups()).toHaveLength(0);
        expect(
          container.querySelectorAll('[data-chat-message-id="claude-1"]'),
        ).toHaveLength(1);
        expect(
          container.querySelectorAll('[data-testid="chat-tool-call"]'),
        ).toHaveLength(5);
      },
    );
  });

  describe('with the setting off', () => {
    function realisticTurn(): TurnGroup {
      return turn([
        thought('think-1'),
        calls('read-1', ['Read']),
        say('say-1', 'Reading the files first.'),
        calls('read-2', ['Read', 'Grep']),
        thought('think-2'),
        calls('read-3', ['Read']),
        calls('bash-1', ['Bash'], true),
      ]);
    }

    function markup(): string {
      return renderToStaticMarkup(
        <TurnGroupRenderer
          chatId="chat"
          group={realisticTurn()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    }

    it('keeps one row per step by default', () => {
      const html = markup();
      expect(html).not.toContain('data-testid="chat-tool-step-group"');
      expect(html).not.toContain('data-testid="chat-tool-step-live"');
    });

    it('keeps the grouping exactly as before when Group tool calls is on', () => {
      mockGroupToolCalls = true;
      const html = markup();
      expect(html).not.toContain('data-testid="chat-tool-step-live"');
      // The single call before the text stays a plain row; the later run
      // folds into one row that does not count thinking.
      expect(html.match(/data-testid="chat-tool-step-group"/g)).toHaveLength(1);
      expect(html).toContain('Read 2 files, searched 1 time, ran 1 command');
      expect(html).toContain('data-chat-message-id="read-1"');
      expect(html).not.toContain('Thought');
    });
  });
});
