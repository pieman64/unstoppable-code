import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type JSX,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type FitViewOptions,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  Pipeline,
  ExecutionState,
} from '@canopy/desktop-shared/types/pipeline';
import {
  buildDefinitionFlow,
  buildExecutionFlow,
  MATRIX_SUMMARY_ROW_HEIGHT,
  JOB_HEADER_HEIGHT,
  STEP_ROW_GAP,
  STEP_ROW_HEIGHT,
  STEP_LIST_PADDING_BOTTOM,
  STEP_LIST_PADDING_TOP,
  type PipelineFlowMatrixSummary,
  type PipelineFlowStatus,
  type PipelineJobNode,
} from '@/lib/pipelineFlowGraph';
import {
  OPERATIONAL_STATUS_COLORS,
  runStatusGlyphState,
} from '@canopy/ui-shared/lib';
import { StatusGlyph } from '@canopy/ui-shared/components';

const STATUS_BORDER: Record<PipelineFlowStatus, string> = {
  success: OPERATIONAL_STATUS_COLORS.success.border,
  failure: OPERATIONAL_STATUS_COLORS.failed.border,
  running: OPERATIONAL_STATUS_COLORS.active.border,
  restarting: OPERATIONAL_STATUS_COLORS.active.border,
  paused: OPERATIONAL_STATUS_COLORS.paused.border,
  queued: '',
  pending: '',
  cancelled: '',
  skipped: '',
  none: '',
};

/**
 * A node's status mark: the shared status glyph, or nothing for a node with
 * no run yet (the definition view), so an unrun workflow carries no marks.
 */
function FlowStatusGlyph({
  status,
  size,
}: {
  readonly status: PipelineFlowStatus;
  readonly size: 12 | 14;
}): JSX.Element | null {
  const state = runStatusGlyphState(status);
  return state === null ? null : <StatusGlyph state={state} size={size} />;
}

interface FlowInteraction {
  onSelectJob?: (jobId: string) => void;
  onSelectStep?: (jobId: string, stepIndex: number) => void;
}

const FlowInteractionContext = createContext<FlowInteraction>({});

/**
 * Matrix summary lines rendered inside one authored logical DAG node.
 */
function MatrixSummaryBody({
  jobId,
  summary,
}: {
  jobId: string;
  summary: PipelineFlowMatrixSummary;
}): JSX.Element | null {
  const lines = [
    summary.expandingLabel,
    summary.emptyLabel,
    summary.variantCountLabel,
    summary.completionLabel,
    summary.breakdownLabel,
    summary.maxParallelLabel,
  ].filter((line): line is string => line !== undefined && line !== '');

  if (lines.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-col border-t px-3"
      style={{
        paddingTop: STEP_LIST_PADDING_TOP,
        paddingBottom: STEP_LIST_PADDING_BOTTOM,
      }}
      data-testid={`pipeline-flow-matrix-summary-${jobId}`}
    >
      {lines.map((line) => (
        <span
          key={line}
          className="truncate text-3xs fg-secondary"
          style={{ height: MATRIX_SUMMARY_ROW_HEIGHT }}
        >
          {line}
        </span>
      ))}
    </div>
  );
}

