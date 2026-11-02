/** @jest-environment jsdom */
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';

import {
  COMPLETED_CREDIT_RETRY_MESSAGES as CREDIT_RETRY_MESSAGES,
  nativeStoppedCreditRetry,
  cancelledCreditRetry,
} from '../../../../ui-shared/src/lib/__tests__/fixtures/credit-retry';
import { persistedMessageToPortalMessage } from '@canopy/agent-transcript';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
} from '@canopy/app-state';

import { ChatTranscript, getLatestMessageSignal } from '../ChatTranscript';
import {
  ChatVisualHostProvider,
  type ChatVisualHost,
} from '../chat-visual-host';
import {
  resetChatVisualsSourcesForTests,
  useChatVisualsSource,
} from '../chat-visuals-source';
import {
  AskUserQuestionInteractionProvider,
  TurnWorkingStatusProvider,
} from '../ChatPartView';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';

function msg(id: string, text: string): PortalChatMessage {
  return {
    messageId: id,
    chatId: 'c1',
    role: id.startsWith('u') ? 'user' : 'assistant',
    status: 'complete',
    text,
    createdAtMs: 0,
  };
}

const MESSAGES: PortalChatMessage[] = [
  msg('u1', 'hello there'),
  msg('a1', 'general answer'),
];
const TURN_GROUPS: PortalChatTurnGroup[] = [
  { userMessageId: 'u1', intermediateMessageIds: [], finalMessageIds: ['a1'] },
];

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatTranscript', () => {
  it('folds a live result in a later message into its call', () => {
    // Live turns deliver a Claude call and its result as separate messages;
    // the shell folds them, so the shared transcript must too.
    const occurrence = { id: 'call-row#0', revision: 3 };
    const messages: PortalChatMessage[] = [
      msg('u1', 'read it'),
      {
        ...msg('a1', ''),
        status: 'streaming',
        parts: [
          {
            kind: 'tool_use',
            occurrence: { id: 'call-row#0', revision: 2 },
            data: { toolUseId: 'read-1', toolName: 'Read', input: '{}' },
          },
        ],
      },
      {
        ...msg('a2', ''),
        role: 'user',
        parts: [
          {
            kind: 'tool_result',
            occurrence,
            outputLocator: {
              messageId: 'result-row',
              blockOrdinal: 0,
              field: 'output',
            },
            data: { toolUseId: 'read-1', output: 'preview', isError: false },
          },
        ],
      },
    ];
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={messages}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1', 'a2'],
            },
          ]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-tool-name="Read"');
    expect(out).not.toContain('data-tool-status="pending"');
    expect(out).not.toContain('Tool result');
  });

  it('drops a result already folded into its call by a snapshot', () => {
    const occurrence = { id: 'call-row#0', revision: 3 };
    const messages: PortalChatMessage[] = [
      msg('u1', 'read it'),
      {
        ...msg('a1', ''),
        parts: [
          {
            kind: 'tool_use',
            occurrence,
            data: {
              toolUseId: 'read-1',
              toolName: 'Read',
              input: '{}',
              result: { output: 'preview', isError: false },
            },
          },
        ],
      },
      {
        ...msg('a2', ''),
        role: 'assistant',
        parts: [
          {
            kind: 'tool_result',
            occurrence,
            data: { toolUseId: 'read-1', output: 'preview', isError: false },
          },
        ],
      },
    ];
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={messages}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1', 'a2'],
            },
          ]}
          status="idle"
        />
      </ChatLookProvider>,
    );
    expect(out.split('data-tool-name="Read"')).toHaveLength(2);
    expect(out).not.toContain('Tool result');
  });

  describe("a wake's link to where its task started (turn-state phase 40e)", () => {
    const scrollIntoView = jest.fn();
    const messages: PortalChatMessage[] = [
      msg('u1', 'watch the build'),
      {
        ...msg('a1', ''),
        parts: [
          {
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              toolName: 'Monitor',
              toolUseId: 'toolu-monitor',
              input: JSON.stringify({ description: 'build errors' }),
            },
          },
        ],
      },
      msg('a2', 'Watching the build.'),
      msg('a-wake', 'The build broke.'),
    ];
    const wakeGroups = (
      wake: NonNullable<PortalChatTurnGroup['wake']>,
    ): PortalChatTurnGroup[] => [
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
        summary: { bashCount: 1 },
      },
      {
        userMessageId: 'tw',
        intermediateMessageIds: [],
        finalMessageIds: ['a-wake'],
        complete: true,
        wake,
      },
    ];
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
      jest.useFakeTimers();
      scrollIntoView.mockClear();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    });

    function renderAndShow(
      wake: NonNullable<PortalChatTurnGroup['wake']>,
    ): void {
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <ChatTranscript
              messages={messages}
              turnGroups={wakeGroups(wake)}
              status="idle"
              renderTurnFeedback={(id) => (
                <span data-testid={`feedback-${id}`} />
              )}
            />
          </ChatLookProvider>,
        ),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="wake-turn-boundary-show-spawning-turn"]',
          )
          ?.click(),
      );
      act(() => {
        jest.advanceTimersByTime(32);
      });
    }

    function turn(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
    }

    it('gives the wake no feedback slot', () => {
      renderAndShow({ spawningUserMessageId: 'u1' });
      expect(
        container.querySelector('[data-testid="feedback-u1"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-testid="feedback-tw"]')).toBeNull();
    });

    it("opens the call's collapsed turn, centers the call and highlights only it", () => {
      renderAndShow({
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'toolu-monitor',
      });

      const row = container.querySelector<HTMLElement>(
        '[data-tool-use-id="toolu-monitor"]',
      );
      expect(row).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(row);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
      expect(row?.dataset.chatCallFocus).toBe('true');
      expect(turn('u1')?.dataset.chatCallFocus).toBeUndefined();
      expect(
        turn('u1')
          ?.querySelector('[data-role="user"]')
          ?.hasAttribute('data-chat-call-focus'),
      ).toBe(false);

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      expect(row?.dataset.chatCallFocus).toBeUndefined();
    });

    it('highlights only the prompt bubble when the call is not loaded', () => {
      renderAndShow({
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'toolu-missing',
      });

      const bubble =
        turn('u1')?.querySelector<HTMLElement>('[data-role="user"]');
      expect(bubble).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(bubble);
      expect(bubble?.dataset.chatCallFocus).toBe('true');
      expect(turn('u1')?.dataset.chatCallFocus).toBeUndefined();
    });

    it('waits for history hydration before revealing a pending question (CAN-4958)', () => {
      const render = (initialized: boolean): void => {
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <StrictMode>
                <AskUserQuestionInteractionProvider
                  value={{
                    states: [
                      {
                        requestId: 'q',
                        toolUseId: 'toolu-monitor',
                        questions: [],
                        answered: false,
                      },
                    ],
                    onAnswer: jest.fn(),
                    onDismiss: jest.fn(),
                  }}
                >
                  <ChatTranscript
                    chatId="c1"
                    initialized={initialized}
                    messages={messages}
                    turnGroups={wakeGroups({ spawningUserMessageId: 'u1' })}
                    status="idle"
                  />
                </AskUserQuestionInteractionProvider>
              </StrictMode>
            </ChatLookProvider>,
          ),
        );
        act(() => {
          jest.advanceTimersByTime(64);
        });
      };
      render(false);
      expect(scrollIntoView).not.toHaveBeenCalled();
      render(true);
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it.each([true, false])(
      'reveals an earlier pending question with correlated id=%s (CAN-4958)',
      (hasToolId) => {
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <StrictMode>
                <AskUserQuestionInteractionProvider
                  value={{
                    states: [
                      {
                        requestId: 'q',
                        ...(hasToolId ? { toolUseId: 'toolu-monitor' } : {}),
                        questions: [
                          { question: 'Continue?', options: ['Yes', 'No'] },
                        ],
                        answered: false,
                      },
                    ],
                    onAnswer: jest.fn(),
                    onDismiss: jest.fn(),
                  }}
                >
                  <ChatTranscript
                    chatId="c1"
                    messages={messages.map((message) =>
                      message.messageId !== 'a1'
                        ? message
                        : {
                            ...message,
                            parts: [
                              {
                                kind: 'tool_use',
                                toolFamily: 'ask-user',
                                data: {
                                  toolName: 'mcp__canopy__AskUserQuestion',
                                  toolUseId: 'already-answered',
                                  result: { output: 'Done' },
                                  input: '{}',
                                },
                              },
                              {
                                kind: 'tool_use',
                                toolFamily: 'ask-user',
                                data: {
                                  toolName: 'mcp__canopy__AskUserQuestion',
                                  toolUseId: 'toolu-monitor',
                                  input: JSON.stringify({
                                    questions: [
                                      {
                                        question: 'Continue?',
                                        options: ['Yes', 'No'],
                                      },
                                    ],
                                  }),
                                },
                              },
                            ],
                          },
                    )}
                    turnGroups={wakeGroups({ spawningUserMessageId: 'u1' })}
                    status="idle"
                  />
                </AskUserQuestionInteractionProvider>
              </StrictMode>
            </ChatLookProvider>,
          ),
        );
        act(() => {
          jest.advanceTimersByTime(64);
        });
        const row = container.querySelector(
          '[data-tool-use-id="toolu-monitor"]',
        );
        expect(row).not.toBeNull();
        expect(scrollIntoView.mock.contexts).toContainEqual(row);
      },
    );
  });

  it('shows the default empty state when there are no messages', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript messages={[]} turnGroups={[]} status="idle" />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-empty"');
    expect(out).toContain('Send a message to start working');
  });

  it('renders the scroll container and footer when there are no messages but a footerSlot', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[]}
          turnGroups={[]}
          status="idle"
          footerSlot={<div data-testid="queued-footer">queued</div>}
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript"');
    expect(out).toContain('data-testid="queued-footer"');
    expect(out).not.toContain('data-testid="chat-transcript-empty"');
    expect(out).not.toContain('Send a message to start working');
  });

  it('renders footerStatus under the footer', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[]}
          turnGroups={[]}
          status="idle"
          footerSlot={<div data-testid="queued-footer">queued</div>}
          footerStatus={<p data-testid="footer-status">starting</p>}
        />
      </ChatLookProvider>,
    );
    const footerAt = out.indexOf('data-testid="queued-footer"');
    const statusAt = out.indexOf('data-testid="footer-status"');
    expect(footerAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(footerAt);
    // Not gated on streaming: a queued first send is idle.
    expect(out).not.toContain('data-testid="chat-transcript-streaming"');
  });

  it('renders a custom empty state', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[]}
          turnGroups={[]}
          status="idle"
          emptyState={<span>nothing yet</span>}
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('nothing yet');
  });

  it('renders turn groups when there are messages', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="idle"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript"');
    expect(out).toContain('h-full min-h-0');
    // Desktop parity: the desktop message list centers on the shared
    // `--chat-reading-width` token; the shared transcript must do the same so
    // web and desktop chats read at one column width.
    expect(out).toContain('max-w-[var(--chat-reading-width)]');
    // The column keeps the 8px rhythm the scroll container used to own, so
    // the streaming row, error row and footer stay spaced from the turns, and
    // it cannot be squeezed by the column flex container the way the inner
    // `flexShrink: 0` list guards against.
    expect(out).toMatch(
      /max-w-\[var\(--chat-reading-width\)\] chat-width-transition shrink-0 flex-col gap-2/,
    );
    expect(out).toContain('hello there');
    expect(out).toContain('general answer');
  });

  it('renders a disabled host action only beside the generating latest turn', () => {
    const messages = [
      msg('u1', 'first prompt'),
      msg('a1', 'first answer'),
      msg('u2', 'second prompt'),
      msg('a2', 'second answer'),
    ];
    const turnGroups: PortalChatTurnGroup[] = [
      {
        userMessageId: 'u1',
        intermediateMessageIds: [],
        finalMessageIds: ['a1'],
      },
      {
        userMessageId: 'u2',
        intermediateMessageIds: [],
        finalMessageIds: ['a2'],
      },
    ];

    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={messages}
          turnGroups={turnGroups}
          status="streaming"
          renderLatestTurnAction={({ disabled }) => (
            <button type="button" disabled={disabled}>
              Fork chat
            </button>
          )}
        />
      </ChatLookProvider>,
    );

    expect(out.match(/Fork chat/g)).toHaveLength(1);
    expect(out.indexOf('Fork chat')).toBeGreaterThan(
      out.indexOf('second answer'),
    );
    expect(out).toContain(
      '<button type="button" disabled="">Fork chat</button>',
    );
  });

  it('changes the scroll signal when the latest streaming message updates', () => {
    const before = getLatestMessageSignal([
      msg('u1', 'hello there'),
      {
        ...msg('a1', 'general answer'),
        status: 'streaming',
        updatedAtMs: 100,
      },
    ]);
    const after = getLatestMessageSignal([
      msg('u1', 'hello there'),
      {
        ...msg('a1', 'general answer with more text'),
        status: 'streaming',
        updatedAtMs: 200,
      },
    ]);

    expect(after).not.toBe(before);
  });

  it('shows a streaming indicator while streaming', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
  });

  it('announces the working label through a live region', () => {
    // The spinner's `aria-label` sits on a roleless <span>, so the row itself
    // has to be the live region or the label is visual-only. Regression guard
    // for the `role="status"` the cloud-chat `Continuing…` banner used to carry
    // before its label moved onto this row.
    const out = renderToString(
      <ChatLookProvider value="classic">
        <TurnWorkingStatusProvider value="Compacting context…">
          <ChatTranscript
            messages={MESSAGES}
            turnGroups={TURN_GROUPS}
            status="streaming"
          />
        </TurnWorkingStatusProvider>
      </ChatLookProvider>,
    );
    const row = out.slice(
      out.indexOf('data-testid="chat-transcript-streaming"') - 200,
    );
    expect(row).toContain('role="status"');
    expect(out).toContain('Compacting context…');
  });

  it('places the working row where the turn timer will land, above the turn actions', () => {
    // The indicator must not move when the real `turn_timer` frame arrives and
    // takes over: both render after the turn's finals and before its action
    // row, on the same `px-3` bubble-text inset.
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="streaming"
          renderLatestTurnAction={() => <button type="button">Fork</button>}
        />
      </ChatLookProvider>,
    );
    const streamingAt = out.indexOf('data-testid="chat-transcript-streaming"');
    const actionsAt = out.indexOf('data-testid="chat-turn-actions"');
    expect(streamingAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(-1);
    expect(streamingAt).toBeLessThan(actionsAt);
    expect(out.slice(streamingAt - 200, streamingAt)).toContain('px-3');
  });

  it('still shows the working row when there is no turn group to host it', () => {
    // No last group to slot into, so the row falls back to transcript level.
    // (A message-less transcript renders the empty state instead, so this
    // needs messages the host has not yet grouped.)
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={[]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
  });

  it('leaves the row a plain element when no host supplied a working label', () => {
    // The desktop surface never mounts `TurnWorkingStatusProvider`, so this row
    // has nothing announceable in it — the spinner's `aria-label` is on a
    // roleless span. A live region there would be an empty one on every turn,
    // and `role="status"` implies `aria-atomic`, so an AT that does expose that
    // name would read "Thinking" every time. Pins the unlabelled shape.
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
    expect(out).not.toContain('role="status"');
  });

  it('hides the streaming indicator when a live turn timer is on screen', () => {
    const timer: PortalChatMessage = {
      ...msg('t1', ''),
      role: 'system',
      status: 'streaming',
      parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, timer]}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1', 't1'],
            },
          ]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="turn-timer"');
    expect(out).not.toContain('data-testid="chat-transcript-streaming"');
  });

  it('keeps the streaming indicator when the only timer is completed', () => {
    const timer: PortalChatMessage = {
      ...msg('t1', ''),
      role: 'system',
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 4000 } },
      ],
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, timer]}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1', 't1'],
            },
          ]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
  });

  it('keeps the streaming indicator when the only live timer is an orphan from an earlier turn', () => {
    // An interrupted turn (client dispose mid-turn) leaves a timer with no
    // completedAt forever; it must not suppress the next turn's fallback
    // spinner during the send→timer gap.
    const orphan: PortalChatMessage = {
      ...msg('t-orphan', ''),
      role: 'system',
      status: 'streaming',
      parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
    };
    const nextUser = msg('u2', 'follow-up');
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, orphan, nextUser]}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1', 't-orphan'],
            },
            {
              userMessageId: 'u2',
              intermediateMessageIds: [],
              finalMessageIds: [],
            },
          ]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
  });

  it('keeps the streaming indicator when a mixed-part system message carries a live timer', () => {
    // A mixed-part message is not floated as a timer row (it may sit hidden in
    // the collapsed chip), so it must not suppress the fallback spinner either
    // — the float predicate and the suppression predicate are shared.
    const mixed: PortalChatMessage = {
      ...msg('s1', ''),
      role: 'system',
      status: 'streaming',
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000 } },
        { kind: 'tool_use', toolFamily: 'bash' },
      ],
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, mixed]}
          turnGroups={[
            {
              userMessageId: 'u1',
              intermediateMessageIds: ['s1'],
              finalMessageIds: ['a1'],
            },
          ]}
          status="streaming"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
  });

  it('shows the error text on error status', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="error"
          error="it broke"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-error"');
    expect(out).toContain('it broke');
  });

  it('does not repeat an error the latest turn already shows', () => {
    const failed: PortalChatMessage = {
      ...msg('a2', 'The version check exited. Try again.'),
      status: 'failed',
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, msg('u2', 'try it'), failed]}
          turnGroups={[
            ...TURN_GROUPS,
            {
              userMessageId: 'u2',
              intermediateMessageIds: [],
              finalMessageIds: ['a2'],
            },
          ]}
          status="error"
          error="The version check exited. Try again."
        />
      </ChatLookProvider>,
    );
    expect(out).not.toContain('data-testid="chat-transcript-error"');
    expect(out.split('The version check exited. Try again.')).toHaveLength(2);
  });

  it('keeps an error that only an earlier turn shows', () => {
    const failed: PortalChatMessage = {
      ...msg('a1', 'it broke'),
      status: 'failed',
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[msg('u1', 'hello there'), failed, msg('u2', 'again')]}
          turnGroups={[
            ...TURN_GROUPS,
            {
              userMessageId: 'u2',
              intermediateMessageIds: [],
              finalMessageIds: [],
            },
          ]}
          status="error"
          error="it broke"
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-error"');
  });

  it('keeps an error the latest final message does not repeat', () => {
    const failed: PortalChatMessage = {
      ...msg('a2', 'Partial answer'),
      status: 'failed',
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[...MESSAGES, msg('u2', 'try it'), failed]}
          turnGroups={[
            ...TURN_GROUPS,
            {
              userMessageId: 'u2',
              intermediateMessageIds: [],
              finalMessageIds: ['a2'],
            },
          ]}
          status="error"
          error="The connection dropped."
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-error"');
    expect(out).toContain('The connection dropped.');
  });

  // CAN-4278: every successfully completed footer, the last turn's included,
  // hides at rest and reveals through its own turn's `group/turn` scope.
  it('fades all but the timestamp of the completed footer on every turn group', () => {
    const timerMsg = (id: string, completedAt: number): PortalChatMessage => ({
      ...msg(id, ''),
      parts: [
        {
          kind: 'turn_timer',
          data: { startedAt: completedAt - 5_000, completedAt },
        },
      ],
    });
    const messages: PortalChatMessage[] = [
      msg('u1', 'first prompt'),
      timerMsg('a1', 10_000),
      msg('u2', 'second prompt'),
      timerMsg('a2', 20_000),
    ];
    const turnGroups: PortalChatTurnGroup[] = [
      {
        userMessageId: 'u1',
        intermediateMessageIds: [],
        finalMessageIds: ['a1'],
      },
      {
        userMessageId: 'u2',
        intermediateMessageIds: [],
        finalMessageIds: ['a2'],
      },
    ];

    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={messages}
          turnGroups={turnGroups}
          status="idle"
        />
      </ChatLookProvider>,
    );

    const classesAfter = (marker: string | RegExp): string[] =>
      out
        .split(marker)
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf('"')));
    const rows = classesAfter(
      /data-testid="turn-timer" data-state="[a-z]+" class="/,
    );
    const stamps = classesAfter('data-testid="turn-timer-relative" class="');
    const labels = classesAfter('data-testid="turn-timer-label" class="');
    expect(rows).toHaveLength(2);
    expect(stamps).toHaveLength(2);
    expect(labels).toHaveLength(2);
    for (const row of rows) expect(row).not.toContain('opacity-0');
    for (const stamp of stamps) expect(stamp).not.toContain('opacity-0');
    for (const label of labels) {
      expect(label).toContain('opacity-0');
      expect(label).toContain('group-hover/turn:opacity-100');
    }
    // Each footer sits inside its own turn scope, so hovering one turn never
    // reveals its neighbour.
    expect(out.split('class="group/turn').length - 1).toBe(2);
  });
});

