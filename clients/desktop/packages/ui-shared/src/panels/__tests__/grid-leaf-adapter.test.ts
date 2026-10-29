/** @jest-environment jsdom */

import type { IDisposable } from '../disposable';
import {
  createPanelLeafElement,
  DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT,
  DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
  isPanelLeafViewJson,
  PanelLeafView,
  type PanelLeafLayoutBox,
} from '../grid-leaf-adapter';
import {
  Direction,
  Grid,
  type GridNode,
  isGridBranchNode,
  type ISerializedGrid,
  type IViewDeserializer,
  SerializableGrid,
  Sizing,
} from '../grid';

type IdTree = string | IdTree[];

function nodesToIds(node: GridNode<PanelLeafView>): IdTree {
  if (isGridBranchNode(node)) {
    return node.children.map((child) => nodesToIds(child));
  }

  return node.view.id;
}

function isSerializedGridShape(value: unknown): value is ISerializedGrid {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    'orientation' in value &&
    'width' in value &&
    'height' in value
  );
}

/** Runs a serialized grid through a real JSON round trip. */
function jsonRoundTrip(value: unknown): ISerializedGrid {
  const parsed: unknown = JSON.parse(JSON.stringify(value));

  if (!isSerializedGridShape(parsed)) {
    throw new Error('JSON round trip did not produce a serialized grid shape');
  }

  return parsed;
}

class PanelLeafViewDeserializer implements IViewDeserializer<PanelLeafView> {
  readonly views = new Map<string, PanelLeafView>();

  fromJSON(json: unknown): PanelLeafView {
    if (!isPanelLeafViewJson(json)) {
      throw new Error('Invalid serialized panel leaf');
    }

    const view = new PanelLeafView({
      id: json.id,
      element: createPanelLeafElement(document),
    });
    this.views.set(json.id, view);
    return view;
  }

  dispose(): void {
    this.views.forEach((view) => view.dispose());
  }
}

