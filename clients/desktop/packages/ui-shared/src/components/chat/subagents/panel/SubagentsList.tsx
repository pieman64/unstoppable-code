import { memo, useId, useMemo, type JSX, type MouseEvent } from 'react';
import { ThinkingSpinner } from '../../../ThinkingSpinner';
import { useSubagentsView } from '../subagents-view';
import { SubagentsList as ClassicSubagentsList } from './SubagentsListClassic';
import type {
  SubagentNode,
  SubagentSkipEdgeNode,
  SubagentSkipEdgeProjection,
  SubagentTree,
} from '@canopy/agent-transcript';
import { isSubagentChatKind } from '@canopy/agent-transcript';
import {
  ArrowUpRightIcon,
  ChevronDownMediumIcon,
} from '../../../../icons/AppIcons';
import { formatSubagentElapsed } from '../common/subagent-format';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import {
  SubagentWorkflowMark,
  SubagentWorkflowPhaseCountText,
  SubagentWorkflowRunStatusText,
  subagentWorkflowRunProgressNote,
  subagentWorkflowPhases,
  subagentWorkflowRunOf,
} from '../common/SubagentWorkflow';
import { OPERATIONAL_STATUS_COLORS } from '../../../../lib/operational-status-colors';
import {
  SUBAGENTS_LIST_LABEL,
  subagentStatusDetail,
  subagentWorkspaceShortLabel,
  subagentsDepthAccessibleLabel,
  subagentsToggleRowLabel,
  SUBAGENTS_OPEN_ROW_LABEL,
  SUBAGENT_OPEN_WORKFLOW_LABEL,
  subagentFilesCountLabel,
  subagentWorkflowPhasePositionLabel,
} from '../subagent-copy';
import type { SubagentChangeTotals } from '../types';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';

/**
 * Supported list layouts, chosen from the list's own available width.
 * `minimal` drops the status column for very narrow panels; each row still
 * announces its status to assistive technology, shimmers a running title,
 * and names any other status beside the title.
 */
export type SubagentsListColumns =
  | 'full'
  | 'no-workspace'
  | 'compact'
  | 'minimal';

/**
 * CSS grid template for a D9 column set. Task takes the remaining width; the
 * other columns are fixed (every row is its own grid, so an `auto` column
 * would land at a different place on each row). Changes is left out when no
 * listed task has changes to show, and Status when the filter already says
 * what every row's status is.
 */
export function subagentsListGrid(
  columns: SubagentsListColumns,
  showChanges: boolean,
  showStatus = true,
): string {
  const base = 'grid items-center gap-x-3';
  switch (columns) {
    case 'full':
      if (showChanges) {
        return showStatus
          ? `${base} grid-cols-[minmax(0,1fr)_7.5rem_7rem_4.5rem_5.5rem_3rem_1.75rem]`
          : `${base} grid-cols-[minmax(0,1fr)_7rem_4.5rem_5.5rem_3rem_1.75rem]`;
      }
      return showStatus
        ? `${base} grid-cols-[minmax(0,1fr)_7.5rem_7rem_4.5rem_3rem_1.75rem]`
        : `${base} grid-cols-[minmax(0,1fr)_7rem_4.5rem_3rem_1.75rem]`;
    case 'no-workspace':
      return showStatus
        ? `${base} grid-cols-[minmax(0,1fr)_7.5rem_7rem_3rem_1.75rem]`
        : `${base} grid-cols-[minmax(0,1fr)_7rem_3rem_1.75rem]`;
    case 'compact':
      return showStatus
        ? `${base} grid-cols-[minmax(0,1fr)_6.5rem_3rem_1.75rem]`
        : `${base} grid-cols-[minmax(0,1fr)_3rem_1.75rem]`;
    case 'minimal':
      return `${base} grid-cols-[minmax(0,1fr)_3rem_1.75rem]`;
  }
}

/** Whether a column set shows the Status column. */
function hasStatusColumn(
  columns: SubagentsListColumns,
  showStatus: boolean,
): boolean {
  return showStatus && columns !== 'minimal';
}

/** Whether a status draws its title in the shimmer of work in progress. */
function isRunningStatus(status: SubagentNode['status']): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * The Status column's ink: neutral secondary text, with failure the one
 * status that keeps its intent (DESIGN.md: failed is destructive). Running
 * is told by the title's shimmer, not a color.
 */
