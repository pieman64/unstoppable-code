import type {
  ChatActivePlanContext,
  PendingSystemInstruction,
} from '@canopy/desktop-shared/types';
import { logMainProcessError } from './main-process-logging';
import { buildPlanFileSystemInstruction } from './plan-system-instructions';
import { hasTrackedPlanStorage } from './tracked-plan-scope';
import { validateId } from './validation';

const ACTIVE_PLAN_INSTRUCTION_PREFIX = 'active-plan:';
const AUTHORED_PLAN_INSTRUCTION_PREFIX = 'plan-file-location:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted `ChatSendMessageRequest.activePlan` payload.
 *
 * `undefined` passes through as `undefined` (no active plan was captured
 * with the message). Anything else must be a record with a valid plan id
 * ({@link validateId}) and, when present, a positive safe-integer
 * `viewedRevisionNumber`. Malformed input throws so the caller rejects the
 * whole request rather than silently dropping the plan context.
 */
export function parseChatActivePlanContext(
  value: unknown,
): ChatActivePlanContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid active plan context.');
  }
  const { planId, viewedRevisionNumber } = value;
  validateId(planId, 'plan id');
  if (viewedRevisionNumber === undefined) {
    return { planId };
  }
  if (
    typeof viewedRevisionNumber !== 'number' ||
    !Number.isSafeInteger(viewedRevisionNumber) ||
    viewedRevisionNumber <= 0
  ) {
    throw new Error('Invalid active plan context.');
  }
  return { planId, viewedRevisionNumber };
}

/**
 * Resolve a request's captured {@link ChatActivePlanContext} into a scoped
 * `active-plan` {@link PendingSystemInstruction} for this turn only, or
 * `null` when there is nothing to attach: no active plan was captured, the
 * request's own `(projectId, worktreeId)` scope cannot own tracked plans
 * (Cowork, Advisor, and other sentinel scopes), or materialization fails.
 * Never throws — a resolution failure must not block the turn from sending.
 */
export async function resolveActivePlanSystemInstruction(options: {
  projectId: string;
  worktreeId: string;
  activePlan: ChatActivePlanContext | undefined;
}): Promise<PendingSystemInstruction | null> {
  if (!options.activePlan) {
    return null;
  }
  if (!hasTrackedPlanStorage(options.projectId)) {
    return null;
  }
  try {
    return await buildPlanFileSystemInstruction({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      planId: options.activePlan.planId,
      purpose: 'active-plan',
      viewedRevisionNumber: options.activePlan.viewedRevisionNumber,
    });
  } catch (error) {
    logMainProcessError(
      'Failed to resolve the active plan system instruction',
      error,
    );
    return null;
  }
}

/**
 * Append `activePlanInstruction` to `instructions` for one turn, unless the
 * same plan's authored-plan instruction (`plan-file-location:<id>`) is
 * already present — the agent already has an equivalent pointer to that
 * plan's file, so the duplicate is skipped. `null` returns `instructions`
 * unchanged (copied, since the parameter is read-only).
 */
export function withActivePlanInstruction(
  instructions: readonly PendingSystemInstruction[] | undefined,
  activePlanInstruction: PendingSystemInstruction | null,
): PendingSystemInstruction[] | undefined {
  if (!activePlanInstruction) {
    return instructions ? [...instructions] : undefined;
  }
  const planId = activePlanInstruction.id.startsWith(
    ACTIVE_PLAN_INSTRUCTION_PREFIX,
  )
    ? activePlanInstruction.id.slice(ACTIVE_PLAN_INSTRUCTION_PREFIX.length)
    : activePlanInstruction.id;
  const authoredInstructionId = `${AUTHORED_PLAN_INSTRUCTION_PREFIX}${planId}`;
  const alreadyPresent = (instructions ?? []).some(
    (instruction) => instruction.id === authoredInstructionId,
  );
  if (alreadyPresent) {
    return instructions ? [...instructions] : undefined;
  }
  return [...(instructions ?? []), activePlanInstruction];
}
