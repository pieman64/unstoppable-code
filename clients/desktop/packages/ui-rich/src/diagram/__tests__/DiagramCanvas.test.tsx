/** @jest-environment jsdom */
import {
  act,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactModule from 'react';
import {
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowProps,
} from '@xyflow/react';
import type { DiagramCanvasNode } from '../types';

interface FlowNodeData extends Record<string, unknown> {
  readonly content: ReactNode;
  readonly width: number;
  readonly height: number;
  readonly selected?: boolean;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

type FlowNode = Node<FlowNodeData, 'diagramCanvasNode'>;
type FlowEdge = Edge<Record<string, never>, 'smoothstep'>;

let mockLatestFlowProps: ReactFlowProps<FlowNode, FlowEdge> | null = null;
const mockFitView = jest
  .fn<Promise<boolean>, [undefined?]>()
  .mockResolvedValue(true);

jest.mock('@xyflow/react', () => {
  const React = jest.requireActual<typeof ReactModule>('react');

  return {
    Position: { Left: 'left', Right: 'right' },
    BackgroundVariant: { Dots: 'dots' },
    Background: (): JSX.Element =>
      React.createElement('div', { 'data-testid': 'mock-background' }),
    Controls: (): JSX.Element =>
      React.createElement('div', { 'data-testid': 'mock-controls' }),
    Handle: ({
      type,
      position,
    }: {
      type: 'source' | 'target';
      position: string;
    }): JSX.Element =>
      React.createElement('span', {
        'data-handle-type': type,
        'data-handle-position': position,
      }),
    useReactFlow: (): { fitView: typeof mockFitView } => ({
      fitView: mockFitView,
    }),
    ReactFlow: (props: ReactFlowProps<FlowNode, FlowEdge>): JSX.Element => {
      mockLatestFlowProps = props;
      const flowNodes = props.nodes ?? [];
      const nodeButtons = flowNodes.map((node) => {
        const NodeView = props.nodeTypes?.[node.type];
        if (!NodeView) return null;

        const nodeViewProps: NodeProps<FlowNode> = {
          id: node.id,
          data: node.data,
          type: node.type,
          width: node.initialWidth,
          height: node.initialHeight,
          sourcePosition: node.sourcePosition,
          targetPosition: node.targetPosition,
          dragging: false,
          zIndex: 0,
          selectable: false,
          deletable: false,
          selected: false,
          draggable: false,
          isConnectable: false,
          positionAbsoluteX: node.position.x,
          positionAbsoluteY: node.position.y,
        };

        return React.createElement(
          'button',
          {
            key: node.id,
            type: 'button',
            'data-testid': `flow-node-${node.id}`,
            onClick: (event: ReactMouseEvent<HTMLButtonElement>): void => {
              event.stopPropagation();
              props.onNodeClick?.(event, node);
            },
            onDoubleClick: (
              event: ReactMouseEvent<HTMLButtonElement>,
            ): void => {
              event.stopPropagation();
              props.onNodeDoubleClick?.(event, node);
            },
          },
          React.createElement(NodeView, nodeViewProps),
        );
      });

      return React.createElement(
        'div',
        {
          'data-testid': 'mock-react-flow',
          onClick: (event: ReactMouseEvent<HTMLDivElement>): void => {
            if (event.target === event.currentTarget) {
              props.onPaneClick?.(event);
            }
          },
        },
        ...nodeButtons,
        props.children,
      );
    },
  };
});

import { DiagramCanvas } from '../DiagramCanvas';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class TestResizeObserver implements ResizeObserver {
  static readonly instances: TestResizeObserver[] = [];
  private observedElement: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observedElement = target;
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  trigger(width: number, height: number): void {
    const target = this.observedElement;
    if (!target) throw new Error('ResizeObserver has no observed element');
    const entry: ResizeObserverEntry = {
      target,
      contentRect: new DOMRect(0, 0, width, height),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    this.callback([entry], this);
  }
}

const NODES: readonly DiagramCanvasNode[] = [
  {
    id: 'source',
    x: 32,
    y: 48,
    width: 140,
    height: 72,
    content: <span>Source card</span>,
    selected: true,
    ariaLabel: 'Source step',
    testId: 'diagram-source',
  },
  {
    id: 'target',
    x: 248,
    y: 48,
    width: 180,
    height: 88,
    content: <span>Target card</span>,
  },
];

const EDGES = [
  {
    id: 'source-target',
    source: 'source',
    target: 'target',
    dashed: true,
    label: 'skips hidden steps',
  },
];

let container: HTMLDivElement;
let root: Root;
let originalResizeObserver: typeof ResizeObserver;

function flowProps(): ReactFlowProps<FlowNode, FlowEdge> {
  const props = mockLatestFlowProps;
  if (!props) throw new Error('React Flow has not rendered');
  return props;
}

function firstFlowNode(): FlowNode {
  const node = flowProps().nodes?.[0];
  if (!node) throw new Error('Missing first React Flow node');
  return node;
}

beforeEach(() => {
  mockLatestFlowProps = null;
  mockFitView.mockClear();
  TestResizeObserver.instances.length = 0;
  originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  });
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, 0, 800, 600));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: originalResizeObserver,
  });
});

