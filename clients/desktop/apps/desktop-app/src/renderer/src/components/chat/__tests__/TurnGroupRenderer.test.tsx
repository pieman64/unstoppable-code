/** @jest-environment jsdom */
import {
  computeTurnSummary,
  type TurnToolResult,
} from '@canopy/desktop-shared/lib/turn-utils';
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
import type * as UiSharedComponentsModule from '@canopy/ui-shared/components';
import {
  buildGitHubWorkflowRunArtifactReceipt,
  buildPipelineRunArtifactReceipt,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import type {
  AgentArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';

// The outcome control's jump handler, as the renderer last passed it, so a
// test can request a step no tooltip entry offers (CAN-5056).
let mockLastOutcomeJump: ((toolUseId?: string) => void) | undefined;
// Chat detail: `recent` when the live step window is on, else `compact` when
// grouping is on, else `detailed`.
let mockLiveStepWindow = false;
let mockGroupToolCalls = false;
jest.mock('@canopy/ui-shared/components', () => {
  const actual = jest.requireActual<typeof UiSharedComponentsModule>(
    '@canopy/ui-shared/components',
  );
  return {
    ...actual,
    useChatDetail: (): ReturnType<typeof actual.useChatDetail> =>
      mockLiveStepWindow
        ? 'recent'
        : mockGroupToolCalls
          ? 'compact'
          : 'detailed',
    TurnOutcomeControl: (
      props: Parameters<typeof actual.TurnOutcomeControl>[0],
    ): ReturnType<typeof actual.TurnOutcomeControl> => {
      mockLastOutcomeJump = props.onJumpToOutcome;
      return actual.TurnOutcomeControl(props);
    },
  };
});

function lastOutcomeJump(): (toolUseId?: string) => void {
  if (!mockLastOutcomeJump) throw new Error('Missing outcome jump');
  return mockLastOutcomeJump;
}

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

function visualToolResult(
  visualRef: ChatVisualOwner['reference'],
  owner?: Pick<ChatVisualOwner, 'messageId' | 'toolUseId'>,
): TurnToolResult & {
  visualRef: ChatVisualOwner['reference'];
  messageId?: string;
  toolUseId?: string;
} {
  return Object.assign(
    { output: 'Shown', isError: false, visualRef },
    owner ?? {},
  );
}

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

jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
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

jest.mock('../DesktopAgentActivitySection', () => ({
  DesktopAgentActivitySection: ({
    artifacts,
  }: {
    artifacts: ReadonlyArray<{
      executionId?: string;
      runId?: string;
      dedupeKey: string;
    }>;
  }): JSX.Element => (
    <div
      data-testid="turn-agent-activity"
      data-artifacts={artifacts
        .map((a) => a.executionId ?? a.runId ?? a.dedupeKey)
        .join(',')}
    />
  ),
}));

const RECEIPT_AT = '2026-09-18T00:00:00.000Z';

function pipelineRun(
  operation: string,
  executionId: string,
): PipelineRunArtifactReceiptV1 {
  return buildPipelineRunArtifactReceipt({
    operation,
    createdAt: RECEIPT_AT,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: RECEIPT_AT,
    projectId: 'project',
    worktreeId: 'worktree',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project',
      worktreeId: 'worktree',
    },
  });
}

function githubRun(runId: string): AgentArtifactReceiptV1 {
  const htmlUrl = `https://github.com/acme/api/actions/runs/${runId}`;
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt: RECEIPT_AT,
    watcherId: 'gh-1',
    repository: 'acme/api',
    runId,
    runAttempt: 1,
    htmlUrl,
    state: { kind: 'intermediate', status: 'in_progress' },
    observedAt: RECEIPT_AT,
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId,
      htmlUrl,
    },
  });
}

const launchedRun = pipelineRun('pipeline.run', 'exec-1');
const watchedRun = pipelineRun('pipeline.watch', 'exec-2');
const watchedGitHubRun = githubRun('101');

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

describe('thinking icon', () => {
  it('marks thinking with the lightbulb in the default look, folded and open', () => {
    const group = completedTurnGroupWithReviewToolCall();
    group.assistantMessages.unshift({
      id: 'assistant-0',
      role: 'assistant',
      blocks: [{ type: 'thinking', text: 'Weighing the options' }],
      timestamp: 2,
    });
    for (const isLastTurnGroup of [false, true]) {
      const html = renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <TurnGroupRenderer
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup={isLastTurnGroup}
            isLastForkableTurnGroup={isLastTurnGroup}
          />
        </ChatLookProvider>,
      );
      expect(html).toContain('data-glyph="lightbulb"');
      expect(html).not.toContain('data-glyph="brain-circuit"');
    }
  });
});

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
    expect(html).toContain('title="Ran 1 command"');
    expect(html).not.toContain('data-testid="turn-work-header"');
  });

  it('folds the steps under a "Worked for" header under the clean look', () => {
    const html = renderIn('clean');
    expect(html).toContain('data-testid="turn-work-header"');
    expect(html).toContain('data-turn-header="done"');
    expect(html).toContain('Worked');
    // What the steps did reads as words on hover.
    expect(html).toContain('title="Ran 1 command, read 1 file"');
    expect(html).not.toContain('title="Ran 1 command"');
  });

  it('spaces the "Worked for" line from the prompt the same, pinned or not', () => {
    const render = (hideUserMessage: boolean): string =>
      renderToStaticMarkup(
        <ChatLookProvider value="clean">
          <TurnGroupRenderer
            group={finishedWorkTurn()}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
            hideUserMessage={hideUserMessage}
          />
        </ChatLookProvider>,
      );
    const afterPrompt = (html: string): string =>
      html.slice(Math.max(0, html.indexOf('turn-work-header') - 200));
    // The prompt hoisted into the pinned section header leaves the same
    // room above the header as a prompt in the turn: no spacer either way;
    // the header carries its own 4px above and below.
    expect(renderIn('clean')).not.toContain('class="h-2.5"');
    const pinned = render(true);
    expect(pinned).not.toContain('class="h-2.5"');
    expect(afterPrompt(pinned)).toContain('class="px-3 pt-2 pb-1"');
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
            result: visualToolResult(
              {
                version: 1,
                visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
                artifactId: `sha256-v1-${'a'.repeat(64)}`,
                sha256: 'a'.repeat(64),
                byteLength: 4,
                mediaType: 'text/html',
                title: 'Final visual',
                maxHeight: 320,
              },
              { messageId: 'final-visual', toolUseId: 'final-tool' },
            ),
          },
          { type: 'text', text: 'Final answer' },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
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
          <ChatLookProvider value="classic">
            <TurnGroupRenderer
              group={group}
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup
            />
          </ChatLookProvider>,
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

describe('revealing a tool call (show where it started)', () => {
  function completedTurnWithBackgroundCall(): TurnGroup {
    const call = (
      id: string,
      toolUseId: string,
      toolName: string,
      input: Record<string, unknown>,
    ): TurnGroup['assistantMessages'][number] => ({
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName,
          input: JSON.stringify(input),
          result: { output: 'ok', isError: false },
        },
      ],
      timestamp: 2,
    });
    return {
      ...completedTurnGroup(),
      assistantMessages: [
        call('read', 'tool-read', 'Read', { file_path: '/repo/a.ts' }),
        call('monitor', 'tool-monitor', 'Monitor', {
          command: 'tail -f build.log',
          description: 'build errors',
        }),
        {
          id: 'final',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Watching the build.' }],
          timestamp: 3,
        },
      ],
    };
  }

  it('opens the collapsed turn and the step row that hold the revealed call', () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const group = completedTurnWithBackgroundCall();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (revealRequest?: { messageId: string }): void =>
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnGroupRenderer
              group={group}
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup
              revealRequest={revealRequest}
            />
          </ChatLookProvider>,
        ),
      );
    try {
      render();
      expect(
        container.querySelector('[data-tool-use-id="tool-monitor"]'),
      ).toBeNull();

      render({ messageId: 'monitor' });
      expect(
        container.querySelector('[data-tool-use-id="tool-monitor"]'),
      ).not.toBeNull();
      // The turn stays open as saved state: the person can still collapse it.
      const summary = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Agent steps:"]',
      );
      expect(summary?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      act(() => root.unmount());
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it.each(['classic', 'clean'] as const)(
    'opens the grouped %s step row that holds the revealed call',
    (look) => {
      (
        globalThis as typeof globalThis & {
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      mockGroupToolCalls = true;
      const group = completedTurnWithBackgroundCall();
      const originalResizeObserver = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
      const container = document.createElement('div');
      const root = createRoot(container);
      const render = (revealRequest?: { messageId: string }): void =>
        act(() =>
          root.render(
            <ChatLookProvider value={look}>
              <TurnGroupRenderer
                group={group}
                chatPendingQuestions={[]}
                isLastTurnGroup
                isLastForkableTurnGroup
                revealRequest={revealRequest}
              />
            </ChatLookProvider>,
          ),
        );
      try {
        render();
        expect(
          container.querySelector('[data-tool-use-id="tool-monitor"]'),
        ).toBeNull();

        render({ messageId: 'monitor' });
        expect(
          container.querySelector('[data-tool-use-id="tool-monitor"]'),
        ).not.toBeNull();
      } finally {
        act(() => root.unmount());
        globalThis.ResizeObserver = originalResizeObserver;
        mockGroupToolCalls = false;
      }
    },
  );
});

describe('TurnGroupRenderer collapsed summary icon', () => {
  it('shows the code-flavored icon for the plan-category chip in Code Review chats', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
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
        />
      </ChatLookProvider>,
    );
    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <CodeBracketsIcon />
        </ChatLookProvider>,
      ),
    );
  });

  it('keeps the Plan Explore map icon for the plan-category chip in Plan Explore chats', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
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
        />
      </ChatLookProvider>,
    );
    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <PlanModeIcon />
        </ChatLookProvider>,
      ),
    );
    expect(html).not.toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <CodeBracketsIcon />
        </ChatLookProvider>,
      ),
    );
  });

  it('maps set-base-branch calls to the App Advisor summary block', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroupWithSetBaseBranchToolCall()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <AppAdvisorIcon />
        </ChatLookProvider>,
      ),
    );
    expect(html).toContain('1 orchestrator');
    expect(html).not.toContain('1 other');
  });

  it('maps the worktree SetBaseBranch tool to the branded app summary block', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroupWithWorktreeSetBaseBranchToolCall()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];

    expect(html).toContain('1 app');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).not.toContain('1 orchestrator');
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
          <ChatLookProvider value="classic">
            <TurnGroupRenderer
              chatId="chat-1"
              group={completedTurnGroup()}
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup={false}
            />
          </ChatLookProvider>,
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

