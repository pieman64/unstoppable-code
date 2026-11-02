import { renderToStaticMarkup } from 'react-dom/server';
import { ForkChatButton } from '../ForkChatButton';
import { ChatLookProvider } from '../chat-look';

describe('ForkChatButton', () => {
  it('renders the shared accessible fork glyph and host classes', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ForkChatButton
          ariaLabel="Fork chat"
          aria-controls="fork-tooltip"
          aria-describedby="fork-description"
          aria-expanded="true"
          className="shrink-0"
          coarsePointerTarget
          dataTestId="fork-action"
          disabled
          onClick={() => undefined}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-label="Fork chat"');
    expect(html).toContain('aria-controls="fork-tooltip"');
    expect(html).toContain('aria-describedby="fork-description"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="fork-action"');
    expect(html).toContain('shrink-0');
    // The 44px touch floor is the button's own, opted into by touch hosts.
    const classes = html.match(/<button[^>]*class="([^"]*)"/)?.[1].split(/\s+/);
    expect(classes).toContain('pointer-coarse:h-11');
    expect(classes).toContain('pointer-coarse:w-11');
    expect(html).toContain('disabled=""');
    expect(html).toContain('ring-1');
    expect(html).toContain('ring-line-base');
    expect(html).not.toContain('border-border');
    expect(html).toContain('data-glyph="repo-forked"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('width="14px"');
  });

  it('stays 24px on every pointer unless the host opts into the touch floor', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ForkChatButton ariaLabel="Fork chat" onClick={() => undefined} />
      </ChatLookProvider>,
    );

    expect(html).toContain('h-6 w-6');
    expect(html).not.toContain('pointer-coarse:h-11');
  });
});
