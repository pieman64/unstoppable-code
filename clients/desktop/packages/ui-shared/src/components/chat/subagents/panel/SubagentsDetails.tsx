import type { JSX, ReactNode } from 'react';
import {
  subagentAncestors,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/agent-transcript';
import {
  SUBAGENT_OPEN_CHAT_LABEL,
  SUBAGENT_OPEN_WORKFLOW_LABEL,
  SUBAGENT_STOP_WORKFLOW_FAILED_LABEL,
  SUBAGENT_STOP_WORKFLOW_LABEL,
  SUBAGENT_STOPPING_WORKFLOW_LABEL,
  SUBAGENTS_CLOSE_DETAILS_LABEL,
  SUBAGENTS_FOCUS_LABEL,
  SUBAGENTS_INSPECTOR_CHAT,
  SUBAGENTS_INSPECTOR_CHANGES,
  SUBAGENTS_INSPECTOR_LINEAGE,
  SUBAGENTS_INSPECTOR_MODEL,
  SUBAGENTS_INSPECTOR_PHASES,
  SUBAGENTS_INSPECTOR_RUN,
  SUBAGENTS_INSPECTOR_STARTED,
  SUBAGENTS_INSPECTOR_STARTED_NONE,
  SUBAGENTS_INSPECTOR_STARTED_TASKS,
  SUBAGENTS_INSPECTOR_TIME,
  SUBAGENTS_INSPECTOR_USAGE,
  SUBAGENTS_INSPECTOR_WORKSPACE,
  SUBAGENTS_STOP_FAILED_LABEL,
  SUBAGENT_SHOW_CHANGES_LABEL,
  subagentFilesCountLabel,
  subagentStatusDetail,
  subagentWorkflowRunPositionLabel,
  subagentWorkflowUsageLabel,
  subagentWorkspaceLabel,
} from '../subagent-copy';
import {
  DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL,
  DELEGATED_AGENT_STOP_LABEL,
  DELEGATED_AGENT_STOPPING_LABEL,
} from '../../delegated-agent-copy';
import type { SubagentChangeTotals } from '../types';
import {
  ArrowUpRightIcon,
  ChatIcon,
  CloseIcon,
} from '../../../../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { Button } from '../../../Button';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import {
  SubagentWorkflowMark,
  SubagentWorkflowPhaseCountText,
  SubagentWorkflowRunStatusText,
  subagentWorkflowPhases,
} from '../common/SubagentWorkflow';
import {
  formatSubagentDuration,
  formatSubagentElapsed,
} from '../common/subagent-format';
import { SubagentStatusGlyph } from '../common/SubagentStatusGlyph';
import { formatRelativeTime } from '../../../../lib/format-relative-time';
import { useSubagentsView } from '../subagents-view';
import {
  SubagentsDrawer as ClassicSubagentsDrawer,
  SubagentsInspector as ClassicSubagentsInspector,
} from './SubagentsDetailsClassic';

/** Shared callback and content props for the inspector and bottom drawer. */
export interface SubagentsDetailsProps {
  /** Complete source tree, used to show ancestry and started tasks. */
  readonly tree: SubagentTree;
  /** The selected task. */
  readonly node: SubagentNode;
  /** Whether the host exposes workspace and change details here. */
  readonly showWorkspaceDetails: boolean;
  /** Optional authorized totals for this task. */
  readonly changeTotals?: SubagentChangeTotals;
  /** Open this task's chat. */
  readonly onOpenChat: (node: SubagentNode) => void;
  /** Focus this task in the tree, when it has children. */
  readonly onFocus?: (node: SubagentNode) => void;
  /** Show the host's worktree changes view when workspace details are enabled. */
  readonly onShowChanges?: (node: SubagentNode) => void;
  /** Stop this live managed task and its descendants. */
  readonly onStop?: (node: SubagentNode) => void;
  /** Open this workflow run in the host's workflow view. */
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
  /** Stop this live workflow run in the host. */
  readonly onStopWorkflow?: (run: SubagentNode) => void;
  /** Whether the Stop workflow request is currently in flight. */
  readonly stoppingWorkflow?: boolean;
  /** Reason returned by the host after a refused Stop workflow. */
  readonly stopWorkflowError?: string;
  /** Current clock for elapsed workflow run time. */
  readonly now?: number;
  /** Whether the Stop request is currently in flight. */
  readonly stopping?: boolean;
  /** Reason returned by the host after a refused Stop. */
  readonly stopError?: string;
  /** Dismiss the detail surface. */
  readonly onClose: () => void;
}

