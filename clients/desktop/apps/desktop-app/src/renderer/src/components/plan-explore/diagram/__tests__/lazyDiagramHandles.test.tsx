/**
 * @jest-environment jsdom
 */
import { useCallback, useRef, useState, type JSX } from 'react';
import type * as ReactModule from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CodeReviewArtifact,
  CodeReviewFile,
  DataModelDiffDiagram,
  LogicDiffDiagram,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { PLAN_DIAGRAM_SCHEMA_VERSION } from '@canopy/desktop-shared/types/plan-diagrams';
import {
  CodeReviewDiagramsPanel,
  type DiagramNodeRevealRequest as ReviewRevealRequest,
} from '@/components/code-review/CodeReviewDiagramsPanel';
import {
  PlanVisualizerPanel,
  type DiagramNodeRevealRequest as PlanRevealRequest,
} from '@/components/plan-explore/PlanVisualizerPanel';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';

// These tests run with React's normal scheduling, not inside act(): act()
// skips the delay React applies before replacing a loading fallback, which
// is exactly the window in which a diagram's handle is still missing.
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: false,
  writable: true,
});

const mockCalls: string[] = [];

// Each view stands in for the React Flow implementation: it records the
// imperative calls the panels make through its search handle.
function mockDiagramView(testId: string): unknown {
  const React = jest.requireActual<typeof ReactModule>('react');
  return React.forwardRef(function MockDiagramView(
    _props: unknown,
    ref: React.Ref<DiagramSearchHandle>,
  ) {
    React.useImperativeHandle(ref, () => ({
      search: (query: string): string[] => [`${testId}:${query}`],
      reveal: (nodeId: string): void => {
        mockCalls.push(`${testId}:reveal:${nodeId}`);
      },
      clear: (): void => undefined,
    }));
    return React.createElement('div', { 'data-testid': testId });
  });
}

// The diagram code loads when the test says so. The real loader resolves
// within a microtask, before the frame in which a panel calls its handle, so
// it cannot hold a request across the window in which a slow chunk is still
// loading; this store can.
let mockLoadedViews: unknown = null;
const mockViewListeners = new Set<() => void>();

jest.mock('../usePlanDiagramViews', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    usePlanDiagramViews: (): unknown =>
      React.useSyncExternalStore(
        (listener: () => void) => {
          mockViewListeners.add(listener);
          return (): void => {
            mockViewListeners.delete(listener);
          };
        },
        () => mockLoadedViews,
      ),
  };
});

/** Finishes loading the diagram code, as the chunk arriving would. */
function loadDiagramViews(): void {
  mockLoadedViews = {
    PlanSequenceDiagram: mockDiagramView('sequence'),
    PlanLogicDiffDiagram: mockDiagramView('logic'),
    PlanDataModelDiffDiagram: mockDiagramView('data-model'),
  };
  for (const listener of Array.from(mockViewListeners)) {
    listener();
  }
}

const LOGIC_DIFF: LogicDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { nodes: [], edges: [] },
  planned: { nodes: [], edges: [] },
  changes: [],
};

const DATA_MODEL_DIFF: DataModelDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { entities: [], relationships: [] },
  planned: { entities: [], relationships: [] },
  changes: [],
};

function plan(): TrackedPlanData {
  return {
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
    diagrams: {
      logicDiff: { data: LOGIC_DIFF, derivedFromRevision: 1, status: 'ready' },
    },
  };
}

function reviewArtifact<T>(data: T): CodeReviewArtifact<T> {
  return { data, derivedFromFingerprint: 'fp', status: 'ready' };
}

const REVIEW: CodeReviewFile = {
  version: 1,
  armed: true,
  commentThreads: [],
  diagrams: {
    logicDiff: reviewArtifact(LOGIC_DIFF),
    dataModelDiff: reviewArtifact(DATA_MODEL_DIFF),
  },
};

/** Mirrors `ChangeDiagramPanel`: re-runs its search whenever the panel asks. */
function ReviewHost({
  query,
  reveal,
}: {
  query: string;
  reveal: ReviewRevealRequest | null;
}): JSX.Element {
  const diagramSearch = useRef<DiagramSearchHandle>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const refreshSearch = useCallback((): void => {
    setMatches(diagramSearch.current?.search(query) ?? []);
  }, [query]);
  return (
    <>
      <output data-testid="matches">{matches.join(',')}</output>
      <CodeReviewDiagramsPanel
        ref={diagramSearch}
        review={REVIEW}
        armed
        onArm={() => undefined}
        onRefresh={() => undefined}
        onAddNodeComment={() => undefined}
        revealNodeRequest={reveal}
        onSearchContextChange={refreshSearch}
      />
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockCalls.length = 0;
  mockLoadedViews = null;
  mockViewListeners.clear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { generateDiagrams: jest.fn() } } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function rendered(testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null;
}

/** Waits for `condition`, or for long enough that React has committed any
 * throttled fallback replacement and run the frames that follow it. */
async function settle(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Lets mount effects and the animation frames they schedule run. */
async function frames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function searchOutput(): string | null | undefined {
  return container.querySelector('output')?.textContent;
}

// Each request arrives while the diagram code is still loading, and the
// test releases the load only afterwards: the panel must keep the request
// until the diagram's handle exists.
describe('diagram handles across the lazy diagram boundary', () => {
  it('reveals a node after a bottom-tray jump to a diagram whose code is still loading', async () => {
    const request: PlanRevealRequest = {
      requestId: 1,
      diagramKind: 'logicDiff',
      nodeId: 'node-a',
    };
    root.render(
      <PlanVisualizerPanel plan={plan()} revealNodeRequest={request} />,
    );
    await frames();
    expect(rendered('logic')).toBe(false);
    expect(mockCalls).toEqual([]);

    loadDiagramViews();
    await settle(() => mockCalls.includes('logic:reveal:node-a'));

    expect(rendered('logic')).toBe(true);
    expect(mockCalls).toEqual(['logic:reveal:node-a']);
  });

  it('re-runs search and reveals a node on a diagram tab whose code is still loading', async () => {
    root.render(
      <ReviewHost
        query="needle"
        reveal={{ requestId: 1, diagramKind: 'dataModelDiff', nodeId: 'user' }}
      />,
    );
    await frames();
    expect(rendered('data-model')).toBe(false);
    expect(searchOutput()).toBe('');
    expect(mockCalls).toEqual([]);

    loadDiagramViews();
    await settle(() => mockCalls.includes('data-model:reveal:user'));

    expect(rendered('data-model')).toBe(true);
    expect(searchOutput()).toBe('data-model:needle');
    expect(mockCalls).toEqual(['data-model:reveal:user']);
  });
});
