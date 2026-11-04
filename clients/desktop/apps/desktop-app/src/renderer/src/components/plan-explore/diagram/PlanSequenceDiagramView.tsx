import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  TextArea,
  ThinkingSpinner,
  Heading,
} from '@canopy/ui-shared/components';
import { DiagramCenteredMessage } from './DiagramCenteredMessage';
import type { PlanDiagramArtifact } from '@canopy/desktop-shared/types/plan-diagrams';
import type { ParsedPlanGraph } from '@canopy/desktop-shared/types/plan-diagrams';
import {
  computePlanGraphLayout,
  PLAN_NODE_HEIGHT,
  PLAN_NODE_WIDTH,
  type PlanFlowEdge,
  type PlanFlowNode,
  type PlanFlowNodeData,
} from './planGraphLayout';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type { AddNodeCommentInput } from '../usePlanComments';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface PlanSequenceDiagramProps {
  artifact: PlanDiagramArtifact<ParsedPlanGraph> | undefined;
  /** Trigger on-demand generation/refresh of the diagrams. */
  onGenerate?: () => void;
  /** True while a generation run is in flight. */
  isGenerating?: boolean;
  /** Stage a comment anchored to the selected node. */
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
}

interface SelectedNode {
  id: string;
  data: PlanFlowNodeData;
}

