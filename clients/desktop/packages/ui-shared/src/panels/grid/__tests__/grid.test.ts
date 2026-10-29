/** @jest-environment jsdom */

import { Emitter, Event } from '../../emitter';
import {
  createSerializedGrid,
  Direction,
  getRelativeLocation,
  Grid,
  type GridNode,
  type GridNodeDescriptor,
  type ISerializableView,
  type ISerializedGrid,
  isGridBranchNode,
  type IView,
  type IViewDeserializer,
  type IViewSize,
  Orientation,
  sanitizeGridNodeDescriptor,
  SerializableGrid,
  Sizing,
} from '../grid';

class TestView implements IView {
  readonly element = document.createElement('div');

  private readonly _onDidChange = new Emitter<IViewSize | undefined>();
  readonly onDidChange: Event<IViewSize | undefined> = this._onDidChange.event;

  private _minimumWidth: number;
  private _maximumWidth: number;
  private _minimumHeight: number;
  private _maximumHeight: number;

  get minimumWidth(): number {
    return this._minimumWidth;
  }
  set minimumWidth(size: number) {
    this._minimumWidth = size;
    this._onDidChange.fire(undefined);
  }

  get maximumWidth(): number {
    return this._maximumWidth;
  }
  set maximumWidth(size: number) {
    this._maximumWidth = size;
    this._onDidChange.fire(undefined);
  }

  get minimumHeight(): number {
    return this._minimumHeight;
  }
  set minimumHeight(size: number) {
    this._minimumHeight = size;
    this._onDidChange.fire(undefined);
  }

  get maximumHeight(): number {
    return this._maximumHeight;
  }
  set maximumHeight(size: number) {
    this._maximumHeight = size;
    this._onDidChange.fire(undefined);
  }

  width = 0;
  height = 0;
  top = 0;
  left = 0;
  visible = true;
  layoutCallCount = 0;

  get size(): [number, number] {
    return [this.width, this.height];
  }

  constructor(
    minimumWidth: number,
    maximumWidth: number,
    minimumHeight: number,
    maximumHeight: number,
  ) {
    this._minimumWidth = minimumWidth;
    this._maximumWidth = maximumWidth;
    this._minimumHeight = minimumHeight;
    this._maximumHeight = maximumHeight;
  }

