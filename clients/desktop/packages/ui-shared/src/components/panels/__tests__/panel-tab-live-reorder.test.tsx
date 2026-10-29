/**
 * @jest-environment jsdom
 */
// Fill tabs reorder live: the dragged tab follows the pointer along its row
// while the others slide aside. The classic strip keeps its insertion marker
// (panel-dnd.test.tsx).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { clearPanelTabDrag } from '../panel-dnd';
import { computeLiveTabReorder, type TabSlot } from '../panel-tab-live-reorder';
import { PanelTabLiveReorderContext } from '../panel-tab-live-reorder-context';
import { PanelTabBar } from '../PanelTabBar';
import { usePanelTabLiveReorder } from '../use-panel-tab-live-reorder';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// Draw in the same act() as the event that moved the pointer.
beforeAll(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 0;
  };
  window.cancelAnimationFrame = (): void => {};
});

/** Four 100px tabs, 4px apart, starting at 4px. */
const SLOTS: readonly TabSlot[] = [
  { left: 4, width: 100 },
  { left: 108, width: 100 },
  { left: 212, width: 100 },
  { left: 316, width: 100 },
];

describe('computeLiveTabReorder', () => {
  it('leaves the row alone until the tab is nearer the next place', () => {
    // 50px right of its place at 4; the next place (108) is 54px away.
    const layout = computeLiveTabReorder(SLOTS, 0, 54);
    expect(layout).toEqual({
      targetIndex: 0,
      draggedLeft: 54,
      shifts: [0, 0, 0, 0],
    });
  });

  it('slides each passed neighbour one tab-width the other way', () => {
    // Nearest the third place (212): the second and third tabs make way.
    const right = computeLiveTabReorder(SLOTS, 0, 220);
    expect(right.targetIndex).toBe(2);
    expect(right.shifts).toEqual([0, -104, -104, 0]);
    // The last tab dragged to the front pushes the others right.
    const left = computeLiveTabReorder(SLOTS, 3, 4);
    expect(left.targetIndex).toBe(0);
    expect(left.shifts).toEqual([104, 104, 104, 0]);
  });

  it('swaps halfway between two places, the same in both directions', () => {
    expect(computeLiveTabReorder(SLOTS, 0, 57).targetIndex).toBe(1);
    expect(computeLiveTabReorder(SLOTS, 0, 55).targetIndex).toBe(0);
    // Dragging the second tab left crosses the same line.
    expect(computeLiveTabReorder(SLOTS, 1, 57).targetIndex).toBe(1);
    expect(computeLiveTabReorder(SLOTS, 1, 55).targetIndex).toBe(0);
  });

  it('keeps the dragged tab inside its strip', () => {
    expect(computeLiveTabReorder(SLOTS, 1, -500).draggedLeft).toBe(4);
    const end = computeLiveTabReorder(SLOTS, 1, 5000);
    expect(end.draggedLeft).toBe(316);
    expect(end.targetIndex).toBe(3);
  });

  it('opens a slot as wide as the dragged tab among narrower ones', () => {
    // A 96px selected tab among 20px tiles.
    const slots: TabSlot[] = [
      { left: 0, width: 20 },
      { left: 24, width: 96 },
      { left: 124, width: 20 },
      { left: 148, width: 20 },
    ];
    const layout = computeLiveTabReorder(slots, 1, 60);
    expect(layout.targetIndex).toBe(2);
    // The passed tile moves back by the dragged tab's width plus the gap.
    expect(layout.shifts).toEqual([0, 0, -100, 0]);
  });
});

function tab(panelId: string, pinned = false): PanelTabModel {
  return { panelId, kind: 'chat', title: `Chat ${panelId}`, pinned };
}

