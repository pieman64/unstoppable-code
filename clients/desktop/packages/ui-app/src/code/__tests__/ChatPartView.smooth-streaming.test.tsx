/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalChatPart } from '@canopy/protocol/portal';
import {
  preloadSmoothMarkdown,
  SmoothStreamingProvider,
} from '@canopy/ui-shared/components/streaming-text';
import { renderMermaid } from '../../../../ui-shared/src/components/markdown-mermaid-renderer';
import { ChatPartView } from '../ChatPartView';

jest.mock(
  '../../../../ui-shared/src/components/markdown-mermaid-renderer',
  () => ({
    renderMermaid: jest.fn(() => Promise.resolve('<svg></svg>')),
  }),
);

const PART: PortalChatPart = {
  kind: 'text',
  data: { text: 'The flow:\n\n```mermaid\ngraph TD; A-->B\n```' },
};

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await preloadSmoothMarkdown();
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  // Every diagram is on screen.
  Reflect.set(
    globalThis,
    'IntersectionObserver',
    class {
      private readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(): void {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
});

beforeEach(() => {
  jest.mocked(renderMermaid).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('ChatPartView text parts and Smooth streaming', () => {
  it('draws a live part’s diagram at once while Smooth streaming is off', async () => {
    act(() => root.render(<ChatPartView part={PART} live />));
    await settle();
    expect(renderMermaid).toHaveBeenCalled();
  });

  it('draws at once with Smooth streaming on under reduced motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList =>
      Object.assign(new EventTarget(), {
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
      });
    try {
      act(() =>
        root.render(
          <SmoothStreamingProvider value>
            <ChatPartView part={PART} live />
          </SmoothStreamingProvider>,
        ),
      );
      await settle();
      expect(renderMermaid).toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it('waits for the stream before drawing while Smooth streaming is on', async () => {
    act(() =>
      root.render(
        <SmoothStreamingProvider value>
          <ChatPartView part={PART} live />
        </SmoothStreamingProvider>,
      ),
    );
    await settle();
    expect(renderMermaid).not.toHaveBeenCalled();
  });
});
