/** @jest-environment jsdom */

import { Emitter, type Event } from '../emitter';
import { Direction, Grid, type IView, type IViewSize, Sizing } from '../grid';
import {
  buildCollapseSnapshotFromGrid,
  getCollapseAffordance,
} from '../collapse-eligibility';

const INF = Number.POSITIVE_INFINITY;

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

  constructor(
    readonly id: string,
    minimumWidth = 50,
    maximumWidth = INF,
    minimumHeight = 50,
    maximumHeight = INF,
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
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

describe('buildCollapseSnapshotFromGrid', () => {
  let container: HTMLElement;
  const disposables: { dispose(): void }[] = [];

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

  test('builds a snapshot for Root-H [A | V[B / C]] after layout', () => {
    const a = new TestView('a');
    const grid = createGrid(a);

    const b = new TestView('b');
    grid.addView(b, Sizing.Distribute, a, Direction.Right);

    const c = new TestView('c');
    grid.addView(c, Sizing.Distribute, b, Direction.Down);

    grid.layout(1000, 800);

    const snapshot = buildCollapseSnapshotFromGrid(grid, () => ({
      collapsedEdge: null,
      tabCount: 1,
    }));

    expect(snapshot).not.toBeNull();
    if (snapshot === null) {
      return;
    }

    expect(getCollapseAffordance(snapshot, 'a')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
    expect(getCollapseAffordance(snapshot, 'b')).toEqual({
      state: 'enabled',
      edge: 'top',
    });
  });

  test('returns null before the grid has been laid out', () => {
    const a = new TestView('a');
    const grid = createGrid(a);

    let result: unknown;
    expect(() => {
      result = buildCollapseSnapshotFromGrid(grid, () => ({
        collapsedEdge: null,
        tabCount: 1,
      }));
    }).not.toThrow();

    expect(result).toBeNull();
  });
});
