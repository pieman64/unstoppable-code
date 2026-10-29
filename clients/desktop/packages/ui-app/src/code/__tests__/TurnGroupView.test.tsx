/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  PortalAskUserQuestionState,
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';

import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';
import { TurnGroupView } from '../TurnGroupView';
import { AskUserQuestionInteractionProvider } from '../ChatPartView';
import {
  ChatVisualHostProvider,
  type ChatVisualHost,
} from '../chat-visual-host';

jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): { chatVisuals: boolean } => ({ chatVisuals: true }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
): string {
  const byId: Record<string, PortalChatMessage> = {};
  for (const m of messages) {
    byId[m.messageId] = m;
  }
  return renderToString(
    <TurnGroupView turnGroup={turnGroup} messagesById={byId} />,
  );
}

describe('TurnGroupView', () => {
  it.each(['failed', 'cancelled'] as const)(
    'keeps %s actions visible when the host supplies no timer part',
    (status) => {
      const out = renderToString(
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
        />,
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
      const timer = {
        ...msg('timer', 'system', ''),
        status,
        parts: [
          { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
        ],
      };
      const out = renderToString(
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
        />,
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
  it('keeps actions and thumbs in their own row when an interrupted timer renders nothing', () => {
    // A settled message whose timer never completed renders no timer row, so
    // the actions and thumbs must not be routed into it.
    const timer = {
      ...msg('timer', 'system', ''),
      parts: [{ kind: 'turn_timer', data: { startedAt: 1000 } }],
    };
    const host = document.createElement('div');
    host.innerHTML = renderToString(
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
      />,
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
    const timer = {
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
    const timer = {
      ...msg('timer', 'system', ''),
      parts: [
        { kind: 'turn_timer', data: { startedAt: 1000, completedAt: 2000 } },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <TurnGroupView
        turnGroup={{
          userMessageId: 'u1',
          intermediateMessageIds: [],
          finalMessageIds: ['timer'],
          complete: true,
        }}
        messagesById={{ u1: msg('u1', 'user', 'hi'), timer }}
        {...slots}
      />,
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
      },
      a2: msg('a2', 'assistant', 'done'),
    };
    const markup = renderToString(
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
      </ChatVisualHostProvider>,
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
      </AskUserQuestionInteractionProvider>,
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
      </AskUserQuestionInteractionProvider>,
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
      <TurnGroupView
        turnGroup={{
          userMessageId: 'u1',
          intermediateMessageIds: [],
          finalMessageIds: ['a1', 't1'],
        }}
        messagesById={byId}
      />,
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
  expect(out).toContain('1 read');
  expect(out).toContain('1 other');
  expect(out).toContain('1 bash');
  expect(out).not.toContain('3 bash');
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
      <TurnGroupView
        turnGroup={{
          userMessageId: 'u1',
          intermediateMessageIds: ['a1'],
          finalMessageIds: ['a2'],
          complete,
          summary: { messageCount: 1 },
        }}
        messagesById={messages}
      />,
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
      />,
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
        />,
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
