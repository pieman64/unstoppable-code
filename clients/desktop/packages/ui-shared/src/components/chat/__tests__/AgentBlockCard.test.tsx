/**
 * Server-rendered tests for the shared {@link AgentBlockCard}. Validates the
 * collapsed header layout (icon, type, background badge, description
 * preview) and that the expand-default state hides usage/result/prompt
 * children until interaction.
 */
import { renderToString } from 'react-dom/server';
import { AgentBlockCard } from '../AgentBlockCard';

describe('AgentBlockCard', () => {
  it('renders the subagent type in the header', () => {
    const html = renderToString(
      <AgentBlockCard subagentType="general-purpose" />,
    );
    expect(html).toContain('general-purpose');
    expect(html).toContain('Agent');
  });

  it.each(['Agent', 'agent', ' agent '])(
    'omits the duplicate subtype when the subagent type is %p',
    (subagentType) => {
      const html = renderToString(
        <AgentBlockCard
          subagentType={subagentType}
          description="Angle A: line-break"
        />,
      );
      expect(html).toContain('Agent');
      expect(html).toContain('Angle A: line-break');
      expect(html).not.toContain('·');
      expect(html).not.toContain('&middot;');
    },
  );

  it('keeps header text separated when the subtype is omitted', () => {
    const html = renderToString(
      <AgentBlockCard subagentType="agent" runInBackground />,
    );
    expect(html).not.toContain('Agent<span');
    expect(html).toContain('Agent<!-- --> <span');
  });

  it('renders the background badge when runInBackground=true', () => {
    const html = renderToString(
      <AgentBlockCard subagentType="audit" runInBackground />,
    );
    expect(html).toContain('data-testid="agent-block-background-badge"');
    expect(html).toContain('background');
  });

  it('omits the background badge by default', () => {
    const html = renderToString(<AgentBlockCard subagentType="audit" />);
    expect(html).not.toContain('data-testid="agent-block-background-badge"');
  });

  it('renders the description preview in the collapsed header', () => {
    const html = renderToString(
      <AgentBlockCard
        subagentType="audit"
        description="Run a quick lint scan"
      />,
    );
    expect(html).toContain('Run a quick lint scan');
  });

  it('truncates long descriptions to 80 chars with ellipsis', () => {
    const long = 'a'.repeat(120);
    const html = renderToString(
      <AgentBlockCard subagentType="audit" description={long} />,
    );
    expect(html).toContain('a'.repeat(80) + '…');
  });

  it('does not mount the usage grid by default (card collapsed)', () => {
    const html = renderToString(
      <AgentBlockCard
        subagentType="audit"
        usage={{ inputTokens: 100, outputTokens: 50, apiCalls: 1 }}
      />,
    );
    expect(html).not.toContain('data-testid="agent-block-usage-grid"');
  });

  it('does not render the spinner when isRunning is false', () => {
    const html = renderToString(
      <AgentBlockCard
        subagentType="audit"
        pendingSpinner={<span data-testid="spinner">…</span>}
        isRunning={false}
      />,
    );
    expect(html).not.toContain('data-testid="spinner"');
  });

  it('renders the spinner slot when isRunning=true', () => {
    const html = renderToString(
      <AgentBlockCard
        subagentType="audit"
        pendingSpinner={<span data-testid="spinner">…</span>}
        isRunning
      />,
    );
    expect(html).toContain('data-testid="spinner"');
  });

  it('renders the error label when isError=true', () => {
    const html = renderToString(
      <AgentBlockCard subagentType="audit" isError />,
    );
    expect(html).toContain('fg-destructive/80');
    expect(html).toContain('error');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <AgentBlockCard subagentType="audit" dataTestId="agent" />,
    );
    expect(html).toContain('data-testid="agent"');
  });

  it('accepts a subBlocks ReactNode slot (rendered post-expand only)', () => {
    // Collapsed by default — slot is not in DOM until expanded. We verify the
    // primitive renders without crashing when subBlocks is supplied, and
    // that the slot stays hidden behind the expand toggle.
    const html = renderToString(
      <AgentBlockCard
        subagentType="audit"
        subBlocks={<span data-testid="sub-block">child</span>}
      />,
    );
    expect(html).not.toContain('data-testid="sub-block"');
  });
});
