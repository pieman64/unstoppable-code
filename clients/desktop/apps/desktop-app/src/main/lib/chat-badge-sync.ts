import type {
  ChatTabsFile,
  PersistedChatTab,
  SidebarItem,
  WorktreeChatBadgeChatRef,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import { deriveWorktreeChatName } from '@canopy/desktop-shared/lib/worktree-chat-name';
import { isWorkEntryWorkspace } from './workspace-registry';
import { readChatTabsFile } from './chat-tabs-reader';
import {
  CHAT_BADGES_SUMMARY_VERSION,
  recordWorktreeChatBadges,
} from './worktree-observer-records';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

/** Mirrors the renderer's unread-chat preview cap (unread-previews.ts). */
const BADGE_PREVIEW_LIMIT = 200;

function normalizePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > BADGE_PREVIEW_LIMIT
    ? `${normalized.slice(0, BADGE_PREVIEW_LIMIT)}...`
    : normalized;
}

/**
 * Last assistant response snippet, mirroring the renderer's
 * `getUnreadChatAgentResponsePreview` walk over the persisted message shape.
 */
function deriveAgentResponsePreview(tab: PersistedChatTab): string | undefined {
  if (tab.transcript) return tab.transcript.lastAssistantPreview;
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    if (!message || message.role !== 'assistant') continue;
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const preview = normalizePreview(text);
    if (preview) return preview;
  }
  return undefined;
}

function toBadgeChatRef(
  tab: PersistedChatTab,
  options?: { includePreview?: boolean },
): WorktreeChatBadgeChatRef {
  const preview =
    options?.includePreview === true
      ? deriveAgentResponsePreview(tab)
      : undefined;
  const title = tab.customTitle?.trim() || tab.title.trim();
  return {
    chatId: tab.id,
    ...(title ? { title } : {}),
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * Derives the compact per-worktree badge summary from a persisted chat tabs
 * file. Pure so it can be unit-tested without touching workspace persistence.
 */
export function deriveWorktreeChatBadgesSummary(
  data: ChatTabsFile,
  now: () => string = () => new Date().toISOString(),
): WorktreeChatBadgesSummary {
  const chatTabs = data.tabs.filter((tab) => (tab.kind ?? 'chat') === 'chat');
  const unreadChats = chatTabs
    .filter((tab) => tab.unread === true)
    .map((tab) => toBadgeChatRef(tab, { includePreview: true }));
  const approvalChats = chatTabs
    .filter((tab) => tab.pendingPlanExit !== undefined)
    .map((tab) => toBadgeChatRef(tab));
  const needsHydration =
    approvalChats.length > 0 ||
    (data.pendingQuestions?.length ?? 0) > 0 ||
    // A persisted tool-approval prompt means the worktree was blocked on the
    // user when it was last saved. Hydration is what pulls main's live
    // pending-approval registry back into the store for that worktree
    // (`recoverRevisionedPendingApprovals`), so without this the needs-input
    // dot is missing after a renderer reload until the row is selected. On a
    // full app restart the registry is empty and the stale entry is scrubbed,
    // which is the correct outcome either way.
    (data.pendingApprovals?.length ?? 0) > 0 ||
    chatTabs.some(
      (tab) =>
        tab.scheduledSendDraft?.runAt !== undefined ||
        tab.trackedPlanReviewStatus === 'pending',
    );
  const chatName = deriveWorktreeChatName(chatTabs);
  return {
    version: CHAT_BADGES_SUMMARY_VERSION,
    ...(chatName ? { chatName } : {}),
    unreadChats,
    approvalChats,
    needsHydration,
    updatedAt: now(),
  };
}

/**
 * Chat-tabs write observer: keep the owning worktree's `chatBadges` summary in
 * `worktrees.json` in sync with every persisted chat write. Fire-and-forget
 * and never throws — badge metadata must not be able to break chat saves.
 * Cowork/app-managed chat targets have no worktrees.json and are skipped;
 * unknown worktree ids no-op inside `recordWorktreeChatBadges`.
 */
export function syncWorktreeChatBadgesFromWrite(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
): void {
  if (isWorkEntryWorkspace(projectId)) {
    return;
  }
  trackDetachedWork(() =>
    recordWorktreeChatBadges({
      source: 'chat_commit',
      workspaceId: projectId,
      worktreeId,
      summary: deriveWorktreeChatBadgesSummary(data),
    }).catch(() => {
      // Non-worktree targets (plan-explore scopes, deleted workspaces) and
      // transient IO failures are ignored; the next save re-derives.
    }),
  );
}

/**
 * One-time (per launch) backfill: derive `chatBadges` for worktrees that
 * predate the field so the renderer can stop eagerly hydrating them at the
 * NEXT launch, and add `chatName` to summaries written before version 2.
 * Sequential on purpose — this reads every legacy worktree's chat file once
 * and must stay a background trickle, not an IO burst.
 */
export async function backfillMissingWorktreeChatBadges(
  items: SidebarItem[],
): Promise<void> {
  for (const item of items) {
    if (item.type === 'cowork') {
      continue;
    }
    for (const worktree of item.worktrees) {
      if (
        worktree.chatBadges !== undefined &&
        worktree.chatBadges.version >= CHAT_BADGES_SUMMARY_VERSION
      ) {
        continue;
      }
      try {
        const file = await readChatTabsFile(item.id, worktree.id);
        // A concurrent live commit may have written newer badges than this
        // read saw; the backfill record keeps them and adds only the name.
        await recordWorktreeChatBadges({
          source: 'launch_backfill',
          workspaceId: item.id,
          worktreeId: worktree.id,
          summary: deriveWorktreeChatBadgesSummary(file),
        });
      } catch {
        // Missing/corrupt chat file or IO failure: leave the field as it is
        // (absent keeps the renderer's legacy eager hydration).
      }
    }
  }
}
