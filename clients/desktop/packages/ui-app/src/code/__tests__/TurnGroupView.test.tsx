/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  PortalAskUserQuestionState,
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';

import {
  ChatLookProvider,
  ChatDetailProvider,
} from '@canopy/ui-shared/components/chat-look';
import { TurnGroupView } from '../TurnGroupView';
import {
  ToolOutputReaderContext,
  type ToolOutputReader,
} from '../DeferredToolOutput';
import { AskUserQuestionInteractionProvider } from '../ChatPartView';
import {
  ChatVisualHostProvider,
  type ChatVisualHost,
} from '../chat-visual-host';

jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCapabilities: (): { chatVisuals: boolean } => ({ chatVisuals: true }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.TextEncoder = jest.requireActual<{
  TextEncoder: typeof TextEncoder;
}>('node:util').TextEncoder;

function msg(
  id: string,
  role: PortalChatMessage['role'],
  text: string,
): PortalChatMessage {
  return {
    messageId: id,
    chatId: 'c1',
    role,
    status: 'complete',
    text,
    createdAtMs: 0,
  };
}

function render(
  turnGroup: PortalChatTurnGroup,
  messages: PortalChatMessage[],
  clean = false,
): string {
  const byId: Record<string, PortalChatMessage> = {};
  for (const m of messages) {
    byId[m.messageId] = m;
  }
  return renderToString(
    <ChatLookProvider value={clean ? 'clean' : 'classic'}>
      <TurnGroupView
        turnGroup={turnGroup}
        messagesById={byId}
        resultsComplete
      />
    </ChatLookProvider>,
  );
}

describe('TurnGroupView', () => {
  it('folds Detailed steps on completion and lets the reader reopen them', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const draw = (complete: boolean): void => {
      act(() =>
        root.render(
          <ChatLookProvider value="clean">
            <ChatDetailProvider value="detailed">
              <TurnGroupView
                turnGroup={{
                  userMessageId: 'u1',
                  intermediateMessageIds: ['work'],
                  finalMessageIds: ['answer'],
                  complete,
                }}
                messagesById={{
                  u1: msg('u1', 'user', 'Check the project'),
                  work: msg('work', 'assistant', 'Inspecting the project'),
                  answer: msg('answer', 'assistant', 'The project is ready.'),
                }}
              />
            </ChatDetailProvider>
          </ChatLookProvider>,
        ),
      );
    };
    try {
      draw(false);
      expect(container.textContent).toContain('Inspecting the project');
      draw(true);
      expect(container.textContent).not.toContain('Inspecting the project');
      expect(container.textContent).toContain('The project is ready.');
      const toggle = container.querySelector<HTMLButtonElement>(
        'button[aria-expanded]',
      );
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle?.click());
      expect(container.textContent).toContain('Inspecting the project');
      draw(true);
      expect(container.textContent).toContain('Inspecting the project');
      act(() => toggle?.click());
      expect(container.textContent).not.toContain('Inspecting the project');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each([false, true])(
    'projects frozen paused wording in both web looks (clean=%s, CAN-4996)',
    (clean) => {
      const timer: PortalChatMessage = {
        ...msg('timer', 'system', ''),
        status: 'streaming',
        parts: [
          {
            kind: 'turn_timer',
            data: {
              startedAt: 1_000,
              pausedAt: 71_000,
              accumulatedPausedDurationMs: 5_000,
              completedAt: null,
            },
          },
        ],
      };
      const html = render(
        {
          userMessageId: 'user',
          intermediateMessageIds: [],
          finalMessageIds: ['reply', 'timer'],
          complete: false,
        },
        [
          msg('user', 'user', 'Proceed'),
          { ...msg('reply', 'assistant', 'Preparing'), status: 'streaming' },
          timer,
        ],
        clean,
      );
      expect(html).toContain('data-state="paused"');
      expect(html).toContain('Waiting for you · 1:05');
      expect(html).not.toContain('Working…');
      if (clean) {
        expect(html).toContain('data-turn-header="paused"');
        expect(html).not.toContain('Thinking');
      }
    },
  );

  it.each(['clean', 'classic'] as const)(
    'shares the pending header in the %s look through timer acknowledgement',
    (look) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      const user = msg('u1', 'user', 'Question');
      const timer: PortalChatMessage = {
        ...msg('t1', 'system', ''),
        status: 'streaming',
        parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
      };
      const draw = (
        messages: Record<string, PortalChatMessage>,
        ids: string[],
      ): void => {
        act(() =>
          root.render(
            <ChatLookProvider value={look}>
              <TurnGroupView
                starting
                latest
                turnGroup={{
                  userMessageId: 'u1',
                  intermediateMessageIds: [],
                  finalMessageIds: ids,
                  complete: false,
                }}
                messagesById={messages}
              />
            </ChatLookProvider>,
          ),
        );
      };
      try {
        draw({ u1: user }, []);
        const status = host.querySelector(
          '[data-testid="turn-starting-status"]',
        );
        expect(status?.querySelector('[role="status"]')?.textContent).toBe(
          'Starting…',
        );
        draw({ u1: user, t1: timer }, ['t1']);
        expect(host.querySelector('[data-testid="turn-starting-status"]')).toBe(
          status,
        );
        expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
        draw({ u1: user, t1: timer, a1: msg('a1', 'assistant', 'Answer') }, [
          'a1',
          't1',
        ]);
        expect(
          host.querySelector('[data-testid="turn-starting-status"]'),
        ).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    },
  );
  it.each(['thinking', 'agent', 'image'] as const)(
    'ends starting on first %s activity',
    (kind) => {
      const html = renderToString(
        <ChatLookProvider value="classic">
          <TurnGroupView
            starting
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: ['a1'],
              finalMessageIds: [],
              complete: false,
            }}
            messagesById={{
              u1: msg('u1', 'user', 'hi'),
              a1: {
                ...msg('a1', 'assistant', ''),
                status: 'streaming',
                parts: [
                  {
                    kind,
                    data: {
                      text: 'Checking the source.',
                      description: 'Check the source',
                      assetId: 'answer-image',
                    },
                  },
                ],
              },
            }}
          />
        </ChatLookProvider>,
      );
      expect(html).not.toContain('turn-starting-status');
    },
  );

  it.each(['EnterPlanMode', 'ExitPlanMode'])(
    'matches starting status to the rendered %s tool',
    (toolName) => {
      const html = renderToString(
        <ChatLookProvider value="classic">
          <TurnGroupView
            starting
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: ['a1'],
              finalMessageIds: [],
              complete: false,
            }}
            messagesById={{
              u1: msg('u1', 'user', 'hi'),
              a1: {
                ...msg('a1', 'assistant', ''),
                status: 'streaming',
                parts: [{ kind: 'tool_use', data: { toolName, input: {} } }],
              },
            }}
          />
        </ChatLookProvider>,
      );
      if (toolName === 'EnterPlanMode')
        expect(html).toContain('turn-starting-status');
      else expect(html).not.toContain('turn-starting-status');
    },
  );

  it.each(['failed', 'cancelled'] as const)(
    'keeps %s actions visible when the host supplies no timer part',
    (status) => {
      const out = renderToString(
        <ChatLookProvider value="classic">
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1'],
              complete: true,
            }}
            messagesById={{
              u1: msg('u1', 'user', 'hi'),
              a1: { ...msg('a1', 'assistant', 'Stopped'), status },
            }}
            actionSlot={<button>Fork</button>}
          />
        </ChatLookProvider>,
      );
      const host = document.createElement('div');
      host.innerHTML = out;
      expect(
        host.querySelector('[data-testid="chat-turn-actions"]')?.className,
      ).not.toContain('opacity-0');
    },
  );
  it.each(['complete', 'failed', 'cancelled'] as const)(
    'applies the footer reveal to %s turn action slots, never the thumbs',
    (status) => {
      const timer: PortalChatMessage = {
        ...msg('timer', 'system', ''),
        status,
        parts: [
          { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
        ],
      };
      const out = renderToString(
        <ChatLookProvider value="classic">
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['timer'],
              complete: true,
            }}
            messagesById={{ u1: msg('u1', 'user', 'hi'), timer }}
            actionSlot={<button>Fork</button>}
            feedbackSlot={<button>Rate</button>}
          />
        </ChatLookProvider>,
      );
      const host = document.createElement('div');
      host.innerHTML = out;
      const row = host.querySelector('[data-testid="chat-turn-actions"]');
      const actions = host.querySelector(
        '[data-testid="chat-turn-action-slot"]',
      );
      const feedback = host.querySelector('[data-testid="chat-turn-feedback"]');
      // Like desktop, the actions follow the elapsed label inside the timer
      // row rather than in a separate row below it.
      expect(row).toBeNull();
      const timerRow = actions?.closest('[data-testid="turn-timer"]');
      expect(timerRow).not.toBeNull();
      const order = Array.from(
        timerRow?.querySelectorAll(
          '[data-testid="turn-timer-relative"], [data-testid="chat-turn-feedback"], [data-testid="turn-timer-label"], [data-testid="chat-turn-action-slot"]',
        ) ?? [],
      ).map((el) => el.getAttribute('data-testid'));
      expect(order).toEqual([
        'turn-timer-relative',
        'chat-turn-feedback',
        'turn-timer-label',
        'chat-turn-action-slot',
      ]);
      expect(feedback).not.toBeNull();
      expect(feedback?.className).not.toContain('opacity-0');
      expect(
        feedback?.closest('[data-testid="turn-timer-stamp-accessory"]'),
      ).not.toBeNull();
      if (status === 'complete') {
        expect(actions?.className).toContain('opacity-0');
        expect(actions?.className).toContain(
          'group-focus-within/turn:opacity-100',
        );
      } else {
        expect(actions?.className).not.toContain('opacity-0');
      }
    },
  );
  it('keeps a clean reply row in view at rest, on older turns too', () => {
    const timer: PortalChatMessage = {
      ...msg('timer', 'system', ''),
      status: 'complete' as const,
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
      ],
    };
    const withTimer = renderToString(
      <ChatLookProvider value="clean">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: ['timer'],
            complete: true,
          }}
          messagesById={{ u1: msg('u1', 'user', 'hi'), timer }}
          actionSlot={<button>Fork</button>}
        />
      </ChatLookProvider>,
    );
    // The prompt's corner badges keep their hover reveal; the reply row
    // under the turn does not.
    const replyRow = (html: string, testId: string): string => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return host.querySelector(`[data-testid="${testId}"]`)?.outerHTML ?? '';
    };
    expect(replyRow(withTimer, 'turn-timer')).toContain(
      'chat-turn-action-slot',
    );
    expect(replyRow(withTimer, 'turn-timer')).not.toContain('opacity-0');
    const ownRow = renderToString(
      <ChatLookProvider value="clean">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: ['a1'],
            complete: true,
          }}
          messagesById={{
            u1: msg('u1', 'user', 'hi'),
            a1: msg('a1', 'assistant', 'Done.'),
          }}
          actionSlot={<button>Fork</button>}
        />
      </ChatLookProvider>,
    );
    expect(replyRow(ownRow, 'chat-turn-actions')).toContain('Fork');
    expect(replyRow(ownRow, 'chat-turn-actions')).not.toContain('opacity-0');
  });
  it('keeps actions and thumbs in their own row when an interrupted timer renders nothing', () => {
    // A settled message whose timer never completed renders no timer row, so
    // the actions and thumbs must not be routed into it.
    const timer: PortalChatMessage = {
      ...msg('timer', 'system', ''),
      parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
    };
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: ['timer'],
            complete: true,
          }}
          messagesById={{ u1: msg('u1', 'user', 'hi'), timer }}
          actionSlot={<button>Fork</button>}
          feedbackSlot={<button>Rate</button>}
        />
      </ChatLookProvider>,
    );
    expect(host.querySelector('[data-testid="turn-timer"]')).toBeNull();
    const row = host.querySelector('[data-testid="chat-turn-actions"]');
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="chat-turn-action-slot"]'),
    ).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="chat-turn-feedback"]'),
    ).not.toBeNull();
  });
  it('trims the trailing footer gap to the transcript column gap', () => {
    const timer: PortalChatMessage = {
      ...msg('timer', 'system', ''),
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = render(
      {
        userMessageId: 'u1',
        intermediateMessageIds: [],
        finalMessageIds: ['timer'],
        complete: true,
      },
      [msg('u1', 'user', 'hi'), timer],
    );
    // The transcript column adds gap-2 between turns, so 12px here plus that
    // 8px equals the desktop footer's collapsed 20px gap (CAN-4278).
    const classes =
      host
        .querySelector('[data-testid="turn-timer"]')
        ?.className.split(/\s+/) ?? [];
    expect(classes).toContain('mb-3');
    expect(classes).not.toContain('mb-5');
  });
  it.each([
    ['inline actions', { actionSlot: <button>Fork</button> }, 'mb-3'],
    ['a working row', { workingSlot: <span>Working</span> }, 'mb-5'],
  ])('with %s, leaves the footer a %s margin', (_, slots, expected) => {
    const timer: PortalChatMessage = {
      ...msg('timer', 'system', ''),
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: ['timer'],
            complete: true,
          }}
          messagesById={{ u1: msg('u1', 'user', 'hi'), timer }}
          {...slots}
        />
      </ChatLookProvider>,
    );
    // A row below the footer gets no column gap, so the trim would pull it
    // up; actions inline in the footer leave it the turn's last row.
    const classes =
      host
        .querySelector('[data-testid="turn-timer"]')
        ?.className.split(/\s+/) ?? [];
    expect(classes).toContain(expected);
    expect(classes).not.toContain(expected === 'mb-5' ? 'mb-3' : 'mb-5');
  });
  it('keeps an intermediate visual visible while its turn is collapsed', () => {
    const visual = {
      version: 1,
      visualId: 'vis_00000000-0000-0000-0000-000000000001',
      artifactId: 'sha256-v1-abc',
      sha256: 'a'.repeat(64),
      byteLength: 12,
      mediaType: 'text/html',
      title: 'Chart',
      maxHeight: 400,
    };
    const host: ChatVisualHost = {
      read: () => Promise.resolve(new Uint8Array()),
      openLink: () => {},
    };
    const byId = {
      u1: msg('u1', 'user', 'chart'),
      a1: {
        ...msg('a1', 'assistant', ''),
        parts: [
          {
            kind: 'tool_result',
            data: { toolUseId: 'tool-1', messageId: 'a1', visual },
          },
        ],
      } satisfies PortalChatMessage,
      a2: msg('a2', 'assistant', 'done'),
    };
    const markup = renderToString(
      <ChatLookProvider value="classic">
        <ChatVisualHostProvider value={host}>
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: ['a1'],
              finalMessageIds: ['a2'],
              complete: true,
            }}
            messagesById={byId}
          />
        </ChatVisualHostProvider>
      </ChatLookProvider>,
    );
    expect(markup).toContain('data-variant="visual-only"');
    expect(markup).not.toContain('Tool result');
  });
  it('collapses intermediates behind a summary chip; shows user + final inline', () => {
    const out = render(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
        summary: { bashCount: 2, readCount: 1 },
      },
      [
        msg('u1', 'user', 'do the thing'),
        msg('a1', 'assistant', 'INTERMEDIATE STEP'),
        msg('a2', 'assistant', 'final answer'),
      ],
    );
    expect(out).toContain('data-testid="chat-turn-group"');
    expect(out).toContain('data-testid="chat-turn-summary"');
    expect(out).toContain('do the thing');
    expect(out).toContain('final answer');
    // Intermediate is collapsed by default → not in the SSR output.
    expect(out).not.toContain('INTERMEDIATE STEP');
  });

  it.each([false, true])(
    'names failed folded steps with clean=%s, matching trailing results (CAN-4810)',
    (clean) => {
      const steps: PortalChatMessage = {
        ...msg('a1', 'assistant', ''),
        parts: [
          {
            kind: 'tool_use',
            toolFamily: 'bash',
            data: { toolUseId: 'push', toolName: 'Bash', input: '{}' },
          },
          {
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              toolUseId: 'status',
              toolName: 'Bash',
              input: '{}',
              result: { output: 'clean', isError: false },
            },
          },
        ],
      };
      const final: PortalChatMessage = {
        ...msg('a2', 'assistant', 'final answer'),
        parts: [
          {
            kind: 'tool_result',
            data: { toolUseId: 'push', output: 'denied', isError: true },
          },
        ],
      };
      const out = render(
        {
          userMessageId: 'u1',
          intermediateMessageIds: ['a1'],
          finalMessageIds: ['a2'],
          complete: true,
          summary: { bashCount: 2 },
        },
        [msg('u1', 'user', 'push it'), steps, final],
        clean,
      );
      expect(out).toContain(
        'aria-label="Agent steps: Ran 2 commands, 1 error"',
      );
      expect(out).toContain('data-turn-failed="1"');
      expect(out).not.toContain('data-turn-blocked');
      expect(out).toContain('>1 error<');
      expect(out).not.toContain('failed<');
      expect(out).toContain(
        `data-testid="${clean ? 'turn-work-header' : 'chat-turn-summary'}"`,
      );
      expect(out).toContain('data-turn-step-count="2"');
    },
  );

  describe.each([false, true])(
    'outcome control with clean=%s (CAN-5056)',
    (clean) => {
      const turnGroup: PortalChatTurnGroup = {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
        summary: { bashCount: 3 },
      };
      const failedRun = (
        id: string,
        output: string,
      ): NonNullable<PortalChatMessage['parts']>[number] => ({
        kind: 'tool_use' as const,
        toolFamily: 'bash' as const,
        data: {
          toolUseId: id,
          toolName: 'Bash',
          input: JSON.stringify({ command: `run ${id}` }),
          result: { output, isError: true },
        },
      });
      const messagesById = (
        failures: number,
      ): Record<string, PortalChatMessage> => ({
        u1: msg('u1', 'user', 'run it'),
        a1: {
          ...msg('a1', 'assistant', ''),
          parts: [
            {
              kind: 'tool_use',
              toolFamily: 'bash',
              data: {
                toolUseId: 'ok',
                toolName: 'Bash',
                input: '{}',
                result: { output: 'fine', isError: false },
              },
            },
            ...(failures > 0
              ? [
                  failedRun(
                    'first',
                    'Exit code 1\nzsh: no matches found: *.json',
                  ),
                ]
              : []),
            ...(failures > 1 ? [failedRun('second', 'fatal: no remote')] : []),
          ],
        },
        a2: msg('a2', 'assistant', 'done'),
      });
      let container: HTMLDivElement;
      let root: ReturnType<typeof createRoot>;
      beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
      });
      afterEach(() => {
        act(() => root.unmount());
        document.body.replaceChildren();
      });
      const draw = (
        failures: number,
        onShowSpawningCall?: (target: { toolUseId?: string }) => void,
      ): HTMLElement | null => {
        act(() =>
          root.render(
            <ChatLookProvider value={clean ? 'clean' : 'classic'}>
              <TurnGroupView
                turnGroup={turnGroup}
                messagesById={messagesById(failures)}
                onShowSpawningCall={onShowSpawningCall}
              />
            </ChatLookProvider>,
          ),
        );
        return container.querySelector<HTMLElement>(
          '[data-testid="turn-outcome-control"]',
        );
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

      it('only describes the steps without a reveal path', () => {
        const control = draw(2);
        expect(control?.tagName).toBe('SPAN');
        if (!control) throw new Error('Missing outcome control');
        hover(control);
        const surface = document.querySelector(
          '[data-testid="turn-outcome-tooltip-surface"]',
        );
        expect(surface?.textContent).toContain('zsh: no matches found: *.json');
        expect(surface?.textContent).toContain('fatal: no remote');
        expect(surface?.textContent).not.toMatch(/exit code/i);
        expect(surface?.querySelector('button')).toBeNull();
      });

      it('only says the count when no errored call carries an id', () => {
        const anonymous: NonNullable<PortalChatMessage['parts']>[number] = {
          kind: 'tool_use',
          toolFamily: 'bash',
          data: {
            toolName: 'Bash',
            input: '{}',
            result: { output: 'boom', isError: true },
          },
        };
        const messages = messagesById(0);
        act(() =>
          root.render(
            <ChatLookProvider value={clean ? 'clean' : 'classic'}>
              <TurnGroupView
                turnGroup={turnGroup}
                messagesById={{
                  ...messages,
                  a1: { ...messages['a1'], parts: [anonymous] },
                }}
                onShowSpawningCall={jest.fn()}
              />
            </ChatLookProvider>,
          ),
        );
        const control = container.querySelector<HTMLElement>(
          '[data-testid="turn-outcome-control"]',
        );
        expect(control?.tagName).toBe('SPAN');
        if (!control) throw new Error('Missing outcome control');
        hover(control);
        expect(
          document.querySelector('[data-testid="turn-outcome-tooltip-surface"]')
            ?.textContent,
        ).toBe('1 step ran into an errorEffect on the result is unknown');
      });

      it('renders no control for a turn without errors', () => {
        expect(draw(0, jest.fn())).toBeNull();
      });

      it('reveals the first errored call, or the entry a reader picks', () => {
        const onShowSpawningCall = jest.fn();
        const control = draw(2, onShowSpawningCall);
        expect(control?.tagName).toBe('BUTTON');
        if (!control) throw new Error('Missing outcome control');

        act(() => control.click());
        expect(onShowSpawningCall).toHaveBeenLastCalledWith({
          toolUseId: 'first',
        });

        hover(control);
        act(() =>
          document
            .querySelector<HTMLElement>('[data-turn-outcome-step="second"]')
            ?.click(),
        );
        expect(onShowSpawningCall).toHaveBeenLastCalledWith({
          toolUseId: 'second',
        });
        // Neither click folds or opens the turn itself.
        expect(
          container
            .querySelector('button[aria-expanded]')
            ?.getAttribute('aria-expanded'),
        ).toBe('false');
      });
    },
  );

  it("heads a wake's turn with its boundary row and a link to the call that started it (turn-state phase 40e)", () => {
    const onShowSpawningCall = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <TurnGroupView
            turnGroup={{
              userMessageId: 'tw',
              intermediateMessageIds: [],
              finalMessageIds: ['a-wake'],
              complete: false,
              wake: {
                taskLabel: 'build errors',
                spawningUserMessageId: 'u1',
                spawningToolUseId: 'toolu-monitor',
                event: true,
              },
            }}
            messagesById={{
              tw: msg('tw', 'system', ''),
              'a-wake': msg('a-wake', 'assistant', 'The build broke.'),
            }}
            onShowSpawningCall={onShowSpawningCall}
          />
        </ChatLookProvider>,
      ),
    );

    // The event flag reaches the shared row, which names the event.
    expect(
      container.querySelector('[data-testid="wake-turn-boundary"]')
        ?.textContent,
    ).toContain('Continued after an event from build errors');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="wake-turn-boundary-show-spawning-turn"]',
        )
        ?.click(),
    );
    expect(onShowSpawningCall).toHaveBeenCalledWith({
      toolUseId: 'toolu-monitor',
      userMessageId: 'u1',
    });
    act(() => root.unmount());
    container.remove();
  });

  it('opens a collapsed turn to reveal the call a host asks for, and anchors the call row', () => {
    const turnGroup: PortalChatTurnGroup = {
      userMessageId: 'u1',
      intermediateMessageIds: ['a1'],
      finalMessageIds: ['a2'],
      complete: true,
      summary: { bashCount: 1 },
    };
    const messagesById = {
      u1: msg('u1', 'user', 'watch the build'),
      a1: {
        ...msg('a1', 'assistant', ''),
        parts: [
          {
            kind: 'tool_use' as const,
            toolFamily: 'bash' as const,
            data: {
              toolName: 'Monitor',
              toolUseId: 'toolu-monitor',
              input: JSON.stringify({ description: 'build errors' }),
            },
          },
        ],
      },
      a2: msg('a2', 'assistant', 'Watching the build.'),
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderTurn = (revealRequest?: { toolUseId: string }): void =>
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnGroupView
              turnGroup={turnGroup}
              messagesById={messagesById}
              revealRequest={revealRequest}
            />
          </ChatLookProvider>,
        ),
      );

    renderTurn();
    expect(
      container.querySelector('[data-tool-use-id="toolu-monitor"]'),
    ).toBeNull();

    renderTurn({ toolUseId: 'toolu-monitor' });
    expect(
      container.querySelector('[data-tool-use-id="toolu-monitor"]'),
    ).not.toBeNull();
    // Opened as saved state: the chip still collapses it.
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-turn-summary"]',
    );
    expect(chip?.getAttribute('aria-expanded')).toBe('true');
    act(() => root.unmount());
    container.remove();
  });

  it('opens the clean folded line that holds the call a host asks for', () => {
    // Under the clean look with grouped tool calls, the call sits inside a
    // folded steps line; revealing it must open that line, not just the turn.
    const turnGroup: PortalChatTurnGroup = {
      userMessageId: 'u1',
      intermediateMessageIds: ['a1'],
      finalMessageIds: ['a2'],
      complete: true,
      summary: { bashCount: 1 },
    };
    const messagesById = {
      u1: msg('u1', 'user', 'watch the build'),
      a1: {
        ...msg('a1', 'assistant', ''),
        parts: [
          {
            kind: 'tool_use' as const,
            toolFamily: 'bash' as const,
            data: {
              toolName: 'Monitor',
              toolUseId: 'toolu-monitor',
              input: JSON.stringify({ description: 'build errors' }),
              result: 'watching',
            },
          },
        ],
      },
      a2: msg('a2', 'assistant', 'Watching the build.'),
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderTurn = (revealRequest?: { toolUseId: string }): void =>
      act(() =>
        root.render(
          <ChatLookProvider value="clean">
            <ChatDetailProvider value="compact">
              <TurnGroupView
                turnGroup={turnGroup}
                messagesById={messagesById}
                revealRequest={revealRequest}
              />
            </ChatDetailProvider>
          </ChatLookProvider>,
        ),
      );

    renderTurn();
    expect(
      container.querySelector('[data-tool-use-id="toolu-monitor"]'),
    ).toBeNull();

    renderTurn({ toolUseId: 'toolu-monitor' });
    expect(
      container.querySelector('[data-tool-use-id="toolu-monitor"]'),
    ).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('leaves an older saved pause out of the clean "Worked for" time', () => {
    // A saved timer with pausedAt/resumedAt and no pause total: 11 s on the
    // clock, 4 s of it paused for an approval.
    const timer: PortalChatMessage = {
      ...msg('t1', 'system', ''),
      parts: [
        {
          kind: 'turn_timer',
          data: {
            startedAt: 1_000,
            completedAt: 12_000,
            pausedAt: 3_000,
            resumedAt: 7_000,
          },
        },
      ],
    };
    const byId: Record<string, PortalChatMessage> = {
      u1: msg('u1', 'user', 'do the thing'),
      a1: msg('a1', 'assistant', 'INTERMEDIATE STEP'),
      a2: msg('a2', 'assistant', 'final answer'),
      t1: timer,
    };
    const out = renderToString(
      <ChatLookProvider value="clean">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: ['a1'],
            finalMessageIds: ['a2', 't1'],
            complete: true,
            summary: { bashCount: 1 },
          }}
          messagesById={byId}
        />
      </ChatLookProvider>,
    );
    expect(out).toContain('Worked for 7s');
    expect(out).not.toContain('Worked for 11s');
  });

  it('renders intermediates inline with no chip while the turn is incomplete', () => {
    const out = render(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: false,
        summary: { messageCount: 1 },
      },
      [
        msg('u1', 'user', 'hi'),
        msg('a1', 'assistant', 'inline step'),
        msg('a2', 'assistant', 'partial answer'),
      ],
    );
    expect(out).toContain('inline step');
    expect(out).toContain('partial answer');
    expect(out).not.toContain('data-testid="chat-turn-summary"');
  });

  it('collapses completed thinking-only intermediates behind a thinking chip', () => {
    const thinking: PortalChatMessage = {
      ...msg('a1', 'assistant', ''),
      parts: [{ kind: 'thinking', data: { text: 'private reasoning' } }],
    };
    const out = render(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
        summary: { thinkingCount: 1 },
      },
      [msg('u1', 'user', 'hi'), thinking, msg('a2', 'assistant', 'done')],
    );

    expect(out).toContain('data-testid="chat-turn-summary"');
    expect(out).toContain('data-tool-chip="thinking"');
    expect(out).not.toContain('private reasoning');
  });

  it('folds a completed tool-result-only intermediate without restoring the leading label', () => {
    const toolResult: PortalChatMessage = {
      ...msg('a1', 'assistant', ''),
      parts: [{ kind: 'tool_result', data: { output: 'Plan rejected' } }],
    };
    const out = render(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
      },
      [
        msg('u1', 'user', 'stay in plan mode'),
        toolResult,
        msg('a2', 'assistant', 'revised plan'),
      ],
    );

    expect(out).toContain('data-testid="chat-turn-summary"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('data-tool-chip=');
    expect(out).not.toContain('Plan rejected');
    expect(out).not.toContain('>0 steps');
  });

  it('auto-expands a summarized turn while it has a projected question', () => {
    const question: PortalAskUserQuestionState = {
      requestId: 'request-1',
      answered: false,
      questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
    };
    const toolMessage: PortalChatMessage = {
      ...msg('a1', 'assistant', ''),
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'ask-user',
          data: {
            toolName: 'mcp__canopy_ui__AskUserQuestion',
            toolUseId: 'toolu-1',
            input: JSON.stringify({ questions: question.questions }),
          },
        },
      ],
    };
    const byId = { u1: msg('u1', 'user', 'choose'), a1: toolMessage };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <AskUserQuestionInteractionProvider
          value={{
            states: [question],
            onAnswer: jest.fn(),
            onDismiss: jest.fn(),
          }}
        >
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: ['a1'],
              finalMessageIds: [],
              complete: true,
              summary: { askUserCount: 1 },
            }}
            messagesById={byId}
          />
        </AskUserQuestionInteractionProvider>
      </ChatLookProvider>,
    );
    expect(out).toContain('data-testid="ask-user-question-card"');
    expect(out).toContain('Pick a color');
  });

  it('keeps a summarized turn collapsed when its projection is answered (CAN-2608)', () => {
    const question: PortalAskUserQuestionState = {
      requestId: 'request-1',
      answered: true,
      questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
      answers: [{ question: 'Pick a color', selectedOptions: ['Red'] }],
    };
    const toolMessage: PortalChatMessage = {
      ...msg('a1', 'assistant', ''),
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'ask-user',
          data: {
            toolName: 'mcp__canopy_ui__AskUserQuestion',
            toolUseId: 'toolu-1',
            input: JSON.stringify({ questions: question.questions }),
          },
        },
      ],
    };
    const byId = { u1: msg('u1', 'user', 'choose'), a1: toolMessage };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <AskUserQuestionInteractionProvider
          value={{
            states: [question],
            onAnswer: jest.fn(),
            onDismiss: jest.fn(),
          }}
        >
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: ['a1'],
              finalMessageIds: [],
              complete: true,
              summary: { askUserCount: 1 },
            }}
            messagesById={byId}
          />
        </AskUserQuestionInteractionProvider>
      </ChatLookProvider>,
    );
    // Answered projections converge the tool row but must NOT pin the turn
    // open: retained App Advisor entries would otherwise keep every
    // historical question turn permanently expanded.
    expect(out).not.toContain('data-testid="ask-user-question-card"');
    expect(out).not.toContain('Pick a color');
  });

  it('renders a completed turn timer after the final answer text', () => {
    const timer: PortalChatMessage = {
      ...msg('t1', 'system', ''),
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 4000 } },
      ],
    };
    const byId = {
      u1: msg('u1', 'user', 'do the thing'),
      a1: msg('a1', 'assistant', 'final answer'),
      t1: timer,
    };
    const out = renderToString(
      <ChatLookProvider value="classic">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: ['a1', 't1'],
          }}
          messagesById={byId}
        />
      </ChatLookProvider>,
    );
    const answerIndex = out.indexOf('final answer');
    const timerIndex = out.indexOf('data-testid="turn-timer"');
    expect(answerIndex).toBeGreaterThan(-1);
    expect(timerIndex).toBeGreaterThan(answerIndex);
  });

  it('skips message ids that are not present without error', () => {
    const out = render(
      {
        userMessageId: 'missing',
        intermediateMessageIds: ['also-missing'],
        finalMessageIds: ['a2'],
      },
      [msg('a2', 'assistant', 'only final')],
    );
    expect(out).toContain('only final');
    expect(out).toContain('data-testid="chat-turn-group"');
  });
});

