/** @jest-environment jsdom */

import {
  type IHorizontalSashLayoutProvider,
  type ISashEvent,
  type IVerticalSashLayoutProvider,
  Orientation,
  Sash,
  SashState,
  setGlobalSashSize,
} from '../sash';

interface PointerEventOptions {
  pageX?: number;
  pageY?: number;
  altKey?: boolean;
}

// jsdom does not implement PointerEvent; fall back to MouseEvent, which
// structurally satisfies everything the sash drag logic reads. pageX/pageY
// are not settable through MouseEventInit in jsdom, so they are defined
// directly on the event instance.
function createPointerEvent(
  type: string,
  options: PointerEventOptions = {},
): MouseEvent {
  const Ctor =
    typeof window.PointerEvent === 'function'
      ? window.PointerEvent
      : MouseEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    altKey: options.altKey ?? false,
  });
  Object.defineProperty(event, 'pageX', { value: options.pageX ?? 0 });
  Object.defineProperty(event, 'pageY', { value: options.pageY ?? 0 });
  return event;
}

function queryHtmlElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected to find element matching '${selector}'`);
  }

  return element;
}

describe('Sash', () => {
  let container: HTMLElement;
  const disposables: { dispose(): void }[] = [];

  function track<T extends { dispose(): void }>(disposable: T): T {
    disposables.push(disposable);
    return disposable;
  }

  function createVerticalSash(
    provider: IVerticalSashLayoutProvider = { getVerticalSashLeft: () => 100 },
  ): Sash {
    return track(
      new Sash(container, provider, { orientation: Orientation.VERTICAL }),
    );
  }

  function createHorizontalSash(
    provider: IHorizontalSashLayoutProvider = {
      getHorizontalSashTop: () => 50,
    },
  ): Sash {
    return track(
      new Sash(container, provider, { orientation: Orientation.HORIZONTAL }),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }

    container.remove();
  });

  describe('construction and DOM structure', () => {
    it('appends a .canopy-sash element to the container', () => {
      createVerticalSash();

      const el = queryHtmlElement(container, '.canopy-sash');
      expect(el.classList.contains('vertical')).toBe(true);
      expect(el.classList.contains('horizontal')).toBe(false);
    });

    it('marks its element to draw above an in-app browser page while hovered', () => {
      createVerticalSash();
      expect(
        queryHtmlElement(container, '.canopy-sash').getAttribute(
          'data-canopy-above-browser',
        ),
      ).toBe('hover');
    });

    it('marks horizontal sashes with the horizontal class', () => {
      createHorizontalSash();

      const el = queryHtmlElement(container, '.canopy-sash');
      expect(el.classList.contains('horizontal')).toBe(true);
      expect(el.classList.contains('vertical')).toBe(false);
    });

    it('positions a vertical sash from its layout provider, centered on the boundary', () => {
      createVerticalSash({ getVerticalSashLeft: () => 100 });

      const el = queryHtmlElement(container, '.canopy-sash');
      // Default global sash size is 4, so left = 100 - 4 / 2.
      expect(el.style.left).toBe('98px');
    });

    it('applies optional top/height from a vertical layout provider', () => {
      createVerticalSash({
        getVerticalSashLeft: () => 100,
        getVerticalSashTop: () => 10,
        getVerticalSashHeight: () => 200,
      });

      const el = queryHtmlElement(container, '.canopy-sash');
      expect(el.style.top).toBe('10px');
      expect(el.style.height).toBe('200px');
    });

    it('honors an explicit size option', () => {
      track(
        new Sash(
          container,
          { getVerticalSashLeft: (): number => 100 },
          { orientation: Orientation.VERTICAL, size: 10 },
        ),
      );

      const el = queryHtmlElement(container, '.canopy-sash');
      expect(el.style.width).toBe('10px');
      expect(el.style.left).toBe('95px');
    });

    it('relayouts default-sized sashes when the global sash size changes', () => {
      createVerticalSash({ getVerticalSashLeft: () => 100 });
      const el = queryHtmlElement(container, '.canopy-sash');

      try {
        setGlobalSashSize(8);
        expect(el.style.left).toBe('96px');
      } finally {
        setGlobalSashSize(4);
      }
    });
  });

  describe('pointer drag lifecycle', () => {
    it('fires onDidStart, onDidChange and onDidEnd with 2-D coordinates', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      const starts: ISashEvent[] = [];
      const changes: ISashEvent[] = [];
      let endCount = 0;
      sash.onDidStart((e) => starts.push(e));
      sash.onDidChange((e) => changes.push(e));
      sash.onDidEnd(() => {
        endCount += 1;
      });

      el.dispatchEvent(
        createPointerEvent('pointerdown', { pageX: 100, pageY: 20 }),
      );

      expect(starts).toEqual([
        { startX: 100, currentX: 100, startY: 20, currentY: 20, altKey: false },
      ]);

      window.dispatchEvent(
        createPointerEvent('pointermove', { pageX: 130, pageY: 25 }),
      );
      window.dispatchEvent(
        createPointerEvent('pointermove', { pageX: 90, pageY: 25 }),
      );

      expect(changes).toEqual([
        { startX: 100, currentX: 130, startY: 20, currentY: 25, altKey: false },
        { startX: 100, currentX: 90, startY: 20, currentY: 25, altKey: false },
      ]);
      expect(endCount).toBe(0);

      window.dispatchEvent(
        createPointerEvent('pointerup', { pageX: 90, pageY: 25 }),
      );
      expect(endCount).toBe(1);
    });

    it('adds the active class during a drag and removes it afterwards', () => {
      createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      expect(el.classList.contains('active')).toBe(true);

      window.dispatchEvent(createPointerEvent('pointerup', { pageX: 10 }));
      expect(el.classList.contains('active')).toBe(false);
    });

    it('injects a global cursor stylesheet during a drag and removes it on pointer up', () => {
      createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      const style = el.querySelector('style');
      expect(style).not.toBeNull();
      expect(style?.textContent).toContain('cursor:');

      window.dispatchEvent(createPointerEvent('pointerup', { pageX: 10 }));
      expect(el.querySelector('style')).toBeNull();
    });

    it('stops emitting drag events after pointer up', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      const changes: ISashEvent[] = [];
      sash.onDidChange((e) => changes.push(e));

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      window.dispatchEvent(createPointerEvent('pointerup', { pageX: 10 }));
      window.dispatchEvent(createPointerEvent('pointermove', { pageX: 50 }));

      expect(changes).toHaveLength(0);
    });

    it('captures the alt key at drag start', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      const starts: ISashEvent[] = [];
      sash.onDidStart((e) => starts.push(e));

      el.dispatchEvent(
        createPointerEvent('pointerdown', { pageX: 10, altKey: true }),
      );
      window.dispatchEvent(createPointerEvent('pointerup', { pageX: 10 }));

      expect(starts).toHaveLength(1);
      expect(starts[0].altKey).toBe(true);
    });

    it('fires onDidReset on double click', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      let resetCount = 0;
      sash.onDidReset(() => {
        resetCount += 1;
      });

      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(resetCount).toBe(1);
    });
  });

  describe('enablement states', () => {
    it('does not start a drag when disabled', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      sash.state = SashState.Disabled;

      let startCount = 0;
      sash.onDidStart(() => {
        startCount += 1;
      });

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      expect(startCount).toBe(0);
      expect(el.classList.contains('active')).toBe(false);
    });

    it('toggles the disabled/minimum/maximum classes with state', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      expect(sash.state).toBe(SashState.Enabled);

      sash.state = SashState.Disabled;
      expect(el.classList.contains('disabled')).toBe(true);

      sash.state = SashState.AtMinimum;
      expect(el.classList.contains('disabled')).toBe(false);
      expect(el.classList.contains('minimum')).toBe(true);

      sash.state = SashState.AtMaximum;
      expect(el.classList.contains('minimum')).toBe(false);
      expect(el.classList.contains('maximum')).toBe(true);

      sash.state = SashState.Enabled;
      expect(el.classList.contains('maximum')).toBe(false);
    });
  });

  describe('hover and active state classes', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('applies the hover class after the hover delay', () => {
      createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      expect(el.classList.contains('hover')).toBe(false);

      jest.advanceTimersByTime(300);
      expect(el.classList.contains('hover')).toBe(true);
    });

    it('cancels a pending hover on mouse leave', () => {
      createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));

      jest.advanceTimersByTime(300);
      expect(el.classList.contains('hover')).toBe(false);
    });

    it('applies the hover class immediately while active', () => {
      createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      expect(el.classList.contains('hover')).toBe(true);

      window.dispatchEvent(createPointerEvent('pointerup', { pageX: 10 }));
    });

    it('clearSashHoverState removes the hover class', () => {
      const sash = createVerticalSash();
      const el = queryHtmlElement(container, '.canopy-sash');

      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      jest.advanceTimersByTime(300);
      expect(el.classList.contains('hover')).toBe(true);

      sash.clearSashHoverState();
      expect(el.classList.contains('hover')).toBe(false);
    });
  });

  describe('orthogonal sashes', () => {
    it('creates and removes corner drag handles based on the orthogonal sash state', () => {
      const vertical = createVerticalSash();
      const horizontal = createHorizontalSash();

      vertical.orthogonalStartSash = horizontal;

      const verticalEl = queryHtmlElement(container, '.canopy-sash.vertical');
      expect(
        verticalEl.querySelector('.orthogonal-drag-handle.start'),
      ).not.toBeNull();

      horizontal.state = SashState.Disabled;
      expect(
        verticalEl.querySelector('.orthogonal-drag-handle.start'),
      ).toBeNull();

      horizontal.state = SashState.Enabled;
      expect(
        verticalEl.querySelector('.orthogonal-drag-handle.start'),
      ).not.toBeNull();
    });

    it('forwards drags starting on a corner handle to the orthogonal sash', () => {
      const vertical = createVerticalSash();
      const horizontal = createHorizontalSash();

      vertical.orthogonalStartSash = horizontal;

      const verticalEl = queryHtmlElement(container, '.canopy-sash.vertical');
      const handle = queryHtmlElement(
        verticalEl,
        '.orthogonal-drag-handle.start',
      );

      let verticalStarts = 0;
      let horizontalStarts = 0;
      let verticalChanges = 0;
      let horizontalChanges = 0;
      let verticalEnds = 0;
      let horizontalEnds = 0;
      vertical.onDidStart(() => {
        verticalStarts += 1;
      });
      horizontal.onDidStart(() => {
        horizontalStarts += 1;
      });
      vertical.onDidChange(() => {
        verticalChanges += 1;
      });
      horizontal.onDidChange(() => {
        horizontalChanges += 1;
      });
      vertical.onDidEnd(() => {
        verticalEnds += 1;
      });
      horizontal.onDidEnd(() => {
        horizontalEnds += 1;
      });

      handle.dispatchEvent(
        createPointerEvent('pointerdown', { pageX: 100, pageY: 50 }),
      );
      expect(verticalStarts).toBe(1);
      expect(horizontalStarts).toBe(1);

      window.dispatchEvent(
        createPointerEvent('pointermove', { pageX: 110, pageY: 60 }),
      );
      expect(verticalChanges).toBe(1);
      expect(horizontalChanges).toBe(1);

      window.dispatchEvent(
        createPointerEvent('pointerup', { pageX: 110, pageY: 60 }),
      );
      expect(verticalEnds).toBe(1);
      expect(horizontalEnds).toBe(1);
    });
  });

  describe('dispose', () => {
    it('removes the element and stops listening', () => {
      const sash = new Sash(
        container,
        { getVerticalSashLeft: (): number => 100 },
        { orientation: Orientation.VERTICAL },
      );
      const el = queryHtmlElement(container, '.canopy-sash');

      let startCount = 0;
      sash.onDidStart(() => {
        startCount += 1;
      });

      sash.dispose();
      expect(container.querySelector('.canopy-sash')).toBeNull();

      el.dispatchEvent(createPointerEvent('pointerdown', { pageX: 10 }));
      expect(startCount).toBe(0);
    });
  });
});
