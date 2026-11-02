/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  BrowserTabPreviewCard,
  browserTabPreviewLocation,
  type BrowserTabPreviewCardProps,
} from '../BrowserTabPreviewCard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('BrowserTabPreviewCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(overrides: Partial<BrowserTabPreviewCardProps> = {}): void {
    act(() =>
      root.render(
        <BrowserTabPreviewCard
          title="Checkout · Northwind Supply"
          url="http://localhost:5173/checkout"
          previewSrc="data:image/jpeg;base64,AAAA"
          {...overrides}
        />,
      ),
    );
  }

  const q = (testId: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${testId}"]`);

  it('shows the title in the chip, the capture, and the location row', () => {
    render();
    expect(q('browser-tab-preview-title')?.textContent).toBe(
      'Checkout · Northwind Supply',
    );
    expect(q('browser-tab-preview-image')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    expect(q('browser-tab-preview-url')?.textContent).toBe(
      'localhost:5173/checkout',
    );
  });

  it('keeps the preview space and shows the fallback glyph without a capture', () => {
    render({ previewSrc: null });
    expect(q('browser-tab-preview-image')).toBeNull();
    expect(q('browser-tab-preview-placeholder')).not.toBeNull();
    expect(q('browser-tab-preview-frame')?.className).toContain('aspect-video');
  });

  it('draws a host-supplied icon in place of the globe', () => {
    render({
      previewSrc: null,
      fallbackIcon: <span data-testid="site-icon" />,
    });
    expect(
      q('browser-tab-preview-placeholder')?.querySelector(
        '[data-testid="site-icon"]',
      ),
    ).not.toBeNull();
  });

  it('falls back when the capture fails to load', () => {
    render();
    const image = q('browser-tab-preview-image');
    act(() => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(q('browser-tab-preview-image')).toBeNull();
    expect(q('browser-tab-preview-placeholder')).not.toBeNull();
  });

  it('keeps page content out of session replay', () => {
    render();
    for (const id of [
      'browser-tab-preview-title',
      'browser-tab-preview-frame',
      'browser-tab-preview-url',
    ]) {
      expect(q(id)?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    }
  });

  it('leaves the location row out when there is no URL', () => {
    render({ url: '' });
    expect(q('browser-tab-preview-url')).toBeNull();
  });
});

describe('browserTabPreviewLocation', () => {
  it.each([
    ['https://docs.example.com/guide/', 'docs.example.com/guide/'],
    ['http://localhost:5173/checkout?step=2', 'localhost:5173/checkout?step=2'],
    ['https://example.com/', 'example.com'],
    ['file:///Users/me/index.html', 'file:///Users/me/index.html'],
  ])('%s reads as %s', (url, expected) => {
    expect(browserTabPreviewLocation(url)).toBe(expected);
  });
});
