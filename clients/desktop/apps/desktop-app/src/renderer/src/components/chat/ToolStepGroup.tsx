import { memo, type JSX, type ReactNode } from 'react';
import {
  ChatToolStepGroup,
  getToolDisplayInfo,
  stepKindIcon,
  useCleanChatLook,
} from '@canopy/ui-shared/components';
import { brand } from '@/lib/brand';
import type { DisplayBlock } from './types';
import {
  describeSteps,
  firstStepKind,
  runningToolUse,
  summarizeSteps,
  type ToolStepBlock,
} from './tool-step-groups';

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

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
      forceExpanded={forceExpanded}
      liveSteps={liveSteps}
      icon={firstKind ? stepKindIcon(firstKind) : undefined}
    >
      {children}
    </ChatToolStepGroup>
  );
});
