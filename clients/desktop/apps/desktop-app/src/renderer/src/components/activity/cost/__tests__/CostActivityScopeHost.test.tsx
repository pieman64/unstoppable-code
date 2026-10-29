/**
 * @jest-environment jsdom
 */
import { act, useContext, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCostScopeStore } from '@canopy/ui-app/cost';
import { CostActivityScopeContext } from '../CostActivityScopeContext';
import { CostActivityScopeHost } from '../CostActivityScopeHost';

interface MockCostScopeRead {
  readonly value: unknown;
  readonly problem: unknown;
}
const mockCostScopeRead: MockCostScopeRead = { value: null, problem: null };
const mockCostStore = <Value,>(
  selector: (state: MockCostScopeRead) => Value,
): Value => selector(mockCostScopeRead);

jest.mock('@canopy/ui-app/cost', () => ({
  costScopeHasContent: (): boolean => false,
  useCostScopeStore: jest.fn(() => mockCostStore),
}));
jest.mock('@/lib/cost/ipc-cost-client', () => ({ desktopCostClient: {} }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let mounts = 0;
let unmounts = 0;
const seenScopes: Array<string | null> = [];

/** Stands in for the rail: counts its mounts and records the scope it reads. */
function Rail(): JSX.Element {
  const cost = useContext(CostActivityScopeContext);
  const scope =
    cost !== null && cost.scope.kind === 'entry'
      ? `${cost.scope.projectId}/${cost.scope.worktreeId}`
      : null;
  seenScopes.push(scope);
  useEffect(() => {
    mounts += 1;
    return (): void => {
      unmounts += 1;
    };
  }, []);
  return <div data-testid="rail" data-cost-scope={scope ?? ''} />;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe('CostActivityScopeHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    mounts = 0;
    unmounts = 0;
    seenScopes.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Runs first: the lazy source has not loaded yet in this module registry.
  it('keeps its children mounted as one instance while the cost source loads', async () => {
    act(() =>
      root.render(
        <CostActivityScopeHost projectId="project" worktreeId="worktree">
          <Rail />
        </CostActivityScopeHost>,
      ),
    );

    // The rail is on screen before the lazy source has reported anything.
    const rail = container.querySelector('[data-testid="rail"]');
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute('data-cost-scope')).toBe('');
    expect(jest.mocked(useCostScopeStore)).not.toHaveBeenCalled();

    await settle();

    expect(jest.mocked(useCostScopeStore)).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: 'entry', projectId: 'project', worktreeId: 'worktree' },
    );
    // The same element now reads the scope: it was updated, not replaced.
    expect(container.querySelector('[data-testid="rail"]')).toBe(rail);
    expect(rail?.getAttribute('data-cost-scope')).toBe('project/worktree');
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it('never hands the previous entry’s scope to the next entry', async () => {
    act(() =>
      root.render(
        <CostActivityScopeHost projectId="project" worktreeId="first">
          <Rail />
        </CostActivityScopeHost>,
      ),
    );
    await settle();
    seenScopes.length = 0;

    act(() =>
      root.render(
        <CostActivityScopeHost projectId="project" worktreeId="second">
          <Rail />
        </CostActivityScopeHost>,
      ),
    );
    await settle();

    expect(seenScopes).not.toContain('project/first');
    expect(seenScopes[seenScopes.length - 1]).toBe('project/second');
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it('provides no scope, and loads no cost store, for a surface that keeps no cost', async () => {
    act(() =>
      root.render(
        <CostActivityScopeHost projectId={null} worktreeId={null}>
          <Rail />
        </CostActivityScopeHost>,
      ),
    );
    await settle();

    expect(jest.mocked(useCostScopeStore)).not.toHaveBeenCalled();
    expect(seenScopes.every((scope) => scope === null)).toBe(true);
    expect(mounts).toBe(1);
  });

  it('clears the scope when the entry stops keeping cost, without remounting', async () => {
    act(() =>
      root.render(
        <CostActivityScopeHost projectId="project" worktreeId="worktree">
          <Rail />
        </CostActivityScopeHost>,
      ),
    );
    await settle();

    act(() =>
      root.render(
        <CostActivityScopeHost projectId={null} worktreeId={null}>
          <Rail />
        </CostActivityScopeHost>,
      ),
    );
    await settle();

    expect(seenScopes[seenScopes.length - 1]).toBeNull();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
});
