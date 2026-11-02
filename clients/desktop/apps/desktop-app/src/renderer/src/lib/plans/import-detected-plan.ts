import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';

export interface ImportDetectedPlanInput {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly entry: DetectedPlanEntry;
  /** Chat that should be told about the import on its next turn. */
  readonly originChatId?: string;
}

/**
 * Import a plan file detected in a chat as a tracked plan, mark the detection
 * imported, and queue the "user imported this plan" instruction for the chat
 * it came from. Resolves `null` when nothing was imported; rejects when the
 * import itself fails. Callers own their busy state and error toast.
 *
 * Once the plan exists the import is never repeated: a failed status update
 * still queues the instruction and resolves the plan, so the caller must hide
 * the entry itself rather than offer the import again.
 */
export async function importDetectedPlan({
  projectId,
  worktreeId,
  entry,
  originChatId,
}: ImportDetectedPlanInput): Promise<TrackedPlanData | null> {
  const activity = useActivityStore.getState();
  const plan = await activity.importTrackedPlan(
    projectId,
    worktreeId,
    entry.sourceFilePath,
    entry.sourceRepoId,
  );
  if (!plan) return null;
  try {
    await activity.updateDetectedPlan(projectId, worktreeId, entry.id, {
      status: 'imported',
      importedPlanId: plan.id,
    });
  } catch {
    // The plan is tracked; a stale `detected` status only leaves a
    // suggestion the duplicate guard already marks as tracked.
  }
  if (originChatId) {
    useChatStore
      .getState()
      .queuePlanImportInstruction(originChatId, entry.sourceFilePath);
  }
  return plan;
}
