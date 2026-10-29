/**
 * Server-rendered tests for the shared {@link ToolCallCard}. Validates that
 * tool-family icon dispatch picks the right SVG, that the pending/success/
 * error status surfaces the right affordances, and that the default
 * collapsed/expanded states render the right body chrome.
 */
import { renderToString } from 'react-dom/server';
import { ToolCallCard, readToolCallResult } from '../ToolCallCard';

describe('readToolCallResult', () => {
  it.each([false, true])(
    'preserves live and persisted isError=%s results',
    (isError) => {
      const raw = { output: 'Tool output', isError };
      const expected = {
        kind: isError ? 'error' : 'text',
        content: raw.output,
      };
      expect(readToolCallResult(raw)).toEqual(expected);
      expect(readToolCallResult(JSON.stringify(raw))).toEqual(expected);
    },
  );

  it('keeps alias priority, empty output, and strict error booleans', () => {
    expect(
      readToolCallResult({ output: '', content: 'fallback', isError: 'true' }),
    ).toEqual({ kind: 'text', content: '' });
    expect(
      readToolCallResult(
        JSON.stringify({ output: null, content: 'Content', text: 'Text' }),
      ),
    ).toEqual({ kind: 'text', content: 'Content' });
    expect(readToolCallResult({ text: 'Text' })).toEqual({
      kind: 'text',
      content: 'Text',
    });
  });

  it.each([
    undefined,
    null,
    42,
    [],
    {},
    'not JSON',
    'null',
    '[]',
    '42',
    '{"output":42}',
    '"plain text"',
  ])('leaves an invalid result unresolved: %p', (value) => {
    expect(readToolCallResult(value)).toBeNull();
  });
});

describe('ToolCallCard', () => {
  it('renders the supplied tool name as the default label', () => {
    const html = renderToString(
      <ToolCallCard toolFamily="read" toolName="Read" />,
    );
    expect(html).toContain('Read');
    expect(html).toContain('data-tool-family="read"');
  });

  it('falls back to the wrench icon when toolFamily is missing', () => {
    const html = renderToString(<ToolCallCard toolName="UnknownTool" />);
    expect(html).toContain('data-tool-family="unknown"');
  });

  it('renders a custom label when provided', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        label={<span data-testid="rich-label">npm test</span>}
      />,
    );
    expect(html).toContain('data-testid="rich-label"');
    expect(html).toContain('npm test');
  });

  it('shows the pending spinner slot while no result is set', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        pendingSpinner={<span data-testid="spinner">…</span>}
      />,
    );
    expect(html).toContain('data-testid="spinner"');
  });

  it('nudges the pending spinner up to align with the label text', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        pendingSpinner={<span data-testid="spinner">…</span>}
      />,
    );
    const spinnerWrapperClass = html.match(
      /<span class="([^"]*)"><span data-testid="spinner"/,
    )?.[1];

    expect(spinnerWrapperClass?.split(/\s+/)).toContain('-translate-y-px');
  });

  it('hides the pending spinner once result is set', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        result={{ kind: 'text', content: 'ok' }}
        pendingSpinner={<span data-testid="spinner">…</span>}
      />,
    );
    expect(html).not.toContain('data-testid="spinner"');
  });

  it('tints the icon red when result is an error', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        result={{ kind: 'error', content: 'boom' }}
      />,
    );
    expect(html).toContain('fg-destructive');
  });

  it('renders the expanded body when defaultCollapsed=false', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        input="npm run build"
        result={{ kind: 'text', content: 'ok' }}
        defaultCollapsed={false}
      />,
    );
    expect(html).toContain('npm run build');
    expect(html).toContain('Result');
    expect(html).toContain('ok');
  });

  it('does not render the body by default', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        input="npm run build"
        result={{ kind: 'text', content: 'ok' }}
      />,
    );
    expect(html).not.toContain('npm run build');
  });

  it('uses the expanded slot override when supplied', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="web"
        toolName="WebFetch"
        defaultCollapsed={false}
        expandedSlot={<div data-testid="custom-slot">prompt</div>}
      />,
    );
    expect(html).toContain('data-testid="custom-slot"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <ToolCallCard toolFamily="read" toolName="Read" dataTestId="tool-call" />,
    );
    expect(html).toContain('data-testid="tool-call"');
  });

  it('exposes the raw canonical tool name and pending status on the root', () => {
    const html = renderToString(
      <ToolCallCard
        toolName="mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs"
        dataTestId="chat-tool-call"
      />,
    );
    expect(html).toContain(
      'data-tool-name="mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs"',
    );
    expect(html).toContain('data-tool-status="pending"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('derives data-tool-status="success" from a text result', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        result={{ kind: 'text', content: 'ok' }}
      />,
    );
    expect(html).toContain('data-tool-status="success"');
  });

  it('derives data-tool-status="error" from an error result', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        result={{ kind: 'error', content: 'boom' }}
      />,
    );
    expect(html).toContain('data-tool-status="error"');
  });

  it('honors an explicit status override on the root attribute', () => {
    const html = renderToString(
      <ToolCallCard toolFamily="bash" toolName="Bash" status="error" />,
    );
    expect(html).toContain('data-tool-status="error"');
  });

  it('expands an error result beneath the Error heading', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="bash"
        toolName="Bash"
        input="npm run build"
        result={{ kind: 'error', content: 'gateway timeout' }}
        defaultCollapsed={false}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('npm run build');
    expect(html).toContain('Error');
    expect(html).not.toContain('>Result<');
    expect(html).toContain('gateway timeout');
  });

  it('uses the supplied app icon for app-family tools', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="canopy"
        toolName="DispatchAction"
        appIcon={<svg data-testid="brand-app-icon" />}
      />,
    );
    expect(html).toContain('data-tool-family="canopy"');
    expect(html).toContain('data-testid="brand-app-icon"');
  });
});

describe('Code Graph tool results through the generic card', () => {
  const toolName = 'mcp__canopy__QueryCodeGraph';
  const errorMessage = 'Code Graph is busy. Try again in a moment.';
  const errorContent = `{"ok":false,"code":"internal","message":"${errorMessage}"}`;

  it('shows a Code Graph error as raw generic result text without invented metrics', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="graph"
        toolName={toolName}
        result={{ kind: 'error', content: errorContent }}
        defaultCollapsed={false}
      />,
    );

    expect(html).toContain('data-tool-family="graph"');
    expect(html).toContain('data-tool-status="error"');
    expect(html).toContain(`data-tool-name="${toolName}"`);
    expect(html).toContain('>Error<');
    expect(html).not.toContain('>Result<');
    expect(html).toContain(errorMessage);
    expect(html).not.toContain('0 files');
    expect(html).not.toContain('>Files<');
    expect(html).not.toContain('>Symbols<');
    expect(html).not.toContain('Edges');
  });

  it('does not render the error body into the markup when collapsed by default', () => {
    const html = renderToString(
      <ToolCallCard
        toolFamily="graph"
        toolName={toolName}
        result={{ kind: 'error', content: errorContent }}
      />,
    );

    expect(html).toContain('data-tool-status="error"');
    expect(html).not.toContain(errorMessage);
  });

  it('renders Code Graph text results verbatim under the Result heading', () => {
    const content = 'Code Graph: 12 file(s), 34 symbol(s)';
    const html = renderToString(
      <ToolCallCard
        toolFamily="graph"
        toolName={toolName}
        result={{ kind: 'text', content }}
        defaultCollapsed={false}
      />,
    );

    expect(html).toContain('>Result<');
    expect(html).toContain(content);
  });
});