describe('interrupted turn outcome (CAN-5178)', () => {
  function renderWithTab(
    tab: Record<string, unknown>,
    group: TurnGroup,
    look: 'classic' | 'clean' = 'classic',
  ): HTMLElement {
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
              ...tab,
            },
          ],
        },
      },
    };
    try {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
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
      return host;
    } finally {
      chatStoreState = {};
    }
  }

  /** A successful Read, then an Edit a restart cut off: 14 seconds. */
  function restartedEditTurn(): TurnGroup {
    const group = completedTurnGroup();
    group.assistantMessages = [
      {
        id: 'work',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'read-1',
            toolName: 'Read',
            input: '{"file_path":"/repo/a.ts"}',
            result: { output: 'contents', isError: false },
          },
          {
            type: 'tool_use',
            toolUseId: 'edit-1',
            toolName: 'Edit',
            input: '{"file_path":"/repo/a.ts"}',
            result: {
              output: 'Interrupted',
              isError: true,
              interruption: { reason: 'app_restart', at: 15_000 },
            },
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Partial answer' }],
      },
    ];
    group.timerMessage = {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1_000, completedAt: 15_000 }],
      timestamp: 4,
    };
    return group;
  }

  it('counts the interrupted edit apart from errors, footer visible at rest', () => {
    const host = renderWithTab(
      { interruptedTurns: { 'user-1': {} } },
      restartedEditTurn(),
    );
    const control = host.querySelector<HTMLElement>(
      '[data-testid="turn-outcome-control"]',
    );
    expect(control?.dataset.turnInterrupted).toBe('1');
    expect(control?.hasAttribute('data-turn-failed')).toBe(false);
    expect(control?.textContent).toBe('1 interrupted');
    const label = host.querySelector('[data-testid="turn-timer-label"]');
    expect(label?.textContent).toBe('Interrupted after 0:14');
    expect(label?.className).not.toContain('opacity-0');
  });

  it('says "Interrupted after" in the clean header', () => {
    const host = renderWithTab(
      { interruptedTurns: { 'user-1': {} } },
      restartedEditTurn(),
      'clean',
    );
    expect(
      host.querySelector('[data-testid="turn-work-header"]')?.textContent,
    ).toContain('Interrupted after 14s');
    expect(host.textContent).not.toContain('Worked for');
  });

  it('interrupts a tool-free turn from main’s record alone', () => {
    const host = renderWithTab(
      { interruptedTurns: { 'user-1': { resumedBy: 'user-2' } } },
      completedTurnGroup(),
    );
    expect(
      host.querySelector('[data-testid="turn-timer-label"]')?.textContent,
    ).toMatch(/^Interrupted/);
    expect(host.querySelector('[data-testid="turn-outcome-control"]')).toBe(
      null,
    );
  });

  it('never inherits another turn’s interruption record', () => {
    const host = renderWithTab(
      { interruptedTurns: { 'user-0': {} } },
      completedTurnGroup(),
    );
    expect(
      host.querySelector('[data-testid="turn-timer-label"]')?.textContent,
    ).toMatch(/^Completed/);
  });

  it('keeps a recorded cancellation ahead of the interruption', () => {
    const host = renderWithTab(
      {
        interruptedTurns: { 'user-1': {} },
        turnEnds: { 'user-1': { outcome: 'cancelled', endedAt: 15_000 } },
      },
      restartedEditTurn(),
    );
    expect(
      host.querySelector('[data-testid="turn-timer-label"]')?.textContent,
    ).toBe('Cancelled after 0:14');
  });
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
      <ChatLookProvider value="classic">
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
        />
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          sourceSdkSessionId="session-1"
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-label="Fork');
  });

  it("heads a wake's turn with its boundary row and leaves fork to the prompt's turn", () => {
    const wake: TurnGroup = {
      ...activeTurnGroup(),
      userMessage: {
        id: 'timer-wake:wake',
        role: 'system',
        blocks: [
          {
            type: 'wake_boundary',
            turnId: 'wake',
            taskLabel: 'Run the tests',
            spawningUserMessageId: 'user-1',
          },
        ],
        timestamp: 3,
      },
    };
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={wake}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          sourceSdkSessionId="session-1"
          onShowSpawningCall={jest.fn()}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="wake-turn-boundary"');
    expect(html).toContain(
      'Continued after <strong>Run the tests</strong> finished',
    );
    expect(html).toContain(
      'data-testid="wake-turn-boundary-show-spawning-turn"',
    );
    expect(html).not.toContain('aria-label="Fork');
  });

  it('hides the inline active fork action for Claude terminal sessions', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          sourceSdkSessionId="session-1"
          suppressActiveForkAction
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('aria-label="Fork');
  });

  it('shows the watcher button for active real worktree turns', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="chat-watcher-button-chat-1"');
  });

  it('hides the watcher button for synthetic plan-explore turns', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
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
        />
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <WorkspaceAccessContext.Provider value={readOnly}>
          <TurnGroupRenderer
            chatId="chat-1"
            group={completedTurnGroup()}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </WorkspaceAccessContext.Provider>
      </ChatLookProvider>,
    );
    const active = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <WorkspaceAccessContext.Provider value={readOnly}>
          <TurnGroupRenderer
            chatId="chat-1"
            group={activeTurnGroup()}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
            sourceSdkSessionId="session-1"
          />
        </WorkspaceAccessContext.Provider>
      </ChatLookProvider>,
    );

    expect(completed).not.toContain('data-testid="turn-share-session"');
    expect(completed).not.toContain('aria-label="Fork');
    expect(active).not.toContain('aria-label="Fork');
    expect(active).not.toContain('data-testid="chat-watcher-button-chat-1"');
  });

  it('shows the Share control on the last forkable completed turn', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="turn-share-session"');
  });

  it('shows the Share control on the last completed Cowork turn', () => {
    registerCoworkWorkspaceIds(['cowork-project']);
    withWorktreeChatTab('cowork-project', 'cowork-entry');
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
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
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="turn-share-session"');
  });

  it('hides the Share control while the turn is still active', () => {
    withWorktreeChatTab();
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          sourceSdkSessionId="session-1"
        />
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroupWithoutTimerBlock()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat-1"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
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
        <ChatLookProvider value="classic">
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
          />
        </ChatLookProvider>,
      );
      // A waiting question asks in the composer, not in the transcript.
      expect(html).not.toContain('data-testid="ask-user-question-card"');
      expect(html).not.toContain('Hidden question reasoning');
      expect(html).toContain('Done reviewing');
      if (state === 'pending') expect(html).not.toContain('Which scope?');
    },
  );
});

