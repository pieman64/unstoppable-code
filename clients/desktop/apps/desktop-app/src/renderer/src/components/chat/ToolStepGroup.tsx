import { memo, type JSX, type ReactNode } from 'react';
import {
  ChatToolStepGroup,
  STEP_GROUP_BODY_CLASS,
  getToolDisplayInfo,
  liveToolCallActivity,
  stepKindIcon,
  useCleanChatLook,
  useToolApprovalWait,
  type ChatToolStepLive,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import { AgentIcon, QuestionMarkIcon } from '@canopy/ui-shared/icons';
import { LightbulbIcon } from '@canopy/ui-shared/icons/AppIcons';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { brand } from '@/lib/brand';
import type { TurnOutcomeEvidence } from '@canopy/protocol/portal';
import type { DisplayBlock, DisplayMessage } from './types';
import {
  cleanBlockRole,
  describeCleanSteps,
  describeSteps,
  firstStepKind,
  runningToolUse,
  stepsBeforeLiveWindow,
  summarizeSteps,
  type CleanStepSegment,
  type ToolStepBlock,
} from './tool-step-groups';

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

function hasCleanStep(message: DisplayMessage): boolean {
  return message.blocks.some((block) => cleanBlockRole(block) === 'step');
}

/**
 * Early access: one row standing in for a run of back-to-back tool calls.
 * Collapsed it reads "Searched 3 times, read 4 files"; while the last call is
 * still running, that call's own label and the spinner follow the summary.
 * Opening it shows the run's messages as today's tool rows, without gaps.
 *
 * With the live step window (CAN-4274), the run a turn is still adding to
 * also shows its newest steps under the closed row (`liveSteps`). Text that
 * ends the run, or the turn finishing, drops them and leaves the row.
 *
 * The row itself is the shared `ChatToolStepGroup`; this adapter turns the
 * desktop transcript's blocks into its summary and running label.
 */
export const ToolStepGroup = memo(function ToolStepGroup({
  toolUses,
  steps,
  streaming,
  forceExpanded = false,
  openRequest,
  isCodeReviewChat,
  liveSteps,
  children,
}: {
  toolUses: readonly ToolUseBlock[];
  /** What the summary counts, when it is more than the tool calls. */
  steps?: readonly ToolStepBlock[];
  /** True while the turn is still running. */
  streaming: boolean;
  /** Opens the group without changing its saved state (search reveal). */
  forceExpanded?: boolean;
  /** Opens the group as saved state once per new object (a call reveal). */
  openRequest?: object;
  isCodeReviewChat?: boolean;
  /** The newest steps, shown under the closed row while the run is live. */
  liveSteps?: ReactNode;
  /** The run's messages, rendered when the group is open. */
  children: ReactNode;
}): JSX.Element {
  const scope = {
    isCodeReview: isCodeReviewChat,
    trustedMcpNamespace: brand.tools.namespace,
  };
  const running = streaming ? runningToolUse(toolUses) : undefined;
  const firstKind = firstStepKind(steps ?? toolUses, scope);
  // Clean chat look: the run's words without counts, like the Codex app.
  const clean = useCleanChatLook();
  const approvalWait = useToolApprovalWait();

  return (
    <ChatToolStepGroup
      summary={
        clean
          ? describeSteps(steps ?? toolUses, scope)
          : summarizeSteps(steps ?? toolUses, scope)
      }
      runningLabel={
        running
          ? getToolDisplayInfo(running.toolName, running.input, scope).label
          : undefined
      }
      runningWaiting={
        running !== undefined && approvalWait.isCallWaiting(running)
      }
      forceExpanded={forceExpanded}
      openRequest={openRequest}
      liveSteps={liveSteps}
      icon={firstKind ? stepKindIcon(firstKind) : undefined}
    >
      {children}
    </ChatToolStepGroup>
  );
});

type CleanStepsSegment = Extract<CleanStepSegment, { kind: 'steps' }>;

/** Words that can carry paths, commands or task text stay out of replay. */
function replayBlocked(label: ReactNode): JSX.Element {
  return <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{label}</span>;
}

/**
 * What the running turn is doing now, from the last step of its live run. A
 * call the turn's approvals hold says it waits instead of shimmering.
 */
function liveActivity(
  segment: CleanStepsSegment | undefined,
  workingLabel: string | undefined,
  scope: { isCodeReview?: boolean; trustedMcpNamespace: string },
  approvalWait: ToolApprovalWait,
): ChatToolStepLive {
  const thinking = {
    label: workingLabel ?? 'Thinking',
    icon: <LightbulbIcon />,
  };
  const messages = segment?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index].blocks;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      const block = blocks[at];
      if (cleanBlockRole(block) !== 'step') continue;
      if (block.type === 'text' && block.asyncQuestion) {
        return { label: 'Waiting for your answer', icon: <QuestionMarkIcon /> };
      }
      if (block.type === 'tool_use' && block.result === undefined) {
        if (isAskUserQuestionToolName(block.toolName)) {
          return {
            label: 'Waiting for your answer',
            icon: <QuestionMarkIcon />,
          };
        }
        return liveToolCallActivity(block, approvalWait, scope);
      }
      if (
        (block.type === 'agent' || block.type === 'workflow') &&
        block.result === undefined
      ) {
        return {
          label:
            block.type === 'agent'
              ? block.description
                ? replayBlocked(block.description)
                : 'Running a helper agent'
              : block.workflowName,
          icon: <AgentIcon />,
        };
      }
      // The newest step is done (or is a thought): the agent is thinking
      // about the next one.
      return thinking;
    }
  }
  return thinking;
}