describe('ChatTranscript working status (REG-2943)', () => {
  it('labels the fallback spinner with the host working status', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <TurnWorkingStatusProvider value="Compacting context…">
          <ChatTranscript
            messages={MESSAGES}
            turnGroups={TURN_GROUPS}
            status="streaming"
          />
        </TurnWorkingStatusProvider>
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="chat-transcript-streaming"');
    expect(out).toContain('Compacting context…');
  });
});

it('does not autoscroll when the reader has scrolled away from the bottom', async () => {
  const scroll = jest.fn();
  Element.prototype.scrollIntoView = scroll;
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="streaming"
        />
      </ChatLookProvider>,
    ),
  );
  const viewport = container.querySelector('[data-testid="chat-transcript"]');
  if (!viewport) throw new Error('Transcript missing');
  Object.defineProperties(viewport, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
    scrollTop: { value: 100, writable: true },
  });
  act(() => {
    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, bubbles: true }),
    );
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  scroll.mockClear();
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={[MESSAGES[0], { ...MESSAGES[1], text: 'new delta' }]}
          turnGroups={TURN_GROUPS}
          status="streaming"
        />
      </ChatLookProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(viewport.scrollTop).toBe(100);
  act(() => root.unmount());
});

it.each([200])(
  'windows a %i-turn transcript while retaining the last turn',
  (count) => {
    const messages = Array.from({ length: count }, (_, i) =>
      msg(`u${i}`, `turn ${i}`),
    );
    const turnGroups = messages.map((message) => ({
      userMessageId: message.messageId,
      intermediateMessageIds: [],
      finalMessageIds: [],
    }));
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={messages}
          turnGroups={turnGroups}
          status="idle"
        />
      </ChatLookProvider>,
    );
    // The initial offset must account for the gap between virtual turns, or
    // long transcripts drop their last turns from the first render.
    expect(out).toContain(`data-turn-id="u${count - 1}"`);
    expect(out).toContain(`turn ${count - 1}`);
  },
);

