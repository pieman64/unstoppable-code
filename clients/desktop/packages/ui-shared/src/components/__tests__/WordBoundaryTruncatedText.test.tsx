/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WordBoundaryTruncatedText } from '../WordBoundaryTruncatedText';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CHAR_PX = 10;
const ELLIPSIS_PX = 10;
const LONG = "Aug 10. Can't reach the server after midnight";

interface Harness {
  readonly root: Root;
  readonly container: HTMLDivElement;
  readonly rangeReads: jest.Mock<DOMRect, [Range]>;
  readonly observed: Element[];
  readonly disconnects: { count: number };
  setAvailable(width: number): void;
  notify(width?: number): void;
  span(): HTMLElement;
  restore(): void;
}

function setUp(withObserver = true): Harness {
  let available = 150;
  const rangeDescriptor = Object.getOwnPropertyDescriptor(
    Range.prototype,
    'getBoundingClientRect',
  );
  const elementDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect',
  );
  const observerDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'ResizeObserver',
  );
  const rangeReads = jest.fn<DOMRect, [Range]>(
    (range) => new DOMRect(0, 0, CHAR_PX * range.toString().length, 16),
  );
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range): DOMRect {
      return rangeReads(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.dataset.testid === 'title') {
        return new DOMRect(0, 0, available, 16);
      }
      if (this.textContent === '…') {
        return new DOMRect(0, 0, ELLIPSIS_PX, 16);
      }
      return new DOMRect(0, 0, 0, 0);
    },
  });
  const observed: Element[] = [];
  const disconnects = { count: 0 };
  let deliver: ((entries: ResizeObserverEntry[]) => void) | null = null;
  if (withObserver) {
    class Observer implements ResizeObserver {
      constructor(next: ResizeObserverCallback) {
        deliver = (entries): void => next(entries, this);
      }
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnects.count += 1;
      }
    }
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: Observer,
    });
  } else {
    Reflect.deleteProperty(window, 'ResizeObserver');
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    root,
    container,
    rangeReads,
    observed,
    disconnects,
    setAvailable(width): void {
      available = width;
    },
    notify(width = available): void {
      const target = observed[observed.length - 1];
      if (!deliver || !target) throw new Error('not observing');
      const run = deliver;
      const entry: Pick<ResizeObserverEntry, 'target' | 'contentRect'> = {
        target,
        contentRect: new DOMRect(0, 0, width, 20),
      };
      act(() => {
        run([
          {
            ...entry,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ]);
      });
    },
    span(): HTMLElement {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="title"]',
      );
      if (!element) throw new Error('missing title');
      return element;
    },
    restore(): void {
      act(() => root.unmount());
      container.remove();
      if (rangeDescriptor) {
        Object.defineProperty(
          Range.prototype,
          'getBoundingClientRect',
          rangeDescriptor,
        );
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
      if (elementDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'getBoundingClientRect',
          elementDescriptor,
        );
      }
      if (observerDescriptor) {
        Object.defineProperty(window, 'ResizeObserver', observerDescriptor);
      } else {
        Reflect.deleteProperty(window, 'ResizeObserver');
      }
    },
  };
}

function render(
  harness: Harness,
  text: string,
  props: { hoverTitle?: boolean; maxWords?: number } = {},
): void {
  act(() => {
    harness.root.render(
      <p>
        <WordBoundaryTruncatedText
          text={text}
          data-testid="title"
          className="inline-block"
          {...props}
        />
      </p>,
    );
  });
}

function expectSingleTextNode(element: HTMLElement, text: string): void {
  expect(element.childNodes).toHaveLength(1);
  const [node] = Array.from(element.childNodes);
  expect(node?.nodeType).toBe(Node.TEXT_NODE);
  expect(node?.textContent).toBe(text);
}

