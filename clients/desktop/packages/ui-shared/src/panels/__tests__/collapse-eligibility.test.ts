import type { PanelCollapseEdge } from '@canopy/protocol';
import {
  getCollapseAffordance,
  planRestoredCollapses,
  collapseEdgeAxis,
  type CollapseSnapshot,
  type CollapseSnapshotNode,
} from '../collapse-eligibility';

function leaf(
  groupId: string,
  box: { top: number; left: number; width: number; height: number },
  opts?: { collapsedEdge?: PanelCollapseEdge; tabCount?: number },
): CollapseSnapshotNode {
  return {
    type: 'leaf',
    groupId,
    box,
    collapsedEdge: opts?.collapsedEdge ?? null,
    tabCount: opts?.tabCount ?? 1,
  };
}

function branch(
  orientation: 'horizontal' | 'vertical',
  children: readonly CollapseSnapshotNode[],
): CollapseSnapshotNode {
  return { type: 'branch', orientation, children };
}

/**
 * Spec Arrangement 1: Root-H [ Left | M-V [ Main / Bottom ] | Right ],
 * 1000x800 grid, Left/Right 200 wide, Main 600 tall.
 */
function arrangement1(overrides?: {
  mainCollapsed?: boolean;
  bottomCollapsed?: boolean;
}): CollapseSnapshot {
  return {
    width: 1000,
    height: 800,
    root: branch('horizontal', [
      leaf('left', { top: 0, left: 0, width: 200, height: 800 }),
      branch('vertical', [
        leaf(
          'main',
          { top: 0, left: 200, width: 600, height: 600 },
          overrides?.mainCollapsed === true
            ? { collapsedEdge: 'top' }
            : undefined,
        ),
        leaf(
          'bottom',
          { top: 600, left: 200, width: 600, height: 200 },
          overrides?.bottomCollapsed === true
            ? { collapsedEdge: 'bottom' }
            : undefined,
        ),
      ]),
      leaf('right', { top: 0, left: 800, width: 200, height: 800 }),
    ]),
  };
}

/**
 * Spec Arrangement 2: Root-H [ Left | X-V [ Y-H [ Main | Right ] / Bottom ] ].
 */
function arrangement2(): CollapseSnapshot {
  return {
    width: 1000,
    height: 800,
    root: branch('horizontal', [
      leaf('left', { top: 0, left: 0, width: 200, height: 800 }),
      branch('vertical', [
        branch('horizontal', [
          leaf('main', { top: 0, left: 200, width: 600, height: 600 }),
          leaf('right', { top: 0, left: 800, width: 200, height: 600 }),
        ]),
        leaf('bottom', { top: 600, left: 200, width: 800, height: 200 }),
      ]),
    ]),
  };
}

describe('collapseEdgeAxis', () => {
  test('maps edges to axes', () => {
    expect(collapseEdgeAxis('left')).toBe('horizontal');
    expect(collapseEdgeAxis('right')).toBe('horizontal');
    expect(collapseEdgeAxis('top')).toBe('vertical');
    expect(collapseEdgeAxis('bottom')).toBe('vertical');
  });
});

