/**
 * @jest-environment jsdom
 */
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DataModelDiffDiagram,
  PlanDiagramArtifacts,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { PLAN_DIAGRAM_SCHEMA_VERSION } from '@canopy/desktop-shared/types/plan-diagrams';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
// `jest.mock` is hoisted above imports by the Jest transform, so the stubs below are wired
// in before `PlanVisualizerPanel` (and its diagram children) are imported.
import { PlanVisualizerPanel } from '../PlanVisualizerPanel';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

// The diagram children mount React Flow, which the node/jsdom test setup cannot
// render. Mock them with minimal ref-exposing stubs so we exercise the panel's
// tab visibility / fallback logic in isolation.
function stubDiagram(
  testId: string,
): ForwardRefExoticComponent<{ artifact?: unknown } & RefAttributes<unknown>> {
  const Stub = forwardRef<unknown, { artifact?: unknown }>(
    function Stub(_props, ref) {
      useImperativeHandle(ref, () => ({
        search: (): string[] => [],
        reveal: (): void => {},
        clear: (): void => {},
      }));
      return createElement('div', { 'data-testid': testId });
    },
  );
  return Stub;
}

jest.mock('../diagram/PlanSequenceDiagram', () => ({
  PlanSequenceDiagram: stubDiagram('mock-sequence'),
}));
jest.mock('../diagram/PlanLogicDiffDiagram', () => ({
  PlanLogicDiffDiagram: stubDiagram('mock-logic-diff'),
}));
jest.mock('../diagram/PlanDataModelDiffDiagram', () => ({
  PlanDataModelDiffDiagram: stubDiagram('mock-data-model-diff'),
}));

const EMPTY_DATA_MODEL: DataModelDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { entities: [], relationships: [] },
  planned: {
    entities: [{ id: 'user', name: 'User', fields: [] }],
    relationships: [],
  },
  changes: [{ target: 'entity', id: 'c1', type: 'added', entityId: 'user' }],
};

function plan(diagrams?: PlanDiagramArtifacts): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    source: 'claude',
    title: 'Test plan',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...(diagrams ? { diagrams } : {}),
  };
}

function withDataModel(): PlanDiagramArtifacts {
  return {
    dataModelDiff: {
      data: EMPTY_DATA_MODEL,
      derivedFromRevision: 1,
      status: 'ready',
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      activity: { plans: { generateDiagrams: jest.fn() } },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function dataModelTab(): HTMLElement | null {
  return container.querySelector(
    '[data-testid="plan-visualizer-data-model-tab"]',
  );
}

describe('PlanVisualizerPanel data model tab', () => {
  it('hides the Data Model tab when no dataModelDiff artifact exists', () => {
    act(() => {
      root.render(createElement(PlanVisualizerPanel, { plan: plan() }));
    });
    expect(dataModelTab()).toBeNull();
    // Ordinary (non-database) plans never surface the tab.
    expect(
      container.querySelector('[data-testid="mock-sequence"]'),
    ).not.toBeNull();
  });

  it('shows the Data Model tab when a dataModelDiff artifact is present', () => {
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, { plan: plan(withDataModel()) }),
      );
    });
    expect(dataModelTab()).not.toBeNull();
  });

  it('activates the Data Model diagram when its tab is clicked', () => {
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, { plan: plan(withDataModel()) }),
      );
    });
    act(() => {
      dataModelTab()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="mock-data-model-diff"]'),
    ).not.toBeNull();
  });

  it('falls back to the logic diff tab when the artifact disappears while active', () => {
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: plan({
            logicDiff: {
              data: null,
              derivedFromRevision: 1,
              status: 'ready',
            },
            ...withDataModel(),
          }),
        }),
      );
    });
    act(() => {
      dataModelTab()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="mock-data-model-diff"]'),
    ).not.toBeNull();

    // Re-render with the dataModelDiff artifact removed (plan became
    // non-applicable). The tab should disappear and the active view falls back
    // to the logic diff diagram so the panel is never left blank.
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: plan({
            logicDiff: {
              data: null,
              derivedFromRevision: 1,
              status: 'ready',
            },
          }),
        }),
      );
    });
    expect(dataModelTab()).toBeNull();
    expect(
      container.querySelector('[data-testid="mock-data-model-diff"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="mock-logic-diff"]'),
    ).not.toBeNull();
  });

  it('falls back to the sequence tab when no logic diff artifact exists', () => {
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, { plan: plan(withDataModel()) }),
      );
    });
    act(() => {
      dataModelTab()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      root.render(createElement(PlanVisualizerPanel, { plan: plan() }));
    });
    expect(dataModelTab()).toBeNull();
    expect(
      container.querySelector('[data-testid="mock-sequence"]'),
    ).not.toBeNull();
  });
});

describe('PlanVisualizerPanel session replay', () => {
  it('records the diagram tabs and blocks the diagrams from session replay', () => {
    act(() => {
      root.render(createElement(PlanVisualizerPanel, { plan: plan() }));
    });
    const panel = container.querySelector(
      '[data-testid="plan-explore-visualizer-panel"]',
    );
    expect(panel).toBe(container.firstElementChild);
    expect(panel?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      container
        .querySelector('[data-testid="plan-visualizer-generate"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="mock-sequence"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
  });
});

describe('PlanVisualizerPanel find context', () => {
  async function flushDiagramCode(): Promise<void> {
    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
      }
    });
  }

  it('tells an open find when the shown tab or its artifact changes', async () => {
    const onSearchContextChange = jest.fn();
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: plan(withDataModel()),
          onSearchContextChange,
        }),
      );
    });
    await flushDiagramCode();
    // Once the diagram code is loaded and the shown diagram's handle exists.
    expect(onSearchContextChange).toHaveBeenCalledTimes(1);

    act(() => {
      dataModelTab()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSearchContextChange).toHaveBeenCalledTimes(2);

    // A regenerated artifact for the shown tab is a new diagram to search.
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: plan(withDataModel()),
          onSearchContextChange,
        }),
      );
    });
    expect(onSearchContextChange).toHaveBeenCalledTimes(3);

    // An unrelated re-render with the same artifact does not re-search.
    const same = plan(withDataModel());
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: same,
          onSearchContextChange,
        }),
      );
    });
    act(() => {
      root.render(
        createElement(PlanVisualizerPanel, {
          plan: same,
          onSearchContextChange,
        }),
      );
    });
    expect(onSearchContextChange).toHaveBeenCalledTimes(4);
  });
});