/** Custom React Flow node: bold title + muted description, phase/task styling. */
function PlanFlowNodeView({ data }: NodeProps<PlanFlowNode>): JSX.Element {
  const isPhase = data.kind === 'phase';
  const searchRing =
    data.searchState === 'active'
      ? 'ring-2 ring-line-attention'
      : data.searchState === 'match'
        ? 'ring-1 ring-line-attention/60'
        : '';
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-md border px-3 py-2 text-left ${
        isPhase ? 'border-line-accent/60 bg-accent/[0.08]' : 'bg-card'
      } ${searchRing}`}
      style={{ width: PLAN_NODE_WIDTH, height: PLAN_NODE_HEIGHT }}
    >
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        className="!opacity-0"
      />
      {isPhase && (
        <>
          <Handle
            id="left"
            type="target"
            position={Position.Left}
            className="!opacity-0"
          />
          <Handle
            id="right"
            type="source"
            position={Position.Right}
            className="!opacity-0"
          />
        </>
      )}
      <div className="flex items-center gap-1.5">
        <Badge size="compact" muted={!isPhase}>
          {data.kind}
        </Badge>
        <span className="min-w-0 truncate text-xs font-semibold fg-primary">
          {data.title}
        </span>
      </div>
      <p className="line-clamp-2 text-2xs leading-tight fg-secondary">
        {data.description}
      </p>
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
      />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { plan: PlanFlowNodeView };

function SelectedNodeDetail({
  node,
  onClose,
  onAddNodeComment,
}: {
  node: SelectedNode;
  onClose: () => void;
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
}): JSX.Element {
  const { data } = node;
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');

  const handleSave = (): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || !onAddNodeComment) {
      return;
    }
    onAddNodeComment({
      diagramKind: 'sequence',
      nodeId: node.id,
      title: data.title,
      detail: data.detail,
      files: data.files,
      headingPath: data.headingPath,
      quote: data.quote,
      body: trimmed,
    });
    setBody('');
    setComposing(false);
  };

  return (
    <div className="absolute bottom-3 left-3 right-3 z-20 max-h-3/5 overflow-auto rounded-lg bg-popover p-3 shadow-lg">
      <div className="mb-1 flex items-start justify-between gap-2">
        <Heading level={4} variant="title">
          {data.title}
        </Heading>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onClose}
          aria-label="Close node detail"
        >
          <AppCatalogCloseIcon width="14" height="14" />
        </Button>
      </div>
      <p className="mb-2 text-xs fg-secondary">{data.description}</p>
      {data.detail && (
        <p className="mb-2 whitespace-pre-wrap text-xs fg-primary">
          {data.detail}
        </p>
      )}
      {data.files && data.files.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-3xs font-medium fg-secondary">Files</p>
          <ul className="flex flex-col gap-0.5">
            {data.files.map((file) => (
              <li key={file} className="truncate font-mono text-2xs fg-primary">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}
      {((data.headingPath && data.headingPath.length > 0) || data.quote) && (
        <div>
          <p className="mb-1 text-3xs font-medium fg-secondary">Plan anchor</p>
          {data.headingPath && data.headingPath.length > 0 && (
            <p className="text-2xs fg-secondary">
              {data.headingPath.join(' › ')}
            </p>
          )}
          {data.quote && (
            <p className="mt-0.5 border-l-2 pl-2 text-2xs italic fg-secondary">
              {data.quote}
            </p>
          )}
        </div>
      )}
      {onAddNodeComment && (
        <div className="mt-3 border-t pt-2">
          {composing ? (
            <div className="flex flex-col gap-1.5">
              <TextArea
                aria-label="Comment"
                value={body}
                onChange={(e): void => setBody(e.target.value)}
                placeholder="Comment on this node…"
                rows={3}
                autoFocus
                data-testid="plan-node-comment-input"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  size="compact"
                  onClick={(): void => {
                    setComposing(false);
                    setBody('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="compact"
                  onClick={handleSave}
                  disabled={body.trim().length === 0}
                  data-testid="plan-node-comment-save"
                >
                  Save comment
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="compact"
              onClick={(): void => setComposing(true)}
              data-testid="plan-node-add-comment"
            >
              + Add comment
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lowercased searchable text for a plan node. */
function nodeSearchText(data: PlanFlowNodeData): string {
  return `${data.title} ${data.description} ${data.detail ?? ''}`.toLowerCase();
}

/**
 * Renders the persisted parsed-plan sequence diagram as a vertical, clickable
 * dependency tree. Surfaces loading / updating / error states derived from the
 * artifact envelope status, and an in-panel detail popover when a node is
 * clicked. Exposes a `DiagramSearchHandle` so the Explore modal search can
 * highlight and reveal matching nodes.
 */
export const PlanSequenceDiagram = forwardRef<
  DiagramSearchHandle,
  PlanSequenceDiagramProps
>(function PlanSequenceDiagram(
  { artifact, onGenerate, isGenerating = false, onAddNodeComment },
  ref,
): JSX.Element {
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [matchIds, setMatchIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const data = artifact?.data ?? null;
  const status = artifact?.status;

  const { nodes: baseNodes, edges } = useMemo(
    () => computePlanGraphLayout(data),
    [data],
  );

  // Keep the latest laid-out nodes and React Flow instance in refs so the
  // imperative search handle (deps `[]`) always reads fresh values.
  const nodesRef = useRef<PlanFlowNode[]>(baseNodes);
  nodesRef.current = baseNodes;
  const instanceRef = useRef<ReactFlowInstance<
    PlanFlowNode,
    PlanFlowEdge
  > | null>(null);

  // Merge the search outline state into node data for rendering.
  const nodes = useMemo<PlanFlowNode[]>(
    () =>
      baseNodes.map((node) => {
        const searchState: 'match' | 'active' | undefined =
          node.id === activeId
            ? 'active'
            : matchIds.has(node.id)
              ? 'match'
              : undefined;
        if (searchState === undefined && node.data.searchState === undefined) {
          return node;
        }
        return { ...node, data: { ...node.data, searchState } };
      }),
    [baseNodes, matchIds, activeId],
  );

  useImperativeHandle(
    ref,
    (): DiagramSearchHandle => ({
      search: (query: string): string[] => {
        const trimmed = query.trim().toLowerCase();
        if (trimmed.length === 0) {
          setMatchIds(new Set());
          setActiveId(null);
          return [];
        }
        const ordered = nodesRef.current
          .filter((node) => nodeSearchText(node.data).includes(trimmed))
          .sort(
            (a, b) =>
              a.position.y - b.position.y || a.position.x - b.position.x,
          );
        setMatchIds(new Set(ordered.map((node) => node.id)));
        setActiveId(null);
        return ordered.map((node) => node.id);
      },
      reveal: (nodeId: string): void => {
        if (nodeId === '') {
          setActiveId(null);
          return;
        }
        setActiveId(nodeId);
        const node = nodesRef.current.find(
          (candidate) => candidate.id === nodeId,
        );
        const instance = instanceRef.current;
        if (node && instance) {
          void instance.setCenter(
            node.position.x + PLAN_NODE_WIDTH / 2,
            node.position.y + PLAN_NODE_HEIGHT / 2,
            { zoom: instance.getZoom(), duration: 300 },
          );
        }
      },
      clear: (): void => {
        setMatchIds(new Set());
        setActiveId(null);
      },
    }),
    [],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<PlanFlowNode>>(
    (_event, node) => {
      setSelected({ id: node.id, data: node.data });
    },
    [],
  );

  const handlePaneClick = useCallback((): void => {
    setSelected(null);
  }, []);

  // Idle: no artifact has ever been generated for this plan, and nothing is in
  // flight. Offer an explicit Generate action instead of a misleading spinner.
  if (artifact === undefined && !isGenerating) {
    return (
      <div
        data-testid="plan-sequence-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <EmptyState
            inset="none"
            title="No sequence diagram yet."
            action={
              onGenerate ? (
                <Button
                  size="compact"
                  data-testid="plan-sequence-generate"
                  onClick={onGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? 'Generating…' : 'Generate diagram'}
                </Button>
              ) : undefined
            }
          />
        </DiagramCenteredMessage>
      </div>
    );
  }

  // Loading: actively generating (or optimistically requested) with no prior
  // data to show.
  if (
    !data &&
    (isGenerating || status === 'pending' || status === 'generating')
  ) {
    return (
      <div
        data-testid="plan-sequence-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <ThinkingSpinner />
          <p className="text-s fg-secondary">Generating diagram…</p>
        </DiagramCenteredMessage>
      </div>
    );
  }

  // Error with no usable prior data.
  if (status === 'error' && !data) {
    return (
      <div
        data-testid="plan-sequence-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <ErrorState
            space="panel"
            message={
              <>
                Couldn’t generate the diagram.
                {artifact?.error && (
                  <span className="mt-1 block max-w-sm text-xs fg-secondary">
                    {artifact.error}
                  </span>
                )}
              </>
            }
            onRetry={onGenerate}
            retrying={isGenerating}
            retryTestId="plan-sequence-retry"
          />
        </DiagramCenteredMessage>
      </div>
    );
  }

  // Ready (possibly with an updating/error overlay over existing data).
  if (nodes.length === 0) {
    return (
      <div
        data-testid="plan-sequence-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <p className="text-s fg-secondary">No diagram content available.</p>
        </DiagramCenteredMessage>
      </div>
    );
  }

  const isUpdating = status === 'stale' || status === 'generating';
  const hasErrorOverlay = status === 'error';

  return (
    <div
      data-testid="plan-sequence-diagram"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {isUpdating && (
        <Badge className="pointer-events-none absolute right-3 top-3 z-10">
          <ThinkingSpinner />
          Updating…
        </Badge>
      )}
      {hasErrorOverlay && (
        <Badge
          tone="danger"
          className="pointer-events-none absolute right-3 top-3 z-10"
        >
          Update failed
        </Badge>
      )}
      <ReactFlow<PlanFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={(instance): void => {
          instanceRef.current = instance;
        }}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selected && (
        <SelectedNodeDetail
          key={selected.id}
          node={selected}
          onClose={(): void => setSelected(null)}
          onAddNodeComment={onAddNodeComment}
        />
      )}
    </div>
  );
});

PlanSequenceDiagram.displayName = 'PlanSequenceDiagram';