it('windows transcripts above 50 turns while retaining the last turn', () => {
  const messages = Array.from({ length: 80 }, (_, i) =>
    msg(`u${i}`, `turn ${i}`),
  );
  const turnGroups = messages.map((message) => ({
    userMessageId: message.messageId,
    intermediateMessageIds: [],
    finalMessageIds: [],
  }));
  const out = renderToString(
    <ChatLookProvider value="classic">
      <ChatTranscript
        messages={messages}
        turnGroups={turnGroups}
        status="idle"
      />
    </ChatLookProvider>,
  );
  expect(out).toContain('data-turn-count="80"');
  expect(out).toContain('data-testid="chat-transcript"');
  expect(out).toContain('data-testid="chat-transcript-virtual-turn"');
  expect(out).toContain('data-turn-id="u79"');
  expect(out).toContain('turn 79');
  expect(out).not.toContain('turn 0<');
});

it('keeps following when layout emits a scroll event above the new bottom', async () => {
  const scroll = jest.fn();
  Element.prototype.scrollIntoView = scroll;
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={MESSAGES}
          turnGroups={TURN_GROUPS}
          status="streaming"
        />
      </ChatLookProvider>,
    ),
  );
  const viewport = container.querySelector('[data-testid="chat-transcript"]');
  if (!viewport) throw new Error('Transcript missing');
  Object.defineProperties(viewport, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
    scrollTop: { value: 100, writable: true },
  });
  act(() => {
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(viewport.scrollTop).toBe(2000);
  act(() => root.unmount());
});

