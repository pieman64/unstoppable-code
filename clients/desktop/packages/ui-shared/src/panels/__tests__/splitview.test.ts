/** @jest-environment jsdom */

import { Emitter, type Event } from '../emitter';
import { SashState } from '../sash';
import {
  type IView,
  LayoutPriority,
  Orientation,
  Sizing,
  SplitView,
} from '../splitview';

interface PointerEventOptions {
  pageX?: number;
  pageY?: number;
  altKey?: boolean;
}

// jsdom does not implement PointerEvent; fall back to MouseEvent, which
// structurally satisfies everything the sash drag logic reads.
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

interface TestViewOptions {
  priority?: LayoutPriority;
  snap?: boolean;
  proportionalLayout?: boolean;
}

class TestView implements IView {
  readonly element = document.createElement('div');
  readonly priority: LayoutPriority | undefined;
  readonly snap: boolean;
  readonly proportionalLayout: boolean;

  private readonly _onDidChange = new Emitter<number | undefined>();
  readonly onDidChange: Event<number | undefined> = this._onDidChange.event;

  size = 0;
  offset = 0;
  visible = true;
  layoutCallCount = 0;

  private _minimumSize: number;
  private _maximumSize: number;

  constructor(
    minimumSize: number,
    maximumSize: number,
    options: TestViewOptions = {},
  ) {
    this._minimumSize = minimumSize;
    this._maximumSize = maximumSize;
    this.priority = options.priority;
    this.snap = options.snap ?? false;
    this.proportionalLayout = options.proportionalLayout ?? true;
  }

  get minimumSize(): number {
    return this._minimumSize;
  }

  set minimumSize(size: number) {
    this._minimumSize = size;
    this._onDidChange.fire(undefined);
  }

  get maximumSize(): number {
    return this._maximumSize;
  }

  set maximumSize(size: number) {
    this._maximumSize = size;
    this._onDidChange.fire(undefined);
  }