/**
 * Clean chat look: one closed line for every step between two replies.
 * Done, it counts what the run did ("Ran 4 commands, read 2 files · 1
 * failed"); as the running turn's tail (`live`) it shimmers what the turn is
 * doing now in the same place. Without a segment it is the running turn's
 * "Thinking" line, which the next run takes over in place.
 */
export const CleanToolStepGroup = memo(function CleanToolStepGroup({
  segment,
  live,
  workingLabel,
  forceExpanded = false,
  openRequest,
  isCodeReviewChat,
  liveSteps,
  outcomeEvidence,
  deniedToolUseIds,
  children,
}: {
  segment?: CleanStepsSegment;
  /** The run is the running turn's tail. */
  live: boolean;
  /** Replaces "Thinking" while the turn waits on something else. */
  workingLabel?: string;
  forceExpanded?: boolean;
  /** Opens the line as saved state once per new object (a call reveal). */
  openRequest?: object;
  isCodeReviewChat?: boolean;
  /** "Show only recent steps": the newest steps, under the closed line. */
  liveSteps?: ReactNode;
  /**
   * Whether the turn settled with every result loaded, so a call without a
   * result counts as interrupted; the turn's outcome counts use the same.
   */
  outcomeEvidence?: TurnOutcomeEvidence;
  /** Authoritative denials, including receipts outside this run. */
  deniedToolUseIds?: ReadonlySet<string>;
  /** The run's steps, rendered when the line is open. */
  children?: ReactNode;
}): JSX.Element {
  const scope = {
    isCodeReview: isCodeReviewChat,
    trustedMcpNamespace: brand.tools.namespace,
  };
  const approvalWait = useToolApprovalWait();
  // "Recent": the newest steps show under the line, so the line counts only
  // the steps before them and the running step is not said twice. With no
  // earlier step there is nothing to count, so the steps show on their own.
  const hidden =
    segment && liveSteps !== undefined
      ? stepsBeforeLiveWindow(segment.messages)
      : undefined;
  if (hidden !== undefined && !hidden.some(hasCleanStep)) {
    return (
      <div className={STEP_GROUP_BODY_CLASS} data-testid="chat-tool-step-live">
        {liveSteps}
      </div>
    );
  }
  const done = segment
    ? describeCleanSteps(
        hidden === undefined ? segment : { ...segment, messages: hidden },
        scope,
        outcomeEvidence,
        deniedToolUseIds,
      )
    : undefined;
  return (
    <ChatToolStepGroup
      summary={done?.label ?? ''}
      failedCount={done?.failed ?? 0}
      blockedCount={done?.blocked ?? 0}
      interruptedCount={done?.interrupted ?? 0}
      icon={done?.firstKind ? stepKindIcon(done.firstKind) : undefined}
      forceExpanded={forceExpanded}
      openRequest={openRequest}
      liveSteps={liveSteps}
      {...(live && hidden === undefined
        ? { live: liveActivity(segment, workingLabel, scope, approvalWait) }
        : {})}
    >
      {children}
    </ChatToolStepGroup>
  );
});