/**
 * The key/value list: one text size, a fixed label column so every value
 * starts on the same line, and quiet tertiary labels.
 */
const INSPECTOR_LIST_CLASS =
  'grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-xs';

function InspectorRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt className="truncate fg-tertiary">{label}</dt>
      <dd className="min-w-0 fg-primary">{children}</dd>
    </>
  );
}

/** The details card's close control, shared by every details body. */
function CloseDetailsButton({
  onClose,
}: {
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="control"
      iconOnly
      aria-label={SUBAGENTS_CLOSE_DETAILS_LABEL}
      data-testid="subagents-inspector-close"
      onClick={onClose}
    >
      <CloseIcon size={14} aria-hidden />
    </Button>
  );
}

function SubagentsTaskDetailsBody({
  tree,
  node,
  showWorkspaceDetails,
  changeTotals,
  onOpenChat,
  onFocus,
  onShowChanges,
  onStop,
  stopping = false,
  stopError,
  now,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  const ancestors = [...subagentAncestors(tree, node.id)].reverse();
  const children = node.childIds.flatMap((childId) => {
    const child = tree.nodes.get(childId);
    return child ? [child.title] : [];
  });
  const workspace = subagentWorkspaceLabel(node);
  // A running task says so by shimmering its title; any other status gets one
  // neutral line under it. Never both.
  const running = node.status === 'running' || node.status === 'starting';
  const startedAt = node.startedAt ?? node.createdAt;

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <h4
            data-testid="subagents-inspector-title"
            className={`min-w-0 flex-1 truncate text-s font-medium ${running ? 'fg-secondary' : 'fg-primary'}`}
          >
            <span
              className={`${REPLAY_MASK_CLASS}${running ? ' canopy-text-shimmer' : ''}`}
            >
              {node.title}
            </span>
            {running ? (
              <span className="sr-only">, {subagentStatusDetail(node)}</span>
            ) : null}
          </h4>
          <CloseDetailsButton onClose={onClose} />
        </div>
        {running ? null : (
          <span
            data-testid="subagents-inspector-status"
            className="text-xs fg-secondary"
          >
            {subagentStatusDetail(node)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="control"
          data-testid="subagents-inspector-open-chat"
          onClick={(): void => onOpenChat(node)}
        >
          <ArrowUpRightIcon size={14} aria-hidden />
          {SUBAGENT_OPEN_CHAT_LABEL}
        </Button>
        {onFocus ? (
          <Button
            variant="secondary"
            size="control"
            data-testid="subagents-inspector-focus"
            onClick={(): void => onFocus(node)}
          >
            {SUBAGENTS_FOCUS_LABEL}
          </Button>
        ) : null}
        {onShowChanges ? (
          <Button
            variant="secondary"
            size="control"
            data-testid="subagents-inspector-show-changes"
            onClick={(): void => onShowChanges(node)}
          >
            {SUBAGENT_SHOW_CHANGES_LABEL}
          </Button>
        ) : null}
        {onStop ? (
          <Button
            variant="ghost"
            size="control"
            aria-label={DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL}
            disabled={stopping}
            data-testid="subagents-inspector-stop"
            onClick={(): void => onStop(node)}
          >
            {stopping
              ? DELEGATED_AGENT_STOPPING_LABEL
              : DELEGATED_AGENT_STOP_LABEL}
          </Button>
        ) : null}
      </div>

      {stopError ? (
        <p role="alert" className="text-xs fg-destructive">
          <span>{SUBAGENTS_STOP_FAILED_LABEL}</span> <span>{stopError}</span>
        </p>
      ) : null}

      <dl className={INSPECTOR_LIST_CLASS}>
        <InspectorRow label={SUBAGENTS_INSPECTOR_MODEL}>
          <span className="flex min-w-0 items-center gap-1.5">
            <SubagentHarnessMark harnessId={node.harnessId} />
            <span className="truncate">{node.modelLabel ?? ''}</span>
            {node.thinkingLevel ? (
              <span className="shrink-0 fg-secondary">
                · {node.thinkingLevel}
              </span>
            ) : null}
          </span>
        </InspectorRow>
        {showWorkspaceDetails && workspace ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_WORKSPACE}>
            {workspace}
          </InspectorRow>
        ) : null}
        {showWorkspaceDetails && changeTotals ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_CHANGES}>
            <span className="flex flex-wrap items-center gap-1.5">
              <SubagentChangesLabel
                additions={changeTotals.additions}
                deletions={changeTotals.deletions}
              />
              <span className="fg-secondary">
                {subagentFilesCountLabel(changeTotals.filesChanged)}
              </span>
            </span>
          </InspectorRow>
        ) : null}
        <InspectorRow label={SUBAGENTS_INSPECTOR_LINEAGE}>
          <span className="flex min-w-0 flex-col gap-1">
            {[tree.root, ...ancestors].map((entry) => (
              <span key={entry.id} className={`${REPLAY_MASK_CLASS} truncate`}>
                {entry.title}
              </span>
            ))}
          </span>
        </InspectorRow>
        {startedAt !== undefined ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_STARTED}>
            <span data-testid="subagents-inspector-started">
              {formatRelativeTime(startedAt, now)}
            </span>
          </InspectorRow>
        ) : null}
        <InspectorRow label={SUBAGENTS_INSPECTOR_STARTED_TASKS}>
          <span
            data-testid="subagents-inspector-started-tasks"
            className="flex min-w-0 flex-col gap-1"
          >
            {children.length > 0 ? (
              children.map((title, index) => (
                <span
                  key={`${index}:${title}`}
                  className={`${REPLAY_MASK_CLASS} truncate`}
                >
                  {title}
                </span>
              ))
            ) : (
              <span className="fg-secondary">
                {SUBAGENTS_INSPECTOR_STARTED_NONE}
              </span>
            )}
          </span>
        </InspectorRow>
      </dl>
    </>
  );
}

