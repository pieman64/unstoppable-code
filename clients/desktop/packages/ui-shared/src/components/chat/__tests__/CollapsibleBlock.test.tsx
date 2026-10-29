import { renderToString } from 'react-dom/server';
import { CollapsibleBlock } from '../CollapsibleBlock';

describe('CollapsibleBlock (shared desktop/web)', () => {
  it('shows the label with an auto preview of the content while collapsed', () => {
    const html = renderToString(
      <CollapsibleBlock label="Thinking" content={'a'.repeat(100)} />,
    );
    expect(html).toContain('Thinking');
    // Desktop-parity preview: first 80 chars + ellipsis.
    expect(html).toContain(`${'a'.repeat(80)}…`);
    expect(html).not.toContain('a'.repeat(100));
  });

  it('renders short content as the full preview', () => {
    const html = renderToString(
      <CollapsibleBlock label="Tool result" content="full output" />,
    );
    expect(html).toContain('full output');
  });

  it('honors an explicit preview override', () => {
    const html = renderToString(
      <CollapsibleBlock
        label="Block"
        content="content body"
        preview="custom preview"
      />,
    );
    expect(html).toContain('custom preview');
    expect(html).not.toContain('content body');
  });

  it('defaults to the desktop brain glyph when no icon is given', () => {
    const html = renderToString(
      <CollapsibleBlock label="Thinking" content="x" />,
    );
    // The shared brain glyph is used on desktop and web.
    expect(html).toContain('data-glyph="brain-circuit"');
  });
});