it('keeps stamped shell summary counts aligned with read and skill displays', () => {
  const parts = [
    'cat package.json',
    'cat /skills/testing/SKILL.md',
    'npm test',
  ].map((input, index) => ({
    kind: 'tool_use' as const,
    toolFamily: 'bash' as const,
    data: { toolUseId: `raw-${index}`, toolName: 'command', input },
  }));
  const out = render(
    {
      userMessageId: 'u',
      intermediateMessageIds: ['tools'],
      finalMessageIds: [],
      complete: true,
      summary: { bashCount: 3 },
    },
    [
      msg('u', 'user', 'Read and test'),
      { ...msg('tools', 'assistant', ''), parts },
    ],
  );
  expect(out).toContain('Read 1 file');
  expect(out).toContain('1 other');
  expect(out).toContain('Ran 1 command');
  expect(out).not.toContain('Ran 3 commands');
});

it('collapses exactly on the incomplete-to-complete edge and stays expanded after unrelated renders', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const messages = {
    u1: msg('u1', 'user', 'go'),
    a1: msg('a1', 'assistant', 'working step'),
    a2: msg('a2', 'assistant', 'done'),
  };
  const renderGroup = (complete: boolean): void => {
    root.render(
      <ChatLookProvider value="classic">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: ['a1'],
            finalMessageIds: ['a2'],
            complete,
            summary: { messageCount: 1 },
          }}
          messagesById={messages}
        />
      </ChatLookProvider>,
    );
  };

  act(() => renderGroup(false));
  expect(container.textContent).toContain('working step');
  expect(
    container.querySelector('[data-testid="chat-turn-summary"]'),
  ).toBeNull();

  act(() => renderGroup(true));
  const summary = container.querySelector<HTMLButtonElement>(
    '[data-testid="chat-turn-summary"]',
  );
  expect(summary?.getAttribute('aria-expanded')).toBe('false');
  expect(container.textContent).not.toContain('working step');

  act(() => summary?.click());
  expect(summary?.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('working step');

  act(() => renderGroup(true));
  expect(summary?.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('working step');
  act(() => root.unmount());
});