function listStatusInk(status: SubagentNode['status']): string {
  return status === 'failed'
    ? OPERATIONAL_STATUS_COLORS.failed.foreground
    : 'fg-secondary';
}

/** Row geometry shared by every row kind, so they line up. */
// The 2px left side and a quarter-pixel transform (layout snaps padding to
// whole pixels) put each row's drawn chevron on the toolbar's left line, the
// filter pill's outer edge (measured at 2x); the right keeps 12px before the
// open arrow.
const ROW_CLASS =
  'h-10 shrink-0 rounded-md pl-0.5 pr-3 text-xs translate-x-[calc(var(--spacing)/16)]';

/** Whether a column set has the Model column. */
function hasModelColumn(columns: SubagentsListColumns): boolean {
  return columns === 'full' || columns === 'no-workspace';
}

/** One pre-order item for the subagent list. */
export interface SubagentsListEntry {
  /** The task shown by this row. */
  readonly node: SubagentNode;
  /** Indentation relative to the visible list root. */
  readonly depth: number;
  /** Hidden ancestors skipped by an Active or Attention projection. */
  readonly via?: readonly SubagentNode[];
  /** Whether this visible row has visible child rows. */
  readonly hasChildren: boolean;
}

/** Props for a selectable row and its separate Open chat action. */
export interface SubagentsListRowProps {
  /** The subagent represented by this row. */
  readonly node: SubagentNode;
  /** Visual indentation from the list top. */
  readonly depth: number;
  /** Absolute tree depth reported after indentation is capped. */
  readonly absoluteDepth: number;
  /** Whether this row has children in the current list projection. */
  readonly hasChildren: boolean;
  /** Whether the inspector or drawer is showing this task. */
  readonly selected: boolean;
  /** Visible list column set. */
  readonly columns: SubagentsListColumns;
  /** Whether the list shows the Changes column. */
  readonly showChanges: boolean;
  /** Whether the list shows the Status column; defaults to true. */
  readonly showStatus?: boolean;
  /** Whether this row's children are hidden. */
  readonly collapsed?: boolean;
  /** Shows or hides this row's children. */
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
  /** Whether worktree and change details are available. */
  readonly showWorkspaceDetails: boolean;
  /** Optional authorized totals for this node. */
  readonly changeTotals?: SubagentChangeTotals;
  /** Clock value used to keep elapsed labels deterministic. */
  readonly now: number;
  /** Selects the inspector/drawer subject. */
  readonly onSelect: (node: SubagentNode) => void;
  /** Opens this subagent's chat directly. */
  readonly onOpenChat: (node: SubagentNode) => void;
}

function Indent({
  depth,
  absoluteDepth,
}: {
  readonly depth: number;
  readonly absoluteDepth: number;
}): JSX.Element | null {
  if (depth === 0) return null;
  const isCapped = depth > 4;
  return (
    <span
      className="flex shrink-0 items-center justify-end pr-1 text-3xs tabular-nums fg-tertiary"
      style={{ width: Math.min(depth, 4) * 16 }}
      aria-label={
        isCapped ? subagentsDepthAccessibleLabel(absoluteDepth) : undefined
      }
    >
      {isCapped ? absoluteDepth : null}
    </span>
  );
}

