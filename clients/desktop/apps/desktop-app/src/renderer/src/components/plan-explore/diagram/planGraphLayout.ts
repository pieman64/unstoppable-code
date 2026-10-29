import dagre from 'dagre';
import { Position, type Edge, type Node } from '@xyflow/react';
import type {
  ParsedPlanGraph,
  PlanGraphNode,
  PlanGraphNodeKind,
} from '@canopy/desktop-shared/types/plan-diagrams';

/** Rendered footprint of a single node, used by the layout and the custom node. */
export const PLAN_NODE_WIDTH = 220;
export const PLAN_NODE_HEIGHT = 72;

const COLUMN_GAP = 72;
const ROW_GAP = 40;
const PHASE_TO_TASKS_GAP = 56;

// dagre fallback (used only when the graph has no phase structure)
const RANK_SEP = 56;
const NODE_SEP = 36;

/**
 * Data carried on each React Flow node. Constrained to a string-keyed record so
 * it satisfies React Flow's `Node<NodeData>` generic without casts.
 */
export interface PlanFlowNodeData extends Record<string, unknown> {
  kind: PlanGraphNodeKind;
  title: string;
  description: string;
  detail?: string;
  files?: string[];
  headingPath?: string[];
  quote?: string;
  parentId?: string;
  /** Search outline state merged in by the diagram search handle. */
  searchState?: 'match' | 'active';
}

/** Concrete React Flow node/edge types for the plan sequence diagram. */
export type PlanFlowNode = Node<PlanFlowNodeData, 'plan'>;
export type PlanFlowEdge = Edge;

export interface PlanGraphLayoutResult {
  nodes: PlanFlowNode[];
  edges: PlanFlowEdge[];
}

function toNodeData(node: PlanGraphNode): PlanFlowNodeData {
  return {
    kind: node.kind,
    title: node.title,
    description: node.description,
    detail: node.detail,
    files: node.files,
    headingPath: node.planAnchor.headingPath,
    quote: node.planAnchor.quote,
    parentId: node.parentId,
  };
}

function makeNode(node: PlanGraphNode, x: number, y: number): PlanFlowNode {
  return {
    id: node.id,
    type: 'plan',
    position: { x, y },
    data: toNodeData(node),
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    draggable: false,
    connectable: false,
  };
}

/**
 * Layout for a `ParsedPlanGraph`:
 *
 *   [Phase 1] ── [Phase 2] ── [Phase 3]
 *      │            │            │
 *   [task 1.1]   [task 2.1]   [task 3.1]
 *      │            │
 *   [task 1.2]   [task 2.2]
 *
 * Phases form a horizontal header row in document order; each phase's tasks
 * (grouped by `parentId`, in document order) stack vertically beneath it. Phase
 * order and task membership come from the node list + `parentId` — NOT from
 * edges — so the structure is stable regardless of how the model wired edges.
 *
 * When the graph has no phases, falls back to a plain dagre top-to-bottom DAG so
 * unstructured plans still render. Returns empty arrays for an empty graph.
 */
export function computePlanGraphLayout(
  graph: ParsedPlanGraph | null | undefined,
): PlanGraphLayoutResult {
  if (!graph || graph.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const phases = graph.nodes.filter((node) => node.kind === 'phase');
  if (phases.length === 0) {
    return dagreFallbackLayout(graph);
  }

  const phaseIds = new Set(phases.map((phase) => phase.id));
  const tasksByPhase = new Map<string, PlanGraphNode[]>();
  for (const phase of phases) {
    tasksByPhase.set(phase.id, []);
  }
  const orphanTasks: PlanGraphNode[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'task') {
      continue;
    }
    const bucket =
      node.parentId && phaseIds.has(node.parentId)
        ? tasksByPhase.get(node.parentId)
        : undefined;
    if (bucket) {
      bucket.push(node);
    } else {
      orphanTasks.push(node);
    }
  }

  // Each phase is one column; trailing column holds any unparented tasks.
  const columns: { phase: PlanGraphNode | null; tasks: PlanGraphNode[] }[] =
    phases.map((phase) => ({
      phase,
      tasks: tasksByPhase.get(phase.id) ?? [],
    }));
  if (orphanTasks.length > 0) {
    columns.push({ phase: null, tasks: orphanTasks });
  }

  const nodes: PlanFlowNode[] = [];
  const edges: PlanFlowEdge[] = [];
  const columnStep = PLAN_NODE_WIDTH + COLUMN_GAP;
  const rowStep = PLAN_NODE_HEIGHT + ROW_GAP;

  let previousPhaseId: string | null = null;
  columns.forEach((column, columnIndex) => {
    const x = columnIndex * columnStep;
    let tasksTop = 0;

    if (column.phase) {
      nodes.push(makeNode(column.phase, x, 0));
      tasksTop = PLAN_NODE_HEIGHT + PHASE_TO_TASKS_GAP;

      // Horizontal connector between consecutive phases (the header row).
      if (previousPhaseId) {
        edges.push({
          id: `phase-row:${previousPhaseId}->${column.phase.id}`,
          source: previousPhaseId,
          target: column.phase.id,
          sourceHandle: 'right',
          targetHandle: 'left',
          type: 'smoothstep',
        });
      }
      previousPhaseId = column.phase.id;
    }

    // Tasks stack downward; connect phase → first task and task → next task.
    let previousInColumn: string | null = column.phase ? column.phase.id : null;
    column.tasks.forEach((task, taskIndex) => {
      const y = tasksTop + taskIndex * rowStep;
      nodes.push(makeNode(task, x, y));
      if (previousInColumn) {
        edges.push({
          id: `seq:${previousInColumn}->${task.id}`,
          source: previousInColumn,
          target: task.id,
          sourceHandle: 'bottom',
          targetHandle: 'top',
          type: 'smoothstep',
          animated: true,
        });
      }
      previousInColumn = task.id;
    });
  });

  return { nodes, edges };
}

/** Plain dagre top-to-bottom layout for graphs without phase structure. */
function dagreFallbackLayout(graph: ParsedPlanGraph): PlanGraphLayoutResult {
  const known = new Set(graph.nodes.map((node) => node.id));

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({
    rankdir: 'TB',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 16,
    marginy: 16,
  });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    dagreGraph.setNode(node.id, {
      width: PLAN_NODE_WIDTH,
      height: PLAN_NODE_HEIGHT,
    });
  }

  const validEdges = graph.edges.filter(
    (edge) => known.has(edge.from) && known.has(edge.to),
  );
  for (const edge of validEdges) {
    dagreGraph.setEdge(edge.from, edge.to);
  }

  dagre.layout(dagreGraph);

  const nodes: PlanFlowNode[] = graph.nodes.map((node) => {
    const positioned = dagreGraph.node(node.id);
    const x = positioned === undefined ? 0 : positioned.x - PLAN_NODE_WIDTH / 2;
    const y =
      positioned === undefined ? 0 : positioned.y - PLAN_NODE_HEIGHT / 2;
    return makeNode(node, x, y);
  });

  const edges: PlanFlowEdge[] = validEdges.map((edge, index) => ({
    id: `${edge.from}->${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: 'bottom',
    targetHandle: 'top',
    type: 'smoothstep',
    animated: edge.kind === 'sequence',
  }));

  return { nodes, edges };
}
