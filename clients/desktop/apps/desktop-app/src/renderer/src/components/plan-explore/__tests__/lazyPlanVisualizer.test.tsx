/** @jest-environment jsdom */
import type * as ReactNamespace from 'react';
import { act, Suspense, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  PlanVisualizer,
  preloadPlanVisualizer,
} from '@/components/plan-explore/lazyPlanVisualizer';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';

jest.mock('@/components/plan-explore/PlanVisualizerPanel', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PlanVisualizerPanel: react.forwardRef(function MockVisualizer() {
      return react.createElement('p', { 'data-testid': 'visualizer' });
    }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const plan: TrackedPlanData = {
  id: 'plan-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  source: 'claude',
  title: 'Test plan',
  content: '# Plan',
  reviewStatus: 'pending',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  latestRevisionNumber: 1,
  revisions: [],
  linkedExecutionIds: [],
};

let show: () => void = () => {};

function Host(): JSX.Element {
  const [shown, setShown] = useState(false);
  show = (): void => setShown(true);
  return shown ? (
    <Suspense fallback={<p data-testid="fallback" />}>
      <PlanVisualizer plan={plan} />
    </Suspense>
  ) : (
    <p data-testid="document" />
  );
}

describe('PlanVisualizer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders preloaded code in the same commit, without the Suspense fallback', async () => {
    await preloadPlanVisualizer();
    act(() => root.render(<Host />));

    // A discrete switch (a tab click) shows the diagram at once: no fallback
    // is committed, so React's reveal throttle never holds the diagram back.
    flushSync(() => show());
    expect(host.querySelector('[data-testid="fallback"]')).toBeNull();
    expect(host.querySelector('[data-testid="visualizer"]')).not.toBeNull();
  });
});
