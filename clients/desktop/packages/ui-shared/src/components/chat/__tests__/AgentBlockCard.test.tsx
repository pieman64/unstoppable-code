/** @jest-environment jsdom */

/**
 * Server-rendered tests for the shared {@link AgentBlockCard}. Validates the
 * collapsed header layout (icon, type, background badge, description
 * preview) and that the expand-default state hides usage/result/prompt
 * children until interaction.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { AgentBlockCard } from '../AgentBlockCard';
import { ChatLookProvider } from '../../chat-look';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('AgentBlockCard', () => {
  it('renders the subagent type in the header', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="general-purpose" />
      </ChatLookProvider>,
    );
    expect(html).toContain('general-purpose');
    expect(html).toContain('Agent');
  });

  it.each(['Agent', 'agent', ' agent '])(
    'omits the duplicate subtype when the subagent type is %p',
    (subagentType) => {
      const html = renderToString(
        <ChatLookProvider value="classic">
          <AgentBlockCard
            subagentType={subagentType}
            description="Angle A: line-break"
          />
        </ChatLookProvider>,
      );
      expect(html).toContain('Agent');
      expect(html).toContain('Angle A: line-break');
      expect(html).not.toContain('·');
      expect(html).not.toContain('&middot;');
    },
  );

  it('keeps header text separated when the subtype is omitted', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="agent" runInBackground />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('Agent<span');
    expect(html).toContain('Agent<!-- --> <span');
  });

  it('renders the background badge when runInBackground=true', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="audit" runInBackground />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="agent-block-background-badge"');
    expect(html).toContain('background');
  });

  it('omits the background badge by default', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="audit" />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="agent-block-background-badge"');
  });

  it('renders the description preview in the collapsed header', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard
          subagentType="audit"
          description="Run a quick lint scan"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('Run a quick lint scan');
  });

  it('truncates long descriptions to 80 chars with ellipsis', () => {
    const long = 'a'.repeat(120);
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="audit" description={long} />
      </ChatLookProvider>,
    );
    expect(html).toContain('a'.repeat(80) + '…');
  });

  it('does not mount the usage grid by default (card collapsed)', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard
          subagentType="audit"
          usage={{ inputTokens: 100, outputTokens: 50, apiCalls: 1 }}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="agent-block-usage-grid"');
  });

  it('does not render the spinner when isRunning is false', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard
          subagentType="audit"
          pendingSpinner={<span data-testid="spinner">…</span>}
          isRunning={false}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="spinner"');
  });

  it('renders the spinner slot when isRunning=true', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard
          subagentType="audit"
          pendingSpinner={<span data-testid="spinner">…</span>}
          isRunning
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="spinner"');
  });

  it('renders the error label when isError=true', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="audit" isError />
      </ChatLookProvider>,
    );
    expect(html).toContain('fg-destructive/80');
    expect(html).toContain('error');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard subagentType="audit" dataTestId="agent" />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="agent"');
  });

  it('accepts a subBlocks ReactNode slot (rendered post-expand only)', () => {
    // Collapsed by default — slot is not in DOM until expanded. We verify the
    // primitive renders without crashing when subBlocks is supplied, and
    // that the slot stays hidden behind the expand toggle.
    const html = renderToString(
      <ChatLookProvider value="classic">
        <AgentBlockCard
          subagentType="audit"
          subBlocks={<span data-testid="sub-block">child</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="sub-block"');
  });

  it('does not toggle the card when the header action is activated', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onAction = jest.fn();
    act(() => {
      root.render(
        <ChatLookProvider value="classic">
          <AgentBlockCard
            subagentType="audit"
            expandLabel="Expand agent"
            collapseLabel="Collapse agent"
            headerAction={
              <button type="button" data-testid="action" onClick={onAction}>
                Stop
              </button>
            }
          />
        </ChatLookProvider>,
      );
    });
    const toggle = container.querySelector('[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="action"]')
        ?.click();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[aria-label="Collapse agent"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