it('stops following when a scroll moves the reader up away from the bottom', async () => {
  // Find (CAN-3048) scrolls an earlier match into view without a gesture; a
  // streamed delta must not pull the transcript back to the bottom.
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (text: string): void =>
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <ChatTranscript
            messages={[MESSAGES[0], { ...MESSAGES[1], text }]}
            turnGroups={TURN_GROUPS}
            status="streaming"
          />
        </ChatLookProvider>,
      ),
    );
  render('first chunk');
  const viewport = container.querySelector('[data-testid="chat-transcript"]');
  if (!viewport) throw new Error('Transcript missing');
  Object.defineProperties(viewport, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
    scrollTop: { value: 1500, writable: true },
  });
  act(() => {
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  act(() => {
    viewport.scrollTop = 300;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  render('more streamed text');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(viewport.scrollTop).toBe(300);
  act(() => root.unmount());
});

it('keeps following content after StrictMode replays effects', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (text: string): void => {
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <StrictMode>
            <ChatTranscript
              messages={[MESSAGES[0], { ...MESSAGES[1], text }]}
              turnGroups={TURN_GROUPS}
              status="streaming"
            />
          </StrictMode>
        </ChatLookProvider>,
      ),
    );
  };
  render('first chunk');
  const viewport = container.querySelector('[data-testid="chat-transcript"]');
  if (!viewport) throw new Error('Transcript missing');
  Object.defineProperties(viewport, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
    scrollTop: { value: 100, writable: true },
  });
  render('more streamed text');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(viewport.scrollTop).toBe(2000);
  act(() => root.unmount());
});