describe('getCollapseAffordance — arrangement 1', () => {
  test('left and right are enabled toward their edges', () => {
    const snap = arrangement1();
    expect(getCollapseAffordance(snap, 'left')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
    expect(getCollapseAffordance(snap, 'right')).toEqual({
      state: 'enabled',
      edge: 'right',
    });
  });

  test('main and bottom are both enabled while neither is collapsed', () => {
    const snap = arrangement1();
    expect(getCollapseAffordance(snap, 'main')).toEqual({
      state: 'enabled',
      edge: 'top',
    });
    expect(getCollapseAffordance(snap, 'bottom')).toEqual({
      state: 'enabled',
      edge: 'bottom',
    });
  });

  test('last child collapse promotes its branch', () => {
    expect(
      getCollapseAffordance(arrangement1({ bottomCollapsed: true }), 'main'),
    ).toEqual({ state: 'enabled', edge: 'top', branchEdge: 'left' });
    expect(
      getCollapseAffordance(arrangement1({ mainCollapsed: true }), 'bottom'),
    ).toEqual({ state: 'enabled', edge: 'bottom', branchEdge: 'left' });
  });

  test('left+right can both collapse (root only width-fixes when ALL children fixed)', () => {
    const snap: CollapseSnapshot = {
      ...arrangement1(),
      root: branch('horizontal', [
        leaf(
          'left',
          { top: 0, left: 0, width: 200, height: 800 },
          { collapsedEdge: 'left' },
        ),
        branch('vertical', [
          leaf('main', { top: 0, left: 200, width: 600, height: 600 }),
          leaf('bottom', { top: 600, left: 200, width: 600, height: 200 }),
        ]),
        leaf('right', { top: 0, left: 800, width: 200, height: 800 }),
      ]),
    };
    expect(getCollapseAffordance(snap, 'right')).toEqual({
      state: 'enabled',
      edge: 'right',
    });
  });
});

describe('getCollapseAffordance — arrangement 2', () => {
  test('outer panels and the inner main panel are enabled', () => {
    const snap = arrangement2();
    expect(getCollapseAffordance(snap, 'left')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
    expect(getCollapseAffordance(snap, 'bottom')).toEqual({
      state: 'enabled',
      edge: 'bottom',
    });
    expect(getCollapseAffordance(snap, 'right')).toEqual({
      state: 'enabled',
      edge: 'right',
    });
    expect(getCollapseAffordance(snap, 'main')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
  });
});

describe('getCollapseAffordance — guards', () => {
  test('N-panel stack allows exactly N-1 collapses in any order', () => {
    const stack = (collapsed: readonly string[]): CollapseSnapshot => ({
      width: 400,
      height: 900,
      root: branch('vertical', [
        leaf(
          'a',
          { top: 0, left: 0, width: 400, height: 300 },
          collapsed.includes('a') ? { collapsedEdge: 'top' } : undefined,
        ),
        leaf(
          'b',
          { top: 300, left: 0, width: 400, height: 300 },
          collapsed.includes('b') ? { collapsedEdge: 'top' } : undefined,
        ),
        leaf(
          'c',
          { top: 600, left: 0, width: 400, height: 300 },
          collapsed.includes('c') ? { collapsedEdge: 'bottom' } : undefined,
        ),
      ]),
    });
    // The middle leaf can now collapse using its following sibling.
    expect(getCollapseAffordance(stack([]), 'b')).toEqual({
      state: 'enabled',
      edge: 'top',
    });
    expect(getCollapseAffordance(stack([]), 'a')).toEqual({
      state: 'enabled',
      edge: 'top',
    });
    expect(getCollapseAffordance(stack(['a']), 'c')).toEqual({
      state: 'enabled',
      edge: 'bottom',
    });
    expect(getCollapseAffordance(stack(['a', 'c']), 'b')).toEqual({
      state: 'blocked',
      edge: 'top',
    });
  });

  test('empty group (0 tabs) is none', () => {
    const snap: CollapseSnapshot = {
      width: 800,
      height: 600,
      root: branch('horizontal', [
        leaf(
          'a',
          { top: 0, left: 0, width: 400, height: 600 },
          { tabCount: 0 },
        ),
        leaf('b', { top: 0, left: 400, width: 400, height: 600 }),
      ]),
    };
    expect(getCollapseAffordance(snap, 'a')).toEqual({ state: 'none' });
  });

  test('sole leaf spanning both candidate edges is none', () => {
    const snap: CollapseSnapshot = {
      width: 800,
      height: 600,
      root: branch('horizontal', [
        leaf('only', { top: 0, left: 0, width: 800, height: 600 }),
      ]),
    };
    expect(getCollapseAffordance(snap, 'only')).toEqual({ state: 'none' });
  });

  test('unknown group id is none', () => {
    expect(getCollapseAffordance(arrangement1(), 'nope')).toEqual({
      state: 'none',
    });
  });

  test('an already-collapsed leaf reports enabled toward its edge', () => {
    const snap = arrangement1({ bottomCollapsed: true });
    expect(getCollapseAffordance(snap, 'bottom')).toEqual({
      state: 'enabled',
      edge: 'bottom',
    });
  });

  test('border adjacency tolerates 1px rounding', () => {
    const snap: CollapseSnapshot = {
      width: 1000,
      height: 800,
      root: branch('horizontal', [
        leaf('l', { top: 0, left: 0.6, width: 199, height: 800 }),
        leaf('r', { top: 0, left: 199.6, width: 799.7, height: 800 }),
      ]),
    };
    expect(getCollapseAffordance(snap, 'l')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
    expect(getCollapseAffordance(snap, 'r')).toEqual({
      state: 'enabled',
      edge: 'right',
    });
  });
});

describe('planRestoredCollapses', () => {
  test('accepts sequentially-legal collapses and drops the one that breaks the invariant', () => {
    const requested = new Map<string, PanelCollapseEdge>([
      ['bottom', 'bottom'],
      ['main', 'top'],
      ['left', 'left'],
      ['right', 'right'],
    ]);
    const accepted = planRestoredCollapses(arrangement1(), requested);
    expect(accepted.get('bottom')).toBe('bottom');
    expect(accepted.get('main')).toBe('top');
    expect(accepted.get('left')).toBe('left');
    expect(accepted.has('right')).toBe(false);
  });

  test('drops a stale edge that no longer matches eligibility', () => {
    const requested = new Map<string, PanelCollapseEdge>([['main', 'top']]);
    expect(planRestoredCollapses(arrangement2(), requested).size).toBe(0);
  });
});

describe('inner sibling collapse', () => {
  function inner(
    collapsed: Record<string, PanelCollapseEdge> = {},
  ): CollapseSnapshot {
    const panel = (
      id: string,
      left: number,
      top: number,
      width: number,
      height: number,
    ): CollapseSnapshotNode =>
      leaf(id, { left, top, width, height }, { collapsedEdge: collapsed[id] });
    return {
      width: 1400,
      height: 800,
      root: branch('horizontal', [
        panel('A', 0, 0, 200, 800),
        branch('vertical', [
          branch('horizontal', [
            panel('B', 200, 0, 300, 600),
            panel('C', 500, 0, 300, 600),
          ]),
          panel('D', 200, 600, 600, 200),
        ]),
        branch('vertical', [
          panel('E', 800, 0, 300, 300),
          panel('F', 800, 300, 300, 200),
          panel('G', 800, 500, 300, 300),
        ]),
        branch('vertical', [
          panel('H', 1100, 0, 300, 420),
          panel('I', 1100, 420, 300, 380),
        ]),
      ]),
    };
  }

  test('B and C collapse individually, then promote their shared row', () => {
    expect(getCollapseAffordance(inner(), 'B')).toEqual({
      state: 'enabled',
      edge: 'left',
    });
    expect(getCollapseAffordance(inner(), 'C')).toEqual({
      state: 'enabled',
      edge: 'right',
    });
    expect(getCollapseAffordance(inner({ B: 'left' }), 'C')).toEqual({
      state: 'enabled',
      edge: 'right',
      branchEdge: 'top',
    });
    expect(getCollapseAffordance(inner({ C: 'right' }), 'B')).toEqual({
      state: 'enabled',
      edge: 'left',
      branchEdge: 'top',
    });
  });

  test('F prefers the following expanded sibling, falls back above, and finally promotes its column', () => {
    expect(getCollapseAffordance(inner(), 'F')).toEqual({
      state: 'enabled',
      edge: 'top',
    });
    expect(getCollapseAffordance(inner({ G: 'bottom' }), 'F')).toEqual({
      state: 'enabled',
      edge: 'bottom',
    });
    expect(
      getCollapseAffordance(inner({ E: 'top', G: 'bottom' }), 'F'),
    ).toEqual({ state: 'enabled', edge: 'top', branchEdge: 'left' });
  });

  test('restore accepts a legal interior edge even if the preferred direction has changed', () => {
    const accepted = planRestoredCollapses(
      inner(),
      new Map([
        ['F', 'bottom'],
        ['B', 'left'],
        ['C', 'right'],
      ]),
    );
    expect([...accepted]).toEqual([
      ['F', 'bottom'],
      ['B', 'left'],
      ['C', 'right'],
    ]);
  });

  test('a structural boundary is required, even when cousins happen to align', () => {
    // Two vertical branches have matching horizontal dividers. Their leaves
    // may only collapse vertically, never across the coincident cousin edge.
    const snapshot: CollapseSnapshot = {
      width: 600,
      height: 600,
      root: branch('horizontal', [
        branch('vertical', [
          leaf('a', { left: 0, top: 0, width: 300, height: 300 }),
          leaf('b', { left: 0, top: 300, width: 300, height: 300 }),
        ]),
        branch('vertical', [
          leaf('c', { left: 300, top: 0, width: 300, height: 300 }),
          leaf('d', { left: 300, top: 300, width: 300, height: 300 }),
        ]),
      ]),
    };
    expect(planRestoredCollapses(snapshot, new Map([['a', 'left']])).size).toBe(
      0,
    );
  });
});
