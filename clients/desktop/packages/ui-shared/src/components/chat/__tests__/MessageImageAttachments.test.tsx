/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageImageAttachments } from '../MessageImageAttachments';

describe('MessageImageAttachments', () => {
  it('renders each image as a thumbnail, a button when it can open', () => {
    const html = renderToStaticMarkup(
      <MessageImageAttachments
        images={[
          {
            key: 'a',
            src: 'data:image/png;base64,AAAA',
            alt: 'a.png',
            onOpen: (): void => undefined,
          },
          { key: 'b', src: null, alt: 'b.png' },
        ]}
      />,
    );

    expect(html.match(/data-testid="message-image-attachment"/g)).toHaveLength(
      2,
    );
    expect(html).toContain('aria-label="Open a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    // A thumbnail still loading keeps its square, without a broken image.
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toMatch(/<span[^>]*title="b.png"/);
  });

  it('draws 64px thumbnails inset evenly from the bubble edges', () => {
    const html = renderToStaticMarkup(
      <MessageImageAttachments
        images={[{ key: 'a', src: 'data:image/png;base64,AAAA', alt: 'a.png' }]}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const row = host.querySelector('[data-testid="message-image-attachments"]');
    const tile = host.querySelector('[data-testid="message-image-attachment"]');
    expect(tile?.className).toContain('h-16 w-16');
    // The bubble pads 12px across and 6px down; the row reaches 6px into the
    // side padding, so the picture sits 6px from the top and both sides.
    expect(row?.className).toContain('-mx-1.5');
    // Concentric with the bubble's 12px corner, 6px in.
    expect(tile?.className).toContain('rounded-md');
  });

  it('renders nothing without images', () => {
    expect(renderToStaticMarkup(<MessageImageAttachments images={[]} />)).toBe(
      '',
    );
  });
});
