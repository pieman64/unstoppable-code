// The classic Subagents list, kept as it was before the Subagents view
// experiment so the panel is unchanged while that experiment is off. Remove
// this file when the experiment graduates or is dropped.
import { memo, useId, useMemo, type JSX, type MouseEvent } from 'react';
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
import {
  SubagentStatusGlyph,
  subagentStatusInk,
} from '../common/SubagentStatusGlyph';
import {
  SUBAGENT_OPEN_CHAT_LABEL,
  SUBAGENTS_COLUMN_CHANGES,
  SUBAGENTS_COLUMN_MODEL,
  SUBAGENTS_COLUMN_STATUS,
  SUBAGENTS_COLUMN_TASK,
  SUBAGENTS_COLUMN_TIME,
  SUBAGENTS_COLUMN_WORKSPACE,
  SUBAGENTS_LIST_LABEL,
  subagentStatusDetail,
  subagentViaLabel,
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
 * shows its status glyph and announces the status to assistive technology.
 */
export type SubagentsListColumns =
  | 'full'
  | 'no-workspace'
  | 'compact'
  | 'minimal';

/**
 * CSS grid template for a D9 column set. Task takes the remaining width; the
 * other columns are fixed so rows line up, and Changes is left out when no
 * listed task has changes to show.
 */
export function subagentsListGrid(
  columns: SubagentsListColumns,
  showChanges: boolean,
): string {
  switch (columns) {
    case 'full':
      return showChanges
        ? 'grid grid-cols-[minmax(0,1fr)_7.5rem_7rem_4.5rem_5.5rem_2.5rem_1.75rem] items-center gap-x-2'
        : 'grid grid-cols-[minmax(0,1fr)_7.5rem_7rem_4.5rem_2.5rem_1.75rem] items-center gap-x-2';
    case 'no-workspace':
      return 'grid grid-cols-[minmax(0,1fr)_7.5rem_7rem_2.5rem_1.75rem] items-center gap-x-2';
    case 'compact':
      return 'grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_auto_1.75rem] items-center gap-x-2';
    case 'minimal':
      return 'grid grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-x-2';
  }
}

/** Whether a column set has the Model column. */
function hasModelColumn(columns: SubagentsListColumns): boolean {
  return columns === 'full' || columns === 'no-workspace';
}

/** Props for the header row that names the visible list columns. */
export interface SubagentsListHeaderProps {
  /** The column set that applies to the rows below. */
  readonly columns: SubagentsListColumns;
  /** Whether a listed task has changes, which adds the Changes column. */
  readonly showChanges: boolean;
}

/** Pure, column-set-aware heading row. */
export function SubagentsListHeader({
  columns,
  showChanges,
}: SubagentsListHeaderProps): JSX.Element {
  return (
    <div
      role="row"
      className={`${subagentsListGrid(columns, showChanges)} h-8 shrink-0 border-b px-3 text-2xs fg-tertiary`}
    >
      <span role="columnheader">{SUBAGENTS_COLUMN_TASK}</span>
      {columns !== 'minimal' ? (
        <span role="columnheader">{SUBAGENTS_COLUMN_STATUS}</span>
      ) : null}
      {hasModelColumn(columns) ? (
        <span role="columnheader">{SUBAGENTS_COLUMN_MODEL}</span>
      ) : null}
      {columns === 'full' ? (
        <span role="columnheader">{SUBAGENTS_COLUMN_WORKSPACE}</span>
      ) : null}
      {columns === 'full' && showChanges ? (
        <span role="columnheader">{SUBAGENTS_COLUMN_CHANGES}</span>
      ) : null}
      <span role="columnheader" className="text-right">
        {SUBAGENTS_COLUMN_TIME}
      </span>
      <span role="columnheader" aria-label={SUBAGENT_OPEN_CHAT_LABEL} />
    </div>
  );
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
  /** Optional hidden ancestors to announce after the title. */
  readonly via?: readonly SubagentNode[];
  /** Visible list column set. */
  readonly columns: SubagentsListColumns;
  /** Whether the list shows the Changes column. */
  readonly showChanges: boolean;
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
  via,
  columns,
  showChanges,
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
      className={`${subagentsListGrid(columns, showChanges)} h-9 shrink-0 rounded-md px-3 text-xs ${selected ? 'bg-secondary' : 'hover:bg-subtle'}`}
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
        <SubagentStatusGlyph status={node.status} />
        <button
          type="button"
          aria-pressed={selected}
          data-testid={`subagents-list-select-${node.id}`}
          onClick={(event): void => {
            event.stopPropagation();
            onSelect(node);
          }}
          className="min-w-0 flex-1 truncate text-left fg-primary focus-ring"
        >
          <span id={titleId} className={REPLAY_MASK_CLASS}>
            {node.title}
          </span>
          {columns === 'minimal' ? (
            <span className="sr-only">, {subagentStatusDetail(node)}</span>
          ) : null}
        </button>
        {via && via.length > 0 ? (
          <span className="min-w-0 w-1/3 shrink-0 truncate text-2xs fg-tertiary">
            {subagentViaLabel(via)}
          </span>
        ) : null}
      </span>
      {columns !== 'minimal' ? (
        <span
          role="gridcell"
          className={`truncate ${subagentStatusInk(node.status)}`}
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
        className="whitespace-nowrap text-right tabular-nums fg-tertiary"
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
      className={`${subagentsListGrid(columns, showChanges)} h-9 shrink-0 rounded-md px-3 text-xs ${selected ? 'bg-secondary' : 'hover:bg-subtle'}`}
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
          {columns === 'minimal' ? (
            <span className="sr-only">
              , <SubagentWorkflowRunStatusText tree={tree} run={node} short />
            </span>
          ) : null}
        </button>
        <span className="min-w-0 shrink-0 truncate text-2xs fg-tertiary">
          {subagentWorkflowRunProgressNote(tree, node)}
        </span>
      </span>
      {columns !== 'minimal' ? (
        <span role="gridcell" className="truncate">
          <SubagentWorkflowRunStatusText tree={tree} run={node} short />
        </span>
      ) : null}
      {hasModelColumn(columns) ? <span role="gridcell" /> : null}
      {columns === 'full' ? <span role="gridcell" /> : null}
      {columns === 'full' && showChanges ? <span role="gridcell" /> : null}
      <span
        role="gridcell"
        className="whitespace-nowrap text-right tabular-nums fg-tertiary"
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
  onToggleCollapsed,
}: WorkflowGroupRowProps & { readonly tree: SubagentTree }): JSX.Element {
  const titleId = useId();
  return (
    <div
      role="row"
      data-testid={`subagents-list-row-${node.id}`}
      className={`${subagentsListGrid(columns, showChanges)} h-9 shrink-0 rounded-md px-3 text-xs`}
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
        {columns === 'minimal' ? (
          <span className="sr-only">
            , <SubagentWorkflowPhaseCountText tree={tree} phase={node} />
          </span>
        ) : null}
      </span>
      {columns !== 'minimal' ? (
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
export function SubagentsList({
  tree,
  projection,
  selectedId,
  columns,
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
      <SubagentsListHeader columns={columns} showChanges={showChanges} />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
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
              via={entry.via}
              columns={columns}
              showChanges={showChanges}
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