it('keeps a pinned reader at the bottom when the footer grows', () => {
  const observed: Element[] = [];
  let notify: (() => void) | null = null;
  const previous = globalThis.ResizeObserver;
  class RecordingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notify = (): void => callback([], this);
    }
    observe(target: Element): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = RecordingResizeObserver;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <ChatTranscript
            messages={[]}
            turnGroups={[]}
            status="idle"
            footerSlot={<div data-testid="queued-footer">queued</div>}
          />
        </ChatLookProvider>,
      ),
    );
    const viewport = container.querySelector('[data-testid="chat-transcript"]');
    const footer = container.querySelector('[data-testid="queued-footer"]');
    if (!viewport || !footer?.parentElement)
      throw new Error('Transcript missing');
    // Growth inside the footer resizes the column, not the scroll container.
    expect(observed).toContain(footer.parentElement);
    Object.defineProperties(viewport, {
      scrollHeight: { value: 2000 },
      scrollTop: { value: 0, writable: true },
    });
    act(() => notify?.());
    expect(viewport.scrollTop).toBe(2000);
  } finally {
    act(() => root.unmount());
    globalThis.ResizeObserver = previous;
  }
});

describe('ChatTranscript and the Chat visuals panel', () => {
  const reference = {
    version: 1 as const,
    visualId: 'vis_00000000-0000-4000-8000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    byteLength: 1,
    mediaType: 'text/html' as const,
    title: 'Chart',
    maxHeight: 400,
  };
  const messages: PortalChatMessage[] = [
    msg('u1', 'show a chart'),
    {
      ...msg('a1', ''),
      parts: [
        { kind: 'tool_result', data: { toolUseId: 't1', visual: reference } },
      ],
    },
    msg('a2', 'here it is'),
  ];
  // The visual's message is held but not drawn here: publishing reads the
  // message list, and drawing a visual needs a client this test does not have.
  const turnGroups: PortalChatTurnGroup[] = [
    {
      userMessageId: 'u1',
      intermediateMessageIds: [],
      finalMessageIds: ['a2'],
    },
  ];

  function Listed({ sourceKey }: { sourceKey: string }): React.JSX.Element {
    const source = useChatVisualsSource(sourceKey);
    return (
      <output data-testid="listed">
        {source
          ? source.owners
              .map((owner) => `${owner.messageId}:${owner.toolUseId}`)
              .join(',')
          : 'none'}
      </output>
    );
  }

  function mountTranscript(host: ChatVisualHost): HTMLElement {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <>
            <ChatVisualHostProvider value={host}>
              <ChatTranscript
                messages={messages}
                turnGroups={turnGroups}
                status="idle"
              />
            </ChatVisualHostProvider>
            <Listed sourceKey="chat-key" />
          </>
        </ChatLookProvider>,
      ),
    );
    return container;
  }

  const read = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array());

  beforeEach(() => resetChatVisualsSourcesForTests());

  it('publishes the visuals it holds under the host key', () => {
    const container = mountTranscript({
      read,
      openLink: (): void => undefined,
      sourceKey: 'chat-key',
    });
    expect(container.querySelector('[data-testid="listed"]')?.textContent).toBe(
      'a1:t1',
    );
  });

  it('publishes nothing for a host without a panel', () => {
    const container = mountTranscript({
      read,
      openLink: (): void => undefined,
    });
    expect(container.querySelector('[data-testid="listed"]')?.textContent).toBe(
      'none',
    );
  });
});