it('preserves transcript order when expanding post-answer messages', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const messages = {
    u1: msg('u1', 'user', 'go'),
    tool: msg('tool', 'assistant', 'first step'),
    answer: msg('answer', 'assistant', 'final answer'),
    trailing: msg('trailing', 'assistant', 'post-answer step'),
  };

  act(() => {
    root.render(
      <ChatLookProvider value="classic">
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: ['tool', 'trailing'],
            finalMessageIds: ['answer'],
            expandedMessageIds: ['tool', 'answer', 'trailing'],
            complete: true,
            summary: { messageCount: 2 },
          }}
          messagesById={messages}
        />
      </ChatLookProvider>,
    );
  });

  const summary = container.querySelector<HTMLButtonElement>(
    '[data-testid="chat-turn-summary"]',
  );
  act(() => summary?.click());

  const text = container.textContent ?? '';
  expect(text.indexOf('first step')).toBeLessThan(text.indexOf('final answer'));
  expect(text.indexOf('final answer')).toBeLessThan(
    text.indexOf('post-answer step'),
  );
  act(() => root.unmount());
});

describe('TurnGroupView reply Copy (CAN-4704)', () => {
  it.each(['classic', 'clean'] as const)(
    'copies historical %s replies using final text or the intermediate fallback',
    async (look) => {
      const writeText = jest.fn<Promise<void>, [string]>(() =>
        Promise.resolve(),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <ChatLookProvider value={look}>
              {[true, false].map((hasFinal) => (
                <TurnGroupView
                  key={String(hasFinal)}
                  turnGroup={{
                    userMessageId: 'u',
                    intermediateMessageIds: ['i'],
                    finalMessageIds: hasFinal ? ['f'] : [],
                    complete: true,
                  }}
                  messagesById={{
                    u: msg('u', 'user', 'go'),
                    i: msg('i', 'assistant', '  Intermediate **text**  '),
                    f: msg('f', 'assistant', '  Final **text**  '),
                  }}
                />
              ))}
            </ChatLookProvider>,
          ),
        );
        const buttons = container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="turn-copy-message"]',
        );
        expect(buttons).toHaveLength(2);
        const payloads = ['  Final **text**  ', '  Intermediate **text**  '];
        for (let index = 0; index < payloads.length; index += 1) {
          await act(async () => {
            buttons[index]?.click();
            await Promise.resolve();
          });
          expect(writeText).toHaveBeenLastCalledWith(payloads[index]);
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  const completedTimer: PortalChatMessage = {
    ...msg('t1', 'system', ''),
    parts: [
      { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 4000 } },
    ],
  };
  const interruptedTimer: PortalChatMessage = {
    ...msg('t1', 'system', ''),
    parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
  };

  function renderTurn(
    look: 'classic' | 'clean',
    {
      answer = '# Plan\n\n- **one**',
      timer,
      complete = true,
    }: {
      answer?: string;
      timer?: PortalChatMessage;
      complete?: boolean;
    } = {},
  ): HTMLElement {
    const messagesById: Record<string, PortalChatMessage> = {
      u1: msg('u1', 'user', 'hi'),
      a1: msg('a1', 'assistant', answer),
    };
    if (timer) messagesById[timer.messageId] = timer;
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <ChatLookProvider value={look}>
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: [],
            finalMessageIds: timer ? ['a1', timer.messageId] : ['a1'],
            complete,
          }}
          messagesById={messagesById}
          actionSlot={<button>Fork</button>}
          feedbackSlot={<button>Rate</button>}
        />
      </ChatLookProvider>,
    );
    return host;
  }

  function copies(host: HTMLElement): HTMLElement[] {
    return Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid="turn-copy-message"]'),
    );
  }

  function hiddenAtRest(element: HTMLElement): boolean {
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement
    ) {
      if (/(^|\s)opacity-0(\s|$)/.test(node.className)) return true;
    }
    return false;
  }

  it.each([
    ['timer row', completedTimer],
    ['actions row without a timer', undefined],
    ['actions row under an interrupted timer', interruptedTimer],
  ])('gives a finished reply one Copy in its %s', (_label, timer) => {
    for (const look of ['classic', 'clean'] as const) {
      const host = renderTurn(look, timer ? { timer } : {});
      const found = copies(host);
      expect(found).toHaveLength(1);
      expect(found[0]?.getAttribute('aria-label')).toBe('Copy message');
      expect(hiddenAtRest(found[0] ?? host)).toBe(false);
      if (look === 'clean') {
        expect(
          host
            .querySelector('[data-testid="chat-turn-feedback"]')
            ?.classList.contains('gap-0.5'),
        ).toBe(true);
      }
    }
  });

  it('offers no Copy while the turn runs or when the reply has no text', () => {
    for (const look of ['classic', 'clean'] as const) {
      expect(copies(renderTurn(look, { complete: false }))).toHaveLength(0);
      expect(
        copies(renderTurn(look, { complete: false, timer: completedTimer })),
      ).toHaveLength(0);
      expect(copies(renderTurn(look, { answer: ' \n ' }))).toHaveLength(0);
      expect(
        copies(renderTurn(look, { answer: ' \n ', timer: completedTimer })),
      ).toHaveLength(0);
    }
  });

  it('copies the reply Markdown as written', async () => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <TurnGroupView
            turnGroup={{
              userMessageId: 'u1',
              intermediateMessageIds: [],
              finalMessageIds: ['a1'],
              complete: true,
            }}
            messagesById={{
              u1: msg('u1', 'user', 'hi'),
              a1: msg('a1', 'assistant', '# Plan\n\n- **one**'),
            }}
          />
        </ChatLookProvider>,
      ),
    );
    const [copy] = copies(container);
    if (!copy) throw new Error('copy missing');
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('# Plan\n\n- **one**');
    act(() => root.unmount());
    container.remove();
  });
});