  layout(width: number, height: number, top: number, left: number): void {
    this.width = width;
    this.height = height;
    this.top = top;
    this.left = left;
    this.layoutCallCount += 1;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

class TestSerializableView extends TestView implements ISerializableView {
  constructor(
    readonly name: string,
    minimumWidth: number,
    maximumWidth: number,
    minimumHeight: number,
    maximumHeight: number,
  ) {
    super(minimumWidth, maximumWidth, minimumHeight, maximumHeight);
  }

  toJSON(): object {
    return { name: this.name };
  }
}

class TestViewDeserializer implements IViewDeserializer<TestSerializableView> {
  private readonly views = new Map<string, TestSerializableView>();

  fromJSON(json: unknown): TestSerializableView {
    if (
      typeof json !== 'object' ||
      json === null ||
      !('name' in json) ||
      typeof json.name !== 'string'
    ) {
      throw new Error('Invalid serialized view');
    }

    const view = new TestSerializableView(
      json.name,
      50,
      Number.POSITIVE_INFINITY,
      50,
      Number.POSITIVE_INFINITY,
    );
    this.views.set(json.name, view);
    return view;
  }

  getView(id: string): TestSerializableView {
    const view = this.views.get(id);

    if (!view) {
      throw new Error('Unknown view');
    }

    return view;
  }

  dispose(): void {
    this.views.forEach((view) => view.dispose());
  }
}

type ViewTree = IView | ViewTree[];

function nodesToArrays<T extends IView>(node: GridNode<T>): ViewTree {
  if (isGridBranchNode(node)) {
    return node.children.map((child) => nodesToArrays(child));
  }

  return node.view;
}

type NameTree = string | NameTree[];

function nodesToNames(node: GridNode<TestSerializableView>): NameTree {
  if (isGridBranchNode(node)) {
    return node.children.map((child) => nodesToNames(child));
  }

  return node.view.name;
}

const INF = Number.POSITIVE_INFINITY;

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

/**
 * Runs a value through an actual JSON round trip, returning it typed as an
 * {@link ISerializedGrid}. Only the top-level shape is checked, so malformed
 * payloads can be fed to `deserialize` to exercise its validation.
 */
function jsonRoundTrip(value: unknown): ISerializedGrid {
  const parsed: unknown = JSON.parse(JSON.stringify(value));

  if (!isSerializedGridShape(parsed)) {
    throw new Error('JSON round trip did not produce a serialized grid shape');
  }

  return parsed;
}

describe('getRelativeLocation', () => {
  test('direction/orientation table', () => {
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0], Direction.Up),
    ).toEqual([0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0], Direction.Down),
    ).toEqual([1]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0], Direction.Left),
    ).toEqual([0, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0], Direction.Right),
    ).toEqual([0, 1]);

    expect(
      getRelativeLocation(Orientation.HORIZONTAL, [0], Direction.Up),
    ).toEqual([0, 0]);
    expect(
      getRelativeLocation(Orientation.HORIZONTAL, [0], Direction.Down),
    ).toEqual([0, 1]);
    expect(
      getRelativeLocation(Orientation.HORIZONTAL, [0], Direction.Left),
    ).toEqual([0]);
    expect(
      getRelativeLocation(Orientation.HORIZONTAL, [0], Direction.Right),
    ).toEqual([1]);

    expect(
      getRelativeLocation(Orientation.VERTICAL, [4], Direction.Up),
    ).toEqual([4]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [4], Direction.Down),
    ).toEqual([5]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [4], Direction.Left),
    ).toEqual([4, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [4], Direction.Right),
    ).toEqual([4, 1]);

    expect(
      getRelativeLocation(Orientation.VERTICAL, [0, 0], Direction.Up),
    ).toEqual([0, 0, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0, 0], Direction.Down),
    ).toEqual([0, 0, 1]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0, 0], Direction.Left),
    ).toEqual([0, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [0, 0], Direction.Right),
    ).toEqual([0, 1]);

    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2], Direction.Up),
    ).toEqual([1, 2, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2], Direction.Down),
    ).toEqual([1, 2, 1]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2], Direction.Left),
    ).toEqual([1, 2]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2], Direction.Right),
    ).toEqual([1, 3]);

    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2, 3], Direction.Up),
    ).toEqual([1, 2, 3]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2, 3], Direction.Down),
    ).toEqual([1, 2, 4]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2, 3], Direction.Left),
    ).toEqual([1, 2, 3, 0]);
    expect(
      getRelativeLocation(Orientation.VERTICAL, [1, 2, 3], Direction.Right),
    ).toEqual([1, 2, 3, 1]);
  });
});