describe('DiagramCanvas', () => {
  it('passes node positions, sizes, and left-to-right handles through to React Flow', () => {
    act(() => {
      root.render(
        <DiagramCanvas
          nodes={NODES}
          edges={EDGES}
          ariaLabel="Plan diagram"
          testId="diagram-canvas"
        />,
      );
    });

    const source = firstFlowNode();
    expect(source.position).toEqual({ x: 32, y: 48 });
    expect(source.initialWidth).toBe(140);
    expect(source.initialHeight).toBe(72);
    expect(source.style).toMatchObject({ width: 140, height: 72 });
    expect(source.sourcePosition).toBe(Position.Right);
    expect(source.targetPosition).toBe(Position.Left);
    expect(source.draggable).toBe(false);
    expect(source.connectable).toBe(false);
    expect(source.deletable).toBe(false);

    const nodeWrapper = container.querySelector(
      '[data-testid="diagram-source"]',
    );
    expect(nodeWrapper?.getAttribute('aria-label')).toBe('Source step');
    expect(nodeWrapper?.getAttribute('data-selected')).toBe('true');
    expect(nodeWrapper?.textContent).toBe('Source card');
    expect(
      nodeWrapper?.querySelector(
        '[data-handle-type="target"][data-handle-position="left"]',
      ),
    ).not.toBeNull();
    expect(
      nodeWrapper?.querySelector(
        '[data-handle-type="source"][data-handle-position="right"]',
      ),
    ).not.toBeNull();

    const canvas = container.querySelector('[data-testid="diagram-canvas"]');
    expect(canvas?.getAttribute('role')).toBe('group');
    expect(canvas?.getAttribute('aria-label')).toBe('Plan diagram');
    expect(flowProps().fitView).toBe(true);
    expect(flowProps().onlyRenderVisibleElements).toBe(true);
    expect(flowProps().minZoom).toBe(0.25);
    expect(flowProps().maxZoom).toBe(1);
    expect(flowProps().zoomOnDoubleClick).toBe(false);
  });

  it('passes smoothstep, dashed and labelled edge styling through to React Flow', () => {
    act(() => {
      root.render(
        <DiagramCanvas nodes={NODES} edges={EDGES} ariaLabel="Plan diagram" />,
      );
    });

    const edge = flowProps().edges?.[0];
    expect(edge).toMatchObject({
      id: 'source-target',
      source: 'source',
      target: 'target',
      type: 'smoothstep',
      style: {
        strokeDasharray: '5 4',
      },
      label: 'skips hidden steps',
      labelShowBg: true,
      labelBgStyle: {
        fill: 'var(--bg-card)',
        stroke: 'var(--line-base)',
      },
    });
    expect(flowProps().nodes?.[1].position).toEqual({ x: 248, y: 48 });
    expect(flowProps().nodes?.[1].style).toMatchObject({
      width: 180,
      height: 88,
    });
  });

  it('reports node, double-click, and pane clicks by id', () => {
    const onNodeClick = jest.fn();
    const onNodeDoubleClick = jest.fn();
    const onPaneClick = jest.fn();

    act(() => {
      root.render(
        <DiagramCanvas
          nodes={NODES}
          edges={EDGES}
          ariaLabel="Plan diagram"
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
        />,
      );
    });

    const nodeButton = container.querySelector(
      '[data-testid="flow-node-source"]',
    );
    if (!nodeButton) throw new Error('Missing mocked flow node');
    act(() => {
      nodeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      nodeButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onNodeClick).toHaveBeenCalledWith('source');
    expect(onNodeDoubleClick).toHaveBeenCalledWith('source');
    expect(onPaneClick).not.toHaveBeenCalled();

    const pane = container.querySelector('[data-testid="mock-react-flow"]');
    if (!pane) throw new Error('Missing mocked React Flow pane');
    act(() => {
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPaneClick).toHaveBeenCalledTimes(1);
  });

  it('refits when fitViewKey changes while capping zoom to the requested range', () => {
    act(() => {
      root.render(
        <DiagramCanvas
          nodes={NODES}
          edges={EDGES}
          ariaLabel="Plan diagram"
          minZoom={0.4}
          fitViewKey="first"
        />,
      );
    });

    const initialNodes = flowProps().nodes;
    const initialEdges = flowProps().edges;
    const initialNodeTypes = flowProps().nodeTypes;
    const fitOptions = flowProps().fitViewOptions;
    expect(fitOptions).toMatchObject({ minZoom: 0.4, maxZoom: 1 });
    expect(mockFitView).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <DiagramCanvas
          nodes={NODES}
          edges={EDGES}
          ariaLabel="Plan diagram"
          minZoom={0.4}
          fitViewKey="second"
        />,
      );
    });

    expect(flowProps().nodes).toBe(initialNodes);
    expect(flowProps().edges).toBe(initialEdges);
    expect(flowProps().nodeTypes).toBe(initialNodeTypes);
    expect(mockFitView).toHaveBeenCalledWith(fitOptions);
  });

  it('reports the container size on mount and after ResizeObserver changes', () => {
    const onViewportSize = jest.fn();

    act(() => {
      root.render(
        <DiagramCanvas
          nodes={NODES}
          edges={EDGES}
          ariaLabel="Plan diagram"
          onViewportSize={onViewportSize}
        />,
      );
    });

    expect(onViewportSize).toHaveBeenCalledWith({ width: 800, height: 600 });
    const observer = TestResizeObserver.instances[0];
    if (!observer) throw new Error('Missing ResizeObserver instance');

    act(() => observer.trigger(960, 540));
    expect(onViewportSize).toHaveBeenLastCalledWith({
      width: 960,
      height: 540,
    });
  });
});