/** Memoized list row, with capped indentation and a direct-open action. */
export const SubagentsListRow = memo(function SubagentsListRow({
  node,
  depth,
  absoluteDepth,
  hasChildren,
  selected,
  columns,
  showChanges,
  showStatus = true,
  collapsed = false,
  onToggleCollapsed,
  showWorkspaceDetails,
  changeTotals,
  now,
  onSelect,
  onOpenChat,
}: SubagentsListRowProps): JSX.Element {
  const titleId = useId();
  const toggleLabelId = useId();
  const openLabelId = useId();
  const workspace = subagentWorkspaceShortLabel(node);
  const showWorkspace = showWorkspaceDetails;
  const running = isRunningStatus(node.status);
  const statusColumn = hasStatusColumn(columns, showStatus);
  const openChat = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onOpenChat(node);
  };

  return (
    <div
      role="row"
      data-testid={`subagents-list-row-${node.id}`}
      aria-selected={selected}
      onClick={(): void => onSelect(node)}
      className={`${subagentsListGrid(columns, showChanges, showStatus)} ${ROW_CLASS} ${selected ? 'bg-secondary' : 'hover:bg-subtle'}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-labelledby={`${toggleLabelId} ${titleId}`}
            data-testid={`subagents-list-toggle-${node.id}`}
            onClick={(event): void => {
              event.stopPropagation();
              onToggleCollapsed(node);
            }}
            className="focus-ring inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm fg-secondary hover:fg-primary"
          >
            <ChevronDownMediumIcon
              aria-hidden
              className={`h-4 w-4 transition-[rotate] ${collapsed ? '-rotate-90' : 'rotate-0'}`}
            />
            <span id={toggleLabelId} className="sr-only">
              {subagentsToggleRowLabel(collapsed)}
            </span>
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {/* The 14px icon slot: the chat tab's spinner while the task runs
            (it follows the Labs loader choice), empty otherwise, so every
            title starts at the same place. */}
        <span
          aria-hidden="true"
          data-testid={`subagents-list-status-${node.id}`}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        >
          {running ? <ThinkingSpinner sizePx={14} tone="accent" /> : null}
        </span>
        <button
          type="button"
          aria-pressed={selected}
          data-testid={`subagents-list-select-${node.id}`}
          data-status={node.status}
          onClick={(event): void => {
            event.stopPropagation();
            onSelect(node);
          }}
          className="min-w-0 flex-1 truncate text-left fg-primary focus-ring"
        >
          <span
            id={titleId}
            data-testid={`subagents-list-title-${node.id}`}
            className={REPLAY_MASK_CLASS}
          >
            {node.title}
          </span>
          {!statusColumn && running ? (
            <span className="sr-only">, {subagentStatusDetail(node)}</span>
          ) : null}
        </button>
        {/* Without the Status column (the minimal set, or the Active
            filter), a running row says so with its spinner and every other
            row (queued, awaiting approval, settled) names its status. */}
        {!statusColumn && !running ? (
          // Shrinks after the title has kept half the row, so a long status
          // ("Idle · 2 active below") never squeezes the title to one letter.
          <span
            className={`min-w-0 max-w-1/2 truncate ${listStatusInk(node.status)}`}
          >
            {subagentStatusDetail(node)}
          </span>
        ) : null}
      </span>
      {statusColumn ? (
        <span
          role="gridcell"
          className={`truncate ${listStatusInk(node.status)}`}
        >
          {subagentStatusDetail(node)}
        </span>
      ) : null}
      {hasModelColumn(columns) ? (
        <span
          role="gridcell"
          className="flex min-w-0 items-center gap-1.5 fg-secondary"
        >
          <SubagentHarnessMark harnessId={node.harnessId} />
          <span className="truncate">{node.modelLabel ?? ''}</span>
        </span>
      ) : null}
      {columns === 'full' ? (
        <span role="gridcell" className="truncate fg-secondary">
          {showWorkspace ? (workspace ?? '') : ''}
        </span>
      ) : null}
      {columns === 'full' && showChanges ? (
        <span role="gridcell" className="truncate text-2xs">
          {showWorkspaceDetails && changeTotals ? (
            <span className="inline-flex items-center gap-1">
              <SubagentChangesLabel
                additions={changeTotals.additions}
                deletions={changeTotals.deletions}
              />
              <span className="fg-tertiary">
                {subagentFilesCountLabel(changeTotals.filesChanged)}
              </span>
            </span>
          ) : null}
        </span>
      ) : null}
      <span
        role="gridcell"
        className="truncate text-right tabular-nums fg-tertiary"
      >
        {formatSubagentElapsed(node, now)}
      </span>
      {isSubagentChatKind(node.kind) ? (
        <button
          type="button"
          aria-labelledby={`${openLabelId} ${titleId}`}
          data-testid={`subagents-list-open-${node.id}`}
          onClick={openChat}
          className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md fg-tertiary hover:bg-secondary hover:fg-primary"
        >
          <ArrowUpRightIcon size={14} aria-hidden />
          <span id={openLabelId} className="sr-only">
            {SUBAGENTS_OPEN_ROW_LABEL}
          </span>
        </button>
      ) : (
        <span role="gridcell" />
      )}
    </div>
  );
});

SubagentsListRow.displayName = 'SubagentsListRow';

interface WorkflowGroupRowProps {
  readonly node: SubagentNode;
  readonly depth: number;
  readonly absoluteDepth: number;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly columns: SubagentsListColumns;
  readonly showChanges: boolean;
  readonly showStatus: boolean;
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
}

function WorkflowGroupToggle({
  node,
  titleId,
  collapsed,
  onToggleCollapsed,
}: {
  readonly node: SubagentNode;
  /** Id of the row's masked title, which names the toggle with its verb. */
  readonly titleId: string;
  readonly collapsed: boolean;
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
}): JSX.Element {
  const labelId = useId();
  return onToggleCollapsed ? (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-labelledby={`${labelId} ${titleId}`}
      data-testid={`subagents-list-toggle-${node.id}`}
      onClick={(event): void => {
        event.stopPropagation();
        onToggleCollapsed(node);
      }}
      className="focus-ring inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm fg-secondary hover:fg-primary"
    >
      <ChevronDownMediumIcon
        aria-hidden
        className={`h-4 w-4 transition-[rotate] ${collapsed ? '-rotate-90' : 'rotate-0'}`}
      />
      <span id={labelId} className="sr-only">
        {subagentsToggleRowLabel(collapsed)}
      </span>
    </button>
  ) : (
    <span className="w-4 shrink-0" />
  );
}

function workflowPhasePositionLabel(
  tree: SubagentTree,
  phase: SubagentNode,
): string {
  const run = subagentWorkflowRunOf(tree, phase);
  const phaseCount =
    phase.workflow?.phaseCount ??
    run?.workflow?.phaseCount ??
    (run ? subagentWorkflowPhases(tree, run).length : 0);
  return subagentWorkflowPhasePositionLabel(
    phase.workflow?.phaseIndex ?? 0,
    phaseCount,
  );
}

function SubagentWorkflowRunListRow({
  tree,
  node,
  depth,
  absoluteDepth,
  hasChildren,
  collapsed,
  columns,
  showChanges,
  showStatus,
  onToggleCollapsed,
  selected,
  now,
  onSelect,
  onOpenWorkflow,
}: WorkflowGroupRowProps & {
  readonly tree: SubagentTree;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: (node: SubagentNode) => void;
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
}): JSX.Element {
  const titleId = useId();
  const openLabelId = useId();
  const openWorkflow = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onOpenWorkflow?.(node);
  };
  return (
    <div
      role="row"
      data-testid={`subagents-list-row-${node.id}`}
      aria-selected={selected}
      onClick={(): void => onSelect(node)}
      className={`${subagentsListGrid(columns, showChanges, showStatus)} ${ROW_CLASS} ${selected ? 'bg-secondary' : 'hover:bg-subtle'}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <WorkflowGroupToggle
            node={node}
            titleId={titleId}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <SubagentWorkflowMark size={12} />
        <button
          type="button"
          aria-pressed={selected}
          data-testid={`subagents-list-select-${node.id}`}
          onClick={(event): void => {
            event.stopPropagation();
            onSelect(node);
          }}
          className="min-w-0 flex-1 truncate text-left font-medium fg-primary focus-ring"
        >
          <span id={titleId} className={REPLAY_MASK_CLASS}>
            {node.title}
          </span>
          {!hasStatusColumn(columns, showStatus) ? (
            <span className="sr-only">
              , <SubagentWorkflowRunStatusText tree={tree} run={node} short />
            </span>
          ) : null}
        </button>
        <span className="min-w-0 shrink-0 truncate text-2xs fg-tertiary">
          {subagentWorkflowRunProgressNote(tree, node)}
        </span>
      </span>
      {hasStatusColumn(columns, showStatus) ? (
        <span role="gridcell" className="truncate">
          <SubagentWorkflowRunStatusText tree={tree} run={node} short />
        </span>
      ) : null}
      {hasModelColumn(columns) ? <span role="gridcell" /> : null}
      {columns === 'full' ? <span role="gridcell" /> : null}
      {columns === 'full' && showChanges ? <span role="gridcell" /> : null}
      <span
        role="gridcell"
        className="truncate text-right tabular-nums fg-tertiary"
      >
        {formatSubagentElapsed(node, now)}
      </span>
      {onOpenWorkflow ? (
        <button
          type="button"
          aria-labelledby={`${openLabelId} ${titleId}`}
          data-testid={`subagents-list-open-${node.id}`}
          onClick={openWorkflow}
          className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md fg-tertiary hover:bg-secondary hover:fg-primary"
        >
          <ArrowUpRightIcon size={14} aria-hidden />
          <span id={openLabelId} className="sr-only">
            {SUBAGENT_OPEN_WORKFLOW_LABEL}
          </span>
        </button>
      ) : (
        <span role="gridcell" />
      )}
    </div>
  );
}

function SubagentWorkflowPhaseListRow({
  tree,
  node,
  depth,
  absoluteDepth,
  hasChildren,
  collapsed,
  columns,
  showChanges,
  showStatus,
  onToggleCollapsed,
}: WorkflowGroupRowProps & { readonly tree: SubagentTree }): JSX.Element {
  const titleId = useId();
  return (
    <div
      role="row"
      data-testid={`subagents-list-row-${node.id}`}
      className={`${subagentsListGrid(columns, showChanges, showStatus)} ${ROW_CLASS}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <WorkflowGroupToggle
            node={node}
            titleId={titleId}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          id={titleId}
          className={`${REPLAY_MASK_CLASS} min-w-0 truncate fg-secondary`}
        >
          {node.title}
        </span>
        <span className="shrink-0 text-2xs tabular-nums fg-tertiary">
          {workflowPhasePositionLabel(tree, node)}
        </span>
        {!hasStatusColumn(columns, showStatus) ? (
          <span className="sr-only">
            , <SubagentWorkflowPhaseCountText tree={tree} phase={node} />
          </span>
        ) : null}
      </span>
      {hasStatusColumn(columns, showStatus) ? (
        <span role="gridcell" className="truncate">
          <SubagentWorkflowPhaseCountText tree={tree} phase={node} />
        </span>
      ) : null}
      {hasModelColumn(columns) ? <span role="gridcell" /> : null}
      {columns === 'full' ? <span role="gridcell" /> : null}
      {columns === 'full' && showChanges ? <span role="gridcell" /> : null}
      <span role="gridcell" />
      <span role="gridcell" />
    </div>
  );
}

/** Props for the pure pre-order list body. */
export interface SubagentsListProps {
  /** Complete tree whose nodes are rendered. */
  readonly tree: SubagentTree;
  /** Skip-edge projection for a non-All filter, if any. */
  readonly projection?: SubagentSkipEdgeProjection;
  /** Currently selected task id. */
  readonly selectedId: string | null;
  /** Which columns are available at this width. */
  readonly columns: SubagentsListColumns;
  /**
   * Whether rows show the Status column. Off under the Active filter, where
   * running rows show their spinner and the rest (queued, awaiting approval)
   * name their status beside the title. Defaults to true.
   */
  readonly showStatus?: boolean;
  /** Tasks whose children are hidden. */
  readonly collapsedIds?: ReadonlySet<string>;
  /** Shows or hides a task's children; parents get a toggle when set. */
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
  /** Whether workspace and change metadata is available on this surface. */
  readonly showWorkspaceDetails: boolean;
  /** Optional host-authorized change lookup. */
  readonly changeTotals?: (
    node: SubagentNode,
  ) => SubagentChangeTotals | undefined;
  /** Current clock for elapsed time. */
  readonly now: number;
  /** Selects a task row. */
  readonly onSelectNode: (node: SubagentNode) => void;
  /** Opens a subagent chat directly. */
  readonly onOpenChat: (node: SubagentNode) => void;
  /** Opens the workflow inspector for a workflow run. */
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
}

function flattenEntries(
  tree: SubagentTree,
  projection: SubagentSkipEdgeProjection | undefined,
  collapsedIds: ReadonlySet<string>,
): readonly SubagentsListEntry[] {
  const entries: SubagentsListEntry[] = [];
  if (projection) {
    const stack: {
      readonly item: SubagentSkipEdgeNode;
      readonly depth: number;
    }[] = [];
    for (let index = projection.items.length - 1; index >= 0; index -= 1) {
      const item = projection.items[index];
      if (item) stack.push({ item, depth: 0 });
    }
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      entries.push({
        node: current.item.node,
        depth: current.depth,
        via: current.item.via,
        hasChildren: current.item.children.length > 0,
      });
      if (
        collapsedIds.has(current.item.node.id) &&
        isSubagentChatKind(current.item.node.kind)
      )
        continue;
      for (
        let index = current.item.children.length - 1;
        index >= 0;
        index -= 1
      ) {
        const child = current.item.children[index];
        if (child) stack.push({ item: child, depth: current.depth + 1 });
      }
    }
    return entries;
  }

  const stack: { readonly node: SubagentNode; readonly depth: number }[] = [];
  for (let index = tree.rootChildIds.length - 1; index >= 0; index -= 1) {
    const id = tree.rootChildIds[index];
    const node = id === undefined ? undefined : tree.nodes.get(id);
    if (node) stack.push({ node, depth: 0 });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const children = current.node.childIds.flatMap((id) => {
      const child = tree.nodes.get(id);
      return child ? [child] : [];
    });
    entries.push({
      node: current.node,
      depth: current.depth,
      hasChildren: children.length > 0,
    });
    if (collapsedIds.has(current.node.id)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return entries;
}

const NO_COLLAPSED_IDS: ReadonlySet<string> = new Set();

/** Memoized task rows in pre-order, for Tree/List parity. */
function SubagentsViewList({
  tree,
  projection,
  selectedId,
  columns,
  showStatus = true,
  collapsedIds = NO_COLLAPSED_IDS,
  onToggleCollapsed,
  showWorkspaceDetails,
  changeTotals,
  now,
  onSelectNode,
  onOpenChat,
  onOpenWorkflow,
}: SubagentsListProps): JSX.Element {
  const entries = useMemo(
    () => flattenEntries(tree, projection, collapsedIds),
    [collapsedIds, projection, tree],
  );
  const changeTotalsById = useMemo(
    () =>
      new Map(
        entries.map(
          (entry) => [entry.node.id, changeTotals?.(entry.node)] as const,
        ),
      ),
    [changeTotals, entries],
  );
  const showChanges =
    showWorkspaceDetails &&
    Array.from(changeTotalsById.values()).some(
      (totals) => totals !== undefined,
    );
  return (
    <div
      role="grid"
      aria-label={SUBAGENTS_LIST_LABEL}
      data-testid="subagents-list"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-1.5">
        {entries.map((entry) => {
          const node = entry.node;
          const groupToggle = projection ? undefined : onToggleCollapsed;
          if (node.kind === 'workflow-run') {
            return (
              <SubagentWorkflowRunListRow
                key={node.id}
                tree={tree}
                node={node}
                depth={entry.depth}
                absoluteDepth={node.depth}
                hasChildren={entry.hasChildren}
                selected={node.id === selectedId}
                columns={columns}
                showChanges={showChanges}
                showStatus={showStatus}
                collapsed={!projection && collapsedIds.has(node.id)}
                onToggleCollapsed={groupToggle}
                now={now}
                onSelect={onSelectNode}
                onOpenWorkflow={onOpenWorkflow}
              />
            );
          }
          if (node.kind === 'workflow-phase') {
            return (
              <SubagentWorkflowPhaseListRow
                key={node.id}
                tree={tree}
                node={node}
                depth={entry.depth}
                absoluteDepth={node.depth}
                hasChildren={entry.hasChildren}
                columns={columns}
                showChanges={showChanges}
                showStatus={showStatus}
                collapsed={!projection && collapsedIds.has(node.id)}
                onToggleCollapsed={groupToggle}
              />
            );
          }
          return (
            <SubagentsListRow
              key={node.id}
              node={node}
              depth={entry.depth}
              absoluteDepth={node.depth}
              hasChildren={entry.hasChildren}
              selected={node.id === selectedId}
              columns={columns}
              showChanges={showChanges}
              showStatus={showStatus}
              collapsed={collapsedIds.has(node.id)}
              onToggleCollapsed={onToggleCollapsed}
              showWorkspaceDetails={showWorkspaceDetails}
              changeTotals={changeTotalsById.get(node.id)}
              now={now}
              onSelect={onSelectNode}
              onOpenChat={onOpenChat}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The Subagents list: spinner rows without a column header under the
 * Subagents view experiment, the classic list otherwise.
 */
export function SubagentsList(props: SubagentsListProps): JSX.Element {
  return useSubagentsView() ? (
    <SubagentsViewList {...props} />
  ) : (
    <ClassicSubagentsList {...props} />
  );
}