function PipelineJobNodeView({
  data,
  sourcePosition,
  targetPosition,
}: NodeProps<PipelineJobNode>): JSX.Element {
  const { onSelectJob, onSelectStep } = useContext(FlowInteractionContext);
  const jobBorder = data.selected
    ? 'border-line-accent ring-1 ring-line-accent/60'
    : STATUS_BORDER[data.status];
  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left ${jobBorder}`}
    >
      <Handle
        type="target"
        position={targetPosition ?? Position.Top}
        className="!opacity-0"
      />
      <button
        type="button"
        className="nodrag flex shrink-0 items-center gap-2 px-3 text-left transition-colors hover:bg-fg-primary/[0.04]"
        style={{ height: JOB_HEADER_HEIGHT }}
        onClick={(e): void => {
          e.stopPropagation();
          onSelectJob?.(data.jobId);
        }}
      >
        <FlowStatusGlyph status={data.status} size={14} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold fg-primary">
          {data.label}
        </span>
        {data.matrix !== undefined && (
          <span className="shrink-0 rounded bg-fg-primary/[0.08] px-1 py-px font-mono text-3xs fg-secondary">
            matrix
          </span>
        )}
        {data.steps.length > 0 && (
          <span className="shrink-0 text-3xs fg-secondary">
            {data.steps.length}
          </span>
        )}
      </button>
      {data.matrix !== undefined && (
        <MatrixSummaryBody jobId={data.jobId} summary={data.matrix} />
      )}
      {data.steps.length > 0 && (
        <div
          className="flex flex-col border-t px-2"
          style={{
            rowGap: STEP_ROW_GAP,
            paddingTop: STEP_LIST_PADDING_TOP,
            paddingBottom: STEP_LIST_PADDING_BOTTOM,
          }}
        >
          {data.steps.map((step) => {
            const stepSelected = data.selectedStepIndex === step.stepIndex;
            const stepClass = stepSelected
              ? 'border-line-accent bg-accent-subtle'
              : 'bg-fg-primary/[0.03] hover:bg-fg-primary/[0.07]';
            return (
              <button
                key={step.stepIndex}
                type="button"
                className={`nodrag flex shrink-0 items-center gap-2 rounded border px-2 text-left transition-colors ${stepClass}`}
                style={{ height: STEP_ROW_HEIGHT }}
                onClick={(e): void => {
                  e.stopPropagation();
                  onSelectStep?.(data.jobId, step.stepIndex);
                }}
              >
                <FlowStatusGlyph status={step.status} size={12} />
                <span className="min-w-0 flex-1 truncate text-2xs fg-primary/80">
                  {step.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <Handle
        type="source"
        position={sourcePosition ?? Position.Bottom}
        className="!opacity-0"
      />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { pipelineJob: PipelineJobNodeView };

/**
 * Space a fitted graph keeps from the diagram's edges. The left side also
 * reserves the zoom controls' column (a 15px inset plus 26px buttons, and a
 * gutter), so no fitted node sits under them at any width.
 */
const PIPELINE_FLOW_FIT_VIEW_OPTIONS: FitViewOptions = {
  padding: { top: '16px', right: '16px', bottom: '16px', left: '56px' },
};

/**
 * Fits the graph again whenever the diagram's own size changes: a panel
 * resized, its job list collapsed, a hidden panel shown at a new width.
 * React Flow fits once, when the nodes are first measured, so a graph fitted
 * at one width is otherwise cut off at another. It reads the size React Flow
 * already observes, and fitting moves only the viewport, never the size, so
 * it cannot loop. A new run state at the same size does not refit, so a
 * user's own zoom survives live updates.
 *
 * Not gated on `useNodesInitialized`: with controlled nodes and no
 * `onNodesChange`, that flag only turns true on a later node update. React
 * Flow queues the fit and applies it once the nodes are measured.
 */
function FitViewOnResize(): null {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  const fittedSizeRef = useRef<string | null>(null);
  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const size = `${width}x${height}`;
    if (fittedSizeRef.current === size) return;
    fittedSizeRef.current = size;
    void fitView(PIPELINE_FLOW_FIT_VIEW_OPTIONS);
  }, [fitView, height, width]);
  return null;
}

export type PipelineFlowSource =
  | { kind: 'definition'; pipeline: Pipeline; jobOrder: string[] }
  | { kind: 'execution'; state: ExecutionState; jobOrder: string[] };

export type PipelineFlowSelection =
  | { type: 'job'; jobId: string }
  | { type: 'step'; jobId: string; stepIndex: number };

export function PipelineFlowDiagram({
  source,
  selection,
  onSelectJob,
  onSelectStep,
}: {
  source: PipelineFlowSource;
  selection?: PipelineFlowSelection;
  onSelectJob?: (jobId: string) => void;
  onSelectStep?: (jobId: string, stepIndex: number) => void;
}): JSX.Element {
  const { nodes, edges } = useMemo(() => {
    const flow =
      source.kind === 'definition'
        ? buildDefinitionFlow(source.pipeline, source.jobOrder)
        : buildExecutionFlow(source.state, source.jobOrder);
    return {
      edges: flow.edges,
      nodes: flow.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selected:
            selection?.type === 'job' && selection.jobId === node.data.jobId,
          selectedStepIndex:
            selection?.type === 'step' && selection.jobId === node.data.jobId
              ? selection.stepIndex
              : undefined,
        },
      })),
    };
  }, [selection, source]);

  const interaction = useMemo<FlowInteraction>(
    () => ({ onSelectJob, onSelectStep }),
    [onSelectJob, onSelectStep],
  );

  return (
    <FlowInteractionContext.Provider value={interaction}>
      <ReactFlow<PipelineJobNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={PIPELINE_FLOW_FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls
          showInteractive={false}
          fitViewOptions={PIPELINE_FLOW_FIT_VIEW_OPTIONS}
        />
        <FitViewOnResize />
      </ReactFlow>
    </FlowInteractionContext.Provider>
  );
}
