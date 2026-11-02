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
  DataModelDiffDiagram,
  PlanDiagramArtifact,
} from '@canopy/desktop-shared/types/plan-diagrams';
import { PLAN_DIAGRAM_SCHEMA_VERSION } from '@canopy/desktop-shared/types/plan-diagrams';
import { PlanDataModelDiffDiagram } from '../PlanDataModelDiffDiagramView';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

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
      nodes: Array<{ id: string; data: { name?: string } }>;
      onNodeClick?: (
        event: MouseEvent<HTMLButtonElement>,
        node: { id: string; data: { name?: string } },
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
            node.data.name ?? node.id,
          ),
        ),
        children,
      );
    },
  };
});

const DATA_MODEL: DataModelDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { entities: [], relationships: [] },
  planned: {
    entities: [
      {
        id: 'user',
        name: 'User',
        kind: 'table',
        detail: 'Stores application accounts.',
        fields: [
          { id: 'id', name: 'id', type: 'uuid', kind: 'primary' },
          { id: 'email', name: 'email', type: 'text', kind: 'unique' },
        ],
        files: ['prisma/schema.prisma'],
        planNodeIds: ['phase-1'],
      },
    ],
    relationships: [],
  },
  changes: [
    {
      target: 'entity',
      id: 'change-user',
      type: 'added',
      entityId: 'user',
      note: 'Add user table.',
    },
  ],
};

const ARTIFACT: PlanDiagramArtifact<DataModelDiffDiagram> = {
  status: 'ready',
  derivedFromRevision: 1,
  data: DATA_MODEL,
};

const RELATIONSHIP_DATA_MODEL: DataModelDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: {
    entities: [
      { id: 'user', name: 'User', fields: [] },
      { id: 'legacy', name: 'LegacyAccount', fields: [] },
    ],
    relationships: [
      {
        id: 'current-user-legacy',
        from: 'user',
        to: 'legacy',
        label: 'current link',
      },
    ],
  },
  planned: {
    entities: [
      { id: 'user', name: 'User', fields: [] },
      { id: 'organization', name: 'Organization', fields: [] },
    ],
    relationships: [
      {
        id: 'planned-user-organization',
        from: 'user',
        to: 'organization',
        label: 'planned link',
      },
    ],
  },
  changes: [],
};

const RELATIONSHIP_ARTIFACT: PlanDiagramArtifact<DataModelDiffDiagram> = {
  status: 'ready',
  derivedFromRevision: 1,
  data: RELATIONSHIP_DATA_MODEL,
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

function getElement<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const button = buttons.find((entry) => entry.textContent === text);
  if (!button) {
    throw new Error(`Missing button ${text}`);
  }
  return button;
}

function setTextAreaValue(element: HTMLTextAreaElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PlanDataModelDiffDiagram comments', () => {
  it('saves selected entity comments with the dataModelDiff diagram kind', () => {
    const onAddNodeComment = jest.fn();

    act(() => {
      root.render(
        <PlanDataModelDiffDiagram
          artifact={ARTIFACT}
          onAddNodeComment={onAddNodeComment}
        />,
      );
    });

    act(() => {
      getElement<HTMLButtonElement>('[data-testid="flow-node-user"]').click();
    });
    act(() => {
      getElement<HTMLButtonElement>(
        '[data-testid="plan-node-add-comment"]',
      ).click();
    });
    act(() => {
      setTextAreaValue(
        getElement<HTMLTextAreaElement>(
          '[data-testid="plan-node-comment-input"]',
        ),
        'Verify the user schema migration.',
      );
    });
    act(() => {
      getElement<HTMLButtonElement>(
        '[data-testid="plan-node-comment-save"]',
      ).click();
    });

    expect(onAddNodeComment).toHaveBeenCalledTimes(1);
    expect(onAddNodeComment).toHaveBeenCalledWith({
      diagramKind: 'dataModelDiff',
      nodeId: 'user',
      title: 'User',
      detail: 'Stores application accounts.',
      files: ['prisma/schema.prisma'],
      planNodeIds: ['phase-1'],
      body: 'Verify the user schema migration.',
    });
  });

  it('scopes selected entity relationships to the active graph view', () => {
    act(() => {
      root.render(
        <PlanDataModelDiffDiagram artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });

    act(() => {
      getButtonByText('Current').click();
    });
    act(() => {
      getElement<HTMLButtonElement>('[data-testid="flow-node-user"]').click();
    });

    expect(container.textContent).toContain('LegacyAccount');
    expect(container.textContent).toContain('current link');
    expect(container.textContent).not.toContain('Organization');
    expect(container.textContent).not.toContain('planned link');

    act(() => {
      getButtonByText('Planned').click();
    });
    act(() => {
      getElement<HTMLButtonElement>('[data-testid="flow-node-user"]').click();
    });

    expect(container.textContent).toContain('Organization');
    expect(container.textContent).toContain('planned link');
    expect(container.textContent).not.toContain('LegacyAccount');
    expect(container.textContent).not.toContain('current link');
  });

  it('clears selected entity details when the graph context changes', () => {
    act(() => {
      root.render(
        <PlanDataModelDiffDiagram artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });

    act(() => {
      getButtonByText('Current').click();
    });
    act(() => {
      getElement<HTMLButtonElement>('[data-testid="flow-node-user"]').click();
    });

    expect(
      container.querySelector(
        '[data-testid="data-model-selected-entity-detail"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain('current link');

    act(() => {
      getButtonByText('Planned').click();
    });

    expect(
      container.querySelector(
        '[data-testid="data-model-selected-entity-detail"]',
      ),
    ).toBeNull();
    expect(container.textContent).not.toContain('current link');
  });

  it('centers search results on the current view instance after view changes', () => {
    const ref = createRef<DiagramSearchHandle>();

    act(() => {
      root.render(
        <PlanDataModelDiffDiagram ref={ref} artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });
    act(() => {
      getButtonByText('Current').click();
    });
    act(() => {
      getButtonByText('Planned').click();
    });
    mockSetCenterFns.forEach((setCenter) => setCenter.mockClear());
    const activeSetCenter = mockSetCenterFns[mockSetCenterFns.length - 1];
    if (!activeSetCenter) {
      throw new Error('Expected an active React Flow instance');
    }
    const inactiveSetCenters = mockSetCenterFns.slice(0, -1);

    act(() => {
      ref.current?.reveal('user');
    });

    expect(activeSetCenter).toHaveBeenCalledTimes(1);
    expect(
      inactiveSetCenters.every(
        (setCenter) => setCenter.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it('switches to the Diff/Unified view before revealing an entity the current view does not render (Bug 3)', () => {
    const ref = createRef<DiagramSearchHandle>();

    act(() => {
      root.render(
        <PlanDataModelDiffDiagram ref={ref} artifact={RELATIONSHIP_ARTIFACT} />,
      );
    });
    act(() => {
      getButtonByText('Current').click();
    });

    // "Organization" only exists in the Planned entity set — it isn't
    // rendered while "Current" is the active view.
    expect(container.textContent).not.toContain('Organization');

    act(() => {
      ref.current?.reveal('organization');
    });

    // Before this fix, `reveal()` only ever centered within whichever
    // primary view/presentation was already active; an entity missing from
    // that view (e.g. an added entity while "Current" is showing) silently
    // failed to reveal. It must now switch back to Diff/Unified — the only
    // presentation guaranteed to contain every entity
    // (`buildUnifiedDataModelGraph` unions both by id) — before trying to
    // center.
    expect(getButtonByText('Diff').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Organization');
  });
});