/** The visible boundary for `available` px, by the 10px-per-char stubs. */
function expectedEnd(text: string, available: number): number {
  const budget = available - ELLIPSIS_PX - 1;
  let end = -1;
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === ' ' && text[index - 1] !== ' ') {
      if (index * CHAR_PX <= budget) end = index;
    }
  }
  return end;
}

describe('WordBoundaryTruncatedText', () => {
  it('clamps an overflowing title after the last whole word', () => {
    const harness = setUp();
    try {
      render(harness, LONG, { hoverTitle: true });
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.dataset.truncated).toBeUndefined();
      expect(span.className).toContain('truncate');
      expect(harness.observed).toEqual([span.parentElement]);

      harness.notify();
      const end = expectedEnd(LONG, 150);
      expect(LONG.slice(0, end)).toBe("Aug 10. Can't");
      expect(span.style.maxWidth).toBe(
        `${Math.ceil(end * CHAR_PX + ELLIPSIS_PX + 1)}px`,
      );
      expect(span.dataset.truncated).toBe('word');
      expect(span.dataset.visibleLength).toBe(String(end));
      expect(span.title).toBe(LONG);
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });

  it('leaves a fitting title alone', () => {
    const harness = setUp();
    try {
      render(harness, 'Short title', { hoverTitle: true });
      harness.notify();
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('data-visible-length')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
      expectSingleTextNode(span, 'Short title');
    } finally {
      harness.restore();
    }
  });

  it('keeps the native mid-word cut when no whole word fits', () => {
    const harness = setUp();
    const word = 'a'.repeat(40);
    try {
      render(harness, `${word} tail`, { hoverTitle: true });
      harness.notify();
      const span = harness.span();
      expect(span.dataset.truncated).toBe('char');
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-visible-length')).toBe(false);
      expect(span.title).toBe(`${word} tail`);
      expectSingleTextNode(span, `${word} tail`);
    } finally {
      harness.restore();
    }
  });

  it('sets no title unless asked', () => {
    const harness = setUp();
    try {
      render(harness, LONG);
      harness.notify();
      const span = harness.span();
      expect(span.dataset.truncated).toBe('word');
      expect(span.hasAttribute('title')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('measures again only when the width or font size changes', () => {
    const harness = setUp();
    try {
      render(harness, LONG, { hoverTitle: true });
      harness.notify();
      const reads = harness.rangeReads.mock.calls.length;
      harness.notify();
      expect(harness.rangeReads.mock.calls.length).toBe(reads);

      harness.setAvailable(100);
      harness.notify();
      const span = harness.span();
      const narrow = expectedEnd(LONG, 100);
      expect(narrow).toBeLessThan(expectedEnd(LONG, 150));
      expect(span.dataset.visibleLength).toBe(String(narrow));
      expect(LONG[narrow]).toBe(' ');

      harness.setAvailable(1000);
      harness.notify();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('data-visible-length')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });

  it('starts over when the text changes and disconnects on unmount', () => {
    const harness = setUp();
    try {
      render(harness, LONG, { hoverTitle: true });
      harness.notify();
      expect(harness.observed).toHaveLength(1);

      render(harness, 'Short title', { hoverTitle: true });
      expect(harness.disconnects.count).toBe(1);
      expect(harness.observed).toHaveLength(2);
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
      harness.notify();
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expectSingleTextNode(span, 'Short title');

      act(() => harness.root.render(<p />));
      expect(harness.disconnects.count).toBe(2);
    } finally {
      harness.restore();
    }
  });

  it('writes nothing for empty text', () => {
    const harness = setUp();
    try {
      render(harness, '', { hoverTitle: true });
      harness.notify();
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('keeps the CSS clip where ResizeObserver is missing', () => {
    const harness = setUp(false);
    try {
      render(harness, LONG, { hoverTitle: true });
      const span = harness.span();
      expect(harness.observed).toHaveLength(0);
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });
});

describe('WordBoundaryTruncatedText with a word limit', () => {
  it('ends after the last allowed word even when more would fit', () => {
    const harness = setUp();
    try {
      harness.setAvailable(1000);
      render(harness, LONG, { hoverTitle: true, maxWords: 3 });
      harness.notify();
      const span = harness.span();
      const end = "Aug 10. Can't".length;
      expect(span.style.maxWidth).toBe(
        `${Math.ceil(end * CHAR_PX + ELLIPSIS_PX + 1)}px`,
      );
      expect(span.dataset.truncated).toBe('word');
      expect(span.dataset.visibleLength).toBe(String(end));
      expect(span.title).toBe(LONG);
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });

  it('cuts at whichever of the limit and the width is shorter', () => {
    const harness = setUp();
    try {
      render(harness, LONG, { hoverTitle: true, maxWords: 2 });
      harness.notify();
      const span = harness.span();
      expect(expectedEnd(LONG, 150)).toBeGreaterThan('Aug 10.'.length);
      expect(span.dataset.visibleLength).toBe(String('Aug 10.'.length));

      render(harness, LONG, { hoverTitle: true, maxWords: 5 });
      harness.notify();
      const narrow = expectedEnd(LONG, 150);
      expect(narrow).toBeLessThan("Aug 10. Can't reach the".length);
      expect(span.dataset.truncated).toBe('word');
      expect(span.dataset.visibleLength).toBe(String(narrow));
      expect(span.style.maxWidth).toBe(
        `${Math.ceil(narrow * CHAR_PX + ELLIPSIS_PX + 1)}px`,
      );

      harness.setAvailable(1000);
      harness.notify();
      expect(span.dataset.visibleLength).toBe(
        String("Aug 10. Can't reach the".length),
      );
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });

  it('leaves text with no more words than the limit alone', () => {
    const harness = setUp();
    try {
      harness.setAvailable(1000);
      render(harness, LONG, { hoverTitle: true, maxWords: 8 });
      harness.notify();
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('data-visible-length')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('keeps the native mid-word cut when the first word is too wide', () => {
    const harness = setUp();
    const word = 'a'.repeat(40);
    try {
      render(harness, `${word} tail`, { hoverTitle: true, maxWords: 1 });
      harness.notify();
      const span = harness.span();
      expect(span.dataset.truncated).toBe('char');
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-visible-length')).toBe(false);
      expect(span.title).toBe(`${word} tail`);
    } finally {
      harness.restore();
    }
  });

  it('shows the whole text when the cut words are narrower than the ellipsis', () => {
    const harness = setUp();
    try {
      // "i" is 1px, so " i" (11px) never outgrows "…" plus the slack.
      harness.rangeReads.mockImplementation((range) => {
        const text = range.toString();
        const narrow = text.split('i').length - 1;
        return new DOMRect(0, 0, CHAR_PX * (text.length - narrow) + narrow, 16);
      });
      harness.setAvailable(1000);
      render(harness, 'one two i', { hoverTitle: true, maxWords: 2 });
      harness.notify();
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('sets no title for a word-limit cut unless asked', () => {
    const harness = setUp();
    try {
      harness.setAvailable(1000);
      render(harness, LONG, { maxWords: 3 });
      harness.notify();
      const span = harness.span();
      expect(span.dataset.truncated).toBe('word');
      expect(span.hasAttribute('title')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('starts over when the limit is removed', () => {
    const harness = setUp();
    try {
      harness.setAvailable(1000);
      render(harness, LONG, { hoverTitle: true, maxWords: 3 });
      harness.notify();
      expect(harness.span().dataset.truncated).toBe('word');

      render(harness, LONG, { hoverTitle: true });
      expect(harness.disconnects.count).toBe(1);
      harness.notify();
      const span = harness.span();
      expect(span.style.maxWidth).toBe('');
      expect(span.hasAttribute('data-truncated')).toBe(false);
      expect(span.hasAttribute('title')).toBe(false);
      expectSingleTextNode(span, LONG);
    } finally {
      harness.restore();
    }
  });
});