function fireDrag(
  target: EventTarget,
  type: string,
  init: { clientX?: number; clientY?: number } = {},
): Event {
  // jsdom has no DragEvent; the wiring only reads the pointer position.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('PanelTabBar live reorder', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    clearPanelTabDrag();
  });

  const tabElement = (panelId: string): HTMLElement => {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="panel-tab-${panelId}"]`,
    );
    if (element === null) throw new Error(`No tab ${panelId}`);
    return element;
  };

  // The host offers the live reorder; `offered: false` is a host without it.
  function render(
    tabs: readonly PanelTabModel[],
    overrides: Partial<Parameters<typeof PanelTabBar>[0]> = {},
    offered = true,
  ): void {
    const tabBar = (
      <PanelTabBar
        tabStyle="fill"
        groupId="group-1"
        tabs={[...tabs]}
        activePanelId={tabs[0]?.panelId ?? null}
        onSelectTab={jest.fn()}
        onCloseTab={jest.fn()}
        {...overrides}
      />
    );
    act(() => {
      root.render(
        offered ? (
          <PanelTabLiveReorderContext.Provider value={usePanelTabLiveReorder}>
            {tabBar}
          </PanelTabLiveReorderContext.Provider>
        ) : (
          tabBar
        ),
      );
    });
    // A 40px title row; 100px tabs, 4px apart, wherever each sits in the row
    // at the moment it is measured (so a re-render's new order is seen by
    // code that measures during that render).
    const bar = container.querySelector<HTMLElement>('.canopy-panel-tab-bar');
    if (bar === null) throw new Error('No tab bar');
    bar.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 500, 40);
    for (const model of tabs) {
      const element = tabElement(model.panelId);
      element.getBoundingClientRect = (): DOMRect => {
        const index = Array.from(bar.querySelectorAll('[role="tab"]')).indexOf(
          element,
        );
        return new DOMRect(4 + index * 104, 6, 100, 28);
      };
    }
  }

  it('leaves the drag to the insertion marker on a host without it', () => {
    render([tab('a'), tab('b'), tab('c')], { onReorderTab: jest.fn() }, false);
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    const over = fireDrag(document.body, 'dragover', {
      clientX: 164,
      clientY: 20,
    });
    expect(over.defaultPrevented).toBe(false);
    expect(tabElement('a').hasAttribute('data-live-drag')).toBe(false);
    expect(tabElement('a').style.transform).toBe('');
    expect(tabElement('b').style.transform).toBe('');
    fireDrag(tabElement('a'), 'dragend');
  });

  it('moves the dragged tab with the pointer and slides the passed tab aside', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c'), tab('d')], { onReorderTab });
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    // Nothing moves until the pointer does.
    expect(tabElement('a').style.transform).toBe('');

    const over = fireDrag(document.body, 'dragover', {
      clientX: 164,
      clientY: 20,
    });
    // The reorder accepts the drop itself, wherever in the row it lands.
    expect(over.defaultPrevented).toBe(true);
    expect(tabElement('a').getAttribute('data-live-drag')).toBe('strip');
    expect(tabElement('a').style.transform).toBe('translateX(110px)');
    expect(tabElement('b').style.transform).toBe('translateX(-104px)');
    expect(tabElement('c').style.transform).toBe('translateX(0px)');
    // No insertion marker: the open slot shows where the tab lands.
    expect(container.querySelector('.canopy-panel-tab-drop-before')).toBeNull();
    expect(container.querySelector('.canopy-panel-tab-drop-after')).toBeNull();

    fireDrag(document.body, 'drop', { clientX: 164, clientY: 20 });
    expect(onReorderTab).toHaveBeenCalledWith('group-1', 'a', 1);

    // The reordered tabs render: every trace of the drag is gone.
    fireDrag(tabElement('a'), 'dragend');
    render([tab('b'), tab('a'), tab('c'), tab('d')], { onReorderTab });
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(tabElement(id).style.transform).toBe('');
      expect(tabElement(id).hasAttribute('data-live-drag')).toBe(false);
      expect(tabElement(id).hasAttribute('data-live-shift')).toBe(false);
    }
  });

  it('selects a tab pressed right after a drag, before the pointer has moved', () => {
    const onReorderTab = jest.fn();
    const onSelectTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], { onReorderTab, onSelectTab });
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    fireDrag(document.body, 'dragover', { clientX: 164, clientY: 20 });
    fireDrag(document.body, 'drop', { clientX: 164, clientY: 20 });
    fireDrag(tabElement('a'), 'dragend');
    render([tab('b'), tab('a'), tab('c')], { onReorderTab, onSelectTab });
    const bar = container.querySelector<HTMLElement>('.canopy-panel-tab-bar');
    if (bar === null) throw new Error('No tab bar');
    // The tabs take no hits until the pointer moves, so a press lands on
    // the row behind them, and so does its click.
    expect(bar.hasAttribute('data-live-hover-stale')).toBe(true);
    const elementFromPoint = jest.fn((): Element => tabElement('a'));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });
    try {
      fireDrag(bar, 'pointerdown', { clientX: 164, clientY: 20 });
      expect(bar.hasAttribute('data-live-hover-stale')).toBe(false);
      fireDrag(bar, 'click', { clientX: 164, clientY: 20 });
      expect(onSelectTab).toHaveBeenCalledWith('group-1', 'a');

      // Only that one press is handed on.
      onSelectTab.mockClear();
      fireDrag(bar, 'click', { clientX: 164, clientY: 20 });
      expect(onSelectTab).not.toHaveBeenCalled();

      // A press on a tab's icon, which is an SVG and not an HTML element.
      const icon = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg',
      );
      tabElement('b').append(icon);
      elementFromPoint.mockImplementation((): Element => icon);
      fireDrag(tabElement('a'), 'dragstart', { clientX: 158, clientY: 20 });
      fireDrag(document.body, 'dragover', { clientX: 170, clientY: 20 });
      fireDrag(tabElement('a'), 'dragend');
      expect(bar.hasAttribute('data-live-hover-stale')).toBe(true);
      fireDrag(bar, 'pointerdown', { clientX: 54, clientY: 20 });
      fireDrag(bar, 'click', { clientX: 54, clientY: 20 });
      expect(onSelectTab).toHaveBeenCalledWith('group-1', 'b');
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('settles from where the tabs were at the drop, not where the reorder left them', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], { onReorderTab });
    const animate = jest.fn((): { addEventListener: () => void } => ({
      addEventListener: (): void => undefined,
    }));
    Reflect.set(tabElement('a'), 'animate', animate);
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    fireDrag(document.body, 'dragover', { clientX: 164, clientY: 20 });
    fireDrag(document.body, 'drop', { clientX: 164, clientY: 20 });
    fireDrag(tabElement('a'), 'dragend');
    // The reorder renders: `a` now sits in the second place (108px), but it
    // was measured at 4px before that, so it starts its settle 104px back.
    // Measured after the render it would read as already in place, and the
    // tab would jump there with its drag offset still applied.
    render([tab('b'), tab('a'), tab('c')], { onReorderTab });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateX(-104px)' }, { transform: 'translateX(0)' }],
      expect.objectContaining({ duration: 200 }),
    );
  });

  it('does not reorder when the tab is dropped back in its own place', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], { onReorderTab });
    fireDrag(tabElement('b'), 'dragstart', { clientX: 158, clientY: 20 });
    fireDrag(document.body, 'dragover', { clientX: 170, clientY: 20 });
    fireDrag(document.body, 'drop', { clientX: 170, clientY: 20 });
    expect(onReorderTab).not.toHaveBeenCalled();
    expect(tabElement('b').style.transform).toBe('');
  });

  it('counts the pinned tabs before an unpinned tab’s new place', () => {
    const onReorderTab = jest.fn();
    render([tab('p', true), tab('a'), tab('b')], { onReorderTab });
    // `b` (third in the row) dragged in front of `a`.
    fireDrag(tabElement('b'), 'dragstart', { clientX: 262, clientY: 20 });
    fireDrag(document.body, 'dragover', { clientX: 120, clientY: 20 });
    // The pinned tab is another strip: it never moves.
    expect(tabElement('p').style.transform).toBe('');
    expect(tabElement('a').style.transform).toBe('translateX(104px)');
    fireDrag(document.body, 'drop', { clientX: 120, clientY: 20 });
    expect(onReorderTab).toHaveBeenCalledWith('group-1', 'b', 1);
  });

  it('hands the drag back when it leaves the title row sideways, at the same height', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], { onReorderTab });
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });

    // A side-by-side group's tab strip sits at the same height, past this
    // row's right edge (the row is 500px wide).
    const beside = fireDrag(document.body, 'dragover', {
      clientX: 700,
      clientY: 20,
    });
    expect(beside.defaultPrevented).toBe(false);
    expect(tabElement('a').getAttribute('data-live-drag')).toBe('detached');

    // The neighbouring strip's own drop target decides; this row does not
    // reorder.
    fireDrag(document.body, 'drop', { clientX: 700, clientY: 20 });
    expect(onReorderTab).not.toHaveBeenCalled();
  });

  it('hands the drag back outside the title row: tabs close up, a chip follows', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], { onReorderTab });
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    fireDrag(document.body, 'dragover', { clientX: 164, clientY: 20 });
    expect(tabElement('b').style.transform).toBe('translateX(-104px)');

    const outside = fireDrag(document.body, 'dragover', {
      clientX: 164,
      clientY: 200,
    });
    // Other drop targets decide what this drag can do now.
    expect(outside.defaultPrevented).toBe(false);
    expect(tabElement('a').getAttribute('data-live-drag')).toBe('detached');
    expect(tabElement('a').style.transform).toBe('translateX(0px)');
    expect(tabElement('b').style.transform).toBe('translateX(0px)');
    const chip = document.querySelector('.canopy-panel-tab-drag-chip');
    expect(chip?.textContent).toBe('Chat a');

    // A drop out there is not a reorder.
    fireDrag(document.body, 'drop', { clientX: 164, clientY: 200 });
    expect(onReorderTab).not.toHaveBeenCalled();
    fireDrag(tabElement('a'), 'dragend');
    expect(document.querySelector('.canopy-panel-tab-drag-chip')).toBeNull();
    expect(tabElement('a').hasAttribute('data-live-drag')).toBe(false);
    expect(tabElement('b').style.transform).toBe('');
  });

  it('leaves classic tabs on the insertion marker', () => {
    const onReorderTab = jest.fn();
    render([tab('a'), tab('b'), tab('c')], {
      onReorderTab,
      tabStyle: 'classic',
    });
    fireDrag(tabElement('a'), 'dragstart', { clientX: 54, clientY: 20 });
    const over = fireDrag(document.body, 'dragover', {
      clientX: 164,
      clientY: 20,
    });
    expect(over.defaultPrevented).toBe(false);
    expect(tabElement('a').style.transform).toBe('');
    expect(tabElement('b').style.transform).toBe('');
    fireDrag(document.body, 'drop', { clientX: 164, clientY: 20 });
    expect(onReorderTab).not.toHaveBeenCalled();
  });
});
