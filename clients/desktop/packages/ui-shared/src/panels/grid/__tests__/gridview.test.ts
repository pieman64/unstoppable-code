/** @jest-environment jsdom */

import { Emitter, type Event } from '../../emitter';
import {
  type GridNode,
  GridView,
  isGridBranchNode,
  type IView,
  type IViewSize,
  Orientation,
  Sizing,
  tail,
} from '../gridview';

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
  proportionalLayout?: boolean;

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

type ViewTree = IView | ViewTree[];

function nodesToArrays(node: GridNode): ViewTree {
  if (isGridBranchNode(node)) {
    return node.children.map(nodesToArrays);
  }

  return node.view;
}

describe('GridView', () => {
  let container: HTMLElement;
  let gridview: GridView;
  const disposables: { dispose(): void }[] = [];

  function createGridView(): GridView {
    const result = new GridView();
    container.appendChild(result.element);
    disposables.push(result);
    return result;
  }

  function createView(
    minimumWidth = 50,
    maximumWidth = Number.POSITIVE_INFINITY,
    minimumHeight = 50,
    maximumHeight = Number.POSITIVE_INFINITY,
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

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    gridview = createGridView();
  });

  afterEach(() => {
    while (disposables.length > 0) {
      const disposable = disposables.pop();
      disposable?.dispose();
    }

    container.remove();
  });

  test('tail splits an array and throws on empty input', () => {
    expect(tail([1, 2, 3])).toEqual([[1, 2], 3]);
    expect(tail([7])).toEqual([[], 7]);
    expect(() => tail([])).toThrow('Invalid tail call');
  });

  test('empty gridview is empty', () => {
    expect(nodesToArrays(gridview.getView())).toEqual([]);
  });

  test('addView validates locations', () => {
    const view = createView(20, 20, 20, 20);

    expect(() => gridview.addView(view, 200, [])).toThrow();
    expect(() => gridview.addView(view, 200, [1])).toThrow();
    expect(() => gridview.addView(view, 200, [0, 0])).toThrow();
  });

  test('addView appends views at the root', () => {
    const views = [
      createView(20, 20, 20, 20),
      createView(20, 20, 20, 20),
      createView(20, 20, 20, 20),
    ];

    gridview.addView(views[0], 200, [0]);
    gridview.addView(views[1], 200, [1]);
    gridview.addView(views[2], 200, [2]);

    expect(nodesToArrays(gridview.getView())).toEqual(views);
  });

  test('addView nested', () => {
    const view1 = createView(20, 20, 20, 20);
    const view2 = createView(20, 20, 20, 20);
    const view3 = createView(20, 20, 20, 20);

    gridview.addView(view1, 200, [0]);
    gridview.addView(view2, 200, [1]);
    gridview.addView(view3, 200, [1, 1]);

    expect(nodesToArrays(gridview.getView())).toEqual([view1, [view2, view3]]);
  });

  test('addView deep nested (3+ levels)', () => {
    const view1 = createView(20, 20, 20, 20);
    gridview.addView(view1, 200, [0]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1]);

    const view2 = createView(20, 20, 20, 20);
    gridview.addView(view2, 200, [1]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1, view2]);

    const view3 = createView(20, 20, 20, 20);
    gridview.addView(view3, 200, [1, 0]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1, [view3, view2]]);

    const view4 = createView(20, 20, 20, 20);
    gridview.addView(view4, 200, [1, 0, 0]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [[view4, view3], view2],
    ]);

    const view5 = createView(20, 20, 20, 20);
    gridview.addView(view5, 200, [1, 0]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [view5, [view4, view3], view2],
    ]);

    const view6 = createView(20, 20, 20, 20);
    gridview.addView(view6, 200, [2]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [view5, [view4, view3], view2],
      view6,
    ]);

    const view7 = createView(20, 20, 20, 20);
    gridview.addView(view7, 200, [1, 1]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [view5, view7, [view4, view3], view2],
      view6,
    ]);

    const view8 = createView(20, 20, 20, 20);
    gridview.addView(view8, 200, [1, 1, 0]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [view5, [view8, view7], [view4, view3], view2],
      view6,
    ]);
  });

  test('simple layout', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    gridview.addView(view1, 200, [0]);
    expect(view1.size).toEqual([800, 600]);
    expect(gridview.getViewSize([0])).toEqual({ width: 800, height: 600 });

    const view2 = createView();
    gridview.addView(view2, 200, [0]);
    expect(view1.size).toEqual([800, 400]);
    expect(gridview.getViewSize([1])).toEqual({ width: 800, height: 400 });
    expect(view2.size).toEqual([800, 200]);
    expect(gridview.getViewSize([0])).toEqual({ width: 800, height: 200 });

    const view3 = createView();
    gridview.addView(view3, 200, [1, 1]);
    expect(view1.size).toEqual([600, 400]);
    expect(gridview.getViewSize([1, 0])).toEqual({ width: 600, height: 400 });
    expect(view2.size).toEqual([800, 200]);
    expect(view3.size).toEqual([200, 400]);
    expect(gridview.getViewSize([1, 1])).toEqual({ width: 200, height: 400 });

    const view4 = createView();
    gridview.addView(view4, 200, [0, 0]);
    expect(view1.size).toEqual([600, 400]);
    expect(view2.size).toEqual([600, 200]);
    expect(view3.size).toEqual([200, 400]);
    expect(view4.size).toEqual([200, 200]);
    expect(gridview.getViewSize([0, 0])).toEqual({ width: 200, height: 200 });

    const view5 = createView();
    gridview.addView(view5, 100, [1, 0, 1]);
    expect(view1.size).toEqual([600, 300]);
    expect(gridview.getViewSize([1, 0, 0])).toEqual({
      width: 600,
      height: 300,
    });
    expect(view2.size).toEqual([600, 200]);
    expect(view3.size).toEqual([200, 400]);
    expect(view4.size).toEqual([200, 200]);
    expect(view5.size).toEqual([600, 100]);
    expect(gridview.getViewSize([1, 0, 1])).toEqual({
      width: 600,
      height: 100,
    });
  });

  test('simple layout with automatic size distribution', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    gridview.addView(view1, Sizing.Distribute, [0]);
    expect(view1.size).toEqual([800, 600]);

    const view2 = createView();
    gridview.addView(view2, Sizing.Distribute, [0]);
    expect(view1.size).toEqual([800, 300]);
    expect(view2.size).toEqual([800, 300]);

    const view3 = createView();
    gridview.addView(view3, Sizing.Distribute, [1, 1]);
    expect(view1.size).toEqual([400, 300]);
    expect(view2.size).toEqual([800, 300]);
    expect(view3.size).toEqual([400, 300]);

    const view4 = createView();
    gridview.addView(view4, Sizing.Distribute, [0, 0]);
    expect(view1.size).toEqual([400, 300]);
    expect(view2.size).toEqual([400, 300]);
    expect(view3.size).toEqual([400, 300]);
    expect(view4.size).toEqual([400, 300]);

    const view5 = createView();
    gridview.addView(view5, Sizing.Distribute, [1, 0, 1]);
    expect(view1.size).toEqual([400, 150]);
    expect(view2.size).toEqual([400, 300]);
    expect(view3.size).toEqual([400, 300]);
    expect(view4.size).toEqual([400, 300]);
    expect(view5.size).toEqual([400, 150]);
  });

  test('addViews before layout call', () => {
    const view1 = createView();
    gridview.addView(view1, 200, [0]);

    const view2 = createView();
    gridview.addView(view2, 200, [0]);

    const view3 = createView();
    gridview.addView(view3, 200, [1, 1]);

    gridview.layout(800, 600);

    expect(view1.size).toEqual([400, 300]);
    expect(view2.size).toEqual([800, 300]);
    expect(view3.size).toEqual([400, 300]);
  });

  test('removeView collapses branch nodes with a leaf sibling', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    const view2 = createView();
    const view3 = createView();

    gridview.addView(view1, Sizing.Distribute, [0]);
    gridview.addView(view2, Sizing.Distribute, [1]);
    gridview.addView(view3, Sizing.Distribute, [1, 1]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1, [view2, view3]]);

    gridview.removeView([1, 1]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1, view2]);
  });

  test('removeView hoists branch-node siblings into the grandparent', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    const view2 = createView();
    const view3 = createView();
    const view4 = createView();

    gridview.addView(view1, Sizing.Distribute, [0]);
    gridview.addView(view2, Sizing.Distribute, [1]);
    gridview.addView(view3, Sizing.Distribute, [1, 1]);
    gridview.addView(view4, Sizing.Distribute, [1, 0, 1]);
    expect(nodesToArrays(gridview.getView())).toEqual([
      view1,
      [[view2, view4], view3],
    ]);

    // Removing view3 leaves its parent with a single branch child, whose
    // children must be hoisted into the grandparent (the root).
    gridview.removeView([1, 1]);
    expect(nodesToArrays(gridview.getView())).toEqual([view1, view2, view4]);
  });

  test('removeView promotes a lone branch sibling to root', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    const view2 = createView();
    const view3 = createView();

    gridview.addView(view1, Sizing.Distribute, [0]);
    gridview.addView(view2, Sizing.Distribute, [1]);
    gridview.addView(view3, Sizing.Distribute, [1, 1]);

    // Root is [view1, [view2, view3]]; removing view1 promotes the branch.
    gridview.removeView([0]);
    expect(nodesToArrays(gridview.getView())).toEqual([view2, view3]);
    expect(gridview.orientation).toBe(Orientation.HORIZONTAL);
  });

  test('removeView throws when removing the last view of the grid', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    gridview.addView(view1, Sizing.Distribute, [0]);

    expect(() => gridview.removeView([0])).toThrow('Invalid grid state');
  });

  test('removeView with Sizing.Distribute redistributes sizes', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    const view2 = createView();
    const view3 = createView();

    gridview.addView(view1, 200, [0]);
    gridview.addView(view2, 100, [1]);
    gridview.addView(view3, 100, [2]);

    gridview.removeView([2], Sizing.Distribute);

    expect(view1.size).toEqual([800, 300]);
    expect(view2.size).toEqual([800, 300]);
  });

  test('maximizeView on a lone leaf and exitMaximizedView', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    gridview.addView(view1, Sizing.Distribute, [0]);

    const maximizedChanges: boolean[] = [];
    const listener = gridview.onDidChangeViewMaximized((maximized) =>
      maximizedChanges.push(maximized),
    );

    expect(gridview.hasMaximizedView()).toBe(false);
    expect(gridview.isViewMaximized([0])).toBe(false);

    gridview.maximizeView([0]);
    expect(gridview.hasMaximizedView()).toBe(true);
    expect(gridview.isViewMaximized([0])).toBe(true);
    expect(view1.size).toEqual([800, 600]);

    gridview.exitMaximizedView();
    expect(gridview.hasMaximizedView()).toBe(false);
    expect(gridview.isViewMaximized([0])).toBe(false);
    expect(maximizedChanges).toEqual([true, false]);

    listener.dispose();
  });

  test('flipping orientation preserves absolute offsets', () => {
    const view1 = createView();
    gridview.addView(view1, 200, [0]);

    const view2 = createView();
    gridview.addView(view2, 200, [1]);

    gridview.layout(800, 600, 100, 200);

    expect([view1.top, view1.left]).toEqual([100, 200]);
    expect([view2.top, view2.left]).toEqual([100 + 300, 200]);

    gridview.orientation = Orientation.HORIZONTAL;

    expect([view1.top, view1.left]).toEqual([100, 200]);
    expect([view2.top, view2.left]).toEqual([100, 200 + 400]);
  });

  test('emits canopy-prefixed CSS class names', () => {
    gridview.layout(800, 600);

    const view1 = createView();
    const view2 = createView();
    const view3 = createView();
    gridview.addView(view1, Sizing.Distribute, [0]);
    gridview.addView(view2, Sizing.Distribute, [1]);
    gridview.addView(view3, Sizing.Distribute, [1, 1]);

    expect(gridview.element.classList.contains('canopy-grid-view')).toBe(true);
    expect(
      gridview.element.querySelectorAll('.canopy-grid-branch-node').length,
    ).toBeGreaterThan(0);
    expect(
      gridview.element.querySelectorAll('.canopy-split-view').length,
    ).toBeGreaterThan(0);
    expect(
      gridview.element.querySelectorAll('.monaco-grid-view, [class*="monaco"]')
        .length,
    ).toBe(0);
  });

  test('maximumWidth reflects the root maximum width (upstream typo fix)', () => {
    gridview.layout(800, 600);

    // Constrain widths and heights differently so the two axes disagree.
    const view1 = createView(50, 300, 50, 900);
    gridview.addView(view1, Sizing.Distribute, [0]);

    expect(gridview.maximumWidth).toBe(300);
    expect(gridview.maximumHeight).toBe(900);
  });

  test('compact branches transfer released space to their leaf recipient', () => {
    gridview.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();

    gridview.addView(a, 200, [0]);
    gridview.addView(b, 400, [1]);
    gridview.addView(c, 200, [1, 1]);
    gridview.addView(d, 200, [2]);
    expect([a.height, d.height]).toEqual([400, 200]);

    gridview.setCollapsedViews(new Set([b, c]), 48);

    expect([a.height, d.height]).toEqual([400, 352]);
  });

  test('compact branches scale their restore height with the grid', () => {
    gridview.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();

    gridview.addView(a, 200, [0]);
    gridview.addView(b, 400, [1]);
    gridview.addView(c, 200, [1, 1]);
    gridview.addView(d, 200, [2]);
    gridview.setCollapsedViews(new Set([b, c]), 48);

    let root = gridview.getView();
    expect(isGridBranchNode(root)).toBe(true);
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let compactBranch = root.children[1];
    expect(isGridBranchNode(compactBranch)).toBe(true);
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    const originalRestoreHeight = compactBranch.expandedSize;
    expect(originalRestoreHeight).toBeDefined();

    gridview.layout(800, 400);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    expect(compactBranch.expandedSize).toBeCloseTo(
      (originalRestoreHeight ?? 0) / 2,
    );

    gridview.setCollapsedViews(new Set([c]), 48);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected expanded branch');
    }
    expect(compactBranch.box.height).toBeCloseTo(
      (originalRestoreHeight ?? 0) / 2,
    );
  });

  test('compact branches scale their restore width with the grid', () => {
    gridview.orientation = Orientation.HORIZONTAL;
    gridview.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();

    gridview.addView(a, 200, [0]);
    gridview.addView(b, 400, [1]);
    gridview.addView(c, 200, [1, 1]);
    gridview.addView(d, 200, [2]);
    gridview.setCollapsedViews(new Set([b, c]), 48);

    let root = gridview.getView();
    expect(isGridBranchNode(root)).toBe(true);
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let compactBranch = root.children[1];
    expect(isGridBranchNode(compactBranch)).toBe(true);
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    const originalRestoreWidth = compactBranch.expandedSize;
    expect(originalRestoreWidth).toBeDefined();

    gridview.layout(400, 800);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    expect(compactBranch.expandedSize).toBeCloseTo(
      (originalRestoreWidth ?? 0) / 2,
    );

    gridview.setCollapsedViews(new Set([c]), 48);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected expanded branch');
    }
    expect(compactBranch.box.width).toBeCloseTo(
      (originalRestoreWidth ?? 0) / 2,
    );
  });

  test('compact branches preserve restore sizes in non-proportional grids', () => {
    const grid = new GridView({ proportionalLayout: false });
    container.appendChild(grid.element);
    disposables.push(grid);
    grid.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();

    grid.addView(a, 200, [0]);
    grid.addView(b, 400, [1]);
    grid.addView(c, 200, [1, 1]);
    grid.addView(d, 200, [2]);
    grid.setCollapsedViews(new Set([b, c]), 48);

    let root = grid.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    const originalRestoreHeight = compactBranch.expandedSize;
    expect(originalRestoreHeight).toBeDefined();

    grid.layout(800, 1_200);

    root = grid.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    expect(compactBranch.expandedSize).toBeCloseTo(originalRestoreHeight ?? 0);
  });

  test('compact branches preserve restore sizes when a child opts out of proportional layout', () => {
    gridview.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();
    b.proportionalLayout = false;

    gridview.addView(a, 200, [0]);
    gridview.addView(b, 400, [1]);
    gridview.addView(c, 200, [1, 1]);
    gridview.addView(d, 200, [2]);
    gridview.setCollapsedViews(new Set([b, c]), 48);

    let root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    const originalRestoreHeight = compactBranch.expandedSize;
    expect(originalRestoreHeight).toBeDefined();

    gridview.layout(800, 1_200);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    expect(compactBranch.expandedSize).toBeCloseTo(originalRestoreHeight ?? 0);
  });

  test('compact branches retain the last positive scale basis through zero-size layouts', () => {
    gridview.layout(800, 800);
    const a = createView();
    const b = createView();
    const c = createView();
    const d = createView();

    gridview.addView(a, 200, [0]);
    gridview.addView(b, 400, [1]);
    gridview.addView(c, 200, [1, 1]);
    gridview.addView(d, 200, [2]);
    gridview.setCollapsedViews(new Set([b, c]), 48);

    let root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    const originalRestoreHeight = compactBranch.expandedSize;
    expect(originalRestoreHeight).toBeDefined();

    gridview.layout(800, 0);
    gridview.layout(800, 400);

    root = gridview.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    compactBranch = root.children[1];
    if (!isGridBranchNode(compactBranch)) {
      throw new Error('Expected compact branch');
    }
    expect(compactBranch.expandedSize).toBeCloseTo(
      (originalRestoreHeight ?? 0) / 2,
    );
  });

  test('deserialized compact branches scale their restore size with the grid', () => {
    const restoredViews = new Map<string, TestView>();
    const restored = GridView.deserialize(
      {
        orientation: Orientation.VERTICAL,
        width: 800,
        height: 600,
        root: {
          type: 'branch',
          size: 800,
          data: [
            { type: 'leaf', data: { id: 'a' }, size: 400 },
            {
              type: 'branch',
              size: 400,
              expandedSize: 360,
              data: [
                { type: 'leaf', data: { id: 'b' }, size: 180 },
                { type: 'leaf', data: { id: 'c' }, size: 180 },
              ],
            },
          ],
        },
      },
      {
        fromJSON(value) {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('id' in value) ||
            typeof value.id !== 'string'
          ) {
            throw new Error('Expected serialized view id');
          }
          const id = value.id;
          const view = Object.assign(createView(), {
            toJSON: () => ({ id }),
          });
          restoredViews.set(id, view);
          return view;
        },
      },
    );
    container.appendChild(restored.element);
    disposables.push(restored);

    restored.layout(800, 1_200);

    let root = restored.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    let nestedBranch = root.children[1];
    if (!isGridBranchNode(nestedBranch)) {
      throw new Error('Expected nested branch');
    }
    expect(nestedBranch.expandedSize).toBeCloseTo(720);

    const b = restoredViews.get('b');
    const c = restoredViews.get('c');
    if (b === undefined || c === undefined) {
      throw new Error('Expected deserialized child views');
    }
    restored.setCollapsedViews(new Set([b, c]), 48);
    restored.setCollapsedViews(new Set([c]), 48);

    root = restored.getView();
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    nestedBranch = root.children[1];
    if (!isGridBranchNode(nestedBranch)) {
      throw new Error('Expected nested branch');
    }
    expect(nestedBranch.box.height).toBeCloseTo(720);
  });

  test('compact branches prefer an immediate expanded sibling over a distant one', () => {
    gridview.layout(800, 600);
    const a = createView();
    const b = createView();
    const c = createView();
    const e = createView();
    const f = createView();
    const d = createView();

    gridview.addView(a, Sizing.Distribute, [0]);
    gridview.addView(b, Sizing.Distribute, [1]);
    gridview.addView(c, Sizing.Distribute, [1, 1]);
    gridview.addView(e, Sizing.Distribute, [2]);
    gridview.addView(f, Sizing.Distribute, [2, 1]);
    gridview.addView(d, Sizing.Distribute, [3]);

    gridview.setCollapsedViews(new Set([b, c, e, f]), 48);

    const root = gridview.getView();
    expect(isGridBranchNode(root)).toBe(true);
    if (!isGridBranchNode(root)) throw new Error('Expected branch root');
    const target = root.children[1];
    expect(isGridBranchNode(target)).toBe(true);
    if (!isGridBranchNode(target)) throw new Error('Expected compact branch');
    expect(target.collapsedAtEnd).toBe(true);
  });

  test('dispose removes the grid element from the DOM', () => {
    const ownContainer = document.createElement('div');
    document.body.appendChild(ownContainer);

    const grid = new GridView();
    ownContainer.appendChild(grid.element);

    const view1 = new TestView(
      50,
      Number.POSITIVE_INFINITY,
      50,
      Number.POSITIVE_INFINITY,
    );
    grid.addView(view1, 200, [0]);
    grid.layout(800, 600);

    expect(ownContainer.children.length).toBe(1);
    grid.dispose();
    expect(ownContainer.children.length).toBe(0);

    view1.dispose();
    ownContainer.remove();
  });
});
