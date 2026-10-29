import type { JSX } from 'react';
import {
  countsAsSubagent,
  isLiveSubagentStatus,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/agent-transcript';
import { WorkflowIcon } from '../../../../icons/WorkflowIcon';
import {
  subagentStatusLabel,
  subagentWorkflowAgentCountLabel,
  subagentWorkflowCurrentPhaseLabel,
  subagentWorkflowDoneOfLabel,
  subagentWorkflowFailedLabel,
  subagentWorkflowFailedOfLabel,
  subagentWorkflowPhaseCountLabel,
  subagentWorkflowRunLiveNote,
  subagentWorkflowRunSettledNote,
} from '../subagent-copy';
import { subagentStatusInk } from './SubagentStatusGlyph';

// Shared display pieces for Claude Code workflow runs and phases: the
// workflow glyph, agent counts under a run or phase, and the status texts
// the tree cards, list rows, inspector and chat details all use.

/** Agents under a workflow run or phase, by outcome. */
export interface SubagentWorkflowCounts {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly live: number;
}

/**
 * Counts the agents below a run or phase node at any depth. Group nodes
 * (phases) are not agents and are never counted.
 */
export function subagentWorkflowCounts(
  tree: SubagentTree,
  group: SubagentNode,
): SubagentWorkflowCounts {
  let total = 0;
  let done = 0;
  let failed = 0;
  let live = 0;
  const stack = [...group.childIds];
  while (stack.length > 0) {
    const id = stack.pop();
    const node = id === undefined ? undefined : tree.nodes.get(id);
    if (!node) continue;
    for (const childId of node.childIds) stack.push(childId);
    if (!countsAsSubagent(node)) continue;
    total += 1;
    if (node.status === 'completed') done += 1;
    else if (node.status === 'failed') failed += 1;
    else if (isLiveSubagentStatus(node.status)) live += 1;
  }
  return { total, done, failed, live };
}

/** A run's phase nodes, in order. */
export function subagentWorkflowPhases(
  tree: SubagentTree,
  run: SubagentNode,
): readonly SubagentNode[] {
  return run.childIds.flatMap((id) => {
    const child = tree.nodes.get(id);
    return child?.kind === 'workflow-phase' ? [child] : [];
  });
}

/**
 * The phase a live run is working on: its first running phase, else its
 * first queued phase, else its last phase. Undefined for a run without
 * phases.
 */
export function subagentWorkflowCurrentPhase(
  tree: SubagentTree,
  run: SubagentNode,
): SubagentNode | undefined {
  const phases = subagentWorkflowPhases(tree, run);
  return (
    phases.find((phase) => phase.status === 'running') ??
    phases.find((phase) => phase.status === 'queued') ??
    phases[phases.length - 1]
  );
}

/** The workflow run a node belongs to: itself, or its nearest run ancestor. */
export function subagentWorkflowRunOf(
  tree: SubagentTree,
  node: SubagentNode,
): SubagentNode | undefined {
  let current: SubagentNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.kind === 'workflow-run') return current;
    seen.add(current.id);
    current =
      current.parentId === null ? undefined : tree.nodes.get(current.parentId);
  }
  return undefined;
}

function phaseCountOf(run: SubagentNode, tree: SubagentTree): number {
  return run.workflow?.phaseCount ?? subagentWorkflowPhases(tree, run).length;
}

/**
 * A run's status line: `Running · 6 of 7 done`, `Done · 2 of 9 failed`, or
 * `Done · 9 agents`.
 */
export function subagentWorkflowRunStatusLine(
  tree: SubagentTree,
  run: SubagentNode,
): string {
  const counts = subagentWorkflowCounts(tree, run);
  const word = subagentStatusLabel(run.status);
  if (isLiveSubagentStatus(run.status))
    return `${word} · ${subagentWorkflowDoneOfLabel(counts.done, counts.total)}`;
  if (counts.failed > 0)
    return `${word} · ${subagentWorkflowFailedOfLabel(counts.failed, counts.total)}`;
  return `${word} · ${subagentWorkflowAgentCountLabel(counts.total)}`;
}

/**
 * A run card's third line: `Phase 3 of 3 · Consistency` while it runs,
 * `4 phases` once it ends. A run without phases names its agent count.
 */
