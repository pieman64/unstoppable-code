/**
 * @jest-environment jsdom
 */
import {
  act,
  createRef,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactModule from 'react';
import type {
  LogicDiffDiagram,
  PlanDiagramArtifact,
} from '@canopy/desktop-shared/types/plan-diagrams';
import { PLAN_DIAGRAM_SCHEMA_VERSION } from '@canopy/desktop-shared/types/plan-diagrams';
import { PlanLogicDiffDiagram } from '../PlanLogicDiffDiagramView';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

// One entry per mock React Flow `onInit` call, in registration order — the
// last entry is always the most recently mounted (live) graph's `setCenter`.
const mockSetCenterFns: jest.Mock[] = [];

jest.mock('@xyflow/react', () => {
  const React = jest.requireActual<typeof ReactModule>('react');

  return {
    Position: { Top: 'top', Bottom: 'bottom' },
    Background: (): JSX.Element =>
      React.createElement('div', { 'data-testid': 'mock-flow-background' }),
    Controls: (): JSX.Element =>
      React.createElement('div', { 'data-testid': 'mock-flow-controls' }),
    Handle: (): JSX.Element =>
      React.createElement('div', { 'data-testid': 'mock-flow-handle' }),
    ReactFlow: ({
      nodes,
      onNodeClick,
      onPaneClick,
      onInit,
      children,
    }: {
      nodes: Array<{ id: string; data: { label?: string } }>;
      onNodeClick?: (
        event: MouseEvent<HTMLButtonElement>,
        node: { id: string; data: { label?: string } },
      ) => void;
      onPaneClick?: () => void;
      onInit?: (instance: unknown) => void;
      children?: ReactNode;
    }): JSX.Element => {
      React.useEffect(() => {
        const setCenter = jest.fn();
        mockSetCenterFns.push(setCenter);
        onInit?.({
          getNode: (id: string) => nodes.find((node) => node.id === id),
          getZoom: () => 1,
          setCenter,
        });
      }, [nodes, onInit]);

      return React.createElement(
        'div',
        {
          'data-testid': 'mock-react-flow',
          onClick: () => onPaneClick?.(),
        },
        nodes.map((node) =>
          React.createElement(
            'button',
            {
              key: node.id,
              type: 'button',
              'data-testid': `flow-node-${node.id}`,
              onClick: (event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                onNodeClick?.(event, node);
              },
            },
            node.data.label ?? node.id,
          ),
        ),
        children,
      );
    },
  };
});

// "rate-limit" only exists in the planned flow; "legacy-cache" only in
// current. This exercises the Bug 3 view-switch fix: revealing a node absent
// from whichever primary view is currently active.
const RELATIONSHIP_LOGIC_DIAGRAM: LogicDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: {
    nodes: [
      { id: 'auth', label: 'Authenticate' },
      { id: 'legacy-cache', label: 'Legacy Cache' },
    ],
    edges: [{ from: 'auth', to: 'legacy-cache' }],
  },
  planned: {
    nodes: [
      { id: 'auth', label: 'Authenticate' },
      { id: 'rate-limit', label: 'Rate Limit' },
    ],
    edges: [{ from: 'auth', to: 'rate-limit' }],
  },
  changes: [
    { nodeId: 'rate-limit', type: 'added', note: 'New rate limiting step.' },
    { nodeId: 'legacy-cache', type: 'removed', note: 'Cache removed.' },
  ],
};

const RELATIONSHIP_ARTIFACT: PlanDiagramArtifact<LogicDiffDiagram> = {
  status: 'ready',
  derivedFromRevision: 1,
  data: RELATIONSHIP_LOGIC_DIAGRAM,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockSetCenterFns.length = 0;
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

function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const button = buttons.find((entry) => entry.textContent === text);
  if (!button) {
    throw new Error(`Missing button ${text}`);
  }
  return button;
}

describe('PlanLogicDiffDiagram reveal (Bug 3)', () => {
  it('leaves the current view untouched when the revealed node is already visible there', () => {
    const ref = createRef<DiagramSearchHandle>();

    act(() => {
      root.render(
        <PlanLogicDiffDiagram ref={ref} artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });
    act(() => {
      getButtonByText('Current').click();
    });

    // "Authenticate" is unchanged, so it's already rendered in the "Current"
    // view — reveal must not need (or trigger) a view switch.
    act(() => {
      ref.current?.reveal('auth');
    });

    expect(getButtonByText('Current').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('switches to the Diff/Unified view before revealing a node the current view does not render', () => {
    const ref = createRef<DiagramSearchHandle>();

    act(() => {
      root.render(
        <PlanLogicDiffDiagram ref={ref} artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });
    act(() => {
      getButtonByText('Current').click();
    });

    // "Rate Limit" only exists in the planned flow — it isn't rendered while
    // "Current" is the active view.
    expect(container.textContent).not.toContain('Rate Limit');

    act(() => {
      ref.current?.reveal('rate-limit');
    });

    // Before this fix, `reveal()` only ever centered within whichever
    // primary view/presentation was already active; a node missing from that
    // view (e.g. an added node while "Current" is showing) silently failed
    // to reveal. It must now switch back to Diff/Unified — the only
    // presentation guaranteed to contain every node
    // (`buildUnifiedLogicFlow` unions current+planned by id) — before trying
    // to center.
    expect(getButtonByText('Diff').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Rate Limit');
  });

  it('centers via the live instance after hopping views before reveal (stale-instance regression)', () => {
    // Capture deferred frames so the view-switch centering can be flushed
    // deterministically after React commits the switched view.
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const stubRequestAnimationFrame = (
      callback: FrameRequestCallback,
    ): number => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    };
    window.requestAnimationFrame = stubRequestAnimationFrame;
    try {
      const ref = createRef<DiagramSearchHandle>();
      act(() => {
        root.render(
          <PlanLogicDiffDiagram ref={ref} artifact={RELATIONSHIP_ARTIFACT} />,
        );
      });

      // Hop through two views. Each hop unmounts the previous graph and
      // mounts a fresh one that registers a new React Flow instance —
      // before the scope-key reset (mirroring `PlanDataModelDiffDiagram`'s
      // `instanceScopeKey` pattern), all of the unmounted views' instances
      // accumulated in `instancesRef` forever.
      act(() => {
        getButtonByText('Current').click();
      });
      act(() => {
        getButtonByText('Planned').click();
      });

      // 'legacy-cache' is current-only, so it's absent from the active
      // Planned view: reveal switches to Diff/Unified and defers centering
      // one frame.
      act(() => {
        ref.current?.reveal('legacy-cache');
      });
      expect(getButtonByText('Diff').getAttribute('aria-pressed')).toBe('true');

      const liveSetCenter = mockSetCenterFns[mockSetCenterFns.length - 1];
      if (!liveSetCenter) {
        throw new Error('Expected the unified view to register an instance');
      }
      const staleSetCenters = mockSetCenterFns.slice(0, -1);
      expect(staleSetCenters.length).toBeGreaterThanOrEqual(2);

      // Flush the deferred centering frame.
      act(() => {
        for (const callback of rafCallbacks.splice(0)) {
          callback(0);
        }
      });

      // The camera pan must land on the LIVE (freshly mounted Diff/Unified)
      // instance. Before the scoping fix, the accumulated initial unified
      // instance came first in iteration order, matched `getNode`, and
      // swallowed the `setCenter` call — panning a dead camera.
      expect(liveSetCenter).toHaveBeenCalledTimes(1);
      expect(
        staleSetCenters.every((setCenter) => setCenter.mock.calls.length === 0),
      ).toBe(true);
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});
