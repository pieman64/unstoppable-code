/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FileMarkdownPreview } from '../FileMarkdownPreview';

describe('FileMarkdownPreview', () => {
  it('renders the preview container with the markdown content', () => {
    const out = renderToString(
      <FileMarkdownPreview content="# Title\n\nbody text" />,
    );
    expect(out).toContain('data-testid="file-viewer-markdown-scroll"');
    expect(out).toContain('body text');
  });

  it('blocks the preview root from session replay', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(
      <FileMarkdownPreview content="# Private notes" />,
    );
    const root = container.firstElementChild;

    expect(root?.getAttribute('data-testid')).toBe(
      'file-viewer-markdown-scroll',
    );
    expect(Array.from(root?.classList ?? [])).toEqual([
      REPLAY_BLOCK_CLASS,
      'min-h-0',
      'flex-1',
      'overflow-auto',
    ]);
  });

  it('renders frontmatter separately from the markdown body', () => {
    const out = renderToString(
      <FileMarkdownPreview
        content={[
          '---',
          'title: Frontmatter Preview',
          'draft: false',
          'tags:',
          '  - alpha',
          '  - beta',
          '---',
          '# Body Heading',
        ].join('\n')}
      />,
    );
    expect(out).toMatch(/<dt[^>]*>title<\/dt>/);
    expect(out).toContain('Frontmatter Preview');
    expect(out).toMatch(/<dt[^>]*>draft<\/dt>/);
    expect(out).toContain('No');
    expect(out).toMatch(/<dt[^>]*>tags<\/dt>/);
    expect(out).toContain('[&quot;alpha&quot;,&quot;beta&quot;]');
    expect(out).toContain('<h1');
    expect(out).toContain('Body Heading</h1>');
    expect(out).not.toContain('title: Frontmatter Preview');
  });

  it('renders remote images as inert alt text without issuing a request', () => {
    const out = renderToString(
      <FileMarkdownPreview content="![Remote diagram](https://tracker.invalid/pixel.png)" />,
    );

    expect(out).not.toContain('<img');
    expect(out).not.toContain('https://tracker.invalid/pixel.png');
    expect(out).toContain('Remote diagram');
  });

  it.each([
    '//tracker.invalid/pixel.png',
    String.raw`\\tracker.invalid\pixel.png`,
  ])('does not resolve network-path image source %s', (src) => {
    const resolveAssetSrc = jest.fn(() => 'data:image/png;base64,AAAA');
    const out = renderToString(
      <FileMarkdownPreview
        content={`![Remote diagram](${src})`}
        resolveAssetSrc={resolveAssetSrc}
      />,
    );

    expect(resolveAssetSrc).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).toContain('Remote diagram');
  });

  it('binds the markdown scroll container for per-tab persistence', () => {
    const onScroll = jest.fn();
    const ref = jest.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => {
      root.render(
        <FileMarkdownPreview
          content="body"
          scrollBinding={{ ref, onScroll }}
        />,
      );
    });
    const scrollContainer = host.querySelector(
      '[data-testid="file-viewer-markdown-scroll"]',
    );
    expect(ref).toHaveBeenCalledWith(scrollContainer);
    act(() => {
      scrollContainer?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(onScroll).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it.each([
    ['null', (): Promise<null> => Promise.resolve(null)],
    ['rejection', (): Promise<never> => Promise.reject(new Error('failed'))],
  ])('shows Image unavailable after resolver %s', async (_label, resolver) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <FileMarkdownPreview
          content="![asset](asset.png)"
          resolveAssetSrc={resolver}
        />,
      );
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Image unavailable');
    act(() => root.unmount());
  });
});