function SubagentsWorkflowRunDetailsBody({
  tree,
  node: run,
  onOpenWorkflow,
  onFocus,
  onStopWorkflow,
  stoppingWorkflow = false,
  stopWorkflowError,
  now,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  const phases = subagentWorkflowPhases(tree, run);
  const usage = subagentWorkflowUsageLabel(
    run.workflow?.tokens,
    run.workflow?.toolCalls,
  );
  const time =
    run.workflow?.durationMs !== undefined
      ? formatSubagentDuration(run.workflow.durationMs)
      : now !== undefined
        ? formatSubagentElapsed(run, now)
        : '';
  const hasActions = Boolean(onOpenWorkflow || onFocus || onStopWorkflow);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SubagentWorkflowMark size={14} />
          <h4
            className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-s font-medium fg-primary`}
          >
            {run.title}
          </h4>
          <CloseDetailsButton onClose={onClose} />
        </div>
        <span className="text-xs">
          <SubagentWorkflowRunStatusText tree={tree} run={run} />
        </span>
      </div>

      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2">
          {onOpenWorkflow ? (
            <Button
              variant="secondary"
              size="control"
              data-testid="subagents-inspector-open-workflow"
              onClick={(): void => onOpenWorkflow(run)}
            >
              <ArrowUpRightIcon size={14} aria-hidden />
              {SUBAGENT_OPEN_WORKFLOW_LABEL}
            </Button>
          ) : null}
          {onFocus ? (
            <Button
              variant="secondary"
              size="control"
              data-testid="subagents-inspector-focus"
              onClick={(): void => onFocus(run)}
            >
              {SUBAGENTS_FOCUS_LABEL}
            </Button>
          ) : null}
          {onStopWorkflow ? (
            <Button
              variant="ghost"
              size="control"
              aria-label={SUBAGENT_STOP_WORKFLOW_LABEL}
              disabled={stoppingWorkflow}
              data-testid="subagents-inspector-stop-workflow"
              onClick={(): void => onStopWorkflow(run)}
            >
              {stoppingWorkflow
                ? SUBAGENT_STOPPING_WORKFLOW_LABEL
                : SUBAGENT_STOP_WORKFLOW_LABEL}
            </Button>
          ) : null}
        </div>
      ) : null}

      {stopWorkflowError ? (
        <p role="alert" className="text-xs fg-destructive">
          <span>{SUBAGENT_STOP_WORKFLOW_FAILED_LABEL}</span>{' '}
          <span>{stopWorkflowError}</span>
        </p>
      ) : null}

      <dl className={INSPECTOR_LIST_CLASS}>
        <InspectorRow label={SUBAGENTS_INSPECTOR_CHAT}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0 fg-secondary">
              <ChatIcon size={12} aria-hidden />
            </span>
            <span className={`${REPLAY_MASK_CLASS} min-w-0 truncate`}>
              {tree.root.title}
            </span>
          </span>
        </InspectorRow>
        {run.workflow ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_RUN}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>
                {subagentWorkflowRunPositionLabel(
                  run.workflow.runOrdinal,
                  run.workflow.runCount,
                )}
              </span>
              <span className="truncate font-mono text-2xs fg-tertiary">
                {run.workflow.runId}
              </span>
            </span>
          </InspectorRow>
        ) : null}
        {phases.length > 0 ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_PHASES}>
            <span className="flex min-w-0 flex-col gap-1">
              {phases.map((phase) => (
                <span
                  key={phase.id}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <SubagentStatusGlyph status={phase.status} size={10} />
                  <span
                    className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}
                  >
                    {phase.title}
                  </span>
                  <span className="shrink-0">
                    <SubagentWorkflowPhaseCountText
                      tree={tree}
                      phase={phase}
                      quiet
                    />
                  </span>
                </span>
              ))}
            </span>
          </InspectorRow>
        ) : null}
        {usage ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_USAGE}>{usage}</InspectorRow>
        ) : null}
        {time ? (
          <InspectorRow label={SUBAGENTS_INSPECTOR_TIME}>{time}</InspectorRow>
        ) : null}
      </dl>
    </>
  );
}

function SubagentsWorkflowPhaseDetailsBody({
  node,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <SubagentWorkflowMark size={14} />
        <h4
          className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-s font-medium fg-primary`}
        >
          {node.title}
        </h4>
        <CloseDetailsButton onClose={onClose} />
      </div>
    </div>
  );
}