describe('Grid', () => {
  let container: HTMLElement;
  const disposables: { dispose(): void }[] = [];

  function createView(
    minimumWidth = 50,
    maximumWidth = INF,
    minimumHeight = 50,
    maximumHeight = INF,
  ): TestView {
    const view = new TestView(
      minimumWidth,
      maximumWidth,
      minimumHeight,
      maximumHeight,
    );
    disposables.push(view);
    return view;
  }

  function createGrid(view: TestView): Grid<TestView> {
    const grid = new Grid<TestView>(view);
    container.appendChild(grid.element);
    disposables.push(grid);
    return grid;
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

  test('single view fills the grid', () => {
    const view1 = createView(100, INF, 100, INF);
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(view1.size).toEqual([800, 600]);
    expect(grid.getViewSize(view1)).toEqual({ width: 800, height: 600 });
    expect(grid.getViewSize()).toEqual({ width: 800, height: 600 });
  });

  test('addView in each direction relative to an existing view', () => {
    const directions = [
      {
        direction: Direction.Up,
        expected: { added: [800, 200], initial: [800, 400] },
      },
      {
        direction: Direction.Down,
        expected: { added: [800, 200], initial: [800, 400] },
      },
      {
        direction: Direction.Left,
        expected: { added: [200, 600], initial: [600, 600] },
      },
      {
        direction: Direction.Right,
        expected: { added: [200, 600], initial: [600, 600] },
      },
    ];

    for (const { direction, expected } of directions) {
      const view1 = createView();
      const grid = createGrid(view1);
      grid.layout(800, 600);

      const view2 = createView();
      grid.addView(view2, 200, view1, direction);

      expect(view2.size).toEqual(expected.added);
      expect(view1.size).toEqual(expected.initial);
    }
  });

  test('addView positions views on the correct side', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const above = createView();
    grid.addView(above, 200, view1, Direction.Up);
    expect(above.top).toBe(0);
    expect(view1.top).toBe(200);

    const left = createView();
    grid.addView(left, 200, view1, Direction.Left);
    expect(left.left).toBe(0);
    expect(view1.left).toBe(200);
  });

  test('simple layout (nested splits, 3 levels)', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);
    expect(view1.size).toEqual([800, 600]);

    const view2 = createView();
    grid.addView(view2, 200, view1, Direction.Up);
    expect(view1.size).toEqual([800, 400]);
    expect(view2.size).toEqual([800, 200]);

    const view3 = createView();
    grid.addView(view3, 200, view1, Direction.Right);
    expect(view1.size).toEqual([600, 400]);
    expect(view2.size).toEqual([800, 200]);
    expect(view3.size).toEqual([200, 400]);

    const view4 = createView();
    grid.addView(view4, 200, view2, Direction.Left);
    expect(view1.size).toEqual([600, 400]);
    expect(view2.size).toEqual([600, 200]);
    expect(view3.size).toEqual([200, 400]);
    expect(view4.size).toEqual([200, 200]);

    const view5 = createView();
    grid.addView(view5, 100, view1, Direction.Down);
    expect(view1.size).toEqual([600, 300]);
    expect(view2.size).toEqual([600, 200]);
    expect(view3.size).toEqual([200, 400]);
    expect(view4.size).toEqual([200, 200]);
    expect(view5.size).toEqual([600, 100]);

    expect(nodesToArrays(grid.getViews())).toEqual([
      [view4, view2],
      [[view1, view5], view3],
    ]);
  });

  test('getViewLocation resolves current locations without DOM access by callers', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, 200, view1, Direction.Up);
    const view3 = createView();
    grid.addView(view3, 200, view1, Direction.Right);
    const view4 = createView();
    grid.addView(view4, 200, view2, Direction.Left);
    const view5 = createView();
    grid.addView(view5, 100, view1, Direction.Down);

    expect(grid.getViewLocation(view4)).toEqual([0, 0]);
    expect(grid.getViewLocation(view2)).toEqual([0, 1]);
    expect(grid.getViewLocation(view1)).toEqual([1, 0, 0]);
    expect(grid.getViewLocation(view5)).toEqual([1, 0, 1]);
    expect(grid.getViewLocation(view3)).toEqual([1, 1]);

    const outsider = createView();
    expect(() => grid.getViewLocation(outsider)).toThrow('View not found');
    expect(grid.hasView(view1)).toBe(true);
    expect(grid.hasView(outsider)).toBe(false);
  });

  test('addView with Sizing.Distribute', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Left);
    expect(view1.size).toEqual([400, 600]);
    expect(view2.size).toEqual([400, 600]);

    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view1, Direction.Right);
    expect(view1.size).toEqual([266, 600]);
    expect(view2.size).toEqual([266, 600]);
    expect(view3.size).toEqual([268, 600]);
  });

  test('addView with Sizing.Split', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Split, view1, Direction.Left);
    expect(view1.size).toEqual([400, 600]);
    expect(view2.size).toEqual([400, 600]);

    const view3 = createView();
    grid.addView(view3, Sizing.Split, view1, Direction.Right);
    expect(view1.size).toEqual([200, 600]);
    expect(view2.size).toEqual([400, 600]);
    expect(view3.size).toEqual([200, 600]);
  });

  test('addView throws when adding the same view twice', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(() =>
      grid.addView(view1, Sizing.Distribute, view1, Direction.Right),
    ).toThrow("Can't add same view twice");
  });

  test('removeView throws when removing the last view', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(() => grid.removeView(view1)).toThrow("Can't remove last view");
  });

  test('sizing is correct after branch demotion', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Split, view1, Direction.Right);

    const view3 = createView();
    grid.addView(view3, Sizing.Split, view2, Direction.Down);

    const view4 = createView();
    grid.addView(view4, Sizing.Split, view2, Direction.Right);
    expect(view1.size).toEqual([400, 600]);
    expect(view2.size).toEqual([200, 300]);
    expect(view3.size).toEqual([400, 300]);
    expect(view4.size).toEqual([200, 300]);

    grid.removeView(view3);
    expect(view1.size).toEqual([400, 600]);
    expect(view2.size).toEqual([200, 600]);
    expect(view4.size).toEqual([200, 600]);

    // The demoted branch's children are hoisted into the root, so the tree
    // flattens back into a single horizontal split.
    expect(nodesToArrays(grid.getViews())).toEqual([view1, view2, view4]);
  });

  test('removeView with Sizing.Distribute after branch demotion', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Down);

    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);

    const view4 = createView();
    grid.addView(view4, Sizing.Distribute, view3, Direction.Right);
    expect(view1.size).toEqual([800, 200]);
    expect(view2.size).toEqual([800, 200]);
    expect(view3.size).toEqual([400, 200]);
    expect(view4.size).toEqual([400, 200]);

    grid.removeView(view3, Sizing.Distribute);
    expect(view1.size).toEqual([800, 200]);
    expect(view2.size).toEqual([800, 200]);
    expect(view4.size).toEqual([800, 200]);
  });

  test('moveView within the same parent reorders views', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Down);
    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);

    expect(nodesToArrays(grid.getViews())).toEqual([view1, view2, view3]);

    grid.moveView(view1, Sizing.Distribute, view3, Direction.Down);

    expect(nodesToArrays(grid.getViews())).toEqual([view2, view3, view1]);
    expect(grid.getViewLocation(view1)).toEqual([2]);
  });

  test('moveView across parents keeps the tree valid', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Right);
    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);

    expect(nodesToArrays(grid.getViews())).toEqual([view1, [view2, view3]]);

    grid.moveView(view3, Sizing.Distribute, view1, Direction.Down);

    expect(nodesToArrays(grid.getViews())).toEqual([[view1, view3], view2]);
    expect(grid.getViewLocation(view3)).toEqual([0, 1]);

    // Total layout still fills the grid.
    const sizes = [view1, view2, view3].map((v) => v.size);
    expect(sizes[0][0]).toBeGreaterThan(0);
    expect(sizes[1][0]).toBeGreaterThan(0);
    expect(sizes[2][0]).toBeGreaterThan(0);
  });

  test('swapViews preserves sizes and tree validity', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, 200, view1, Direction.Right);
    const view3 = createView();
    grid.addView(view3, 200, view2, Direction.Down);

    const size1 = view1.size;
    const size3 = view3.size;

    grid.swapViews(view1, view3);

    expect(nodesToArrays(grid.getViews())).toEqual([view3, [view2, view1]]);
    expect(view3.size).toEqual(size1);
    expect(view1.size).toEqual(size3);
    expect(grid.getViewLocation(view1)).toEqual([1, 1]);
    expect(grid.getViewLocation(view3)).toEqual([0]);
  });

  test('swapViews within the same parent', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, 200, view1, Direction.Down);

    grid.swapViews(view1, view2);

    expect(nodesToArrays(grid.getViews())).toEqual([view2, view1]);
    expect(view1.size).toEqual([800, 200]);
    expect(view2.size).toEqual([800, 400]);
  });

  test('resizeView and getViewSize', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, 200, view1, Direction.Down);

    grid.resizeView(view2, { width: 800, height: 300 });
    expect(grid.getViewSize(view2)).toEqual({ width: 800, height: 300 });
    expect(grid.getViewSize(view1)).toEqual({ width: 800, height: 300 });
  });

  test('distributeViewSizes evens out sizes', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, 100, view1, Direction.Down);
    const view3 = createView();
    grid.addView(view3, 100, view2, Direction.Down);

    grid.distributeViewSizes();

    expect(view1.size).toEqual([800, 200]);
    expect(view2.size).toEqual([800, 200]);
    expect(view3.size).toEqual([800, 200]);
  });

  test('maximizeView hides all other views and exit restores sizes in order', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Right);
    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);
    const view4 = createView();
    grid.addView(view4, Sizing.Distribute, view2, Direction.Right);

    const size1 = view1.size;
    const size2 = view2.size;
    const size3 = view3.size;
    const size4 = view4.size;

    const maximizedChanges: boolean[] = [];
    grid.onDidChangeViewMaximized((maximized) =>
      maximizedChanges.push(maximized),
    );

    grid.maximizeView(view1);

    expect(grid.hasMaximizedView()).toBe(true);
    expect(grid.isViewMaximized(view1)).toBe(true);
    expect(grid.isViewMaximized(view2)).toBe(false);
    expect(view1.size).toEqual([800, 600]);
    expect(view2.size).toEqual([0, 0]);
    expect(view3.size).toEqual([0, 0]);
    expect(view4.size).toEqual([0, 0]);
    expect(grid.isViewVisible(view1)).toBe(true);
    expect(grid.isViewVisible(view2)).toBe(false);
    expect(grid.isViewVisible(view3)).toBe(false);
    expect(grid.isViewVisible(view4)).toBe(false);

    grid.exitMaximizedView();

    expect(grid.hasMaximizedView()).toBe(false);
    expect(grid.isViewMaximized(view1)).toBe(false);
    expect(view1.size).toEqual(size1);
    expect(view2.size).toEqual(size2);
    expect(view3.size).toEqual(size3);
    expect(view4.size).toEqual(size4);
    expect(maximizedChanges).toEqual([true, false]);
  });

  test('maximizeView throws for a lone view', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(() => grid.maximizeView(view1)).toThrow(
      'At least two views are required to maximize a view',
    );
  });

  test('grid mutations unmaximize the maximized view', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Right);
    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);

    const view4 = createView();

    // Adding a view unmaximizes the view
    grid.maximizeView(view1);
    expect(grid.hasMaximizedView()).toBe(true);
    grid.addView(view4, Sizing.Distribute, view2, Direction.Right);
    expect(grid.hasMaximizedView()).toBe(false);
    expect(grid.isViewVisible(view1)).toBe(true);
    expect(grid.isViewVisible(view2)).toBe(true);
    expect(grid.isViewVisible(view3)).toBe(true);
    expect(grid.isViewVisible(view4)).toBe(true);

    // Removing a view unmaximizes the view
    grid.maximizeView(view1);
    expect(grid.hasMaximizedView()).toBe(true);
    grid.removeView(view4);
    expect(grid.hasMaximizedView()).toBe(false);

    // Maximizing another view switches the maximized view
    grid.maximizeView(view1);
    grid.maximizeView(view2);
    expect(grid.hasMaximizedView()).toBe(true);
    expect(grid.isViewMaximized(view1)).toBe(false);
    expect(grid.isViewMaximized(view2)).toBe(true);

    // Distributing sizes unmaximizes the view
    grid.distributeViewSizes();
    expect(grid.hasMaximizedView()).toBe(false);

    // No view can be expanded while a view is maximized
    grid.maximizeView(view1);
    expect(grid.isViewExpanded(view1)).toBe(false);
    grid.exitMaximizedView();
  });

  test('getNeighborViews on a single view layout', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(grid.getNeighborViews(view1, Direction.Up)).toEqual([]);
    expect(grid.getNeighborViews(view1, Direction.Right)).toEqual([]);
    expect(grid.getNeighborViews(view1, Direction.Down)).toEqual([]);
    expect(grid.getNeighborViews(view1, Direction.Left)).toEqual([]);

    expect(grid.getNeighborViews(view1, Direction.Up, true)).toEqual([view1]);
    expect(grid.getNeighborViews(view1, Direction.Right, true)).toEqual([
      view1,
    ]);
    expect(grid.getNeighborViews(view1, Direction.Down, true)).toEqual([view1]);
    expect(grid.getNeighborViews(view1, Direction.Left, true)).toEqual([view1]);
  });

  test('getNeighborViews throws before first layout', () => {
    const view1 = createView();
    const grid = new Grid<TestView>(view1);
    disposables.push(grid);

    expect(() => grid.getNeighborViews(view1, Direction.Up)).toThrow(
      "Can't call getNeighborViews before first layout",
    );
  });

  test('getNeighborViews on a complex layout', () => {
    const view1 = createView();
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createView();
    grid.addView(view2, Sizing.Distribute, view1, Direction.Down);
    const view3 = createView();
    grid.addView(view3, Sizing.Distribute, view2, Direction.Down);
    const view4 = createView();
    grid.addView(view4, Sizing.Distribute, view2, Direction.Right);
    const view5 = createView();
    grid.addView(view5, Sizing.Distribute, view4, Direction.Down);

    expect(grid.getNeighborViews(view1, Direction.Up)).toEqual([]);
    expect(grid.getNeighborViews(view1, Direction.Right)).toEqual([]);
    expect(grid.getNeighborViews(view1, Direction.Down)).toEqual([
      view2,
      view4,
    ]);
    expect(grid.getNeighborViews(view1, Direction.Left)).toEqual([]);
    expect(grid.getNeighborViews(view2, Direction.Up)).toEqual([view1]);
    expect(grid.getNeighborViews(view2, Direction.Right)).toEqual([
      view4,
      view5,
    ]);
    expect(grid.getNeighborViews(view2, Direction.Down)).toEqual([view3]);
    expect(grid.getNeighborViews(view2, Direction.Left)).toEqual([]);
    expect(grid.getNeighborViews(view4, Direction.Up)).toEqual([view1]);
    expect(grid.getNeighborViews(view4, Direction.Right)).toEqual([]);
    expect(grid.getNeighborViews(view4, Direction.Down)).toEqual([view5]);
    expect(grid.getNeighborViews(view4, Direction.Left)).toEqual([view2]);
    expect(grid.getNeighborViews(view5, Direction.Up)).toEqual([view4]);
    expect(grid.getNeighborViews(view5, Direction.Down)).toEqual([view3]);
    expect(grid.getNeighborViews(view5, Direction.Left)).toEqual([view2]);
    expect(grid.getNeighborViews(view3, Direction.Up)).toEqual([view2, view5]);
    expect(grid.getNeighborViews(view3, Direction.Down)).toEqual([]);
  });

  test('dispose removes the grid element from the DOM', () => {
    const view1 = createView();
    const grid = new Grid<TestView>(view1);
    container.appendChild(grid.element);
    grid.layout(800, 600);

    expect(container.children.length).toBe(1);
    grid.dispose();
    expect(container.children.length).toBe(0);
  });
});