describe('PanelLeafView', () => {
  let container: HTMLElement;
  const disposables: IDisposable[] = [];

  function createLeaf(
    id: string,
    constraints: {
      minimumWidth?: number;
      maximumWidth?: number;
      minimumHeight?: number;
      maximumHeight?: number;
    } = {},
  ): PanelLeafView {
    const view = new PanelLeafView({
      id,
      element: createPanelLeafElement(document),
      ...constraints,
    });
    disposables.push(view);
    return view;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    while (disposables.length > 0) {
      const disposable = disposables.pop();
      disposable?.dispose();
    }

    container.remove();
  });

  test('defaults min/max constraints when options omit them', () => {
    const leaf = createLeaf('a');

    expect(leaf.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(leaf.maximumWidth).toBe(Number.POSITIVE_INFINITY);
    expect(leaf.minimumHeight).toBe(DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT);
    expect(leaf.maximumHeight).toBe(Number.POSITIVE_INFINITY);
    // 320px keeps an activity card header (24+24 padding, 16px icon, 12+8
    // gaps, 28px action button ≈ 112px min-content) fully visible with the
    // leaf's `overflow: hidden`; the previous 100px floor clipped the CTA.
    expect(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH).toBe(320);
    expect(DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT).toBe(70);
  });

  test('a real Grid lays out PanelLeafViews and onDidLayout reports boxes', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    const c = createLeaf('c');

    const aBoxes: PanelLeafLayoutBox[] = [];
    a.onDidLayout((box) => {
      aBoxes.push(box);
    });

    const grid = new Grid<PanelLeafView>(a);
    disposables.push(grid);
    container.appendChild(grid.element);
    grid.layout(800, 600);

    expect(aBoxes.length).toBeGreaterThan(0);
    expect(a.lastLayout).toEqual({ width: 800, height: 600, top: 0, left: 0 });

    grid.addView(b, Sizing.Distribute, a, Direction.Right);
    grid.addView(c, Sizing.Distribute, a, Direction.Down);

    // Left column split vertically (a over c), b fills the right column.
    expect(a.lastLayout).toEqual({ width: 400, height: 300, top: 0, left: 0 });
    expect(c.lastLayout).toEqual({
      width: 400,
      height: 300,
      top: 300,
      left: 0,
    });
    expect(b.lastLayout).toEqual({
      width: 400,
      height: 600,
      top: 0,
      left: 400,
    });

    // The grid adopted each caller-created element into its own DOM.
    for (const leaf of [a, b, c]) {
      expect(grid.hasView(leaf)).toBe(true);
      expect(grid.element.contains(leaf.element)).toBe(true);
    }

    // layout() writes nothing to the element; the engine sizes its wrapper.
    expect(a.element.style.width).toBe('100%');
    expect(a.element.style.height).toBe('100%');
  });

  test('setConstraints fires onDidChange and the grid respects new minimums', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');

    const grid = new Grid<PanelLeafView>(a);
    disposables.push(grid);
    container.appendChild(grid.element);
    grid.layout(800, 600);
    grid.addView(b, Sizing.Distribute, a, Direction.Right);

    // Squeeze `a` down toward its default minimum.
    grid.resizeView(b, { width: 700, height: 600 });
    expect(a.lastLayout?.width).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);

    let changeCount = 0;
    a.onDidChange(() => {
      changeCount++;
    });

    a.setConstraints({ minimumWidth: 300 });
    expect(changeCount).toBe(1);
    expect(a.minimumWidth).toBe(300);

    grid.layout(800, 600);
    expect(a.lastLayout?.width).toBeGreaterThanOrEqual(300);
    expect((a.lastLayout?.width ?? 0) + (b.lastLayout?.width ?? 0)).toBe(800);

    // Unchanged constraints are a no-op and must not fire.
    a.setConstraints({ minimumWidth: 300 });
    expect(changeCount).toBe(1);

    // Omitted fields keep their current values.
    a.setConstraints({ maximumHeight: 500 });
    expect(changeCount).toBe(2);
    expect(a.minimumWidth).toBe(300);
    expect(a.maximumHeight).toBe(500);
  });

  test('SerializableGrid round-trips PanelLeafViews by id', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    const c = createLeaf('c');

    const grid = new SerializableGrid<PanelLeafView>(a);
    disposables.push(grid);
    container.appendChild(grid.element);
    grid.layout(800, 600);
    grid.addView(b, Sizing.Distribute, a, Direction.Right);
    grid.addView(c, Sizing.Distribute, b, Direction.Down);

    const originalIds = nodesToIds(grid.getViews());
    const serialized = jsonRoundTrip(grid.serialize());

    const deserializer = new PanelLeafViewDeserializer();
    disposables.push(deserializer);
    const restored = SerializableGrid.deserialize(serialized, deserializer);
    disposables.push(restored);
    const restoredContainer = document.createElement('div');
    document.body.appendChild(restoredContainer);
    restoredContainer.appendChild(restored.element);
    restored.layout(800, 600);

    // Every leaf was recreated by id and the tree shape survived.
    expect([...deserializer.views.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(nodesToIds(restored.getViews())).toEqual(originalIds);

    // Restored views are live grid citizens: laid out and re-serializable.
    deserializer.views.forEach((view) => {
      expect(view.lastLayout).toBeDefined();
      expect(restored.hasView(view)).toBe(true);
    });

    expect(jsonRoundTrip(restored.serialize())).toEqual(serialized);
    restoredContainer.remove();
  });

  test('same-parent swaps preserve reordered expanded sizes', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    const c = createLeaf('c');

    const grid = new SerializableGrid<PanelLeafView>(a);
    disposables.push(grid);
    container.appendChild(grid.element);
    grid.layout(900, 600);
    grid.addView(b, 300, a, Direction.Right);
    grid.addView(c, 200, b, Direction.Right);
    grid.resizeView(a, { width: 400 }, true);

    grid.setCollapsedViews(new Set([a]), 48, true);
    const before = grid.serialize();
    expect(before.root.type).toBe('branch');
    if (before.root.type !== 'branch') {
      throw new Error('Expected a branch root');
    }
    expect(before.root.expandedSizes).toHaveLength(3);

    grid.swapViews(a, c);

    const after = grid.serialize();
    expect(after.root.type).toBe('branch');
    if (after.root.type !== 'branch') {
      throw new Error('Expected a branch root');
    }
    expect(after.root.expandedSizes).toEqual([
      before.root.expandedSizes?.[2],
      before.root.expandedSizes?.[1],
      before.root.expandedSizes?.[0],
    ]);
  });

  test('toJSON serializes identity only and isPanelLeafViewJson validates it', () => {
    const leaf = createLeaf('leaf-1');

    expect(leaf.toJSON()).toEqual({ id: 'leaf-1' });
    expect(isPanelLeafViewJson(leaf.toJSON())).toBe(true);
    expect(isPanelLeafViewJson({ id: '' })).toBe(false);
    expect(isPanelLeafViewJson({ id: 42 })).toBe(false);
    expect(isPanelLeafViewJson(null)).toBe(false);
    expect(isPanelLeafViewJson('leaf-1')).toBe(false);
  });

  test('setVisible tracks grid visibility and fires onDidVisibilityChange', () => {
    const leaf = createLeaf('a');
    const seen: boolean[] = [];
    leaf.onDidVisibilityChange((visible) => {
      seen.push(visible);
    });

    expect(leaf.visible).toBe(true);
    leaf.setVisible(true); // no-op
    leaf.setVisible(false);
    leaf.setVisible(false); // no-op
    leaf.setVisible(true);

    expect(seen).toEqual([false, true]);
    expect(leaf.visible).toBe(true);
  });

  test('dispose silences all emitters', () => {
    const leaf = new PanelLeafView({
      id: 'a',
      element: createPanelLeafElement(document),
    });

    let layoutCount = 0;
    let changeCount = 0;
    leaf.onDidLayout(() => {
      layoutCount++;
    });
    leaf.onDidChange(() => {
      changeCount++;
    });

    leaf.dispose();
    leaf.layout(100, 100, 0, 0);
    leaf.setConstraints({ minimumWidth: 300 });

    expect(layoutCount).toBe(0);
    expect(changeCount).toBe(0);
  });
});

describe('createPanelLeafElement', () => {
  test('creates the container in the passed document (opener-realm seam)', () => {
    const otherDocument = document.implementation.createHTMLDocument('child');
    const element = createPanelLeafElement(otherDocument);

    expect(element.ownerDocument).toBe(otherDocument);
    expect(element.ownerDocument).not.toBe(document);
    expect(element.classList.contains('canopy-panel-leaf')).toBe(true);
  });

  test('applies fill/overflow styles for grid wrapper adoption', () => {
    const element = createPanelLeafElement(document);

    expect(element.ownerDocument).toBe(document);
    expect(element.style.position).toBe('relative');
    expect(element.style.width).toBe('100%');
    expect(element.style.height).toBe('100%');
    expect(element.style.overflow).toBe('hidden');
  });
});
