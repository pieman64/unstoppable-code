/** @jest-environment jsdom */
import { createDomSearchExecutor } from '../dom-search-highlight';

class TestHighlight extends Set<Range> {}

describe('createDomSearchExecutor', () => {
  let highlights = new Map<string, TestHighlight>();

  beforeEach(() => {
    highlights = new Map<string, TestHighlight>();
    Object.assign(window, { Highlight: TestHighlight, CSS: { highlights } });
  });

  it('matches visually contiguous text across inline markup without crossing blocks', () => {
    document.body.innerHTML =
      '<div id="content"><p>alpha <strong>bravo</strong> charlie</p><p>delta echo</p></div>';
    const container = document.querySelector<HTMLElement>('#content');
    const executor = createDomSearchExecutor(() => container);

    expect(executor.findMatches('alpha bravo')).toBe(1);
    expect(executor.findMatches('bravo charlie')).toBe(1);
    expect(executor.findMatches('charlie delta')).toBe(0);
  });

  it('bounds traversed text parts and retained match ranges', () => {
    document.body.innerHTML = `<div id="content">${'<span>aa</span>'.repeat(1_001)}</div>`;
    const container = document.querySelector<HTMLElement>('#content');
    const executor = createDomSearchExecutor(() => container);
    const createRange = jest.spyOn(document, 'createRange');

    expect(executor.findMatches('aa')).toBe(1_000);
    expect(createRange).toHaveBeenCalledTimes(1_000);
  });

  it('stops traversing after the text-part budget', () => {
    document.body.innerHTML = `<div id="content">${'<span>filler</span>'.repeat(10_000)}<span>needle</span></div>`;
    const container = document.querySelector<HTMLElement>('#content');
    const executor = createDomSearchExecutor(() => container);

    expect(executor.findMatches('needle')).toBe(0);
  });

  it('ignores generated Markdown text while retaining authored prose', () => {
    document.body.innerHTML =
      '<div id="content"><span data-markdown-generated>Repeated label</span><p>Repeated label</p></div>';
    const container = document.querySelector<HTMLElement>('#content');
    const executor = createDomSearchExecutor(() => container);

    expect(executor.findMatches('Repeated label')).toBe(1);
  });

  it('uses viewport-relative bounds for the document scrolling element', () => {
    document.body.innerHTML = '<p id="match">Orchid</p>';
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });
    Object.defineProperties(document.documentElement, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 800 },
      scrollTop: { configurable: true, writable: true, value: 1000 },
    });
    document.documentElement.getBoundingClientRect = (): DOMRect =>
      DOMRect.fromRect({ x: 0, y: -1000, width: 800, height: 1000 });
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      DOMRect.fromRect({ x: 10, y: 800, width: 80, height: 20 });
    const executor = createDomSearchExecutor(
      () => document.body,
      () => document.documentElement,
    );

    expect(executor.findMatches('Orchid')).toBe(1);
    executor.scrollToMatch(0);
    expect(document.documentElement.scrollTop).toBe(1510);
  });

  describe('per-document highlight registries', () => {
    class FrameHighlight extends Set<Range> {}

    function mountFrame(): {
      frameWindow: Window;
      frameDocument: Document;
      frameHighlights: Map<string, FrameHighlight>;
    } {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const frameWindow = iframe.contentWindow;
      const frameDocument = iframe.contentDocument;
      if (!frameWindow || !frameDocument) throw new Error('no iframe window');
      const frameHighlights = new Map<string, FrameHighlight>();
      Object.assign(frameWindow, {
        Highlight: FrameHighlight,
        CSS: { highlights: frameHighlights },
      });
      return { frameWindow, frameDocument, frameHighlights };
    }

    const mainHighlights = (): Map<string, TestHighlight> => highlights;

    it("registers a popped-out container's matches in its own window", () => {
      document.body.innerHTML = '';
      const { frameDocument, frameHighlights } = mountFrame();
      frameDocument.body.innerHTML =
        '<div id="content"><p>alpha beta alpha</p></div>';
      const container = frameDocument.querySelector<HTMLElement>('#content');
      const executor = createDomSearchExecutor(() => container, undefined, {
        matches: 'm',
        active: 'a',
      });

      expect(executor.findMatches('alpha')).toBe(2);
      executor.setActiveMatch(0);
      expect(frameHighlights.get('m')).toBeInstanceOf(FrameHighlight);
      expect(frameHighlights.get('m')?.size).toBe(2);
      expect(frameHighlights.get('a')?.size).toBe(1);
      expect(mainHighlights().size).toBe(0);

      executor.clearHighlights();
      expect(frameHighlights.size).toBe(0);
    });

    it('clears the old window when the container moves mid-query', () => {
      document.body.innerHTML = '<div id="content"><p>alpha</p></div>';
      const container = document.querySelector<HTMLElement>('#content');
      let current: HTMLElement | null = container;
      const executor = createDomSearchExecutor(() => current, undefined, {
        matches: 'm',
      });
      expect(executor.findMatches('alpha')).toBe(1);
      expect(mainHighlights().has('m')).toBe(true);

      const { frameDocument, frameHighlights } = mountFrame();
      if (!container) throw new Error('no container');
      current = frameDocument.adoptNode(container);
      frameDocument.body.appendChild(current);
      expect(executor.findMatches('alpha')).toBe(1);
      expect(mainHighlights().has('m')).toBe(false);
      expect(frameHighlights.get('m')?.size).toBe(1);

      executor.clearHighlights();
      expect(mainHighlights().size).toBe(0);
      expect(frameHighlights.size).toBe(0);
    });

    it('skips a remembered registry whose window has closed', () => {
      document.body.innerHTML = '';
      const { frameWindow, frameDocument, frameHighlights } = mountFrame();
      frameDocument.body.innerHTML = '<div id="content">alpha</div>';
      const container = frameDocument.querySelector<HTMLElement>('#content');
      const executor = createDomSearchExecutor(() => container);
      expect(executor.findMatches('alpha')).toBe(1);

      Object.defineProperty(frameWindow, 'closed', { value: true });
      jest.spyOn(frameHighlights, 'delete').mockImplementation(() => {
        throw new Error('window closed');
      });
      expect(() => executor.clearHighlights()).not.toThrow();
    });
  });
});