// Background drawer D3: a completed turn's box lists only what the chat list
// placed in it (its tiles and runs), under either view; background agents,
// tasks and the runs the drawer lists stay out.
describe('completed turn agent activity', () => {
  it('lists the receipts the chat list placed in the turn', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="c"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup={false}
          isLastForkableTurnGroup={false}
          completedAgentArtifacts={[launchedRun]}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-artifacts="exec-1"');
  });

  it('renders no box when the chat list places nothing in the turn', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="c"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          completedAgentArtifacts={[]}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="turn-agent-activity"');
  });

  it('lists completed watcher receipts', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="c"
          group={completedTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          completedAgentArtifacts={[watchedRun, watchedGitHubRun]}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-artifacts="exec-2,101"');
  });

  it('shows placed completed run records while their parent turn is still active', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="c"
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          completedAgentArtifacts={[launchedRun]}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-artifacts="exec-1"');
  });
});

it('renders only a spinner and Working label while the submitted turn awaits its real timer', () => {
  const markup = renderToStaticMarkup(
    <ChatLookProvider value="classic">
      <TurnGroupRenderer
        chatId="chat"
        group={activeTurnGroup()}
        pendingTimer
        chatPendingQuestions={[]}
        isLastTurnGroup
        isLastForkableTurnGroup
        sourceSdkSessionId="session"
      />
    </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          chatId="chat"
          group={runningTurnWithToolCalls()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
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
        <ChatLookProvider value="classic">
          <TurnGroupRenderer
            chatId="chat"
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
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

  it.each([false, true])(
    'keeps the newest steps under the clean live line (grouping %p)',
    (grouping) => {
      mockLiveStepWindow = true;
      mockGroupToolCalls = grouping;
      act(() =>
        root.render(
          <ChatLookProvider value="clean">
            <TurnGroupRenderer
              chatId="chat"
              group={turn([
                thought('think-1'),
                calls('read-1', ['Read']),
                thought('think-2'),
                calls('bash-1', ['Bash'], true),
              ])}
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup
            />
          </ChatLookProvider>,
        ),
      );
      const [line] = groups();
      expect(liveIds(line)).toEqual(['read-1', 'think-2', 'bash-1']);
      // The line counts only the step the window hides, so the running
      // command is said once, in its own row.
      expect(line.hasAttribute('data-live')).toBe(false);
      const summary =
        line.querySelector('[data-testid="chat-tool-step-summary"]')
          ?.textContent ?? '';
      expect(summary).not.toMatch(/Run/);
      expect(container.textContent?.match(/Running/g) ?? []).toHaveLength(1);
    },
  );

  function runningAgent(id: string): Message {
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'agent',
          toolUseId: `${id}-agent`,
          subagentType: 'Explore',
          description: 'Check the source',
          prompt: 'Investigate',
          runInBackground: false,
          subBlocks: [],
        },
      ],
      timestamp: 2,
    };
  }

  function showClean(messages: Message[]): void {
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <TurnGroupRenderer
            chatId="chat"
            group={turn(messages)}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
      ),
    );
  }

  it('keeps a running helper agent in view when it is the only step', () => {
    mockLiveStepWindow = true;
    showClean([runningAgent('agent-only')]);
    const live = container.querySelector('[data-testid="chat-tool-step-live"]');
    expect(
      live?.querySelector('[data-chat-message-id="agent-only"]'),
    ).not.toBeNull();
    expect(live?.textContent).toContain('Check the source');
  });

  it('counts a running helper agent among the newest steps', () => {
    mockLiveStepWindow = true;
    showClean([
      calls('bash-1', ['Bash']),
      calls('bash-2', ['Bash']),
      calls('bash-3', ['Bash']),
      calls('bash-4', ['Bash']),
      calls('bash-5', ['Bash']),
      runningAgent('agent-last'),
    ]);
    const [line] = groups();
    expect(liveIds(line)).toEqual(['bash-4', 'bash-5', 'agent-last']);
    expect(
      line.querySelector('[data-testid="chat-tool-step-summary"]')?.textContent,
    ).toBe('Ran 3 commands');
  });

  it('shows the steps without a line while the window holds them all', () => {
    mockLiveStepWindow = true;
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <TurnGroupRenderer
            chatId="chat"
            group={turn([
              calls('read-1', ['Read']),
              calls('bash-1', ['Bash'], true),
            ])}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
      ),
    );
    expect(groups()).toHaveLength(0);
    const live = container.querySelector('[data-testid="chat-tool-step-live"]');
    expect(
      Array.from(
        live?.querySelectorAll('[data-chat-message-id]') ?? [],
        (row) => row.getAttribute('data-chat-message-id'),
      ),
    ).toEqual(['read-1', 'bash-1']);
  });

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
          <ChatLookProvider value="classic">
            <TurnGroupRenderer
              chatId="chat"
              group={group}
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup
              searchMessageId="say-1"
            />
          </ChatLookProvider>,
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
        <ChatLookProvider value="classic">
          <TurnGroupRenderer
            chatId="chat"
            group={realisticTurn()}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
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