describe('TurnGroupView clean chat steps between replies', () => {
  function toolMessage(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    result?: { output: string; isError: boolean },
    status: PortalChatMessage['status'] = 'complete',
  ): PortalChatMessage {
    return {
      ...msg(id, 'assistant', ''),
      status,
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: `${id}-tool`,
            toolName,
            input: JSON.stringify(input),
            ...(result ? { result } : {}),
          },
        },
      ],
    };
  }
  const ok = { output: 'ok', isError: false };
  const failed = { output: 'no such file', isError: true };
  const timer: PortalChatMessage = {
    ...msg('timer', 'system', ''),
    status: 'streaming',
    parts: [{ kind: 'turn_timer', data: { startedAt: 1 } }],
  };

  function streamingTurn(): PortalChatMessage[] {
    return [
      msg('u1', 'user', "let's work on something"),
      {
        ...msg('m1', 'assistant', ''),
        parts: [
          { kind: 'thinking', data: { text: 'Find the ticket.' } },
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'ls-1',
              toolName: 'list_directory',
              input: '{"path":"."}',
              result: ok,
            },
          },
        ],
      },
      toolMessage('m2', 'read', { filePath: 'missing/absent.txt' }, failed),
      msg('m3', 'assistant', 'Pulling up the repo.'),
      toolMessage('m4', 'read', { filePath: 'missing/other.txt' }, failed),
      toolMessage('m5', 'write', { filePath: 'notes/a.txt', content: 'x' }, ok),
      timer,
    ];
  }

  function show(
    root: ReturnType<typeof createRoot>,
    messages: PortalChatMessage[],
    complete = false,
    groupToolCalls = true,
  ): void {
    const byId: Record<string, PortalChatMessage> = {};
    for (const message of messages) byId[message.messageId] = message;
    const ids = messages
      .filter((message) => message.role !== 'user')
      .map((message) => message.messageId);
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <ChatDetailProvider value={groupToolCalls ? 'compact' : 'detailed'}>
            <TurnGroupView
              turnGroup={{
                userMessageId: 'u1',
                intermediateMessageIds: ids.slice(0, -2),
                finalMessageIds: ids.slice(-2),
                complete,
              }}
              messagesById={byId}
              latest
            />
          </ChatDetailProvider>
        </ChatLookProvider>,
      ),
    );
  }

  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const lines = (): HTMLElement[] =>
    Array.from(
      host.querySelectorAll<HTMLElement>(
        '[data-testid="chat-tool-step-group"]',
      ),
    );
  const words = (line: HTMLElement): string =>
    line.querySelector('[data-step-row]')?.textContent ?? '';

  it('folds the work between two replies into one closed line', () => {
    show(root, streamingTurn());
    expect(lines().map(words)).toEqual([
      'Searched once, read 1 file· 1 error',
      // The newest step is done: the agent is deciding what to do next.
      'Thinking',
    ]);
    // Closed lines: no single step row until the person opens one.
    expect(
      host.querySelectorAll('[data-testid="chat-tool-call"]'),
    ).toHaveLength(0);
    expect(host.textContent).toContain('Pulling up the repo.');
  });

  it('keeps every line in place as steps stream in', () => {
    const messages = streamingTurn();
    show(root, messages);
    const before = lines();
    const next = [
      ...messages.slice(0, -1),
      toolMessage(
        'm6',
        'read',
        { filePath: 'src/toolbar.ts' },
        undefined,
        'streaming',
      ),
      timer,
    ];
    show(root, next);
    const after = lines();
    expect(after).toHaveLength(before.length);
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(words(after[1])).toBe('Read toolbar.ts');
  });

  it('puts "Thinking" in the timer row after a reply, in the same row', () => {
    const messages = [
      ...streamingTurn().slice(0, -1),
      msg('m6', 'assistant', 'Notes are saved.'),
      timer,
    ];
    show(root, messages);
    const row = host.querySelector('[data-testid="turn-timer"]');
    expect(row?.textContent).toBe('Thinking');
    expect(row?.querySelector('.canopy-text-shimmer-strong')).not.toBeNull();
  });

  it('keeps a turn that finishes on screen open, so nothing moves', () => {
    const messages = streamingTurn();
    show(root, messages);
    const done: PortalChatMessage[] = [
      ...messages.slice(0, -1),
      msg('m6', 'assistant', 'Here is the audit.'),
      {
        ...timer,
        status: 'complete',
        parts: [{ kind: 'turn_timer', data: { startedAt: 1, completedAt: 9 } }],
      },
    ];
    show(root, done, true);
    expect(host.textContent).toContain('Pulling up the repo.');
    expect(host.textContent).toContain('Worked');
  });

  it('keeps what the running step names out of session replay', () => {
    const messages = streamingTurn();
    show(root, [
      ...messages.slice(0, -1),
      toolMessage(
        'm6',
        'read',
        { filePath: 'src/secret.ts' },
        undefined,
        'streaming',
      ),
      timer,
    ]);
    const blocked = host.querySelector('.ph-no-capture');
    expect(blocked?.textContent).toContain('secret.ts');
    expect(blocked?.tagName).toBe('SPAN');
  });

  it('folds an opened Detailed tool card when the turn finishes', () => {
    const messages = streamingTurn();
    show(root, messages, false, false);
    const toggle = (): HTMLElement | null =>
      host.querySelector<HTMLElement>(
        '[data-testid="chat-tool-call"] [aria-expanded]',
      );
    const opener = toggle();
    if (!opener) throw new Error('tool card toggle missing');
    act(() => opener.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    const done: PortalChatMessage[] = [
      ...messages.slice(0, -1),
      msg('m6', 'assistant', 'Here is the audit.'),
      {
        ...timer,
        status: 'complete',
        parts: [{ kind: 'turn_timer', data: { startedAt: 1, completedAt: 9 } }],
      },
    ];
    show(root, done, true, false);
    expect(toggle()).toBeNull();
    const turnToggle = host.querySelector<HTMLButtonElement>(
      '[data-testid="turn-work-header"] button[aria-expanded]',
    );
    act(() => turnToggle?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps one row per tool call while Group tool calls is off', () => {
    show(root, streamingTurn(), false, false);
    expect(
      lines().filter((line) => !line.closest('[data-testid="turn-timer"]')),
    ).toHaveLength(1);
    expect(
      host.querySelectorAll('[data-testid="chat-tool-call"]').length,
    ).toBeGreaterThan(2);
    // The fallback is a sibling of the steps, sharing their vertical rhythm.
    const stack = host.querySelectorAll(
      '[data-testid="chat-tool-step-detailed"]',
    );
    expect(stack[stack.length - 1]?.lastElementChild?.textContent).toBe(
      'Thinking',
    );
    expect(host.querySelector('[data-testid="turn-timer"]')?.textContent).toBe(
      '',
    );
  });
});