  layout(size: number, offset: number): void {
    this.size = size;
    this.offset = offset;
    this.layoutCallCount += 1;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

function queryHtmlElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected to find element matching '${selector}'`);
  }

  return element;
}

function getSashElement(container: HTMLElement, index: number): HTMLElement {
  const sashes = container.querySelectorAll('.canopy-sash');
  const sash = sashes.item(index);

  if (!(sash instanceof HTMLElement)) {
    throw new Error(`Expected to find sash element at index ${index}`);
  }

  return sash;
}

/**
 * Simulates a full drag of the given sash along the split axis of a vertical
 * split view (pageY).
 */
function dragSashVertically(
  sashElement: HTMLElement,
  delta: number,
  options: { end?: boolean } = {},
): void {
  const start = 100;
  sashElement.dispatchEvent(
    createPointerEvent('pointerdown', { pageX: 0, pageY: start }),
  );
  window.dispatchEvent(
    createPointerEvent('pointermove', { pageX: 0, pageY: start + delta }),
  );

  if (options.end ?? true) {
    window.dispatchEvent(
      createPointerEvent('pointerup', { pageX: 0, pageY: start + delta }),
    );
  }
}

function getSizes(splitView: SplitView, count: number): number[] {
  const sizes: number[] = [];

  for (let i = 0; i < count; i++) {
    sizes.push(splitView.getViewSize(i));
  }

  return sizes;
}

describe('SplitView', () => {
  let container: HTMLElement;
  const disposables: { dispose(): void }[] = [];

  function track<T extends { dispose(): void }>(disposable: T): T {
    disposables.push(disposable);
    return disposable;
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
    it('creates the container structure', () => {
      const splitView = track(new SplitView(container));

      expect(splitView.el.classList.contains('canopy-split-view')).toBe(true);
      expect(splitView.el.classList.contains('vertical')).toBe(true);
      expect(splitView.el.querySelector('.sash-container')).not.toBeNull();
      expect(
        splitView.el.querySelector('.split-view-container'),
      ).not.toBeNull();
    });

    it('marks horizontal split views with the horizontal class', () => {
      const splitView = track(
        new SplitView(container, { orientation: Orientation.HORIZONTAL }),
      );

      expect(splitView.el.classList.contains('horizontal')).toBe(true);
    });

    it('initializes from a descriptor, including hidden views', () => {
      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      const splitView = track(
        new SplitView(container, {
          descriptor: {
            size: 200,
            views: [
              { size: 120, view: v0 },
              { size: 80, view: v1, visible: false },
            ],
          },
        }),
      );

      expect(splitView.getViewSize(0)).toBe(120);
      expect(splitView.getViewSize(1)).toBe(0);
      expect(splitView.isViewVisible(0)).toBe(true);
      expect(splitView.isViewVisible(1)).toBe(false);
      expect(splitView.getViewCachedVisibleSize(1)).toBe(80);
    });
  });

  describe('addView and removeView', () => {
    it('adds views with fixed sizes and creates sashes between them', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      expect(splitView.length).toBe(1);
      expect(splitView.sashes).toHaveLength(0);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      expect(splitView.length).toBe(2);
      expect(splitView.sashes).toHaveLength(1);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(1);

      expect(getSizes(splitView, 2)).toEqual([100, 100]);
    });

    it('distributes sizes evenly with Sizing.Distribute and sums exactly to the container size', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(100);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );
      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );
      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );

      const sizes = getSizes(splitView, 3);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(100);

      for (const size of sizes) {
        expect(size === 33 || size === 34).toBe(true);
      }
    });

    it('removes a view with Sizing.Distribute and redistributes the space', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      const views = [
        new TestView(0, Number.POSITIVE_INFINITY),
        new TestView(0, Number.POSITIVE_INFINITY),
        new TestView(0, Number.POSITIVE_INFINITY),
      ];

      for (const view of views) {
        splitView.addView(view, Sizing.Distribute);
      }

      expect(getSizes(splitView, 3)).toEqual([100, 100, 100]);

      const removed = splitView.removeView(1, Sizing.Distribute);
      expect(removed).toBe(views[1]);
      expect(splitView.length).toBe(2);
      expect(splitView.sashes).toHaveLength(1);
      expect(getSizes(splitView, 2)).toEqual([150, 150]);
    });

    it('adds a view with Sizing.Split, halving the reference view', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );
      expect(splitView.getViewSize(0)).toBe(300);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Split(0),
      );
      expect(getSizes(splitView, 2)).toEqual([150, 150]);
    });

    it('resolves Sizing.Auto to distribute when views are evenly distributed', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );
      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Distribute,
      );
      expect(getSizes(splitView, 2)).toEqual([150, 150]);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Auto(0),
      );
      expect(getSizes(splitView, 3)).toEqual([100, 100, 100]);
    });

    it('resolves Sizing.Auto to split when views are not evenly distributed', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 200);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      expect(getSizes(splitView, 2)).toEqual([200, 100]);

      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Auto(1),
      );
      expect(getSizes(splitView, 3)).toEqual([200, 50, 50]);
    });

    it('adds an invisible view with Sizing.Invisible and restores its cached size on show', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 200);
      splitView.addView(
        new TestView(0, Number.POSITIVE_INFINITY),
        Sizing.Invisible(80),
      );

      expect(splitView.isViewVisible(1)).toBe(false);
      expect(splitView.getViewSize(1)).toBe(0);
      expect(splitView.getViewCachedVisibleSize(1)).toBe(80);
      expect(getSizes(splitView, 2)).toEqual([200, 0]);

      splitView.setViewVisible(1, true);
      expect(splitView.isViewVisible(1)).toBe(true);
      expect(getSizes(splitView, 2)).toEqual([120, 80]);
    });

    it('throws when removing a view out of bounds', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(100);

      expect(() => splitView.removeView(0)).toThrow('Index out of bounds');
    });
  });

  describe('layout', () => {
    it('relayouts proportionally when the container is resized', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      splitView.layout(400);
      expect(getSizes(splitView, 2)).toEqual([200, 200]);
      expect(splitView.contentSize).toBe(400);
    });

    it('enforces min/max constraints across siblings on resize', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, 120);
      splitView.addView(v0, 100);
      splitView.addView(v1, 100);

      splitView.layout(400);

      // v1 is clamped at 120; v0 absorbs the leftover space.
      expect(getSizes(splitView, 2)).toEqual([280, 120]);
      expect(splitView.contentSize).toBe(400);
    });

    it('respects view minimum sizes when shrinking', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(120);

      splitView.addView(new TestView(50, Number.POSITIVE_INFINITY), 40);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 40);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 40);

      splitView.layout(120);
      const sizes = getSizes(splitView, 3);
      expect(sizes[0]).toBeGreaterThanOrEqual(50);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(120);
    });

    it('passes size and offset to view layout calls', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 100);
      splitView.addView(v1, 100);

      expect(v0.size).toBe(100);
      expect(v0.offset).toBe(0);
      expect(v1.size).toBe(100);
      expect(v1.offset).toBe(100);
    });

    it('grows high-priority views first under non-proportional layout', () => {
      const splitView = track(
        new SplitView(container, { proportionalLayout: false }),
      );
      splitView.layout(200);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY, {
        priority: LayoutPriority.High,
      });
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 100);
      splitView.addView(v1, 100);

      splitView.layout(300);
      expect(getSizes(splitView, 2)).toEqual([200, 100]);
    });

    it('grows the last view first under non-proportional layout without priorities', () => {
      const splitView = track(
        new SplitView(container, { proportionalLayout: false }),
      );
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      splitView.layout(300);
      expect(getSizes(splitView, 2)).toEqual([100, 200]);
    });
  });

  describe('resizeView', () => {
    it('resizes a view and keeps the total size constant', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      splitView.resizeView(1, 150);

      const sizes = getSizes(splitView, 3);
      expect(sizes[1]).toBe(150);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(300);
    });

    it('clamps resizeView to the view maximum size', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(new TestView(0, 150), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 200);

      splitView.resizeView(0, 500);

      const sizes = getSizes(splitView, 2);
      expect(sizes[0]).toBe(150);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(300);
    });
  });

  describe('distributeViewSizes', () => {
    it('distributes sizes with exact rounding so the sum equals the container size', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(100);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 50);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 30);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 20);

      splitView.distributeViewSizes();

      const sizes = getSizes(splitView, 3);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(100);
      expect(sizes).toEqual([33, 33, 34]);
    });

    it('skips inflexible views when distributing', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      splitView.addView(new TestView(100, 100), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 150);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 50);

      splitView.distributeViewSizes();

      const sizes = getSizes(splitView, 3);
      expect(sizes[0]).toBe(100);
      expect(sizes[1]).toBe(100);
      expect(sizes[2]).toBe(100);
    });
  });

  describe('sash dragging', () => {
    it('resizes adjacent views on drag and fires onDidSashChange on drag end', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      const sashChanges: number[] = [];
      splitView.onDidSashChange((i) => sashChanges.push(i));

      dragSashVertically(getSashElement(container, 0), 30);

      expect(getSizes(splitView, 2)).toEqual([130, 70]);
      expect(sashChanges).toEqual([0]);
    });

    it('clamps drags to sibling minimum sizes', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(50, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(30, Number.POSITIVE_INFINITY), 100);

      dragSashVertically(getSashElement(container, 0), -80);
      expect(getSizes(splitView, 2)).toEqual([50, 150]);

      dragSashVertically(getSashElement(container, 0), 200);
      expect(getSizes(splitView, 2)).toEqual([170, 30]);
    });

    it('updates view container styles imperatively during layout', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      const viewContainer = queryHtmlElement(
        container,
        '.split-view-container',
      );
      const wrappers = viewContainer.querySelectorAll('.split-view-view');

      dragSashVertically(getSashElement(container, 0), 30);

      const first = wrappers.item(0);
      const second = wrappers.item(1);

      if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
        throw new Error('Expected split view wrappers');
      }

      expect(first.style.top).toBe('0px');
      expect(first.style.height).toBe('130px');
      expect(second.style.top).toBe('130px');
      expect(second.style.height).toBe('70px');
    });

    it('marks the sash disabled between two fixed-size views', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(100, 100), 100);
      splitView.addView(new TestView(100, 100), 100);

      const sashEl = getSashElement(container, 0);
      expect(sashEl.classList.contains('disabled')).toBe(true);
      expect(splitView.sashes[0].state).toBe(SashState.Disabled);
    });
  });

  describe('snapping', () => {
    it('does not shrink a snap view below its minimum before the snap threshold', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(
        new TestView(100, Number.POSITIVE_INFINITY, { snap: true }),
        100,
      );
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      dragSashVertically(getSashElement(container, 0), -30);
      expect(getSizes(splitView, 2)).toEqual([100, 100]);
      expect(splitView.isViewVisible(0)).toBe(true);
    });

    it('snaps a view hidden when dragged past half its minimum size', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(100, Number.POSITIVE_INFINITY, { snap: true });
      splitView.addView(v0, 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      dragSashVertically(getSashElement(container, 0), -60);

      expect(splitView.isViewVisible(0)).toBe(false);
      expect(v0.visible).toBe(false);
      expect(getSizes(splitView, 2)).toEqual([0, 200]);
    });

    it('snaps a hidden view back open when dragged past the threshold', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(100, Number.POSITIVE_INFINITY, { snap: true });
      splitView.addView(v0, 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      dragSashVertically(getSashElement(container, 0), -60);
      expect(splitView.isViewVisible(0)).toBe(false);

      dragSashVertically(getSashElement(container, 0), 60);
      expect(splitView.isViewVisible(0)).toBe(true);
      expect(v0.visible).toBe(true);
      expect(getSizes(splitView, 2)).toEqual([100, 100]);
    });
  });

  describe('view visibility', () => {
    it('hides and shows views, redistributing space', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 100);
      splitView.addView(v1, 100);

      splitView.setViewVisible(0, false);
      expect(splitView.isViewVisible(0)).toBe(false);
      expect(v0.visible).toBe(false);
      expect(splitView.getViewCachedVisibleSize(0)).toBe(100);
      expect(getSizes(splitView, 2)).toEqual([0, 200]);

      splitView.setViewVisible(0, true);
      expect(splitView.isViewVisible(0)).toBe(true);
      expect(v0.visible).toBe(true);
      expect(getSizes(splitView, 2)).toEqual([100, 100]);
    });

    it('toggles the visible class on view wrappers', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 200);

      const wrapper = queryHtmlElement(container, '.split-view-view');
      expect(wrapper.classList.contains('split-view-view-visible')).toBe(true);

      splitView.setViewVisible(0, false);
      expect(wrapper.classList.contains('split-view-view-visible')).toBe(false);
    });
  });

  describe('view change events', () => {
    it('relayouts when a view fires onDidChange after a constraint change', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(200);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 100);
      splitView.addView(v1, 100);

      v0.minimumSize = 150;

      const sizes = getSizes(splitView, 2);
      expect(sizes[0]).toBeGreaterThanOrEqual(150);
      expect(sizes.reduce((r, s) => r + s, 0)).toBe(200);
    });
  });

  describe('moveView and swapViews', () => {
    it('moves a view preserving its size', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 150);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 50);

      // Sequential adds reflow earlier views (upstream behavior).
      expect(getSizes(splitView, 3)).toEqual([200, 50, 50]);

      splitView.moveView(0, 2);

      // The moved view carries its 200px size to the new position.
      expect(getSizes(splitView, 3)).toEqual([50, 50, 200]);
      expect(v0.size).toBe(200);
      expect(v0.offset).toBe(100);
    });

    it('swaps two views, exchanging positions while slot sizes stay put', () => {
      const splitView = track(new SplitView(container));
      splitView.layout(300);

      const v0 = new TestView(0, Number.POSITIVE_INFINITY);
      const v1 = new TestView(0, Number.POSITIVE_INFINITY);
      splitView.addView(v0, 200);
      splitView.addView(v1, 100);

      splitView.swapViews(0, 1);

      // Slot sizes are preserved; the views trade places.
      expect(getSizes(splitView, 2)).toEqual([200, 100]);
      expect(v1.size).toBe(200);
      expect(v1.offset).toBe(0);
      expect(v0.size).toBe(100);
      expect(v0.offset).toBe(200);
    });
  });

  describe('dispose', () => {
    it('removes view wrappers and sash elements', () => {
      const splitView = new SplitView(container);
      splitView.layout(200);

      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);
      splitView.addView(new TestView(0, Number.POSITIVE_INFINITY), 100);

      expect(container.querySelectorAll('.split-view-view')).toHaveLength(2);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(1);

      splitView.dispose();

      expect(container.querySelectorAll('.split-view-view')).toHaveLength(0);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(0);
    });
  });
});
