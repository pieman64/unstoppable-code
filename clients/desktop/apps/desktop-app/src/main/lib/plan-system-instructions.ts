import { BRAND } from '@canopy/brand/current';
import type {
  PendingSystemInstruction,
  PlanFileInstructionPurpose,
} from '@canopy/desktop-shared/types';
import { sanitizeSystemInstructionText } from '@canopy/desktop-shared/lib/pending-system-instructions';
import {
  getPlanFileSyncService,
  type MaterializedPlanFile,
} from './plan-file-sync';

export interface BuildPlanFileSystemInstructionOptions {
  projectId: string;
  worktreeId: string;
  planId: string;
  /** Defaults to `authored-plan`. */
  purpose?: PlanFileInstructionPurpose;
  /** An older revision on screen (`active-plan` only). */
  viewedRevisionNumber?: number;
}

/** Collapse embedded newlines and neutralize the reserved instruction delimiter. */
function sanitizePlanTitleForInstruction(title: string): string {
  return sanitizeSystemInstructionText(
    title.replace(/\s*[\r\n]+\s*/g, ' ').trim(),
  );
}

function buildActivePlanInstructionText(
  planId: string,
  materialized: MaterializedPlanFile,
  viewedRevisionNumber: number | undefined,
): string {
  const title = sanitizePlanTitleForInstruction(materialized.title);
  const lines = [
    `The user is working with the tracked plan "${title}" (plan ${planId}), now at revision ${String(materialized.latestRevisionNumber)}. Its latest content is at:`,
    `  ${materialized.filePath}`,
    `If the user asks you to change the plan, edit that file; ${BRAND.displayName} saves each change as a new plan revision when your turn ends. Do not edit it otherwise. Discussing the plan does not by itself ask you to implement it.`,
  ];
  if (
    viewedRevisionNumber !== undefined &&
    viewedRevisionNumber !== materialized.latestRevisionNumber
  ) {
    lines.push(
      `The user was viewing revision ${String(viewedRevisionNumber)}, which is read-only; make any requested change in the file above, which holds revision ${String(materialized.latestRevisionNumber)}.`,
    );
  }
  return lines.join('\n');
}

function buildAuthoredPlanInstructionText(
  materialized: MaterializedPlanFile,
): string {
  return [
    `The implementation plan you previously prepared has been parsed by ${BRAND.displayName} and is now persisted as a markdown file at:`,
    `  ${materialized.filePath}`,
    'For any future reads or updates to that plan, use that file as the source of truth instead of relying on the earlier chat transcript.',
  ].join('\n');
}

/**
 * Build the pending system instruction that points a turn at a tracked
 * plan's materialized `plan.md`, or `null` when the scope has no tracked
 * plans or the plan does not exist. Always flushes: an edited working copy
 * becomes a new revision first, unless a turn is already running in the
 * plan's scope, in which case the working copy is left for that scope's
 * next check.
 *
 * `authored-plan` (default) is for a plan the agent itself just prepared
 * (Claude ExitPlanMode, Codex plan tracking): id `plan-file-location:<id>`.
 * `active-plan` is for the plan the user has open while chatting, captured
 * with the message rather than derived from any tab state: id
 * `active-plan:<planId>`. Neither purpose writes the plan-explore registry;
 * ordinary chats resolve their own real `(projectId, worktreeId)` scope.
 */
export async function buildPlanFileSystemInstruction(
  options: BuildPlanFileSystemInstructionOptions,
): Promise<PendingSystemInstruction | null> {
  const materialized = await getPlanFileSyncService().materializePlanFile(
    {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      planId: options.planId,
    },
    { flush: true },
  );
  if (!materialized) {
    return null;
  }

  const purpose: PlanFileInstructionPurpose =
    options.purpose ?? 'authored-plan';
  if (purpose === 'active-plan') {
    return {
      id: `active-plan:${options.planId}`,
      text: buildActivePlanInstructionText(
        options.planId,
        materialized,
        options.viewedRevisionNumber,
      ),
    };
  }

  return {
    id: `plan-file-location:${options.planId}`,
    text: buildAuthoredPlanInstructionText(materialized),
  };
}