describe('safety denial notices in a collapsed turn', () => {
  it.each([false, true])(
    'keeps the notice visible when its denied tool row collapses (visual: %s)',
    (withVisual) => {
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
              input: '{"command":"git push --force origin HEAD"}',
              result: { output: 'Blocked', isError: true },
            },
            {
              type: 'approval_safety_denied_info',
              receiptId: 'approval-safety-1',
              timestamp: 2,
              reason: 'force-push',
              command: 'git push --force origin HEAD',
              mode: 'ask',
              toolUseId: 'bash-1',
            },
            { type: 'thinking', text: 'Hidden intermediate reasoning' },
          ],
        },
        {
          id: 'final',
          role: 'assistant',
          timestamp: 3,
          blocks: [{ type: 'text', text: 'The push was blocked.' }],
        },
      ];
      if (withVisual) {
        group.assistantMessages[0]?.blocks.push({
          type: 'tool_use',
          toolUseId: 'visual-tool',
          toolName: 'mcp__canopy__ShowVisual',
          input: '{}',
          result: visualToolResult({
            version: 1,
            visualId: 'vis_123e4567-e89b-12d3-a456-426614174000',
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            byteLength: 4,
            mediaType: 'text/html',
            title: 'Retained chart',
            maxHeight: 320,
          }),
        });
      }
      const html = renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <TurnGroupRenderer
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
      );
      expect(html).toContain('data-testid="approval-safety-denied-notice"');
      expect(html).not.toContain('Hidden intermediate reasoning');
      expect(
        html.indexOf('data-testid="approval-safety-denied-notice"'),
      ).toBeLessThan(html.indexOf('The push was blocked.'));
    },
  );
});

describe('clean chat look steps between replies', () => {
  type Block = TurnGroup['assistantMessages'][number]['blocks'][number];
  let messageIndex = 0;
  function message(...blocks: Block[]): TurnGroup['assistantMessages'][number] {
    messageIndex += 1;
    return {
      id: `m${messageIndex}`,
      role: 'assistant',
      timestamp: messageIndex + 1,
      blocks,
    };
  }
  function tool(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    result?: { output: string; isError: boolean },
  ): Block {
    return {
      type: 'tool_use',
      toolUseId: id,
      toolName,
      input: JSON.stringify(input),
      ...(result ? { result } : {}),
    };
  }
  const ok = { output: 'ok', isError: false };
  const failed = { output: 'fatal', isError: true };

  /** The user's turn from 2026-10-22, still running, thinking at the end. */
  function streamingTurn(): TurnGroup {
    messageIndex = 0;
    const group = activeTurnGroup();
    group.assistantMessages = [
      message(tool('t1', 'mcp__linear__list_issues', {}, ok)),
      message(
        tool(
          'ask',
          'mcp__canopy__AskUserQuestion',
          { questions: [{ question: 'What should we work on?' }] },
          { output: 'Q: What should we work on?\nA: CAN-3321', isError: false },
        ),
      ),
      message(tool('t2', 'mcp__linear__get_issue', {}, ok)),
      message(tool('b1', 'Bash', { command: 'git status' }, failed)),
      message({ type: 'thinking', text: 'The path may differ.' }),
      message({ type: 'text', text: 'Pulling up the canopy repo.' }),
      message(tool('b2', 'Bash', { command: 'git fetch' }, failed)),
      message(
        tool('t3', 'mcp__canopy__GetCodeGraphContext', {}, ok),
        tool('b3', 'Bash', { command: 'git log' }, ok),
      ),
      message({ type: 'text', text: 'The checkout has an unfinished merge.' }),
      message(tool('b4', 'Bash', { command: 'git worktree add' }, ok)),
      message({ type: 'thinking', text: 'Start with the toolbar.' }),
    ];
    return group;
  }

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    // Grouping follows Settings → "Group tool calls".
    mockGroupToolCalls = true;
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
    mockGroupToolCalls = false;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function show(group: TurnGroup): void {
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <TurnGroupRenderer
            group={group}
            chatPendingQuestions={[]}
            isLastTurnGroup
            isLastForkableTurnGroup
          />
        </ChatLookProvider>,
      ),
    );
  }

  const groups = (): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="chat-tool-step-group"]',
      ),
    );
  const lineOf = (group: HTMLElement): string =>
    group.querySelector('[data-step-row]')?.textContent ?? '';

  it('folds all the work between two replies into one closed line', () => {
    show(streamingTurn());
    // Before the question, after it, after each reply: four lines, not a
    // row per tool call.
    expect(groups().map(lineOf)).toEqual([
      'Used 1 tool',
      'Used 1 tool, ran 1 command· 1 error',
      'Ran 2 commands, checked the code graph· 1 error',
      'Thinking',
    ]);
    // Closed: no single step row shows until the person opens a line.
    expect(container.querySelectorAll('[data-tool-status]')).toHaveLength(0);
    // The question reads as the answer card alone, without a tool row.
    expect(container.textContent).not.toContain('Asked you');
    expect(
      container.querySelector('[data-testid="answered-questions"]'),
    ).not.toBeNull();
  });

  it('shimmers one live line and keeps the timer row quiet', () => {
    show(streamingTurn());
    const live = groups().at(-1);
    expect(live?.querySelector('.canopy-text-shimmer-strong')).not.toBeNull();
    expect(
      container.querySelectorAll('.canopy-text-shimmer-strong'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="turn-timer-label"]'),
    ).toBeNull();
  });

  it('keeps every line in place as steps stream in', () => {
    const group = streamingTurn();
    show(group);
    const before = groups();
    const running = {
      ...group,
      assistantMessages: [
        ...group.assistantMessages,
        message(tool('r1', 'Read', { file_path: '/repo/BrowserToolbar.tsx' })),
      ],
    };
    show(running);
    const after = groups();
    // Same lines, same nodes: the new step joins the live line.
    expect(after).toHaveLength(before.length);
    after.forEach((node, index) => expect(node).toBe(before[index]));
    expect(lineOf(after.at(-1) ?? container)).toBe(
      'Reading BrowserToolbar.tsx',
    );
    expect(container.querySelectorAll('[data-tool-status]')).toHaveLength(0);
  });

  it('shows "Thinking" on its own line until the next step starts', () => {
    const group = streamingTurn();
    group.assistantMessages = group.assistantMessages.slice(0, 6);
    show(group);
    expect(groups().map(lineOf).at(-1)).toBe('Thinking');
    const reply = container.querySelector('[data-chat-message-id="m6"]');
    expect(reply).not.toBeNull();
  });

  it('keeps a turn that finishes on screen open, so nothing moves', () => {
    const group = streamingTurn();
    show(group);
    show({
      ...group,
      assistantMessages: [
        ...group.assistantMessages,
        message({ type: 'text', text: 'Here is the audit.' }),
      ],
      timerMessage: {
        ...group.timerMessage,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 9 }],
      },
      isComplete: true,
    });
    expect(container.textContent).toContain('Pulling up the canopy repo.');
    expect(container.textContent).toContain('Worked');
    expect(groups().map(lineOf).at(-1)).toBe('Ran 1 command');
  });

  it('keeps one row per tool call while Group tool calls is off', () => {
    mockGroupToolCalls = false;
    const group = streamingTurn();
    show(group);
    expect(
      groups().filter((g) => g.closest('[data-testid="turn-timer"]') === null),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-tool-status]').length,
    ).toBeGreaterThan(4);
    // The newest thought shimmers in its own row, so the slot under the
    // reply stays empty rather than saying "Thinking" twice.
    expect(
      container.querySelector('[data-testid="turn-timer"]')?.textContent,
    ).toBe('');
    // Once the newest step is done, the slot says the agent is thinking.
    show({
      ...group,
      assistantMessages: [
        ...group.assistantMessages,
        message(tool('b9', 'Bash', { command: 'ls' }, ok)),
      ],
    });
    expect(
      container.querySelector('[data-testid="turn-timer"]')?.textContent,
    ).toBe('Thinking');
  });
});