describe('TurnGroupView chat detail recent', () => {
  const ok = { output: 'ok', isError: false };
  function read(id: string, filePath: string, done = true): PortalChatMessage {
    return {
      ...msg(id, 'assistant', ''),
      status: done ? 'complete' : 'streaming',
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: `${id}-tool`,
            toolName: 'read',
            input: JSON.stringify({ filePath }),
            ...(done ? { result: ok } : {}),
          },
        },
      ],
    };
  }
  const timer: PortalChatMessage = {
    ...msg('timer', 'system', ''),
    status: 'streaming',
    parts: [{ kind: 'turn_timer', data: { startedAt: 1 } }],
  };

  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function show(
    steps: PortalChatMessage[],
    complete = false,
    detail: 'recent' | 'compact' = 'recent',
  ): void {
    const messages = [
      msg('u1', 'user', 'Fix the toolbar test'),
      msg('n1', 'assistant', 'Looking at the test first.'),
      ...steps,
      timer,
    ];
    const byId: Record<string, PortalChatMessage> = {};
    for (const message of messages) byId[message.messageId] = message;
    const ids = messages
      .filter((message) => message.role !== 'user')
      .map((message) => message.messageId);
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <ChatDetailProvider value={detail}>
            <TurnGroupView
              turnGroup={{
                userMessageId: 'u1',
                intermediateMessageIds: ids.slice(0, -2),
                finalMessageIds: ids.slice(-2),
                complete,
              }}
              messagesById={byId}
              latest
            />
          </ChatDetailProvider>
        </ChatLookProvider>,
      ),
    );
  }

  const lines = (): string[] =>
    Array.from(
      host.querySelectorAll('[data-testid="chat-tool-step-summary"]'),
      (line) => line.textContent ?? '',
    );
  const liveRows = (): number =>
    host
      .querySelector('[data-testid="chat-tool-step-live"]')
      ?.querySelectorAll('[data-testid="chat-tool-call"]').length ?? 0;

  it('keeps Thinking after one completed compact call, without duplicating a running call', () => {
    show([read('r1', 'a.ts')], false, 'compact');
    expect(host.textContent?.match(/Thinking/g)).toHaveLength(1);
    expect(
      host.querySelector('[data-testid="chat-tool-step-summary"]'),
    ).toBeNull();
    show([read('r1', 'a.ts', false)], false, 'compact');
    expect(host.textContent).not.toContain('Thinking');
    expect(host.textContent?.match(/Read a\.ts/g)).toHaveLength(1);
  });

  it.each([1, 4, 8])(
    'shows Thinking after %i completed recent calls while the turn runs',
    (count) => {
      const calls = Array.from({ length: count }, (_, index) =>
        read(`r${index}`, `file${index}.ts`),
      );
      show(calls);
      expect(host.textContent?.match(/Thinking/g)).toHaveLength(1);
      const live = host.querySelector('[data-testid="chat-tool-step-live"]');
      expect(live?.lastElementChild?.textContent).toBe('Thinking');
      show([...calls, read('next', 'next.ts', false)]);
      expect(host.textContent).not.toContain('Thinking');
    },
  );

  it('shows a short live run as its own rows, with no line to count', () => {
    show([read('r1', 'a.ts'), read('r2', 'b.ts', false)]);
    expect(lines()).toEqual([]);
    expect(liveRows()).toBe(2);
    expect(host.textContent?.match(/Read b\.ts/g)).toHaveLength(1);
  });

  it('keeps the newest three steps in view and counts the rest on the line', () => {
    show([
      read('r1', 'a.ts'),
      read('r2', 'b.ts'),
      read('r3', 'c.ts'),
      read('r4', 'd.ts'),
      read('r5', 'e.ts', false),
    ]);
    expect(lines()).toEqual(['Read 2 files']);
    expect(liveRows()).toBe(3);
    // The running step is said once, in its own row, not on the line too.
    expect(host.textContent?.match(/Read e\.ts/g)).toHaveLength(1);
    expect(
      host.querySelector('[data-testid="chat-tool-step-group"][data-live]'),
    ).toBeNull();
  });

  it('leaves the final standalone call visible once the turn is done', () => {
    show(
      [
        read('r1', 'a.ts'),
        read('r2', 'b.ts'),
        read('r3', 'c.ts'),
        read('r4', 'd.ts'),
      ],
      true,
    );
    expect(host.querySelector('[data-tool-use-id="r4-tool"]')).not.toBeNull();
    expect(
      host.querySelectorAll('[data-testid="chat-tool-step-summary"]'),
    ).toHaveLength(0);
  });
});

