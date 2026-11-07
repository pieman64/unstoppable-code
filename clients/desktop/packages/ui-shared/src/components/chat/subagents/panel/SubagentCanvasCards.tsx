import { memo, type JSX } from 'react';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import {
  subagentsFoldedParentsAccessibleLabel,
  subagentsFoldedParentsLabel,
  subagentsMoreBelowAccessibleLabel,
  subagentsMoreBelowLabel,
  subagentsMoreBelowLiveLabel,
  subagentsRootActiveLabel,
  subagentWorkflowPhasePositionLabel,
  SUBAGENT_DETAIL_SEPARATOR,
} from '../subagent-copy';
import { ChatIcon, ChevronRightIcon } from '../../../../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { SubagentStatusGlyph } from '../common/SubagentStatusGlyph';
import {
  SubagentWorkflowMark,
  SubagentWorkflowPhaseCountText,
  SubagentWorkflowRunStatusText,
  subagentWorkflowPhases,
  subagentWorkflowRunOf,
  subagentWorkflowRunPhaseLine,
} from '../common/SubagentWorkflow';

/** Props for the leftmost root-chat card in the tree canvas. */
export interface SubagentRootCardProps {
  /** The root chat's display title. */
  readonly title: string;
  /** Number of live subagents in this root chat. */
  readonly activeCount: number;
  /** Whether this card is highlighted by the current interaction. */
  readonly selected?: boolean;
}

function cardShell(selected: boolean): string {
  return `flex h-full w-full min-w-0 flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 py-1.5 text-left ${selected ? 'border-line-accent ring-2 ring-line-accent/30' : ''}`;
}

/** Pure display for the root chat; clicks belong to the diagram wrapper. */
export const SubagentRootCard = memo(function SubagentRootCard({
  title,
  activeCount,
  selected = false,
}: SubagentRootCardProps): JSX.Element {
  return (
    <div className={cardShell(selected)}>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="inline-flex shrink-0 fg-secondary">
          <ChatIcon size={14} aria-hidden />
        </span>
        <span
          className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-xs font-medium fg-primary`}
        >
          {title}
        </span>
      </span>
      <span className="w-full truncate text-2xs fg-tertiary">
        {subagentsRootActiveLabel(activeCount)}
      </span>
    </div>
  );
});

SubagentRootCard.displayName = 'SubagentRootCard';

/** Props for a Claude Code workflow run on the tree canvas. */
export interface SubagentWorkflowRunCardProps {
  /** Complete source tree used to summarize run progress. */
  readonly tree: SubagentTree;
  /** The workflow run represented by this card. */
  readonly run: SubagentNode;
  /** Whether the inspector currently describes this run. */
  readonly selected?: boolean;
}

/** Pure display for a workflow run; clicks belong to the diagram wrapper. */
export const SubagentWorkflowRunCard = memo(function SubagentWorkflowRunCard({
  tree,
  run,
  selected = false,
}: SubagentWorkflowRunCardProps): JSX.Element {
  const phaseLine = subagentWorkflowRunPhaseLine(tree, run);
  return (
    <div className={cardShell(selected)}>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <SubagentWorkflowMark size={12} />
        <span
          className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-xs font-medium fg-primary`}
        >
          {run.title}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs">
        <SubagentStatusGlyph status={run.status} size={10} />
        <span className="min-w-0 flex-1 truncate">
          <SubagentWorkflowRunStatusText tree={tree} run={run} />
        </span>
      </span>
      <span className="w-full truncate text-2xs fg-tertiary">
        {phaseLine.label}
        {phaseLine.phaseTitle ? (
          <>
            {SUBAGENT_DETAIL_SEPARATOR}
            <span className={REPLAY_MASK_CLASS}>{phaseLine.phaseTitle}</span>
          </>
        ) : null}
      </span>
    </div>
  );
});

SubagentWorkflowRunCard.displayName = 'SubagentWorkflowRunCard';

