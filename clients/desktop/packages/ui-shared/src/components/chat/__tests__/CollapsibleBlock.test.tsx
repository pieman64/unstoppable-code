import { renderToString } from 'react-dom/server';
import { CollapsibleBlock } from '../CollapsibleBlock';
import { ChatLookProvider } from '../../chat-look';

describe('CollapsibleBlock (shared desktop/web)', () => {
  it('shows the label with an auto preview of the content while collapsed', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <CollapsibleBlock label="Thinking" content={'a'.repeat(100)} />
      </ChatLookProvider>,
    );
    expect(html).toContain('Thinking');
    // Desktop-parity preview: first 80 chars + ellipsis.
    expect(html).toContain(`${'a'.repeat(80)}…`);
    expect(html).not.toContain('a'.repeat(100));
  });

  it('renders short content as the full preview', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <CollapsibleBlock label="Tool result" content="full output" />
      </ChatLookProvider>,
    );
    expect(html).toContain('full output');
  });

  it('honors an explicit preview override', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <CollapsibleBlock
          label="Block"
          content="content body"
          preview="custom preview"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('custom preview');
    expect(html).not.toContain('content body');
  });

  it('defaults to the lightbulb when no icon is given', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <CollapsibleBlock label="Thinking" content="x" />
      </ChatLookProvider>,
    );
    // The same lightbulb as the clean chat look, on desktop and web.
    expect(html).toContain('data-glyph="lightbulb"');
    expect(html).not.toContain('data-glyph="brain-circuit"');
  });
});