describe('TurnGroupView Copy plan (CAN-5354)', () => {
  const PLAN = '# Plan ✓\n\n1. Edit `src/a.ts`\n\n```ts\nconst x = 1;\n```\n';
  const PLAN_FILE = '/Users/me/.claude/plans/brave-otter.md';
  const completedTimer: PortalChatMessage = {
    ...msg('t1', 'system', ''),
    parts: [
      { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 4000 } },
    ],
  };

  function toolMessage(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    result?: { output: string; isError?: boolean },
  ): PortalChatMessage {
    return {
      ...msg(id, 'assistant', ''),
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolName,
            toolUseId: `${id}-call`,
            input: JSON.stringify(input),
            ...(result ? { result } : {}),
          },
        },
      ],
    };
  }

  function renderPlanTurn(
    look: 'classic' | 'clean',
    {
      tools,
      prose = 'Here is the plan.',
      timer,
      complete = true,
    }: {
      tools: PortalChatMessage[];
      prose?: string;
      timer?: PortalChatMessage;
      complete?: boolean;
    },
  ): HTMLElement {
    const messagesById: Record<string, PortalChatMessage> = {
      u1: msg('u1', 'user', 'plan it'),
      a1: msg('a1', 'assistant', prose),
    };
    for (const tool of tools) messagesById[tool.messageId] = tool;
    if (timer) messagesById[timer.messageId] = timer;
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <ChatLookProvider value={look}>
        <TurnGroupView
          turnGroup={{
            userMessageId: 'u1',
            intermediateMessageIds: tools.map((tool) => tool.messageId),
            finalMessageIds: timer ? ['a1', timer.messageId] : ['a1'],
            complete,
          }}
          messagesById={messagesById}
          feedbackSlot={<button>Rate</button>}
        />
      </ChatLookProvider>,
    );
    return host;
  }

  const exitTools = [toolMessage('p1', 'ExitPlanMode', { plan: PLAN })];
  const writeTools = [
    toolMessage(
      'w1',
      'Write',
      { file_path: PLAN_FILE, content: PLAN },
      { output: 'ok' },
    ),
    toolMessage('p1', 'ExitPlanMode', {}),
  ];

  it.each(['complete', 'rejected', 'no-reader', 'unrelated'] as const)(
    'never copies an older draft before recovering a later truncated Write (%s)',
    async (mode) => {
      const revised = `${PLAN}${'Revised ✓\n'.repeat(1000)}`;
      const serialized = JSON.stringify({
        file_path: mode === 'unrelated' ? '/repo/README.md' : PLAN_FILE,
        content: revised,
      });
      const read = jest.fn<
        ReturnType<ToolOutputReader>,
        Parameters<ToolOutputReader>
      >(() =>
        mode === 'rejected'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              text: serialized,
              byteLength: Buffer.byteLength(serialized),
            }),
      );
      const writeText = jest.fn<Promise<void>, [string]>(() =>
        Promise.resolve(),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      const laterWrite: PortalChatMessage = {
        ...msg('w2', 'assistant', ''),
        parts: [
          {
            kind: 'tool_use',
            occurrence: { id: 'stored-revision#1', revision: 2 },
            data: {
              toolName: 'Write',
              toolUseId: 'w2-call',
              input: `${serialized.slice(0, 4000)}\n\n[truncated 9000 chars]`,
              result: { output: 'ok' },
            },
          },
        ],
      };
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <ToolOutputReaderContext.Provider
              value={mode === 'no-reader' ? null : read}
            >
              <TurnGroupView
                turnGroup={{
                  userMessageId: 'u1',
                  intermediateMessageIds: ['w1', 'w2', 'p1'],
                  finalMessageIds: ['a1'],
                  complete: true,
                }}
                messagesById={{
                  u1: msg('u1', 'user', 'plan'),
                  w1: writeTools[0],
                  w2: laterWrite,
                  p1: writeTools[1],
                  a1: msg('a1', 'assistant', 'Prose must not win'),
                }}
              />
            </ToolOutputReaderContext.Provider>,
          );
          await Promise.resolve();
        });
        const copy = container.querySelector<HTMLButtonElement>(
          '[data-testid="turn-copy-plan"]',
        );
        expect(copy?.getAttribute('data-state')).toBe(
          mode === 'complete' || mode === 'unrelated' ? 'ready' : 'unavailable',
        );
        await act(async () => {
          copy?.click();
          await Promise.resolve();
        });
        if (mode === 'complete')
          expect(writeText).toHaveBeenCalledWith(revised);
        else if (mode === 'unrelated')
          expect(writeText).toHaveBeenCalledWith(PLAN);
        else expect(writeText).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(['complete', 'short', 'rejected', 'malformed'] as const)(
    'reads only complete historical proposal input (%s)',
    async (mode) => {
      const markdown = `${PLAN}${'1. Preserve Unicode ✓ and `paths`.\n'.repeat(3000)}`;
      const serialized = JSON.stringify({ plan: markdown });
      const head = serialized.slice(0, 60000);
      const firstOffset = Buffer.byteLength(head);
      const read = jest.fn<
        ReturnType<ToolOutputReader>,
        Parameters<ToolOutputReader>
      >((_identity, offset) =>
        mode === 'rejected'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              text:
                mode === 'malformed'
                  ? 'not JSON'
                  : offset === 0
                    ? head
                    : serialized.slice(head.length),
              ...(mode === 'complete' && offset === 0
                ? { nextOffset: firstOffset }
                : {}),
              byteLength:
                mode === 'malformed' ? 8 : Buffer.byteLength(serialized),
            }),
      );
      const writeText = jest.fn<Promise<void>, [string]>(() =>
        Promise.resolve(),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      const planMessage = toolMessage('historical', 'ExitPlanMode', {
        plan: '# Partial\n\n[truncated 90000 chars]',
      });
      planMessage.parts = planMessage.parts?.map((part) => ({
        ...part,
        occurrence: { id: 'stored-row#3', revision: 8 },
      }));
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <ToolOutputReaderContext.Provider value={read}>
              <TurnGroupView
                turnGroup={{
                  userMessageId: 'u1',
                  intermediateMessageIds: ['historical'],
                  finalMessageIds: ['a1'],
                  complete: true,
                }}
                messagesById={{
                  u1: msg('u1', 'user', 'plan'),
                  historical: planMessage,
                  a1: msg('a1', 'assistant', 'Prose must not win'),
                }}
              />
            </ToolOutputReaderContext.Provider>,
          );
          await Promise.resolve();
        });
        expect(read).toHaveBeenCalledWith(
          {
            kind: 'row',
            messageId: 'stored-row',
            blockOrdinal: 3,
            field: 'input',
          },
          0,
          expect.any(AbortSignal),
        );
        if (mode === 'complete')
          expect(read.mock.calls.length).toBeGreaterThan(1);
        const copy = container.querySelector<HTMLButtonElement>(
          '[data-testid="turn-copy-plan"]',
        );
        expect(copy?.getAttribute('data-state')).toBe(
          mode === 'complete' ? 'ready' : 'unavailable',
        );
        expect(
          container.querySelector('[data-testid="turn-copy-message"]'),
        ).toBeNull();
        await act(async () => {
          copy?.click();
          await Promise.resolve();
        });
        if (mode === 'complete')
          expect(writeText).toHaveBeenCalledWith(markdown);
        else expect(writeText).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it.each([
    ['ExitPlanMode plan', exitTools],
    ['plan-file Write before ExitPlanMode {}', writeTools],
  ])('replaces reply Copy with one Copy plan for a %s', (_label, tools) => {
    for (const look of ['classic', 'clean'] as const) {
      for (const timer of [completedTimer, undefined]) {
        const host = renderPlanTurn(look, {
          tools,
          ...(timer ? { timer } : {}),
        });
        const plan = host.querySelectorAll('[data-testid="turn-copy-plan"]');
        expect(plan).toHaveLength(1);
        expect(plan[0]?.getAttribute('aria-label')).toBe('Copy plan');
        expect(plan[0]?.getAttribute('data-state')).toBe('ready');
        expect(
          host.querySelectorAll('[data-testid="turn-copy-message"]'),
        ).toHaveLength(0);
      }
    }
  });

  it('offers no Copy plan while the plan turn runs', () => {
    const host = renderPlanTurn('classic', {
      tools: exitTools,
      complete: false,
    });
    expect(host.querySelector('[data-testid="turn-copy-plan"]')).toBeNull();
  });

  it('keeps an unavailable Copy plan for a truncated plan, never the prose', () => {
    const host = renderPlanTurn('classic', {
      tools: [
        toolMessage('p1', 'ExitPlanMode', {
          plan: '# Plan\n\n[truncated 9000 chars]',
        }),
      ],
      timer: completedTimer,
    });
    const plan = host.querySelector('[data-testid="turn-copy-plan"]');
    expect(plan?.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[data-testid="turn-copy-message"]')).toBeNull();
  });

  it('copies the plan Markdown exactly', async () => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnGroupView
              turnGroup={{
                userMessageId: 'u1',
                intermediateMessageIds: ['w1', 'p1'],
                finalMessageIds: ['a1', 't1'],
                complete: true,
              }}
              messagesById={{
                u1: msg('u1', 'user', 'plan it'),
                a1: msg('a1', 'assistant', 'Here is the plan.'),
                t1: completedTimer,
                ...Object.fromEntries(
                  writeTools.map((tool) => [tool.messageId, tool]),
                ),
              }}
            />
          </ChatLookProvider>,
        ),
      );
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="turn-copy-plan"]')
          ?.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(PLAN);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