export function subagentWorkflowRunPhaseLine(
  tree: SubagentTree,
  run: SubagentNode,
): { readonly label: string; readonly phaseTitle?: string } {
  const phaseCount = phaseCountOf(run, tree);
  if (phaseCount === 0)
    return {
      label: subagentWorkflowAgentCountLabel(
        subagentWorkflowCounts(tree, run).total,
      ),
    };
  if (!isLiveSubagentStatus(run.status))
    return { label: subagentWorkflowPhaseCountLabel(phaseCount) };
  const current = subagentWorkflowCurrentPhase(tree, run);
  const phaseTitle = current?.workflow?.phaseTitle ?? current?.title;
  return {
    label: subagentWorkflowCurrentPhaseLabel(
      current?.workflow?.phaseIndex ?? 0,
      phaseCount,
    ),
    ...(phaseTitle ? { phaseTitle } : {}),
  };
}

/** A run row's note: `6 of 7 done · phase 3 of 3`, or `9 agents · 4 phases`. */
export function subagentWorkflowRunProgressNote(
  tree: SubagentTree,
  run: SubagentNode,
): string {
  const counts = subagentWorkflowCounts(tree, run);
  const phaseCount = phaseCountOf(run, tree);
  if (!isLiveSubagentStatus(run.status))
    return subagentWorkflowRunSettledNote(counts.total, phaseCount);
  const current = subagentWorkflowCurrentPhase(tree, run);
  return subagentWorkflowRunLiveNote(
    counts.done,
    counts.total,
    current?.workflow?.phaseIndex,
    phaseCount,
  );
}

/** A phase's count: `2 of 2 done`, or `1 of 4 failed` when it lost agents. */
export function subagentWorkflowPhaseCountLine(
  tree: SubagentTree,
  phase: SubagentNode,
): string {
  const counts = subagentWorkflowCounts(tree, phase);
  return counts.failed > 0
    ? subagentWorkflowFailedOfLabel(counts.failed, counts.total)
    : subagentWorkflowDoneOfLabel(counts.done, counts.total);
}

/** The workflow glyph the chat's Workflow card uses, in its special ink. */
export function SubagentWorkflowMark({
  size = 14,
}: {
  readonly size?: number;
}): JSX.Element {
  return (
    <span
      aria-hidden
      data-testid="subagent-workflow-mark"
      className="inline-flex shrink-0 items-center justify-center fg-special"
      style={{ width: size, height: size }}
    >
      <WorkflowIcon className="h-full w-full" />
    </span>
  );
}

/**
 * A run's status in its status ink. A finished run that lost agents keeps
 * its status word but names the failures in the failed ink, so a run with
 * failures never reads as a clean success. `short` drops the progress
 * detail: `Running`, `Done`, `Done · 2 failed`.
 */
export function SubagentWorkflowRunStatusText({
  tree,
  run,
  short = false,
}: {
  readonly tree: SubagentTree;
  readonly run: SubagentNode;
  readonly short?: boolean;
}): JSX.Element {
  const counts = subagentWorkflowCounts(tree, run);
  const word = subagentStatusLabel(run.status);
  const live = isLiveSubagentStatus(run.status);
  if (!live && counts.failed > 0) {
    return (
      <>
        <span className={subagentStatusInk(run.status)}>{word} · </span>
        <span className={subagentStatusInk('failed')}>
          {short
            ? subagentWorkflowFailedLabel(counts.failed)
            : subagentWorkflowFailedOfLabel(counts.failed, counts.total)}
        </span>
      </>
    );
  }
  const detail = live
    ? subagentWorkflowDoneOfLabel(counts.done, counts.total)
    : subagentWorkflowAgentCountLabel(counts.total);
  return (
    <span className={subagentStatusInk(run.status)}>
      {short ? word : `${word} · ${detail}`}
    </span>
  );
}

/** A phase's count in its status ink, or the failed ink when it lost agents. */
export function SubagentWorkflowPhaseCountText({
  tree,
  phase,
  quiet = false,
}: {
  readonly tree: SubagentTree;
  readonly phase: SubagentNode;
  /** Draws a clean count in tertiary ink, for captions beside a title. */
  readonly quiet?: boolean;
}): JSX.Element {
  const failed = subagentWorkflowCounts(tree, phase).failed > 0;
  const ink = failed
    ? subagentStatusInk('failed')
    : quiet
      ? 'fg-tertiary'
      : subagentStatusInk(phase.status);
  return (
    <span className={ink}>{subagentWorkflowPhaseCountLine(tree, phase)}</span>
  );
}
