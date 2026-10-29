/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

function viewportClassTokens(html: string): string[] {
  // The viewport is the wrapper's first child div.
  const wrapper = /<div[^>]*data-overlay-scroll-area[^>]*>\s*(<div[^>]*>)/.exec(
    html,
  );
  return (/class="([^"]*)"/.exec(wrapper?.[1] ?? '')?.[1] ?? '').split(/\s+/);
}

function contentClassTokens(html: string): string[] {
  const tag = /<div[^>]*data-overlay-scroll-content[^>]*>/.exec(html)?.[0];
  return (/class="([^"]*)"/.exec(tag ?? '')?.[1] ?? '').split(/\s+/);
}

describe('OverlayScrollArea viewport role', () => {
  it('clears its own edge fade when disabled without clearing a caller mask', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderArea = (edgeFadeSize: number): HTMLDivElement => {
      act(() => {
        root.render(
          <OverlayScrollArea edgeFadeSize={edgeFadeSize}>
            rows
          </OverlayScrollArea>,
        );
      });
      const viewport = container.querySelector<HTMLDivElement>(
        '[data-overlay-scroll-area] > div',
      );
      if (!viewport) throw new Error('Scroll viewport missing');
      return viewport;
    };
    try {
      const viewport = renderArea(12);
      Object.defineProperties(viewport, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 500 },
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.style.maskImage).toContain('linear-gradient');
      renderArea(0);
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.style.maskImage).toBe('none');
      const customMask = 'linear-gradient(to bottom, transparent, black 12px)';
      viewport.style.maskImage = customMask;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.style.maskImage).toBe(customMask);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('fades only the bottom edge when asked, and only while content remains below', () => {
    // The chat transcript: its top carries the pinned user bubble, so only
    // the edge that meets the composer fades, and not once scrolled to the
    // bottom, where the latest line must read in full.
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <OverlayScrollArea edgeFadeSize={32} edgeFadeEdges="bottom">
            rows
          </OverlayScrollArea>,
        );
      });
      const viewport = container.querySelector<HTMLDivElement>(
        '[data-overlay-scroll-area] > div',
      );
      if (!viewport) throw new Error('Scroll viewport missing');
      Object.defineProperties(viewport, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 500 },
      });
      const scrollTo = (top: number): void => {
        viewport.scrollTop = top;
        act(() => {
          viewport.dispatchEvent(new Event('scroll'));
        });
      };

      scrollTo(200);
      // Mid-scroll: the top edge stays sharp, the bottom fades over 32px.
      expect(viewport.style.maskImage).toContain('black 0px');
      expect(viewport.style.maskImage).toContain('calc(100% - 32px)');
      expect(viewport.style.maskImage).toMatch(/transparent\)$/);

      scrollTo(400);
      expect(viewport.style.maskImage).toBe('none');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps a pinned top inset sharp and fades the rows below it', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <OverlayScrollArea edgeFadeSize={16} edgeFadeTopInset={20}>
            rows
          </OverlayScrollArea>,
        );
      });
      const viewport = container.querySelector<HTMLDivElement>(
        '[data-overlay-scroll-area] > div',
      );
      if (!viewport) throw new Error('Scroll viewport missing');
      Object.defineProperties(viewport, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 500 },
      });
      viewport.scrollTop = 200;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });

      // The pinned header stays opaque; the fade starts at its bottom edge.
      expect(viewport.style.maskImage).toMatch(
        /^linear-gradient\(to bottom, black 20px, transparent 20px, black 36px,/,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('is a plain viewport with no content inset by default', () => {
    const html = renderToStaticMarkup(
      <OverlayScrollArea>rows</OverlayScrollArea>,
    );

    expect(viewportClassTokens(html)).toEqual(
      expect.arrayContaining(['scrollbar-hide', 'overflow-y-auto']),
    );
    expect(viewportClassTokens(html)).not.toContain(
      'canopy-floating-menu-scroll-viewport',
    );
    expect(contentClassTokens(html)).not.toContain(
      'canopy-floating-menu-scroll-content',
    );
  });

  it("names a floating menu's row viewport and its 4px content inset", () => {
    const html = renderToStaticMarkup(
      <OverlayScrollArea viewport="menu" contentInset>
        rows
      </OverlayScrollArea>,
    );

    expect(viewportClassTokens(html)).toContain(
      'canopy-floating-menu-scroll-viewport',
    );
    expect(contentClassTokens(html)).toContain(
      'canopy-floating-menu-scroll-content',
    );
  });

  it("names a picker's list viewport and its own content inset", () => {
    const html = renderToStaticMarkup(
      <OverlayScrollArea
        viewport="pickerList"
        contentInset
        contentClassName="px-1"
      >
        rows
      </OverlayScrollArea>,
    );

    expect(viewportClassTokens(html)).toContain('canopy-picker-menu-list');
    expect(viewportClassTokens(html)).not.toContain(
      'canopy-floating-menu-scroll-viewport',
    );
    expect(contentClassTokens(html)).toEqual(
      expect.arrayContaining(['canopy-picker-menu-list-content', 'px-1']),
    );
  });

  it('leaves the content inset to the caller when only the viewport role is set', () => {
    const html = renderToStaticMarkup(
      <OverlayScrollArea viewport="menu" contentClassName="min-w-0 py-1">
        rows
      </OverlayScrollArea>,
    );

    expect(contentClassTokens(html)).toEqual(
      expect.arrayContaining(['min-w-0', 'py-1']),
    );
    expect(contentClassTokens(html)).not.toContain(
      'canopy-floating-menu-scroll-content',
    );
  });
});

describe('OverlayScrollArea session replay', () => {
  function wrapperClassTokens(html: string): string[] {
    const tag = /<div[^>]*data-overlay-scroll-area[^>]*>/.exec(html)?.[0];
    return (/class="([^"]*)"/.exec(tag ?? '')?.[1] ?? '').split(/\s+/);
  }

  it('keeps the wrapper classes unchanged and unblocked', () => {
    const html = renderToStaticMarkup(
      <OverlayScrollArea className="max-h-70">rows</OverlayScrollArea>,
    );

    expect(wrapperClassTokens(html)).toEqual([
      'flex',
      'min-h-0',
      'flex-col',
      'max-h-70',
    ]);
    expect(html).not.toContain(REPLAY_BLOCK_CLASS);
  });
});