describe.each([false, true])(
  'TurnGroupView interrupted turns with clean=%s (CAN-5178)',
  (clean) => {
    const turnGroup: PortalChatTurnGroup = {
      userMessageId: 'u1',
      intermediateMessageIds: ['a1'],
      finalMessageIds: ['t1'],
      complete: true,
      summary: { readCount: 1, editCount: 1 },
    };
    const steps = (
      edit: Record<string, unknown> = {
        toolUseId: 'edit',
        toolName: 'Edit',
        input: '{}',
        result: {
          output: 'Interrupted',
          isError: true,
          interruption: { reason: 'app_restart', at: 15_000 },
        },
      },
    ): PortalChatMessage => ({
      ...msg('a1', 'assistant', ''),
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'read',
          data: {
            toolUseId: 'read',
            toolName: 'Read',
            input: '{}',
            result: { output: 'contents', isError: false },
          },
        },
        { kind: 'tool_use', toolFamily: 'edit', data: edit },
      ],
    });
    const timer = (data: Record<string, unknown>): PortalChatMessage => ({
      ...msg('t1', 'assistant', ''),
      parts: [{ kind: 'turn_timer', data }],
    });
    // Both looks keep a non-complete outcome in the reply row.
    const footer = 'Interrupted after 0:14';
    const header = clean ? 'Interrupted after 14s' : undefined;

    it('counts the interrupted edit apart from errors and says so in the footer', () => {
      const out = render(
        turnGroup,
        [
          msg('u1', 'user', 'edit it'),
          steps(),
          timer({ startedAt: 1_000, completedAt: 15_000 }),
        ],
        clean,
      );
      expect(out).toContain('data-turn-interrupted="1"');
      expect(out).not.toContain('data-turn-failed');
      expect(out).toContain('>1 interrupted<');
      expect(out).toContain('data-turn-step-count="2"');
      expect(out).toContain(footer);
      if (header !== undefined) expect(out).toContain(header);
      expect(out).not.toContain('Completed in');
    });

    it('interrupts a turn from projected restart evidence with no interrupted tool', () => {
      const out = render(
        turnGroup,
        [
          msg('u1', 'user', 'edit it'),
          steps({
            toolUseId: 'edit',
            toolName: 'Edit',
            input: '{}',
            result: { output: 'ok', isError: false },
          }),
          timer({
            startedAt: 1_000,
            completedAt: 15_000,
            endReason: 'interrupted',
          }),
        ],
        clean,
      );
      expect(out).not.toContain('data-turn-interrupted');
      expect(out).toContain(footer);
      expect(out).not.toContain('Completed in');
    });

    it('treats a settled, fully loaded call without a result as interrupted', () => {
      const out = render(
        turnGroup,
        [
          msg('u1', 'user', 'edit it'),
          steps({ toolUseId: 'edit', toolName: 'Edit', input: '{}' }),
          timer({ startedAt: 1_000, completedAt: 15_000 }),
        ],
        clean,
      );
      expect(out).toContain('data-turn-interrupted="1"');
      expect(out).toContain(footer);
    });

    it('keeps a recorded failure ahead of the interruption', () => {
      const out = render(
        turnGroup,
        [
          msg('u1', 'user', 'edit it'),
          steps(),
          timer({ startedAt: 1_000, completedAt: 15_000, endReason: 'failed' }),
        ],
        clean,
      );
      expect(out).toContain('data-turn-interrupted="1"');
      expect(out).toContain('Failed after');
      expect(out).not.toContain('Interrupted after');
    });

    it.each(['failed', 'cancelled'] as const)(
      'keeps recorded %s ahead of a projected interruption',
      (status) => {
        const out = render(
          turnGroup,
          [
            msg('u1', 'user', 'edit it'),
            steps(),
            {
              ...timer({
                startedAt: 1_000,
                completedAt: 15_000,
                endReason: 'interrupted',
              }),
              status,
            },
          ],
          clean,
        );
        expect(out).toContain(
          status === 'failed' ? 'Failed after' : 'Cancelled after',
        );
        expect(out).not.toContain('Interrupted after');
      },
    );

    it('does not infer an absent result from a bounded host snapshot with every known id loaded', () => {
      const rows = [
        msg('u1', 'user', 'edit it'),
        steps({ toolUseId: 'edit', toolName: 'Edit', input: '{}' }),
        timer({ startedAt: 1000, completedAt: 15000 }),
      ];
      const host = document.createElement('div');
      const root = createRoot(host);
      try {
        act(() =>
          root.render(
            <ChatLookProvider value={clean ? 'clean' : 'classic'}>
              <TurnGroupView
                turnGroup={turnGroup}
                messagesById={Object.fromEntries(
                  rows.map((row) => [row.messageId, row]),
                )}
              />
            </ChatLookProvider>,
          ),
        );
        const summary = host.querySelector<HTMLButtonElement>(
          'button[aria-label^="Agent steps"]',
        );
        if (!summary) throw new Error('expected turn summary');
        act(() => summary.click());
        expect(host.innerHTML).not.toContain('data-turn-interrupted');
        expect(host.textContent).not.toContain('Interrupted after');
        expect(
          host
            .querySelector('[data-tool-name="Edit"]')
            ?.getAttribute('data-tool-status'),
        ).toBe('pending');
      } finally {
        act(() => root.unmount());
      }
    });

    it('shows no terminal label while the turn runs', () => {
      const out = render(
        { ...turnGroup, complete: false },
        [
          msg('u1', 'user', 'edit it'),
          steps({ toolUseId: 'edit', toolName: 'Edit', input: '{}' }),
          { ...timer({ startedAt: 1_000 }), status: 'streaming' },
        ],
        clean,
      );
      expect(out).not.toContain('Interrupted');
      expect(out).not.toContain('data-turn-interrupted');
    });
  },
);