function SubagentsDetailsBody(props: SubagentsDetailsProps): JSX.Element {
  if (props.node.kind === 'workflow-run')
    return <SubagentsWorkflowRunDetailsBody {...props} />;
  if (props.node.kind === 'workflow-phase')
    return <SubagentsWorkflowPhaseDetailsBody {...props} />;
  return <SubagentsTaskDetailsBody {...props} />;
}

/** Wide-panel detail column displayed beside the tree or list. */
function SubagentsViewInspector(props: SubagentsDetailsProps): JSX.Element {
  return (
    <aside
      data-testid="subagents-inspector"
      className="flex w-80 shrink-0 flex-col gap-4 overflow-hidden border-l bg-base p-4"
    >
      <SubagentsDetailsBody {...props} />
    </aside>
  );
}

/** Narrow-panel detail drawer; canvas mode clears its zoom controls. */
function SubagentsViewDrawer({
  over,
  ...props
}: SubagentsDetailsProps & { readonly over: 'canvas' | 'list' }): JSX.Element {
  return (
    <aside
      data-testid="subagents-drawer"
      className={`absolute bottom-3 right-3 z-20 flex max-h-[min(70%,32rem)] min-w-0 flex-col gap-3 overflow-auto rounded-lg bg-popover p-3 shadow-lg ${over === 'canvas' ? 'left-14' : 'left-3'}`}
    >
      <SubagentsDetailsBody {...props} />
    </aside>
  );
}

/**
 * Wide-panel details: the simplified card under the Subagents view
 * experiment, the classic card otherwise.
 */
export function SubagentsInspector(props: SubagentsDetailsProps): JSX.Element {
  return useSubagentsView() ? (
    <SubagentsViewInspector {...props} />
  ) : (
    <ClassicSubagentsInspector {...props} />
  );
}

/** Narrow-panel details drawer, chosen the same way as the inspector. */
export function SubagentsDrawer(
  props: SubagentsDetailsProps & { readonly over: 'canvas' | 'list' },
): JSX.Element {
  return useSubagentsView() ? (
    <SubagentsViewDrawer {...props} />
  ) : (
    <ClassicSubagentsDrawer {...props} />
  );
}