describe('first-send starting status (CAN-4742)', () => {
  function startingTurn(
    assistantMessages: TurnGroup['assistantMessages'] = [],
    completedAt: number | null = null,
  ): TurnGroup {
    return {
      kind: 'turn-group',
      userMessage: {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Why is the deck empty?' }],
        timestamp: 1,
      },
      assistantMessages,
      timerMessage: {
        id: 'timer-1',
        role: 'system',
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt }],
        timestamp: 1,
      },
      isComplete: completedAt !== null,
    };
  }

  function renderIn(
    look: 'classic' | 'clean',
    group: TurnGroup,
    starting = true,
  ): string {
    return renderToStaticMarkup(
      <ChatLookProvider value={look}>
        <TurnGroupRenderer
          group={group}
          pendingTimer
          starting={starting}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );
  }

  function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
  }

  it.each(['classic', 'clean'] as const)(
    'shows one polite "Starting…" status before any output under the %s look',
    (look) => {
      const html = renderIn(look, startingTurn());
      expect(count(html, 'data-testid="turn-starting-status"')).toBe(1);
      expect(count(html, 'role="status"')).toBe(1);
      expect(html).toContain('Starting…');
      expect(html).not.toContain('data-testid="turn-work-header"');
      expect(html).not.toContain('Working');
    },
  );

  it.each(['classic', 'clean'] as const)(
    'hands over to the normal turn on the first reply under the %s look',
    (look) => {
      const html = renderIn(
        look,
        startingTurn([
          {
            id: 'reply',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Looking now.' }],
          },
        ]),
      );
      expect(html).not.toContain('turn-starting-status');
    },
  );

  it.each(['classic', 'clean'] as const)(
    'ends starting on the first thinking or agent activity under the %s look',
    (look) => {
      const blocks: TurnGroup['assistantMessages'][number]['blocks'] = [
        { type: 'thinking', text: 'Checking the source.' },
        { type: 'image', path: '/tmp/answer.png', alt: 'Generated answer' },
        {
          type: 'agent',
          toolUseId: 'agent-1',
          subagentType: 'Explore',
          description: 'Check the source',
          prompt: 'Investigate',
          runInBackground: false,
          subBlocks: [],
        },
      ];
      for (const block of blocks) {
        const html = renderIn(
          look,
          startingTurn([
            {
              id: 'activity',
              role: 'assistant',
              timestamp: 2,
              blocks: [block],
            },
          ]),
        );
        expect(html).not.toContain('turn-starting-status');
      }
    },
  );

  it.each(['classic', 'clean'] as const)(
    'keeps starting through hidden plan-mode tools under the %s look',
    (look) => {
      for (const toolName of ['EnterPlanMode', 'ExitPlanMode']) {
        const message: TurnGroup['assistantMessages'][number] = {
          id: 'hidden-plan',
          role: 'assistant',
          timestamp: 2,
          blocks: [
            { type: 'tool_use', toolUseId: 'plan-1', toolName, input: '{}' },
          ],
        };
        expect(renderIn(look, startingTurn([message]))).toContain(
          'turn-starting-status',
        );
        expect(
          renderIn(
            look,
            startingTurn([
              message,
              {
                id: 'reply',
                role: 'assistant',
                timestamp: 3,
                blocks: [{ type: 'text', text: 'Visible answer' }],
              },
            ]),
          ),
        ).not.toContain('turn-starting-status');
      }
    },
  );

  it('hands over on the first tool step, not on an empty reply', () => {
    expect(
      renderIn(
        'clean',
        startingTurn([
          {
            id: 'empty',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: '' }],
          },
        ]),
      ),
    ).toContain('turn-starting-status');
    expect(
      renderIn(
        'clean',
        startingTurn([
          {
            id: 'tool',
            role: 'assistant',
            timestamp: 2,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'bash-1',
                toolName: 'Bash',
                input: '{"command":"ls"}',
              },
            ],
          },
        ]),
      ),
    ).not.toContain('turn-starting-status');
  });

  it('ends when the turn finishes without output', () => {
    expect(renderIn('clean', startingTurn([], 5))).not.toContain(
      'turn-starting-status',
    );
  });

  it('leaves an ordinary running turn unchanged', () => {
    const html = renderIn('clean', startingTurn(), false);
    expect(html).not.toContain('turn-starting-status');
    expect(html).toContain('data-testid="turn-work-header"');
  });
});

