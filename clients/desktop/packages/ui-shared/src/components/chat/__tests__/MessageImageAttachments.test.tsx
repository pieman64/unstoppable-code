/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import { MessageImageAttachments } from '../MessageImageAttachments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

  it('blocks the image name tooltip from session replay', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <MessageImageAttachments
          images={[
            {
              key: 'a',
              src: 'data:image/png;base64,AAAA',
              alt: 'private-plan.png',
              onOpen: (): void => undefined,
            },
          ]}
        />,
      ),
    );
    const tile = container.querySelector(
      '[data-testid="message-image-attachment"]',
    );
    act(() => {
      tile?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // The tip portals to the body, outside the transcript's replay block, so
    // the surface itself must carry the block class.
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('private-plan.png');
    expect(tooltip?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  it('renders nothing without images', () => {
    expect(renderToStaticMarkup(<MessageImageAttachments images={[]} />)).toBe(
      '',
    );
  });
});