/** Props for a workflow phase grouping card on the tree canvas. */
export interface SubagentWorkflowPhaseCardProps {
  /** Complete source tree used to summarize phase progress. */
  readonly tree: SubagentTree;
  /** The workflow phase represented by this card. */
  readonly phase: SubagentNode;
}

/** Pure display for a workflow phase; clicks belong to the diagram wrapper. */
export const SubagentWorkflowPhaseCard = memo(
  function SubagentWorkflowPhaseCard({
    tree,
    phase,
  }: SubagentWorkflowPhaseCardProps): JSX.Element {
    const run = subagentWorkflowRunOf(tree, phase);
    const phaseCount =
      phase.workflow?.phaseCount ??
      run?.workflow?.phaseCount ??
      (run ? subagentWorkflowPhases(tree, run).length : 0);
    const phaseIndex = phase.workflow?.phaseIndex ?? 0;
    return (
      <div className="flex h-full w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-dashed bg-base px-2.5 text-left text-2xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate font-medium fg-secondary`}
          >
            {phase.title}
          </span>
          <span className="shrink-0 tabular-nums fg-tertiary">
            {subagentWorkflowPhasePositionLabel(phaseIndex, phaseCount)}
          </span>
        </span>
        <span className="min-w-0 truncate">
          <SubagentWorkflowPhaseCountText tree={tree} phase={phase} />
        </span>
      </div>
    );
  },
);

SubagentWorkflowPhaseCard.displayName = 'SubagentWorkflowPhaseCard';

/** Props for the dashed card at the visible edge of a Levels window. */
export interface SubagentMoreBelowCardProps {
  /** Number of descendants hidden below this card. */
  readonly hiddenCount: number;
  /** Live descendants among the hidden tasks. */
  readonly hiddenLiveCount: number;
}

/** Pure display for a clickable-by-canvas depth stub. */
export const SubagentMoreBelowCard = memo(function SubagentMoreBelowCard({
  hiddenCount,
  hiddenLiveCount,
}: SubagentMoreBelowCardProps): JSX.Element {
  return (
    <div
      aria-label={subagentsMoreBelowAccessibleLabel(hiddenCount)}
      className="flex h-full w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed bg-base px-2.5 text-2xs fg-secondary"
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {subagentsMoreBelowLabel(hiddenCount)}
      </span>
      {hiddenLiveCount > 0 ? (
        <span className="shrink-0 fg-info">
          {subagentsMoreBelowLiveLabel(hiddenLiveCount)}
        </span>
      ) : null}
      <ChevronRightIcon size="sm" aria-hidden className="shrink-0" />
    </div>
  );
});

SubagentMoreBelowCard.displayName = 'SubagentMoreBelowCard';

/** Props for the folded root-to-focus ancestry card. */
export interface SubagentFoldedParentsCardProps {
  /** Title of the root chat that owns the tree. */
  readonly rootTitle: string;
  /** Root-down ancestry, with the nearest parent last. */
  readonly ancestors: readonly SubagentNode[];
}

/** Pure display for folded ancestry; its interaction belongs to the canvas. */
export const SubagentFoldedParentsCard = memo(
  function SubagentFoldedParentsCard({
    rootTitle,
    ancestors,
  }: SubagentFoldedParentsCardProps): JSX.Element {
    return (
      <div
        aria-label={subagentsFoldedParentsAccessibleLabel(ancestors.length)}
        className="flex h-full w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-dashed bg-base px-2.5 text-left text-2xs fg-tertiary"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex shrink-0">
            <ChatIcon size="sm" aria-hidden />
          </span>
          <span className="min-w-0 truncate">{rootTitle}</span>
        </span>
        <span className="min-w-0 truncate">
          {subagentsFoldedParentsLabel(ancestors)}
        </span>
      </div>
    );
  },
);

SubagentFoldedParentsCard.displayName = 'SubagentFoldedParentsCard';
