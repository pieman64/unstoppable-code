/**
 * @jest-environment jsdom
 *
 * Shared web transcript presentation for CAN-4897: a settled turn's
 * unresolved tool calls render interrupted, and only trusted resume
 * provenance replaces a prompt bubble with the shared marker.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  PortalChatMessage,
  PortalChatPart,
} from '@canopy/protocol/portal';
import { ChatMessageView } from '../ChatMessageView';
import { ChatPartView, ToolTurnSettledContext } from '../ChatPartView';

const EDIT: PortalChatPart = {
  kind: 'tool_use',
  data: { toolName: 'Edit', toolUseId: 'edit', input: '{}' },
};

function message(partial: Partial<PortalChatMessage>): PortalChatMessage {
  return {
    messageId: 'resume',
    chatId: 'c1',
    role: 'user',
    status: 'complete',
    text: 'Continue',
    createdAtMs: new Date(2026, 9, 25, 21, 41).getTime(),
    ...partial,
  };
}

describe('settled turn tool calls', () => {
  it('keeps a live background child pending when the parent turn settles', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const agent: PortalChatPart = {
      kind: 'agent',
      data: {
        provider: 'claude',
        toolUseId: 'background',
        subagentType: 'Explore',
        runInBackground: true,
        isRunning: true,
        subBlocks: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'child-tool',
              toolName: 'Bash',
              input: '{}',
            },
          },
        ],
      },
    };
    const render = (settled: boolean): void => {
      act(() => {
        root.render(
          <ToolTurnSettledContext.Provider value={settled}>
            <ChatPartView part={EDIT} />
            <ChatPartView part={agent} />
          </ToolTurnSettledContext.Provider>,
        );
      });
    };
    try {
      render(false);
      const card = container.querySelector(
        '[data-testid="chat-agent-block"] [aria-expanded]',
      );
      if (!card) throw new Error('Missing background agent card');
      act(() => {
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(
        container
          .querySelector('[data-tool-use-id="child-tool"]')
          ?.getAttribute('data-tool-status'),
      ).toBe('pending');
      render(true);
      expect(
        container
          .querySelector('[data-tool-use-id="edit"]')
          ?.getAttribute('data-tool-status'),
      ).toBe('interrupted');
      expect(
        container
          .querySelector('[data-tool-use-id="child-tool"]')
          ?.getAttribute('data-tool-status'),
      ).toBe('pending');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('render interrupted only inside an authoritatively settled turn', () => {
    const settled = renderToString(
      <ToolTurnSettledContext.Provider value>
        <ChatPartView part={EDIT} live={false} />
      </ToolTurnSettledContext.Provider>,
    );
    expect(settled).toContain('data-tool-status="interrupted"');
    expect(settled).toContain('data-tool-interruption="unknown"');

    // Not live is not evidence that execution ended.
    const unsettled = renderToString(<ChatPartView part={EDIT} live={false} />);
    expect(unsettled).toContain('data-tool-status="pending"');
  });

  it('keeps a recorded result over the settled fallback', () => {
    const html = renderToString(
      <ToolTurnSettledContext.Provider value>
        <ChatPartView
          part={{
            kind: 'tool_use',
            data: {
              toolName: 'Read',
              input: '{}',
              result: { output: 'file', isError: false },
            },
          }}
        />
      </ToolTurnSettledContext.Provider>,
    );
    expect(html).toContain('data-tool-status="success"');
  });

  it('renders explicit relay interruption metadata', () => {
    const html = renderToString(
      <ChatPartView
        part={{
          kind: 'tool_use',
          data: {
            toolName: 'Edit',
            input: '{}',
            result: {
              output: 'Interrupted by app restart',
              isError: true,
              interruption: { reason: 'app_restart', at: 180 },
            },
          },
        }}
      />,
    );
    expect(html).toContain('data-tool-interruption="app_restart"');
  });
});

describe('ChatMessageView automatic resume', () => {
  it('shows one marker and no bubble for a generated nudge', () => {
    const html = renderToString(
      <ChatMessageView
        message={message({
          promptSource: 'automated',
          autoResume: { reason: 'app_shutdown', resendsUserMessage: false },
        })}
      />,
    );
    expect(html).toContain('data-auto-resume-reason="app_shutdown"');
    expect(html).toContain('data-chat-message-id="resume"');
    expect(html).not.toContain('portal-chat-message-content');
    expect(html).toContain('data-testid="auto-resume-copy"');
    expect(html).toContain('data-role="user"');
  });

  it('reads provenance from a cached prompt_source part', () => {
    const html = renderToString(
      <ChatMessageView
        message={message({
          text: 'Fix the build',
          promptSource: 'automated',
          parts: [
            {
              kind: 'prompt_source',
              data: {
                source: 'automated',
                autoResume: {
                  reason: 'usage_limit',
                  providerName: 'Codex',
                  resendsUserMessage: true,
                },
              },
            },
          ],
        })}
      />,
    );
    expect(html).toContain('re-sent your last message');
    expect(html).toContain('Resumed after Codex usage limit');
    expect(html).toContain('Fix the build');
  });

  it('never marks generic automation or a human Continue as a resume', () => {
    for (const promptSource of ['automated', 'human'] as const) {
      const html = renderToString(
        <ChatMessageView message={message({ promptSource })} />,
      );
      expect(html).not.toContain('auto-resume-marker');
      expect(html).toContain('Continue');
      if (promptSource === 'automated')
        expect(html).toContain('Sent automatically');
    }
  });
});