describe('ChatTranscript when the person sends a prompt', () => {
  const WATCHER_PROMPT =
    '<system_instruction><canopy_watcher_event>{"label":"Build finished"}</canopy_watcher_event></system_instruction>';

  function prompt(
    id: string,
    createdAtMs: number,
    text = id,
  ): PortalChatMessage {
    return {
      ...msg(id, text),
      role: 'user',
      promptSource: 'human',
      createdAtMs,
    };
  }
  function reply(id: string, createdAtMs: number): PortalChatMessage {
    return { ...msg(id, id), role: 'assistant', createdAtMs };
  }
  interface TranscriptState {
    messages?: readonly PortalChatMessage[];
    chatId?: string;
    queuedPromptCount?: number;
    queuedPromptIds?: readonly string[];
    queuedPromptMessageIds?: readonly string[];
    initialized?: boolean;
    status?: 'idle' | 'error';
  }
  interface MountedTranscript {
    metrics: { scrollHeight: number; clientHeight: number };
    render: (props?: TranscriptState) => void;
    scrollUp: () => void;
    flush: () => Promise<void>;
    bottomGap: () => number;
    offset: () => number;
    unmount: () => void;
  }
  function groupsFor(
    messages: readonly PortalChatMessage[],
  ): PortalChatTurnGroup[] {
    return messages
      .filter((message) => message.role === 'user')
      .map((message) => ({
        userMessageId: message.messageId,
        intermediateMessageIds: [],
        finalMessageIds: [],
      }));
  }

  const HISTORY: PortalChatMessage[] = [prompt('u1', 1), reply('a1', 2)];

  /**
   * Mounts a transcript with browser scroll geometry: the offset clamps to
   * `scrollHeight - clientHeight`, so the bottom gap is what a reader sees.
   */
  function mount(initial: TranscriptState = {}): MountedTranscript {
    const container = document.createElement('div');
    const root = createRoot(container);
    const metrics = { scrollHeight: 2_000, clientHeight: 500 };
    let offset = 0;
    let viewport: HTMLElement | null = null;
    const render = (props: TranscriptState = {}): void => {
      const messages = props.messages ?? initial.messages ?? HISTORY;
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <ChatTranscript
              {...{
                initialized: props.initialized ?? initial.initialized ?? true,
                queuedPromptIds:
                  props.queuedPromptIds ?? initial.queuedPromptIds,
                queuedPromptMessageIds:
                  props.queuedPromptMessageIds ??
                  initial.queuedPromptMessageIds,
              }}
              chatId={props.chatId ?? initial.chatId ?? 'c1'}
              messages={messages}
              turnGroups={groupsFor(messages)}
              status={props.status ?? 'idle'}
              footerSlot={<div />}
              queuedPromptCount={
                props.queuedPromptCount ?? initial.queuedPromptCount ?? 0
              }
            />
          </ChatLookProvider>,
        ),
      );
      const next = container.querySelector<HTMLElement>(
        '[data-testid="chat-transcript"]',
      );
      if (next && next !== viewport) {
        viewport = next;
        Object.defineProperties(next, {
          scrollHeight: { get: () => metrics.scrollHeight },
          clientHeight: { get: () => metrics.clientHeight },
          scrollTop: {
            get: () => offset,
            set: (value: number) => {
              offset = Math.max(
                0,
                Math.min(value, metrics.scrollHeight - metrics.clientHeight),
              );
            },
          },
        });
      }
    };
    render();
    const element = (): HTMLElement => {
      if (!viewport) throw new Error('Transcript missing');
      return viewport;
    };
    const bottomGap = (): number =>
      metrics.scrollHeight - metrics.clientHeight - offset;
    const scrollUp = (): void => {
      const target = element();
      act(() => {
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, bubbles: true }),
        );
        target.scrollTop = 100;
        target.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
    };
    const flush = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    };
    return {
      metrics,
      render,
      scrollUp,
      flush,
      bottomGap,
      offset: (): number => offset,
      unmount: (): void => act(() => root.unmount()),
    };
  }

  it('jumps to the bottom and follows the reply after a send from above', async () => {
    const view = mount();
    view.scrollUp();
    expect(view.bottomGap()).toBe(1_400);

    view.metrics.scrollHeight = 2_400;
    view.render({ messages: [...HISTORY, prompt('u2', 3)] });
    expect(view.bottomGap()).toBe(0);

    // The reply streams in below the prompt and stays in view.
    view.metrics.scrollHeight = 2_900;
    view.render({ messages: [...HISTORY, prompt('u2', 3), reply('a2', 4)] });
    await view.flush();
    expect(view.bottomGap()).toBe(0);
    view.unmount();
  });

  it('stops following when the reader scrolls up again after sending', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('u2', 3)] });
    expect(view.bottomGap()).toBe(0);

    view.scrollUp();
    view.metrics.scrollHeight = 2_600;
    view.render({ messages: [...HISTORY, prompt('u2', 3), reply('a2', 4)] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('re-arms when a human queue entry is replaced at the same count', () => {
    const view = mount({ queuedPromptCount: 1, queuedPromptIds: ['q1'] });
    view.scrollUp();
    view.render({ queuedPromptCount: 1, queuedPromptIds: ['q2'] });
    expect(view.bottomGap()).toBe(0);
    view.unmount();
  });

  it('preserves scrollback when an observed queue entry is restored', async () => {
    const view = mount({ queuedPromptCount: 1, queuedPromptIds: ['q1'] });
    view.scrollUp();
    view.render({ queuedPromptCount: 0, queuedPromptIds: [] });
    view.render({ queuedPromptCount: 1, queuedPromptIds: ['q1'] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.render({ queuedPromptCount: 2, queuedPromptIds: ['q1', 'q2'] });
    expect(view.bottomGap()).toBe(0);
    view.unmount();
  });

  it('does not mistake loading transitions for sends', async () => {
    const view = mount({ initialized: false });
    view.scrollUp();
    view.render({
      initialized: false,
      messages: [...HISTORY, prompt('u2', 3)],
    });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.render({ initialized: true, messages: [...HISTORY, prompt('u2', 3)] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('does not re-arm for a plain-text automated prompt', async () => {
    const view = mount();
    view.scrollUp();
    const automated = {
      ...prompt('hook', 3),
      promptSource: 'automated' as const,
    };
    view.render({ messages: [...HISTORY, automated] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('jumps to the bottom when the prompt is queued', () => {
    const view = mount();
    view.scrollUp();
    view.render({ queuedPromptCount: 1 });
    expect(view.bottomGap()).toBe(0);
    view.unmount();
  });

  it('does not re-arm when queue removal precedes transcript delivery', async () => {
    const view = mount({
      queuedPromptCount: 1,
      queuedPromptIds: ['q1'],
      queuedPromptMessageIds: ['u2'],
    });
    view.scrollUp();
    view.render({
      queuedPromptCount: 0,
      queuedPromptIds: [],
      queuedPromptMessageIds: [],
    });
    view.render({
      messages: [...HISTORY, prompt('u2', 3)],
      queuedPromptCount: 0,
      queuedPromptIds: [],
      queuedPromptMessageIds: [],
    });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('keeps the reader in place when a queued prompt moves into the transcript', async () => {
    const view = mount({ queuedPromptCount: 1 });
    view.scrollUp();
    view.render({
      messages: [...HISTORY, prompt('u2', 3)],
      queuedPromptCount: 0,
    });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('jumps once for an optimistic prompt, not again when it is persisted', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('optimistic:u2', 3, 'ask')] });
    expect(view.bottomGap()).toBe(0);

    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('u2', 4, 'ask')] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('keeps the reader in place when a rejected send adds no prompt or queue row', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ status: 'error', messages: [...HISTORY] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('does not re-arm for reconciliation with an earlier authoritative timestamp', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('optimistic-skew', 10_000)] });
    expect(view.bottomGap()).toBe(0);
    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('authoritative-skew', 3)] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('follows a new enqueue batched with dequeue, then ignores the later dequeue', async () => {
    const view = mount({ queuedPromptCount: 1, queuedPromptIds: ['q1'] });
    view.scrollUp();
    const sent = [...HISTORY, prompt('u2', 3)];
    view.render({
      messages: sent,
      queuedPromptCount: 1,
      queuedPromptIds: ['q2'],
    });
    expect(view.bottomGap()).toBe(0);
    view.scrollUp();
    view.render({
      messages: [...sent, prompt('u3', 4)],
      queuedPromptCount: 0,
      queuedPromptIds: [],
    });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('keeps the reader in place when a failed send is rolled back', async () => {
    const view = mount({ messages: [...HISTORY, prompt('u2', 3)] });
    view.scrollUp();
    view.render({ messages: HISTORY });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('keeps the reader in place for a watcher prompt', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ messages: [...HISTORY, prompt('u2', 3, WATCHER_PROMPT)] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('keeps the reader in place when older history loads above', async () => {
    const view = mount();
    view.scrollUp();
    view.render({ messages: [prompt('u0', 0), reply('a0', 0), ...HISTORY] });
    await view.flush();
    expect(view.bottomGap()).not.toBe(0);
    view.unmount();
  });

  it('adopts a hydrated transcript as already seen', async () => {
    const view = mount({ messages: [], initialized: false });
    view.scrollUp();
    view.render({ messages: HISTORY, initialized: true });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('adopts the prompts of a newly selected chat as already seen', async () => {
    const view = mount();
    view.scrollUp();
    view.render({
      chatId: 'c2',
      messages: [prompt('c2-u1', 5), reply('c2-a1', 6), prompt('c2-u2', 7)],
    });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });

  it('leaves the first prompt of an empty chat at the bottom', () => {
    const view = mount({ messages: [] });
    view.render({ messages: [prompt('u1', 1)] });
    expect(view.bottomGap()).toBe(0);
    view.unmount();
  });

  it('does not replay a send on a re-render with the same prompts', async () => {
    const view = mount();
    view.scrollUp();
    const sent = [...HISTORY, prompt('u2', 3)];
    view.render({ messages: sent });
    expect(view.bottomGap()).toBe(0);

    view.scrollUp();
    view.render({ messages: [...sent] });
    await view.flush();
    expect(view.offset()).toBe(100);
    view.unmount();
  });
});

describe('CAN-4450 recovered credit hold in Portal transcript', () => {
  function renderRetry(
    messages = CREDIT_RETRY_MESSAGES,
    cancelled = false,
  ): string {
    const projected = messages.map((message) =>
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'c1',
        message,
      }),
    );
    // The Portal host also supplies the terminal row status from its turn state.
    if (cancelled) projected[9].status = 'cancelled';
    return renderToString(
      <ChatLookProvider value="classic">
        <ChatTranscript
          messages={projected}
          turnGroups={computeIncrementalTurnGroups(
            'c1',
            projected,
            createEmptyTurnGroupCache(),
          )}
          status="idle"
        />
      </ChatLookProvider>,
    );
  }

  it('removes the recovered inline notice while retaining the reply and original user row once', () => {
    const out = renderRetry();
    expect(out).not.toContain(
      'Chat stopped. Choose how to pay for this message to keep going.',
    );
    expect(out).toContain('Ready for your project summary');
    expect(out).toContain(
      'API Error: 402 AI Credits are unavailable for this request.',
    );
    expect(out.match(/Summarize this project\./g)).toHaveLength(1);
  });

  it('keeps the cancelled partial reply footer and warning without a detached prior-attempt timestamp', () => {
    const host = document.createElement('div');
    host.innerHTML = renderRetry(cancelledCreditRetry(), true);
    expect(host.textContent).toContain(
      'Chat stopped. Choose how to pay for this message to keep going.',
    );
    expect(host.textContent?.match(/Summarize this project\./g)).toHaveLength(
      1,
    );
    expect(host.textContent).toContain('Ready for your project summary');
    const footerLabel = host.querySelector(
      `[data-testid="turn-timer-label"][title="Cancelled at ${new Date(1793229281367).toLocaleString()}"]`,
    );
    expect(footerLabel?.textContent).toBe('Cancelled after 0:29');
    expect(
      host.querySelector(
        `[title="Completed at ${new Date(1793228712687).toLocaleString()}"]`,
      ),
    ).toBeNull();
    expect(host.querySelectorAll('[data-testid="turn-timer"]')).toHaveLength(3);
  });

  it('retains the notice and both attempt timers through the actual native Stop Portal projection', () => {
    const out = renderRetry(nativeStoppedCreditRetry());
    expect(out).toContain(
      'Chat stopped. Choose how to pay for this message to keep going.',
    );
    expect(out.match(/data-testid="turn-timer"/g)).toHaveLength(4);
  });

  it('removes only the obsolete credit-attempt footer, preserving ordinary failed and successful timing', () => {
    expect(renderRetry().match(/data-testid="turn-timer"/g)).toHaveLength(3);
  });

  it('keeps unresolved credit-hold copy and timing', () => {
    const out = renderRetry(CREDIT_RETRY_MESSAGES.slice(0, -2));
    expect(out).toContain(
      'Chat stopped. Choose how to pay for this message to keep going.',
    );
    expect(out.match(/data-testid="turn-timer"/g)).toHaveLength(3);
  });
});