describe('SerializableGrid', () => {
  let container: HTMLElement;
  const disposables: { dispose(): void }[] = [];

  function createSerializableView(name: string): TestSerializableView {
    const view = new TestSerializableView(name, 50, INF, 50, INF);
    disposables.push(view);
    return view;
  }

  function createGrid(
    view: TestSerializableView,
  ): SerializableGrid<TestSerializableView> {
    const grid = new SerializableGrid<TestSerializableView>(view);
    container.appendChild(grid.element);
    disposables.push(grid);
    return grid;
  }

  function createFiveViewGrid(): {
    grid: SerializableGrid<TestSerializableView>;
    views: TestSerializableView[];
  } {
    const view1 = createSerializableView('view1');
    const grid = createGrid(view1);
    grid.layout(800, 600);

    const view2 = createSerializableView('view2');
    grid.addView(view2, 200, view1, Direction.Up);
    const view3 = createSerializableView('view3');
    grid.addView(view3, 200, view1, Direction.Right);
    const view4 = createSerializableView('view4');
    grid.addView(view4, 200, view2, Direction.Left);
    const view5 = createSerializableView('view5');
    grid.addView(view5, 100, view1, Direction.Down);

    return { grid, views: [view1, view2, view3, view4, view5] };
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

  test('serialize single view', () => {
    const view1 = createSerializableView('view1');
    const grid = createGrid(view1);
    grid.layout(800, 600);

    expect(grid.serialize()).toEqual({
      orientation: 0,
      width: 800,
      height: 600,
      root: {
        type: 'branch',
        data: [
          {
            type: 'leaf',
            data: { name: 'view1' },
            size: 600,
          },
        ],
        size: 800,
      },
    });
  });

  test('serialize simple layout', () => {
    const { grid } = createFiveViewGrid();

    expect(grid.serialize()).toEqual({
      orientation: 0,
      width: 800,
      height: 600,
      root: {
        type: 'branch',
        data: [
          {
            type: 'branch',
            data: [
              { type: 'leaf', data: { name: 'view4' }, size: 200 },
              { type: 'leaf', data: { name: 'view2' }, size: 600 },
            ],
            size: 200,
          },
          {
            type: 'branch',
            data: [
              {
                type: 'branch',
                data: [
                  { type: 'leaf', data: { name: 'view1' }, size: 300 },
                  { type: 'leaf', data: { name: 'view5' }, size: 100 },
                ],
                size: 600,
              },
              { type: 'leaf', data: { name: 'view3' }, size: 200 },
            ],
            size: 400,
          },
        ],
        size: 800,
      },
    });
  });

  test('serialize -> JSON round-trip -> deserialize restores tree shape and sizes', () => {
    const { grid } = createFiveViewGrid();

    const serialized = jsonRoundTrip(grid.serialize());
    grid.dispose();

    const deserializer = new TestViewDeserializer();
    disposables.push(deserializer);
    const grid2 = SerializableGrid.deserialize(serialized, deserializer);
    container.appendChild(grid2.element);
    disposables.push(grid2);

    expect(grid2.orientation).toBe(Orientation.VERTICAL);

    const view1Copy = deserializer.getView('view1');
    const view2Copy = deserializer.getView('view2');
    const view3Copy = deserializer.getView('view3');
    const view4Copy = deserializer.getView('view4');
    const view5Copy = deserializer.getView('view5');

    expect(nodesToNames(grid2.getViews())).toEqual([
      ['view4', 'view2'],
      [['view1', 'view5'], 'view3'],
    ]);

    grid2.layout(800, 600);

    expect(view1Copy.size).toEqual([600, 300]);
    expect(view2Copy.size).toEqual([600, 200]);
    expect(view3Copy.size).toEqual([200, 400]);
    expect(view4Copy.size).toEqual([200, 200]);
    expect(view5Copy.size).toEqual([600, 100]);

    // Locations survive the round trip.
    expect(grid2.getViewLocation(view4Copy)).toEqual([0, 0]);
    expect(grid2.getViewLocation(view1Copy)).toEqual([1, 0, 0]);
  });

  test('deserialize + layout reproduces sizes proportionally', () => {
    const { grid } = createFiveViewGrid();

    const serialized = jsonRoundTrip(grid.serialize());
    grid.dispose();

    const deserializer = new TestViewDeserializer();
    disposables.push(deserializer);
    const grid2 = SerializableGrid.deserialize(serialized, deserializer);
    container.appendChild(grid2.element);
    disposables.push(grid2);

    grid2.layout(400, 800); // [/2, *4/3]

    expect(deserializer.getView('view1').size).toEqual([300, 400]);
    expect(deserializer.getView('view2').size).toEqual([300, 267]);
    expect(deserializer.getView('view3').size).toEqual([100, 533]);
    expect(deserializer.getView('view4').size).toEqual([100, 267]);
    expect(deserializer.getView('view5').size).toEqual([300, 133]);
  });

  test('serialize stores visibility and previous size; both survive a round trip', () => {
    const { grid, views } = createFiveViewGrid();
    const [view1] = views;

    grid.setViewVisible(view1, false);
    expect(grid.isViewVisible(view1)).toBe(false);
    expect(grid.getViewCachedVisibleSize(view1)).toBe(300);

    const serialized = jsonRoundTrip(grid.serialize());
    grid.dispose();

    const deserializer = new TestViewDeserializer();
    disposables.push(deserializer);
    const grid2 = SerializableGrid.deserialize(serialized, deserializer);
    container.appendChild(grid2.element);
    disposables.push(grid2);
    grid2.layout(800, 600);

    const view1Copy = deserializer.getView('view1');
    expect(grid2.isViewVisible(view1Copy)).toBe(false);
    expect(grid2.getViewCachedVisibleSize(view1Copy)).toBe(300);

    grid2.setViewVisible(view1Copy, true);
    expect(grid2.isViewVisible(view1Copy)).toBe(true);
    expect(view1Copy.size).toEqual([600, 300]);
  });

  test('maximized state survives a serialization round trip', () => {
    const { grid, views } = createFiveViewGrid();
    const [view1] = views;

    grid.maximizeView(view1);
    expect(grid.hasMaximizedView()).toBe(true);

    const serialized = jsonRoundTrip(grid.serialize());
    grid.dispose();

    const deserializer = new TestViewDeserializer();
    disposables.push(deserializer);
    const grid2 = SerializableGrid.deserialize(serialized, deserializer);
    container.appendChild(grid2.element);
    disposables.push(grid2);
    grid2.layout(800, 600);

    const view1Copy = deserializer.getView('view1');
    expect(grid2.hasMaximizedView()).toBe(true);
    expect(grid2.isViewMaximized(view1Copy)).toBe(true);
    expect(view1Copy.size).toEqual([800, 600]);

    grid2.exitMaximizedView();
    expect(grid2.hasMaximizedView()).toBe(false);
  });

  test('deserialize rejects malformed JSON', () => {
    const deserializer = new TestViewDeserializer();
    disposables.push(deserializer);

    const valid = {
      root: { type: 'branch', data: [], size: 800 },
      orientation: 0,
      width: 800,
      height: 600,
    };

    expect(() =>
      SerializableGrid.deserialize(
        jsonRoundTrip({ ...valid, orientation: 'nope' }),
        deserializer,
      ),
    ).toThrow("'orientation' property must be a number");
    expect(() =>
      SerializableGrid.deserialize(
        jsonRoundTrip({ ...valid, width: 'nope' }),
        deserializer,
      ),
    ).toThrow("'width' property must be a number");
    expect(() =>
      SerializableGrid.deserialize(
        jsonRoundTrip({ ...valid, height: 'nope' }),
        deserializer,
      ),
    ).toThrow("'height' property must be a number");
    expect(() =>
      SerializableGrid.deserialize(
        jsonRoundTrip({
          ...valid,
          root: { type: 'leaf', data: { name: 'x' }, size: 800 },
        }),
        deserializer,
      ),
    ).toThrow("'root' property must have 'type' value of branch");
  });

  test('sanitizeGridNodeDescriptor fills sizes and collapses single-child groups', () => {
    const nodeDescriptor: GridNodeDescriptor<unknown> = {
      groups: [{ size: 0.2 }, { size: 0.2 }, { size: 0.6, groups: [{}, {}] }],
    };
    sanitizeGridNodeDescriptor(nodeDescriptor, true);
    expect(nodeDescriptor).toEqual({
      groups: [
        { size: 0.2 },
        { size: 0.2 },
        { size: 0.6, groups: [{ size: 0.5 }, { size: 0.5 }] },
      ],
    });
  });

  test('createSerializedGrid computes dimensions', () => {
    const serializedGrid = createSerializedGrid({
      orientation: Orientation.VERTICAL,
      groups: [
        { size: 0.2, data: 'a' },
        { size: 0.2, data: 'b' },
        { size: 0.6, groups: [{ data: 'c' }, { data: 'd' }] },
      ],
    });
    expect(serializedGrid).toEqual({
      root: {
        type: 'branch',
        size: 0,
        data: [
          { type: 'leaf', size: 0.2, data: 'a' },
          { type: 'leaf', size: 0.2, data: 'b' },
          {
            type: 'branch',
            size: 0.6,
            data: [
              { type: 'leaf', size: 0.5, data: 'c' },
              { type: 'leaf', size: 0.5, data: 'd' },
            ],
          },
        ],
      },
      orientation: Orientation.VERTICAL,
      width: 1,
      height: 1,
    });
  });

  test('createSerializedGrid does not allow single-child groups', () => {
    const serializedGrid = createSerializedGrid({
      orientation: Orientation.HORIZONTAL,
      groups: [
        { groups: [{}, {}], size: 0.5 },
        { groups: [{}], size: 0.5 },
      ],
    });

    const views: ISerializableView[] = [];
    const deserializer: IViewDeserializer<ISerializableView> = {
      fromJSON(): ISerializableView {
        const view: ISerializableView = {
          element: document.createElement('div'),
          layout: (): void => undefined,
          minimumWidth: 0,
          maximumWidth: INF,
          minimumHeight: 0,
          maximumHeight: INF,
          onDidChange: Event.None,
          toJSON: (): object => ({}),
        };
        views.push(view);
        return view;
      },
    };

    const grid = SerializableGrid.deserialize(serializedGrid, deserializer);
    disposables.push(grid);
    container.appendChild(grid.element);
    expect(views.length).toBe(3);

    // should not throw
    grid.removeView(views[2]);
  });

  test('from builds a grid out of a descriptor with live views', () => {
    const createLiveView = (): ISerializableView => ({
      element: document.createElement('div'),
      layout: (): void => undefined,
      minimumWidth: 0,
      maximumWidth: INF,
      minimumHeight: 0,
      maximumHeight: INF,
      onDidChange: Event.None,
      toJSON: (): object => ({}),
    });

    const a = createLiveView();
    const b = createLiveView();
    const c = createLiveView();
    const d = createLiveView();

    const grid = SerializableGrid.from({
      orientation: Orientation.VERTICAL,
      groups: [
        { size: 0.2, data: a },
        { size: 0.2, data: b },
        { size: 0.6, groups: [{ data: c }, { data: d }] },
      ],
    });
    disposables.push(grid);
    container.appendChild(grid.element);

    expect(nodesToArrays(grid.getViews())).toEqual([a, b, [c, d]]);
  });
});
