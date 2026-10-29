import dagre from 'dagre';
import { Position, type Edge, type Node } from '@xyflow/react';
import type {
  LogicChange,
  LogicChangeType,
  LogicEdge,
  LogicFlow,
  LogicNode,
} from '@canopy/desktop-shared/types/plan-diagrams';

/** Rendered footprint of a single logic node, used by dagre and the node view. */
export const LOGIC_NODE_WIDTH = 220;
export const LOGIC_NODE_HEIGHT = 64;

const RANK_SEP = 52;
const NODE_SEP = 32;

/**
 * Data carried on each React Flow node. Constrained to a string-keyed record so
 * it satisfies React Flow's `Node<NodeData>` generic without casts.
 */
export interface LogicFlowNodeData extends Record<string, unknown> {
  label: string;
  detail?: string;
  files?: string[];
  planNodeIds?: string[];
  /** Annotation tone in the unified diff view; absent in current/planned views. */
  changeType?: LogicChangeType;
  /** Change note carried through for the unified diff chip/detail. */
  changeNote?: string;
  /** Search outline state merged in by the diagram search handle. */
  searchState?: 'match' | 'active';
}

/** Concrete React Flow node/edge types for the plan logic diff diagram. */
export type LogicFlowNode = Node<LogicFlowNodeData, 'logic'>;
export type LogicFlowEdge = Edge;

export interface LogicFlowLayoutResult {
  nodes: LogicFlowNode[];
  edges: LogicFlowEdge[];
}

function toNodeData(
  node: LogicNode,
  changeType: LogicChangeType | undefined,
  changeNote: string | undefined,
): LogicFlowNodeData {
  return {
    label: node.label,
    detail: node.detail,
    files: node.files,
    planNodeIds: node.planNodeIds,
    changeType,
    changeNote,
  };
}

/**
 * Pure dagre top-to-bottom layout for a `LogicFlow`. Returns positioned React
 * Flow nodes plus edges. Edges that reference unknown node ids are dropped so
 * dagre never positions phantom nodes. Returns empty arrays for an empty flow.
 *
 * `changeByNodeId` (and optional `noteByNodeId`) carry diff annotations into
 * node data so the unified view can color and chip each node.
 */
export function computeLogicFlowLayout(
  flow: LogicFlow | null | undefined,
  changeByNodeId?: Map<string, LogicChangeType>,
  noteByNodeId?: Map<string, string>,
): LogicFlowLayoutResult {
  if (!flow || flow.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const known = new Set(flow.nodes.map((node) => node.id));

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({
    rankdir: 'TB',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 16,
    marginy: 16,
  });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  for (const node of flow.nodes) {
    dagreGraph.setNode(node.id, {
      width: LOGIC_NODE_WIDTH,
      height: LOGIC_NODE_HEIGHT,
    });
  }

  const validEdges = flow.edges.filter(
    (edge) => known.has(edge.from) && known.has(edge.to),
  );
  for (const edge of validEdges) {
    dagreGraph.setEdge(edge.from, edge.to);
  }

  dagre.layout(dagreGraph);

  const nodes: LogicFlowNode[] = flow.nodes.map((node) => {
    const positioned = dagreGraph.node(node.id);
    const x =
      positioned === undefined ? 0 : positioned.x - LOGIC_NODE_WIDTH / 2;
    const y =
      positioned === undefined ? 0 : positioned.y - LOGIC_NODE_HEIGHT / 2;
    return {
      id: node.id,
      type: 'logic',
      position: { x, y },
      data: toNodeData(
        node,
        changeByNodeId?.get(node.id),
        noteByNodeId?.get(node.id),
      ),
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: false,
      connectable: false,
    };
  });

  const edges: LogicFlowEdge[] = validEdges.map((edge, index) => ({
    id: `${edge.from}->${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
    label: edge.label,
  }));

  return { nodes, edges };
}

/**
 * Builds the unified current/planned `LogicFlow` over the union of node ids
 * (keyed by id, planned winning on collision so labels/detail reflect the
 * projected state). Edges are the union of current+planned edges deduped by
 * `from|to`. Removed nodes (current ids absent from planned) are appended so
 * they still render with a removed annotation.
 */
export function buildUnifiedLogicFlow(
  current: LogicFlow,
  planned: LogicFlow,
): LogicFlow {
  const byId = new Map<string, LogicNode>();
  for (const node of current.nodes) {
    byId.set(node.id, node);
  }
  for (const node of planned.nodes) {
    byId.set(node.id, node);
  }

  const edgeKeys = new Set<string>();
  const edges: LogicEdge[] = [];
  for (const edge of [...current.edges, ...planned.edges]) {
    const key = `${edge.from}|${edge.to}`;
    if (edgeKeys.has(key)) {
      continue;
    }
    edgeKeys.add(key);
    edges.push(edge);
  }

  return { nodes: Array.from(byId.values()), edges };
}

/**
 * Resolves the per-node change annotation map for the unified view. Removed
 * nodes are derived from current ids not present in planned; the explicit
 * `changes` array supplies added/changed (and may also confirm removed).
 */
export function buildChangeMaps(
  current: LogicFlow,
  planned: LogicFlow,
  changes: LogicChange[],
): {
  changeByNodeId: Map<string, LogicChangeType>;
  noteByNodeId: Map<string, string>;
} {
  const changeByNodeId = new Map<string, LogicChangeType>();
  const noteByNodeId = new Map<string, string>();

  const plannedIds = new Set(planned.nodes.map((node) => node.id));
  for (const node of current.nodes) {
    if (!plannedIds.has(node.id)) {
      changeByNodeId.set(node.id, 'removed');
    }
  }

  for (const change of changes) {
    changeByNodeId.set(change.nodeId, change.type);
    if (change.note !== undefined) {
      noteByNodeId.set(change.nodeId, change.note);
    }
  }

  return { changeByNodeId, noteByNodeId };
}