describe('TurnGroupView approval waiting from a paused timer (CAN-5291)', () => {
  const bash = (toolUseId: string): PortalChatMessage => ({
    ...msg(`a-${toolUseId}`, 'assistant', ''),
    status: 'streaming',
    parts: [
      {
        kind: 'tool_use',
        data: {
          toolUseId,
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        },
      },
    ],
  });
  const timer = (data: Record<string, unknown>): PortalChatMessage => ({
    ...msg('timer', 'system', ''),
    status: 'streaming',
    parts: [{ kind: 'turn_timer', data: { startedAt: 1_000, ...data } }],
  });
  const renderTurn = (
    messages: PortalChatMessage[],
    complete = false,
  ): string =>
    render(
      {
        userMessageId: 'user',
        intermediateMessageIds: [],
        finalMessageIds: messages.map((message) => message.messageId),
        complete,
      },
      [msg('user', 'user', 'Run the tests'), ...messages],
      true,
    );

  it('says a paused turn’s unresolved call waits, without shimmer', () => {
    const html = renderTurn([bash('call-1'), timer({ pausedAt: 5_000 })]);
    expect(html).toContain('data-tool-approval="waiting"');
    expect(html).toContain('Waiting for approval');
    expect(html).not.toContain('Running pnpm test');
  });

  it('runs again once the timer resumes', () => {
    const html = renderTurn([
      bash('call-1'),
      timer({ pausedAt: 5_000, resumedAt: 9_000 }),
    ]);
    expect(html).not.toContain('data-tool-approval');
    expect(html).toContain('Run');
    expect(html).toContain('canopy-text-shimmer-strong');
  });

  it('never waits in a completed turn', () => {
    const html = renderTurn(
      [bash('call-1'), timer({ pausedAt: 5_000, completedAt: 9_000 })],
      true,
    );
    expect(html).not.toContain('data-tool-approval');
    expect(html).not.toContain('Waiting for approval');
  });

  it('keeps a cloud turn without pause timestamps unchanged', () => {
    const html = renderTurn([
      bash('call-1'),
      timer({ pausedAt: null, resumedAt: null }),
    ]);
    expect(html).not.toContain('data-tool-approval');
  });

  it('leaves a pause held by an unanswered question alone', () => {
    const question: PortalChatMessage = {
      ...msg('question', 'assistant', ''),
      status: 'streaming',
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: 'ask-1',
            toolName: 'AskUserQuestion',
            input: { questions: [] },
          },
        },
      ],
    };
    const html = renderTurn([
      bash('call-1'),
      question,
      timer({ pausedAt: 5_000 }),
    ]);
    expect(html).not.toContain('data-tool-approval');
  });
});
