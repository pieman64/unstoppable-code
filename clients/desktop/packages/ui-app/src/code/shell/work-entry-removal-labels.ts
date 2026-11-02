import {
  CHAT_UNIT_LABEL,
  CHAT_UNIT_LABEL_PLURAL,
} from '@canopy/protocol/ui-labels';
import type { SidebarBatchUnitLabel } from '@canopy/ui-shared/components';

/**
 * Work Entry (chat) removal copy, shared by the single-row confirm and the
 * bulk confirm so both say the same thing about what is kept.
 */

export type WorkEntryRemovalMode = 'archive' | 'delete';

const CHAT = CHAT_UNIT_LABEL.toLowerCase();
const CHATS = CHAT_UNIT_LABEL_PLURAL.toLowerCase();

export const WORK_ENTRY_BATCH_UNIT: SidebarBatchUnitLabel = {
  singular: CHAT,
  plural: CHATS,
};

/** Tooltip for the Archive affordance. */
export const ARCHIVE_TOOLTIP = 'Kept until you delete it';

function dayCount(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Tooltip for the Delete affordance: how long the deleted chat is kept. */
export function deleteRetentionTooltip(days: number): string {
  return `Kept for ${dayCount(days)}, then removed`;
}

export interface WorkEntryRemovalLabels {
  /**
   * The single-row confirmation's action, a verb and noun. Its title repeats
   * the verb as a question naming the chat: `Archive “Release notes”?`.
   */
  readonly dialogConfirmLabel: string;
  /** One sentence under the title: what happens to the chat. */
  readonly dialogBody: string;
  /** Delete ends in losing the chat for good; Archive keeps it. */
  readonly dialogDestructive: boolean;
  readonly retentionSummary: string;
  readonly retentionDetail: string;
}

export function getWorkEntryRemovalLabels(
  mode: WorkEntryRemovalMode,
  retentionDays: number,
): WorkEntryRemovalLabels {
  if (mode === 'archive') {
    return {
      dialogConfirmLabel: `Archive ${CHAT}`,
      dialogBody:
        'It leaves the sidebar with its messages and is kept until you delete it.',
      dialogDestructive: false,
      retentionSummary: `Archived ${CHATS} are kept until you delete them.`,
      retentionDetail: `Archiving removes each ${CHAT} from the sidebar and keeps its messages until you delete the archive. Restore it from Archived and deleted.`,
    };
  }
  const kept = dayCount(retentionDays);
  return {
    dialogConfirmLabel: `Delete ${CHAT}`,
    dialogBody: `It leaves the sidebar with its messages and is removed after ${kept}.`,
    dialogDestructive: true,
    retentionSummary: `Deleted ${CHATS} are kept for ${kept}, then removed.`,
    retentionDetail: `Deleting removes each ${CHAT} from the sidebar. Its messages are kept for ${kept} in Archived and deleted, then removed.`,
  };
}

/**
 * Batch copy over the retention windows of the projects the batch covers.
 * One distinct window reads as the single-row copy; archive copy never
 * varies by window.
 */
export function getWorkEntryBatchCopy(
  mode: WorkEntryRemovalMode,
  retentionDaysByWorkspace: readonly number[],
): { retentionSummary: string; retentionDetail: string } {
  const windows = new Set(retentionDaysByWorkspace);
  if (mode === 'delete' && windows.size > 1) {
    return {
      retentionSummary: "Restorable for each project's retention window.",
      retentionDetail: `Deleting removes each ${CHAT} from the sidebar. Its messages are kept for its project's retention window in Archived and deleted, then removed.`,
    };
  }
  const [onlyDays] = windows;
  const { retentionSummary, retentionDetail } = getWorkEntryRemovalLabels(
    mode,
    onlyDays ?? 0,
  );
  return { retentionSummary, retentionDetail };
}