describe('turn outcomes (CAN-4810)', () => {
  const bash = (
    id: string,
    isError: boolean,
  ): TurnGroup['assistantMessages'][number] => ({
    id: `step-${id}`,
    role: 'assistant',
    timestamp: 2,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: id,
        toolName: 'Bash',
        input: JSON.stringify({ command: `echo ${id}` }),
        result: { output: isError ? 'Blocked' : 'ok', isError },
      },
    ],
  });

  /** Four Bash steps, the last one safety-denied, then the reply. */
  function deniedPushTurn(): TurnGroup {
    const group = completedTurnGroup();
    group.assistantMessages = [
      bash('status', false),
      bash('add', false),
      bash('commit', false),
      bash('push', true),
      {
        id: 'receipt',
        role: 'system',
        timestamp: 3,
        blocks: [
          {
            type: 'approval_safety_denied_info',
            receiptId: 'approval-safety-1',
            timestamp: 3,
            reason: 'force-push',
            command: 'fixture only',
            mode: 'ask',
            toolUseId: 'push',
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 4,
        blocks: [{ type: 'text', text: 'The push was blocked.' }],
      },
    ];
    return group;
  }

  function renderStatic(
    group: TurnGroup,
    props: Partial<ComponentProps<typeof TurnGroupRenderer>> = {},
  ): string {
    return renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnGroupRenderer
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          {...props}
        />
      </ChatLookProvider>,
    );
  }

  it('labels the steps and names the blocked step on the classic summary', () => {
    const html = renderStatic(deniedPushTurn());
    expect(html).toContain('data-testid="chat-turn-summary"');
    expect(html).toContain(
      'aria-label="Agent steps: Ran 4 commands, 1 blocked"',
    );
    expect(html).toContain('data-turn-step-count="4"');
    expect(html).toContain('4 steps');
    expect(html).toContain('data-turn-blocked="1"');
    expect(html).not.toContain('data-turn-failed');
    expect(html).toContain('data-tool-chip="bash"');
  });

  it('does not count an unplaced receipt explicitly owned by another turn', () => {
    const group = deniedPushTurn();
    group.assistantMessages = group.assistantMessages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'approval_safety_denied_info'
          ? { ...block, turnUserMessageId: 'another-turn' }
          : block,
      ),
    }));
    const html = renderStatic(group);
    expect(html).toContain('aria-label="Agent steps: Ran 4 commands, 1 error"');
    expect(html).not.toContain('data-turn-blocked');
  });

  it('adds the same outcome to the clean header', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnGroupRenderer
          group={deniedPushTurn()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="turn-work-header"');
    expect(html).toContain(
      'aria-label="Agent steps: Ran 4 commands, 1 blocked"',
    );
    expect(html).toContain('data-turn-blocked="1"');
    expect(html).toContain('Worked for');
  });

  it('keeps a success-only turn named as before', () => {
    const group = deniedPushTurn();
    group.assistantMessages = group.assistantMessages
      .filter((message) => message.id !== 'receipt')
      .map((message) =>
        message.id === 'step-push' ? bash('push', false) : message,
      );
    const html = renderStatic(group);
    expect(html).toContain('aria-label="Agent steps: Ran 4 commands"');
    expect(html).not.toContain('data-turn-outcomes');
  });

  it('uses the paged index outcomes, never the loaded subset, and treats missing metadata as unknown', () => {
    const group = deniedPushTurn();
    // Only the reply is loaded; the index knows the whole turn.
    group.assistantMessages = group.assistantMessages.filter(
      (message) => message.id === 'final',
    );
    const transcriptTurn = {
      id: 'user-1',
      start: 0,
      end: 7,
      complete: true,
      summary: { ...computeTurnSummary([]), bash: 4 },
      finalMessageIds: ['final'],
      before: 5,
    };
    const indexed = renderStatic(group, {
      transcriptTurn: {
        ...transcriptTurn,
        outcomes: { blocked: 1, failed: 2, interrupted: 0 },
      },
    });
    expect(indexed).toContain(
      'aria-label="Agent steps: Ran 4 commands, 1 blocked, 2 errors"',
    );
    const legacy = renderStatic(group, { transcriptTurn });
    expect(legacy).toContain('aria-label="Agent steps: Ran 4 commands"');
    expect(legacy).not.toContain('data-turn-outcomes');
  });

  it('keeps completed projection outcomes when the receipt is omitted from a neighboring page', () => {
    const group = deniedPushTurn();
    group.assistantMessages = group.assistantMessages.filter(
      (message) => message.id !== 'receipt',
    );
    const html = renderStatic(group, {
      transcriptTurn: {
        id: 'user-1',
        start: 0,
        end: 7,
        complete: true,
        summary: computeTurnSummary(group.assistantMessages),
        outcomes: { blocked: 1, failed: 0, interrupted: 0 },
        finalMessageIds: ['final'],
        files: [],
      },
    });
    expect(html).toContain(
      'aria-label="Agent steps: Ran 4 commands, 1 blocked"',
    );
    expect(html).not.toContain('data-turn-failed');
  });

  it('incorporates a loaded denial that arrives after a completed projection', () => {
    const group = deniedPushTurn();
    const html = renderStatic(group, {
      transcriptTurn: {
        id: 'user-1',
        start: 0,
        end: 6,
        complete: true,
        summary: computeTurnSummary(group.assistantMessages),
        outcomes: { blocked: 0, failed: 1, interrupted: 0 },
        deniedToolUseIds: [],
        finalMessageIds: ['final'],
        files: [],
      },
    });
    expect(html).toContain(
      'aria-label="Agent steps: Ran 4 commands, 1 blocked"',
    );
    expect(html).not.toContain('data-turn-failed');
  });

  describe('landing on expand', () => {
    let frames: FrameRequestCallback[] = [];
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    const originalResizeObserver = globalThis.ResizeObserver;

    beforeEach(() => {
      frames = [];
      globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
      // jsdom has no CSS namespace; ids in these fixtures need no escaping.
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { escape: (value: string): string => value },
      });
      jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      jest
        .spyOn(window, 'cancelAnimationFrame')
        .mockImplementation(() => undefined);
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      jest.restoreAllMocks();
      globalThis.ResizeObserver = originalResizeObserver;
      mockGroupToolCalls = false;
    });

    function mount(
      group: TurnGroup,
      props: Partial<ComponentProps<typeof TurnGroupRenderer>> = {},
    ): HTMLButtonElement {
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <div data-chat-turn-group="user-1">
              <TurnGroupRenderer
                group={group}
                chatPendingQuestions={[]}
                isLastTurnGroup
                isLastForkableTurnGroup
                {...props}
              />
            </div>
          </ChatLookProvider>,
        ),
      );
      const summary = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-turn-summary"]',
      );
      if (!summary) throw new Error('Missing turn summary');
      return summary;
    }

    function flushFrames(): void {
      for (let index = 0; index < 20 && frames.length > 0; index += 1) {
        const next = frames.shift();
        act(() => next?.(index * 16));
      }
    }

    const rowToggle = (toolUseId: string): Element | null =>
      container.querySelector(
        `[data-tool-use-id="${toolUseId}"] button[aria-expanded]`,
      );

    it('focuses the blocked step, revealing it inside a folded step group', () => {
      mockGroupToolCalls = true;
      const summary = mount(deniedPushTurn());
      summary.focus();
      act(() => summary.click());
      flushFrames();
      const toggle = rowToggle('push');
      expect(toggle).not.toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it('prefers a blocked step over an earlier failed one', () => {
      const group = deniedPushTurn();
      group.assistantMessages[0] = bash('status', true);
      const summary = mount(group);
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(document.activeElement).toBe(rowToggle('push'));
    });

    it('scopes a pinned control landing to its turn when another turn reuses the step id', () => {
      container.dataset.testid = 'chat-message-list-scroll';
      const summary = mount(deniedPushTurn());
      const home = summary.parentElement;
      const neighbor = document.createElement('div');
      neighbor.innerHTML =
        '<div data-chat-turn-group="neighbor"><div data-tool-use-id="push"><button aria-expanded="false">Other turn</button></div></div>';
      container.prepend(neighbor);
      // Sticky controls mount outside the turn, inside the transcript scroller.
      container.append(summary);
      try {
        summary.focus();
        act(() => summary.click());
        flushFrames();
        const target = container.querySelector(
          '[data-chat-turn-group="user-1"] [data-tool-use-id="push"] button[aria-expanded]',
        );
        expect(document.activeElement).toBe(target);
      } finally {
        home?.prepend(summary);
        neighbor.remove();
      }
    });

    it('uses projected denial IDs to land on an omitted-receipt owner before an earlier failure', () => {
      const group = deniedPushTurn();
      group.assistantMessages = group.assistantMessages.filter(
        (message) => message.id !== 'receipt',
      );
      group.assistantMessages[0] = bash('status', true);
      const transcriptTurn = {
        id: 'user-1',
        start: 0,
        end: 7,
        complete: true,
        summary: computeTurnSummary(group.assistantMessages),
        outcomes: { blocked: 1, failed: 1, interrupted: 0 },
        deniedToolUseIds: ['push'],
        finalMessageIds: ['final'],
        files: [],
      };
      const summary = mount(group, { transcriptTurn });
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(document.activeElement).toBe(rowToggle('push'));
    });

    it('targets the first failed step when nothing was blocked', () => {
      const group = deniedPushTurn();
      group.assistantMessages = group.assistantMessages.filter(
        (message) => message.id !== 'receipt',
      );
      group.assistantMessages[1] = bash('add', true);
      const summary = mount(group);
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(document.activeElement).toBe(rowToggle('add'));
    });

    it('lands on a failed agent step the outcome helper counted', () => {
      const group = deniedPushTurn();
      group.assistantMessages = group.assistantMessages.filter(
        (message) => message.id !== 'receipt',
      );
      group.assistantMessages[3] = {
        id: 'step-agent',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'agent',
            toolUseId: 'helper',
            subagentType: 'general-purpose',
            description: 'Check the branch',
            prompt: 'Check the branch',
            runInBackground: false,
            subBlocks: [],
            result: { output: 'Failed', isError: true },
          },
        ],
      };
      const summary = mount(group);
      summary.focus();
      act(() => summary.click());
      flushFrames();
      const row = container.querySelector('[data-tool-use-id="helper"]');
      expect(row).not.toBeNull();
      expect(row?.contains(document.activeElement)).toBe(true);
    });

    it('leaves focus where the reader moved it', () => {
      const summary = mount(deniedPushTurn());
      const elsewhere = document.createElement('button');
      document.body.append(elsewhere);
      try {
        summary.focus();
        act(() => summary.click());
        act(() => {
          elsewhere.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true }),
          );
          elsewhere.focus();
        });
        flushFrames();
        expect(document.activeElement).toBe(elsewhere);
      } finally {
        elsewhere.remove();
      }
    });

    it('does not choose a loaded failure while the blocked step is outside the page', () => {
      const group = deniedPushTurn();
      group.assistantMessages = [
        bash('loaded-failure', true),
        group.assistantMessages[5],
      ];
      const summary = mount(group, {
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 1, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(document.activeElement).toBe(summary);
    });

    it('waits for history, then focuses the mounted blocked row', async () => {
      let finish: (() => void) | undefined;
      const load = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const group = deniedPushTurn();
      const summary = mount(group, {
        onLoadHistory: load,
        historyLoading: true,
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 0, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(rowToggle('push')).toBeNull();
      await act(() => Promise.resolve());
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
      mount(group);
      flushFrames();
      expect(document.activeElement).toBe(rowToggle('push'));
    });

    it('wheel input cancels landing while history loads', async () => {
      let finish: (() => void) | undefined;
      const load = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const group = deniedPushTurn();
      const summary = mount(group, {
        onLoadHistory: load,
        historyLoading: true,
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 0, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(rowToggle('push')).toBeNull();
      act(() => {
        summary.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      });
      await act(() => Promise.resolve());
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
      mount(group);
      flushFrames();
      expect(rowToggle('push')).not.toBeNull();
      expect(document.activeElement).toBe(summary);
    });

    it('a second toggle cancels a pending history expansion', async () => {
      let finish: (() => void) | undefined;
      const load = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const group = deniedPushTurn();
      const summary = mount(group, {
        onLoadHistory: load,
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 0, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      summary.focus();
      act(() => summary.click());
      act(() => summary.click());
      await act(() => Promise.resolve());
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
      flushFrames();
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('opens the section without landing when the history load rejects', async () => {
      const group = deniedPushTurn();
      const summary = mount(group, {
        onLoadHistory: () => Promise.reject(new Error('offline')),
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 0, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      summary.focus();
      await act(async () => {
        summary.click();
        await Promise.resolve();
      });
      flushFrames();
      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(summary);
    });

    it('ignores a load completion after the component switches turns', async () => {
      let finish: (() => void) | undefined;
      const group = deniedPushTurn();
      const summary = mount(group, {
        onLoadHistory: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        transcriptTurn: {
          id: 'user-1',
          start: 0,
          end: 100,
          before: 1,
          complete: true,
          summary: computeTurnSummary(group.assistantMessages),
          outcomes: { blocked: 1, failed: 0, interrupted: 0 },
          finalMessageIds: ['final'],
          files: [],
        },
      });
      await act(async () => {
        summary.click();
        await Promise.resolve();
      });
      const next = {
        ...deniedPushTurn(),
        userMessage: { ...group.userMessage, id: 'next-user' },
      };
      const nextSummary = mount(next);
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
      flushFrames();
      expect(nextSummary.getAttribute('aria-expanded')).toBe('false');
    });

    it('does not land when collapsing', () => {
      const summary = mount(deniedPushTurn());
      summary.focus();
      act(() => summary.click());
      flushFrames();
      summary.focus();
      act(() => summary.click());
      flushFrames();
      expect(document.activeElement).toBe(summary);
      expect(rowToggle('push')).toBeNull();
    });

    describe('from the outcome control (CAN-5056)', () => {
      const outcomeControl = (): HTMLButtonElement => {
        const control = container.querySelector<HTMLButtonElement>(
          '[data-testid="turn-outcome-control"]',
        );
        if (!control) throw new Error('Missing outcome control');
        return control;
      };
      const hover = (element: HTMLElement): void =>
        act(() => {
          element.dispatchEvent(
            new MouseEvent('mouseover', {
              bubbles: true,
              relatedTarget: document.body,
            }),
          );
        });
      const tooltip = (): HTMLElement | null =>
        document.querySelector<HTMLElement>(
          '[data-testid="turn-outcome-tooltip-surface"]',
        );
      const toolRow = (toolUseId: string): HTMLElement | null =>
        container.querySelector<HTMLElement>(
          `[data-tool-use-id="${toolUseId}"]`,
        );
      const blurActive = (): void =>
        act(() => {
          if (document.activeElement instanceof HTMLElement)
            document.activeElement.blur();
        });
      const jump = (): void => {
        const control = outcomeControl();
        act(() => control.focus());
        act(() => control.click());
        flushFrames();
      };

      it('expands a collapsed turn and lands on the first affected step without toggling twice', () => {
        const summary = mount(deniedPushTurn());
        jump();
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(rowToggle('push'));
        expect(toolRow('push')?.dataset.chatCallFocus).toBe('true');
      });

      it('lands again on an expanded turn, on every click', () => {
        const summary = mount(deniedPushTurn());
        summary.focus();
        act(() => summary.click());
        flushFrames();
        blurActive();

        jump();
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(rowToggle('push'));

        blurActive();
        delete toolRow('push')?.dataset.chatCallFocus;
        jump();
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(rowToggle('push'));
        expect(toolRow('push')?.dataset.chatCallFocus).toBe('true');
      });

      it('lands on the step a tooltip entry names', () => {
        const group = deniedPushTurn();
        group.assistantMessages[0] = bash('status', true);
        mount(group);
        hover(outcomeControl());
        const entries = Array.from(
          tooltip()?.querySelectorAll<HTMLElement>(
            '[data-turn-outcome-step]',
          ) ?? [],
        );
        // Blocked first, like the landing order.
        expect(entries.map((entry) => entry.dataset.turnOutcomeStep)).toEqual([
          'push',
          'status',
        ]);

        act(() => entries[1]?.click());
        flushFrames();

        expect(tooltip()).toBeNull();
        expect(document.activeElement).toBe(rowToggle('status'));
        expect(toolRow('status')?.dataset.chatCallFocus).toBe('true');
      });

      it('falls back to the first affected step for an id it cannot find', () => {
        const group = deniedPushTurn();
        group.assistantMessages[0] = bash('status', true);
        mockLastOutcomeJump = undefined;
        const summary = mount(group);
        const jumpTo = lastOutcomeJump();

        act(() => jumpTo('gone'));
        flushFrames();

        // Blocked first, like the landing order.
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(rowToggle('push'));
        expect(toolRow('push')?.dataset.chatCallFocus).toBe('true');
        expect(toolRow('status')?.dataset.chatCallFocus).toBeUndefined();
      });

      it('says only the counts for a paged turn', () => {
        const group = deniedPushTurn();
        group.assistantMessages = [
          bash('loaded-failure', true),
          group.assistantMessages[5],
        ];
        mount(group, {
          transcriptTurn: {
            id: 'user-1',
            start: 0,
            end: 100,
            before: 0,
            complete: true,
            summary: computeTurnSummary(group.assistantMessages),
            outcomes: { blocked: 1, failed: 1, interrupted: 0 },
            finalMessageIds: ['final'],
            files: [],
          },
        });
        hover(outcomeControl());
        expect(tooltip()?.textContent).toBe(
          '1 step was blocked1 step ran into an errorEffect on the result is unknown',
        );
        expect(tooltip()?.querySelector('[data-turn-outcome-step]')).toBeNull();
      });

      it('clears the ring on collapse and on unmount', () => {
        const summary = mount(deniedPushTurn());
        jump();
        const row = toolRow('push');
        expect(row?.dataset.chatCallFocus).toBe('true');
        act(() => summary.click());
        expect(row?.dataset.chatCallFocus).toBeUndefined();

        jump();
        const again = toolRow('push');
        expect(again?.dataset.chatCallFocus).toBe('true');
        act(() => root.unmount());
        root = createRoot(container);
        expect(again?.dataset.chatCallFocus).toBeUndefined();
      });
    });
  });
});

describe('TurnGroupRenderer approval wait (CAN-4996)', () => {
  function renderGroup(
    look: 'classic' | 'clean',
    props: Partial<ComponentProps<typeof TurnGroupRenderer>>,
  ): string {
    return renderToStaticMarkup(
      <ChatLookProvider value={look}>
        <TurnGroupRenderer
          group={activeTurnGroup()}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          {...props}
        />
      </ChatLookProvider>,
    );
  }

  it('pauses the classic timer while the chat waits on an approval', () => {
    const html = renderGroup('classic', { waitingForApproval: true });
    expect(html).toContain('data-state="paused"');
    expect(html).toContain('Waiting for you · ');
    expect(html).not.toContain('Working…');
  });

  it('pauses the clean header and drops its live line', () => {
    const html = renderGroup('clean', { waitingForApproval: true });
    expect(html).toContain('data-turn-header="paused"');
    expect(html).toContain('data-state="paused"');
    expect(html).not.toContain('Working for');
    expect(html).not.toContain('Thinking');
  });

  it('keeps the timer live without an approval', () => {
    expect(renderGroup('classic', {})).toContain('data-state="live"');
    expect(renderGroup('clean', {})).toContain('data-turn-header="live"');
  });

  it('leaves a completed turn as it was', () => {
    const html = renderGroup('classic', {
      group: completedTurnGroup(),
      waitingForApproval: true,
    });
    expect(html).toContain('data-state="completed"');
    expect(html).not.toContain('Waiting for you');
  });

  it.each(['classic', 'clean'] as const)(
    'wires only this unfinished chat’s matching calls through the %s turn provider (CAN-5291)',
    (look) => {
      const savedState = chatStoreState;
      const savedGrouping = mockGroupToolCalls;
      try {
        mockGroupToolCalls = false;
        withWorktreeChatTab();
        const request = {
          requestId: 'approval',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          provider: 'claude',
          title: 'Run command',
          details: { kind: 'command', command: 'pnpm test' },
        };
        chatStoreState.pendingApprovals = { approval: request };
        const group = activeTurnGroup();
        const call = (
          id: string,
          command: string,
        ): TurnGroup['assistantMessages'][number] => ({
          id,
          role: 'assistant',
          timestamp: 2,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: id,
              toolName: 'Bash',
              input: JSON.stringify({ command }),
            },
          ],
        });
        group.assistantMessages = [
          call('approved', 'sleep 30'),
          call('waiting', 'pnpm test'),
        ];
        const html = (): string =>
          renderGroup(look, {
            chatId: 'chat-1',
            group,
            waitingForApproval: true,
          });
        const host = document.createElement('div');
        host.innerHTML = html();
        expect(
          host
            .querySelector('[data-tool-use-id="waiting"]')
            ?.getAttribute('data-tool-approval'),
        ).toBe('waiting');
        expect(
          host
            .querySelector('[data-tool-use-id="approved"]')
            ?.hasAttribute('data-tool-approval'),
        ).toBe(false);
        chatStoreState.pendingApprovals = {
          approval: { ...request, chatId: 'other-chat' },
        };
        expect(html()).not.toContain('data-tool-approval');
        chatStoreState.pendingApprovals = { approval: request };
        group.isComplete = true;
        expect(html()).not.toContain('data-tool-approval');
        group.isComplete = false;
        group.assistantMessages = [call('approved', 'sleep 30')];
        expect(html()).not.toContain('data-tool-approval');
        // A late streamed call recomputes the turn's predicate.
        group.assistantMessages = [
          ...group.assistantMessages,
          call('waiting', 'pnpm test'),
        ];
        expect(html()).toContain('data-tool-approval="waiting"');
        chatStoreState.pendingApprovals = {};
        expect(html()).not.toContain('data-tool-approval');
      } finally {
        chatStoreState = savedState;
        mockGroupToolCalls = savedGrouping;
      }
    },
  );
});

describe('TurnGroupRenderer Copy plan (CAN-5354)', () => {
  const PLAN = '# Plan ✓\n\n1. Edit `src/a.ts`\n\n```ts\nconst x = 1;\n```\n';
  const PLAN_FILE = '/Users/me/.claude/plans/brave-otter.md';

  function withPlanTurn(group: TurnGroup, writeIsError = false): TurnGroup {
    group.assistantMessages = [
      {
        id: 'plan-write',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_plan_file',
            toolName: 'Write',
            input: JSON.stringify({ file_path: PLAN_FILE, content: PLAN }),
            result: { output: 'ok', isError: writeIsError },
          },
        ],
      },
      {
        id: 'plan-exit',
        role: 'assistant',
        timestamp: 3,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_exit_plan',
            toolName: 'ExitPlanMode',
            input: '{}',
          },
          { type: 'text', text: 'Here is the plan.' },
        ],
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

  function count(html: string, testId: string): number {
    return html.match(new RegExp(`data-testid="${testId}"`, 'g'))?.length ?? 0;
  }

  it.each(['classic', 'clean'] as const)(
    'gives a finished %s plan turn one Copy plan instead of reply Copy',
    (look) => {
      for (const group of [
        completedTurnGroup(),
        completedTurnGroupWithoutTimerBlock(),
      ]) {
        const html = renderIn(look, withPlanTurn(group));
        expect(count(html, 'turn-copy-plan')).toBe(1);
        expect(count(html, 'turn-copy-message')).toBe(0);
        expect(html).toContain('aria-label="Copy plan"');
      }
    },
  );

  it('offers no Copy plan while the plan turn runs', () => {
    const running = withPlanTurn(completedTurnGroup());
    running.isComplete = false;
    expect(count(renderIn('classic', running), 'turn-copy-plan')).toBe(0);
  });

  it('keeps Copy plan unavailable when the plan-file write failed', () => {
    const html = renderIn('classic', withPlanTurn(completedTurnGroup(), true));
    expect(count(html, 'turn-copy-plan')).toBe(1);
    expect(html).toContain('aria-disabled="true"');
    expect(count(html, 'turn-copy-message')).toBe(0);
  });
});
