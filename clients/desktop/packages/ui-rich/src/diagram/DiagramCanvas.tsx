'use client';

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styles from './DiagramCanvas.module.css';
import type {
  DiagramCanvasEdge,
  DiagramCanvasProps,
  DiagramCanvasViewportSize,
} from './types';

interface DiagramCanvasNodeData extends Record<string, unknown> {
  readonly content: ReactNode;
  readonly width: number;
  readonly height: number;
  readonly selected?: boolean;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

type FlowNode = Node<DiagramCanvasNodeData, 'diagramCanvasNode'>;
type FlowEdge = Edge<Record<string, never>, 'smoothstep'>;

const NODE_ORIGIN: [number, number] = [0, 0];
const EDGE_LABEL_BG_PADDING: [number, number] = [4, 2];

function DiagramCanvasNodeView({ data }: NodeProps<FlowNode>): JSX.Element {
  return (
    <div
      className={styles.node}
      data-selected={data.selected ? 'true' : undefined}
      data-testid={data.testId}
      aria-label={data.ariaLabel}
      style={{ width: data.width, height: data.height }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={styles.handle}
      />
      {data.content}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={styles.handle}
      />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { diagramCanvasNode: DiagramCanvasNodeView };

function RefitOnKeyChange({
  fitViewKey,
  fitViewOptions,
}: {
  readonly fitViewKey: string | number | undefined;
  readonly fitViewOptions: FitViewOptions<FlowNode>;
}): null {
  const { fitView } = useReactFlow<FlowNode, FlowEdge>();
  const previousKeyRef = useRef(fitViewKey);

  useEffect(() => {
    if (Object.is(previousKeyRef.current, fitViewKey)) return;
    previousKeyRef.current = fitViewKey;
    void fitView(fitViewOptions);
  }, [fitView, fitViewKey, fitViewOptions]);

  return null;
}

function ViewportSizeReporter({
  containerRef,
  onViewportSize,
}: {
  readonly containerRef: { readonly current: HTMLDivElement | null };
  readonly onViewportSize?: (size: DiagramCanvasViewportSize) => void;
}): null {
  const lastSizeRef = useRef<DiagramCanvasViewportSize | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reportSize = (width: number, height: number): void => {
      const previousSize = lastSizeRef.current;
      if (previousSize?.width === width && previousSize.height === height) {
        return;
      }
      const size = { width, height };
      lastSizeRef.current = size;
      onViewportSize?.(size);
    };

    const bounds = container.getBoundingClientRect();
    reportSize(bounds.width, bounds.height);

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      reportSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return (): void => observer.disconnect();
  }, [containerRef, onViewportSize]);

  return null;
}

function DiagramCanvasComponent({
  nodes,
  edges,
  ariaLabel,
  minZoom: requestedMinZoom = 0.25,
  fitViewKey,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
  onViewportSize,
  testId,
}: DiagramCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const minZoom = Math.min(1, Math.max(0.01, requestedMinZoom));

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'diagramCanvasNode',
        position: { x: node.x, y: node.y },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        initialWidth: node.width,
        initialHeight: node.height,
        style: { width: node.width, height: node.height },
        data: {
          content: node.content,
          width: node.width,
          height: node.height,
          selected: node.selected,
          ariaLabel: node.ariaLabel,
          testId: node.testId,
        },
        draggable: false,
        connectable: false,
        selectable: false,
        deletable: false,
        focusable: false,
        ariaLabel: node.ariaLabel,
      })),
    [nodes],
  );

  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      edges.map((edge: DiagramCanvasEdge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        style: {
          stroke: 'var(--line-base)',
          strokeWidth: 1.5,
          ...(edge.dashed ? { strokeDasharray: '5 4' } : {}),
        },
        reconnectable: false,
        selectable: false,
        deletable: false,
        focusable: false,
        ...(edge.label === undefined
          ? {}
          : {
              label: edge.label,
              labelStyle: {
                fill: 'var(--fg-secondary)',
                fontFamily: 'inherit',
                fontSize: 'var(--text-3xs)',
              },
              labelShowBg: true,
              labelBgStyle: {
                fill: 'var(--bg-card)',
                stroke: 'var(--line-base)',
              },
              labelBgPadding: EDGE_LABEL_BG_PADDING,
              labelBgBorderRadius: 3,
            }),
      })),
    [edges],
  );

  const fitViewOptions = useMemo<FitViewOptions<FlowNode>>(
    () => ({ minZoom, maxZoom: 1 }),
    [minZoom],
  );

  const handleNodeClick: NodeMouseHandler<FlowNode> = (_event, node): void => {
    onNodeClick?.(node.id);
  };
  const handleNodeDoubleClick: NodeMouseHandler<FlowNode> = (
    _event,
    node,
  ): void => {
    onNodeDoubleClick?.(node.id);
  };

  return (
    <div
      ref={containerRef}
      className={styles.canvas}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <ReactFlow<FlowNode, FlowEdge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        nodeOrigin={NODE_ORIGIN}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={minZoom}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesReconnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={onPaneClick}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--line-base)"
        />
        <Controls showInteractive={false} fitViewOptions={fitViewOptions} />
        <RefitOnKeyChange
          fitViewKey={fitViewKey}
          fitViewOptions={fitViewOptions}
        />
        <ViewportSizeReporter
          containerRef={containerRef}
          onViewportSize={onViewportSize}
        />
      </ReactFlow>
    </div>
  );
}

export const DiagramCanvas = memo(DiagramCanvasComponent);
