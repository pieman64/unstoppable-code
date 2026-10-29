import { workspaceOwnerMatchesContext } from '@canopy/desktop-shared/lib/workspace-owner';
import type {
  ArchivedChatSummary,
  CoworkWorkEntryMeta,
  StandaloneChatMeta,
  WorktreeSelection,
  SidebarItem,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from './cowork';

/** Shared rule for whether a selection belongs to the scoping context (CAN-2954). */
export function selectionBelongsToContext(
  previous: WorktreeSelection,
  projects: readonly SidebarItem[],
  context: WorkspaceContext | undefined,
): boolean {
  const project = projects.find((item) => item.id === previous.projectId);
  return (
    project !== undefined &&
    workspaceOwnerMatchesContext(project.owner, context)
  );
}

export function shouldRestorePreviousWorktreeAfterCoworkPageUnmount(
  currentSelection: WorktreeSelection | null,
): boolean {
  return !currentSelection || isCoworkChatTarget(currentSelection.projectId);
}

/**
 * Decides whether the Cowork page's mount effect may re-assert the retained
 * `activeWorkEntryId` into the global chat selection.
 *
 * Arriving from a code workspace leaves `chatStore` pointed at that worktree,
 * so the retained entry has to be re-asserted for the page to show a chat at
 * all. A sidebar click on a different Work Entry is the opposite case: it
 * sets the global selection to its destination synchronously but commits
 * `activeWorkEntryId` only once tab hydration resolves, and the page remounts
 * inside that window — so an unconditional re-assert would clobber the
 * in-flight destination with the previously active entry (REG-2842). Treat any
 * cowork selection already in place as the authoritative destination.
 */
export function shouldReassertRetainedCoworkEntryOnPageMount(
  currentSelection: WorktreeSelection | null,
): boolean {
  return !currentSelection || !isCoworkChatTarget(currentSelection.projectId);
}

export interface CoworkReadTarget {
  projectId: string | null;
  workEntryId: string | null;
  tabId: string | undefined;
  activeTabHidden: boolean;
  archiveOverlayChatId: string | null;
}

interface VisibleCoworkReadTarget extends CoworkReadTarget {
  projectId: string;
  workEntryId: string;
  tabId: string;
  activeTabHidden: false;
  archiveOverlayChatId: null;
}

export function shouldAcknowledgeCoworkTarget(
  input: CoworkReadTarget,
): input is VisibleCoworkReadTarget {
  return (
    input.archiveOverlayChatId === null &&
    !input.activeTabHidden &&
    input.projectId !== null &&
    input.workEntryId !== null &&
    input.tabId !== undefined
  );
}

export interface CoworkActivityStatus {
  archiveActivityLoaded: boolean;
  hasChatActivity: boolean;
}

export function getCoworkActivityStatus(input: {
  projectId: string;
  workEntries: CoworkWorkEntryMeta[];
  legacyArchivedChats: StandaloneChatMeta[] | undefined;
  archivedChats: Record<string, ArchivedChatSummary[]>;
}): CoworkActivityStatus {
  const hasLiveActivity = input.workEntries.some(
    (entry) => entry.lastMessageAt !== undefined,
  );
  const hasLegacyArchiveActivity = (input.legacyArchivedChats?.length ?? 0) > 0;
  // Archive hydration exists only to decide whether the zero-state CTA is
  // truthful. Any known live or legacy activity already answers that question,
  // so do not make the page wait for (or request) every Work Entry archive.
  const archiveActivityLoaded =
    hasLiveActivity ||
    hasLegacyArchiveActivity ||
    (input.legacyArchivedChats !== undefined &&
      input.workEntries.every((entry) =>
        Object.prototype.hasOwnProperty.call(
          input.archivedChats,
          `${input.projectId}/${entry.id}`,
        ),
      ));
  const hasChatActivity =
    hasLiveActivity ||
    hasLegacyArchiveActivity ||
    input.workEntries.some(
      (entry) =>
        (input.archivedChats[`${input.projectId}/${entry.id}`]?.length ?? 0) >
        0,
    );
  return { archiveActivityLoaded, hasChatActivity };
}
