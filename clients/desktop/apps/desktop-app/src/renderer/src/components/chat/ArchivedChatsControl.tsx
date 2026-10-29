import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type JSX,
} from 'react';
import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { TitlebarIconButton } from '@canopy/ui-shared';
import { ArchiveIcon, CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import { TabContextMenu } from './TabContextMenu';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
} from '@/stores/chatStore';
import type { WorktreeChatOpenArchiveTranscriptDetail } from '@/stores/chatStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';
import { ArchivedChatsPopover } from './ArchivedChatsPopover';

const ArchivedChatsModal = lazy(() =>
  import('./ArchivedChatsModal').then((m) => ({
    default: m.ArchivedChatsModal,
  })),
);

const ArchivedChatTranscriptModal = lazy(() =>
  import('./ArchivedChatTranscriptModal').then((m) => ({
    default: m.ArchivedChatTranscriptModal,
  })),
);

const EMPTY_ARCHIVES: ArchivedChatSummary[] = [];

/** Corner-badge copy: past two digits the exact number stops mattering. */
function formatArchiveBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
const WORKTREE_CHAT_OPEN_ARCHIVES_EVENT = 'canopy:worktree-chat-open-archives';

interface WorktreeChatOpenArchivesDetail {
  projectId?: string;
  worktreeId?: string;
}

function isWorktreeChatOpenArchivesDetail(
  value: unknown,
): value is WorktreeChatOpenArchivesDetail {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    'projectId' in value &&
    value.projectId !== undefined &&
    typeof value.projectId !== 'string'
  ) {
    return false;
  }
  if (
    'worktreeId' in value &&
    value.worktreeId !== undefined &&
    typeof value.worktreeId !== 'string'
  ) {
    return false;
  }
  return true;
}

function isWorktreeChatOpenArchiveTranscriptDetail(
  value: unknown,
): value is WorktreeChatOpenArchiveTranscriptDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'chatId' in value &&
    typeof value.chatId === 'string'
  );
}

export interface ArchivedChatsControlProps {
  /**
   * Optional scope override. When provided, the control lists and mutates
   * archives for this `(projectId, worktreeId)` instead of the globally
   * selected worktree, and skips the App Advisor slice + global open events
   * (only the primary unscoped instance reports/handles those). Mirrors
   * ChatTabBar's `scope` semantics.
   */
  scope?: { projectId: string; worktreeId: string };
  /**
   * Extra classes for the control's root.
   *
   * Callers must not wrap this control in a positioning div: it renders
   * NOTHING when the worktree has no archived chats, and an empty wrapper
   * still consumes a flex `gap` from its parent — which is exactly how the
   * header's status region ended up 8px further from the action buttons than
   * the buttons are from each other.
   */
  className?: string;
  /**
   * Which edge the hover popover anchors to (default `'right'`, opening
   * down-and-left). Pass `'left'` when the control sits at a container's left
   * edge so the popover opens down-and-right and is not clipped by the window.
   */
  popoverAlign?: 'left' | 'right';
  /**
   * Marks this instance as the app's PRIMARY archived-chats surface even when
   * `scope` is provided: it handles the global open-archives events and
   * reports the App Advisor `chat.archivedChats` UI-state slice. Exactly one
   * mounted instance may set this (the main-window worktree header);
   * secondary scoped instances (plan-explore modal, cowork, popouts) omit it.
   */
  primarySurface?: boolean;
  /**
   * `header` (default): the hand-rolled icon with its count badge, tinted
   * amber while anything is unread. `tabStrip`: a scoped surface's icon
   * button (as the `+` and Activity), in the neutral ink, with a blue
   * dot while anything is unread instead of the count.
   */
  variant?: 'header' | 'tabStrip';
}

/**
 * The archived-chats affordance: archive icon (with unread tint + count),
 * hover popover of recent archives, right-click "Mark all as read" menu, the
 * full archive list modal, and the read-only transcript viewer.
 *
 * Extracted from ChatTabBar so both hosts can mount it: the worktree page's
 * `WorktreeTopBar` (which replaced ChatTabBar there) and ChatTabBar itself
 * (still used by non-worktree chat surfaces such as the Plan Explore modal).
 * Renders nothing while the scoped worktree has no archived chats.
 */
export const ArchivedChatsControl = memo(function ArchivedChatsControl({
  scope,
  popoverAlign = 'right',
  primarySurface = false,
  className = '',
  variant = 'header',
}: ArchivedChatsControlProps = {}): JSX.Element | null {
  const hasScopedSelection = scope != null;
  const scopedProjectId = scope?.projectId;
  const scopedWorktreeId = scope?.worktreeId;
  const worktreeKey = useChatStore((s) => {
    const sel = scope ?? s.selectedWorktree;
    if (!sel) return '';
    return `${sel.projectId}/${sel.worktreeId}`;
  });
  const archivedSummaries = useChatStore((s) => {
    const sel = scope ?? s.selectedWorktree;
    if (!sel) return EMPTY_ARCHIVES;
    const key = `${sel.projectId}/${sel.worktreeId}`;
    return s.archivedChats[key] ?? EMPTY_ARCHIVES;
  });
  const archivedChatsLoaded = useChatStore((s) => {
    const sel = scope ?? s.selectedWorktree;
    if (!sel) return false;
    const key = `${sel.projectId}/${sel.worktreeId}`;
    return Object.prototype.hasOwnProperty.call(s.archivedChats, key);
  });
  const loadArchivedChats = useChatStore((s) => s.loadArchivedChats);
  const restoreArchivedChat = useChatStore((s) => s.restoreArchivedChat);
  const summarizeArchivedChat = useChatStore((s) => s.summarizeArchivedChat);
  const markArchivedChatRead = useChatStore((s) => s.markArchivedChatRead);
  const markAllArchivedChatsRead = useChatStore(
    (s) => s.markAllArchivedChatsRead,
  );
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  // Labs: draw the hover card on the shared menu surface.
  const archivedChatsCard = useLabsExperimentEnabled('archived-chats-card');

  // Archive surfacing: hover popover + full modal, plus per-chat in-flight
  // tracking so the row actions can show spinners and disable while the async
  // restore/summarize calls run.
  const [archivePopoverOpen, setArchivePopoverOpen] = useState(false);
  // The tab-strip variant's wrapper, which anchors its body-portaled popover.
  const [tabStripAnchor, setTabStripAnchor] = useState<HTMLDivElement | null>(
    null,
  );
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  // Right-click menu on the archive icon ("Mark all as read").
  const [archiveMenu, setArchiveMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Read-only transcript viewer state. `viewerChatId` is the archived chat being
  // viewed; `viewerFromModal` records whether it was opened from the archive
  // list modal, so closing the viewer can return to that list.
  const [viewerChatId, setViewerChatId] = useState<string | null>(null);
  const [viewerFromModal, setViewerFromModal] = useState(false);
  const [summarizingIds, setSummarizingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Ensure the worktree's archive list is loaded when the control mounts or
  // changes worktrees (eager hydration covers startup; this covers later
  // navigation). Reading `selectedWorktree` via `getState` keeps the effect
  // keyed on the stable `worktreeKey` string rather than object identity.
  useEffect(() => {
    const sel = hasScopedSelection
      ? {
          projectId: scopedProjectId as string,
          worktreeId: scopedWorktreeId as string,
        }
      : useChatStore.getState().selectedWorktree;
    if (!sel) return;
    void loadArchivedChats(sel.projectId, sel.worktreeId);
  }, [
    worktreeKey,
    hasScopedSelection,
    scopedProjectId,
    scopedWorktreeId,
    loadArchivedChats,
  ]);

  // Close the archive popover/modal when there is nothing left to show (e.g.
  // the last archived chat was restored).
  useEffect(() => {
    if (archivedSummaries.length === 0) {
      setArchivePopoverOpen(false);
      setArchiveModalOpen(false);
      setViewerChatId(null);
    }
  }, [archivedSummaries.length]);

  // If the chat being viewed is no longer in the archive list (restored, or its
  // worktree changed), drop the viewer so it cannot reference a missing entry.
  useEffect(() => {
    if (
      viewerChatId !== null &&
      !archivedSummaries.some((summary) => summary.chatId === viewerChatId)
    ) {
      setViewerChatId(null);
    }
  }, [viewerChatId, archivedSummaries]);

  useEffect(() => {
    if (scope && !primarySurface) return;

    const handleOpenArchives = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail: unknown = event.detail;
      if (!isWorktreeChatOpenArchivesDetail(detail)) {
        return;
      }
      const sel = scope ?? useChatStore.getState().selectedWorktree;
      if (!sel) return;
      if (detail?.projectId && detail.projectId !== sel.projectId) {
        return;
      }
      if (detail?.worktreeId && detail.worktreeId !== sel.worktreeId) {
        return;
      }

      void loadArchivedChats(sel.projectId, sel.worktreeId).then((): void => {
        const nextSummaries =
          useChatStore.getState().archivedChats[
            `${sel.projectId}/${sel.worktreeId}`
          ] ?? EMPTY_ARCHIVES;
        if (nextSummaries.length === 0) return;
        setArchivePopoverOpen(false);
        setArchiveModalOpen(true);
      });
    };

    window.addEventListener(
      WORKTREE_CHAT_OPEN_ARCHIVES_EVENT,
      handleOpenArchives,
    );
    return (): void => {
      window.removeEventListener(
        WORKTREE_CHAT_OPEN_ARCHIVES_EVENT,
        handleOpenArchives,
      );
    };
  }, [scope, primarySurface, loadArchivedChats]);

  const archivedViewerSel = scope ?? selectedWorktree;
  const archivedViewerSummary =
    viewerChatId !== null
      ? archivedSummaries.find((summary) => summary.chatId === viewerChatId)
      : undefined;

  // Surface the archive count + modal/viewer-open state to the App Advisor's
  // current-UI-state snapshot (consumed under `chat.archivedChats`). Only the
  // primary instance reports it; secondary scoped instances (plan-explore
  // modal, cowork, popouts) stay out so they cannot clobber the slice.
  useCurrentUiStateReporter(
    'chat.archivedChats',
    (scope && !primarySurface) || !archivedChatsLoaded
      ? null
      : {
          count: archivedSummaries.length,
          modalOpen: archiveModalOpen,
          viewerOpen: Boolean(archivedViewerSummary),
          ...(archivedViewerSummary
            ? {
                viewerChatId: archivedViewerSummary.chatId,
                viewerTitle: getArchivedChatDisplayLabel(archivedViewerSummary),
              }
            : {}),
        },
  );

  const withInFlight = useCallback(
    (
      setIds: (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>,
      ) => void,
      chatId: string,
      run: () => Promise<void>,
    ): void => {
      setIds((prev) => new Set(prev).add(chatId));
      void run()
        .catch((error: unknown) => {
          // eslint-disable-next-line no-console
          console.error('Archived chat action failed', error);
        })
        .finally(() => {
          setIds((prev) => {
            const next = new Set(prev);
            next.delete(chatId);
            return next;
          });
        });
    },
    [],
  );

  const handleRestoreArchived = useCallback(
    (chatId: string): void => {
      const sel = scope ?? useChatStore.getState().selectedWorktree;
      if (!sel) return;
      withInFlight(setRestoringIds, chatId, async () => {
        await restoreArchivedChat(sel.projectId, sel.worktreeId, chatId);
        setArchivePopoverOpen(false);
        setArchiveModalOpen(false);
        setViewerChatId(null);
      });
    },
    [scope, restoreArchivedChat, withInFlight],
  );

  const handleSummarizeArchived = useCallback(
    (chatId: string): void => {
      const sel = scope ?? useChatStore.getState().selectedWorktree;
      if (!sel) return;
      withInFlight(setSummarizingIds, chatId, async () => {
        await summarizeArchivedChat(sel.projectId, sel.worktreeId, chatId);
        setArchivePopoverOpen(false);
        setArchiveModalOpen(false);
        setViewerChatId(null);
      });
    },
    [scope, summarizeArchivedChat, withInFlight],
  );

  // Open the read-only transcript viewer for an archived chat. Remember whether
  // the list modal was open so the viewer can return to it on close. Opening the
  // viewer counts as reading the chat, so clear its unread flag.
  const handleOpenArchivedChat = useCallback(
    (chatId: string): void => {
      setViewerFromModal(archiveModalOpen);
      setArchivePopoverOpen(false);
      setViewerChatId(chatId);
      const sel = scope ?? useChatStore.getState().selectedWorktree;
      if (sel) {
        void markArchivedChatRead(sel.projectId, sel.worktreeId, chatId);
      }
    },
    [archiveModalOpen, scope, markArchivedChatRead],
  );

  const handleCloseViewer = useCallback((): void => {
    setViewerChatId(null);
    // When the viewer was launched from the list modal, returning means simply
    // revealing the still-open modal underneath; otherwise nothing else to do.
  }, []);

  // Open the transcript viewer for a specific archived chat in response to the
  // unread-chat toast for an auto-archived chat. The worktree was just selected
  // by the toast handler, so refresh the archive list first, then open.
  useEffect(() => {
    const handleOpenTranscript = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isWorktreeChatOpenArchiveTranscriptDetail(detail)) return;
      const sel = scope ?? useChatStore.getState().selectedWorktree;
      if (!sel) return;
      if (detail.projectId !== sel.projectId) return;
      if (detail.worktreeId !== sel.worktreeId) return;

      void loadArchivedChats(sel.projectId, sel.worktreeId).then((): void => {
        const nextSummaries =
          useChatStore.getState().archivedChats[
            `${sel.projectId}/${sel.worktreeId}`
          ] ?? EMPTY_ARCHIVES;
        if (!nextSummaries.some((s) => s.chatId === detail.chatId)) return;
        setArchiveModalOpen(false);
        handleOpenArchivedChat(detail.chatId);
      });
    };

    window.addEventListener(
      WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
      handleOpenTranscript,
    );
    return (): void => {
      window.removeEventListener(
        WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
        handleOpenTranscript,
      );
    };
  }, [scope, loadArchivedChats, handleOpenArchivedChat]);

  // Track unread archive state for the archive icon and menu.
  const hasUnreadArchived = archivedSummaries.some((summary) => summary.unread);

  const closeArchiveMenu = useCallback((): void => setArchiveMenu(null), []);

  const handleMarkAllArchivedRead = useCallback((): void => {
    setArchiveMenu(null);
    const sel = scope ?? useChatStore.getState().selectedWorktree;
    if (!sel) return;
    void markAllArchivedChatsRead(sel.projectId, sel.worktreeId);
  }, [scope, markAllArchivedChatsRead]);

  if (archivedSummaries.length === 0) {
    return null;
  }

  return (
    <div
      ref={variant === 'tabStrip' ? setTabStripAnchor : undefined}
      className={`relative shrink-0 ${className}`.trimEnd()}
      onPointerLeave={() => setArchivePopoverOpen(false)}
    >
      {variant === 'tabStrip' ? (
        <>
          <TitlebarIconButton
            data-testid="chat-tab-archive"
            data-unread={hasUnreadArchived ? 'true' : undefined}
            icon={ArchiveIcon}
            onPointerEnter={() => setArchivePopoverOpen(true)}
            onClick={() => {
              setArchivePopoverOpen(false);
              setArchiveModalOpen(true);
            }}
            onContextMenu={(e): void => {
              e.preventDefault();
              setArchivePopoverOpen(false);
              setArchiveMenu({ x: e.clientX, y: e.clientY });
            }}
            aria-label={`Archived ${CHAT_UNIT_LABEL}s (${archivedSummaries.length})`}
            aria-haspopup="dialog"
            // Hovering opens the archive popover, which says what this is.
            tooltipLabel=""
          />
          {hasUnreadArchived ? (
            <span
              data-testid="chat-tab-archive-unread"
              aria-hidden="true"
              // The sidebar's 6px unread dot, on the glyph's top-right corner.
              className={`pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${OPERATIONAL_STATUS_COLORS.unread.background}`}
            />
          ) : null}
        </>
      ) : (
        <button
          type="button"
          data-testid="chat-tab-archive"
          data-unread={hasUnreadArchived ? 'true' : undefined}
          onPointerEnter={() => setArchivePopoverOpen(true)}
          onClick={() => {
            setArchivePopoverOpen(false);
            setArchiveModalOpen(true);
          }}
          onContextMenu={(e): void => {
            e.preventDefault();
            setArchivePopoverOpen(false);
            setArchiveMenu({ x: e.clientX, y: e.clientY });
          }}
          // Matches the shared TitlebarIconButton frame (tab strip `+`, group
          // chrome) — hand-rolled rather than the shared component because the
          // count badge renders as a child, and hovering opens the archive
          // popover, which the component's built-in tooltip would fight.
          className={`electron-no-drag focus-ring relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors enabled:hover:bg-subtle enabled:hover:fg-primary ${
            hasUnreadArchived ? 'text-amber-400' : 'fg-secondary'
          }`}
          aria-label={`Archived ${CHAT_UNIT_LABEL}s (${archivedSummaries.length})`}
          aria-haspopup="dialog"
        >
          <ArchiveIcon size={16} />
          <span
            data-testid="chat-tab-archive-count"
            // Same material as the `Open in` split control next to it:
            // `bg-quaternary` + `shadow-sm` + a 0.5px `line-secondary` ring.
            className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.25 min-w-3.25 items-center justify-center rounded-full bg-quaternary px-0.75 text-3xs font-medium leading-none tabular-nums fg-primary shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary"
          >
            {formatArchiveBadgeCount(archivedSummaries.length)}
          </span>
        </button>
      )}
      {archivePopoverOpen && (
        <ArchivedChatsPopover
          summaries={archivedSummaries}
          onOpenChat={handleOpenArchivedChat}
          onRestore={handleRestoreArchived}
          onSummarize={handleSummarizeArchived}
          onOpenModal={() => {
            setArchivePopoverOpen(false);
            setArchiveModalOpen(true);
          }}
          summarizingIds={summarizingIds}
          restoringIds={restoringIds}
          align={popoverAlign}
          anchor={variant === 'tabStrip' ? tabStripAnchor : null}
          look={archivedChatsCard ? 'card' : 'classic'}
        />
      )}
      {archiveMenu && (
        <TabContextMenu
          x={archiveMenu.x}
          y={archiveMenu.y}
          dataTestId="chat-tab-archive-menu"
          onClose={closeArchiveMenu}
          items={[
            {
              key: 'mark-all-read',
              label: 'Mark all as read',
              icon: <CheckIcon />,
              disabled: !hasUnreadArchived,
              testId: 'chat-tab-archive-mark-all-read',
              onSelect: handleMarkAllArchivedRead,
            },
          ]}
        />
      )}
      {archiveModalOpen && (
        <Suspense fallback={null}>
          <ArchivedChatsModal
            summaries={archivedSummaries}
            onOpenChat={handleOpenArchivedChat}
            onRestore={handleRestoreArchived}
            onSummarize={handleSummarizeArchived}
            onClose={() => setArchiveModalOpen(false)}
            summarizingIds={summarizingIds}
            restoringIds={restoringIds}
          />
        </Suspense>
      )}
      {viewerChatId !== null && archivedViewerSel && archivedViewerSummary && (
        <Suspense fallback={null}>
          <ArchivedChatTranscriptModal
            projectId={archivedViewerSel.projectId}
            worktreeId={archivedViewerSel.worktreeId}
            summary={archivedViewerSummary}
            onRestore={() => handleRestoreArchived(viewerChatId)}
            onSummarize={() => handleSummarizeArchived(viewerChatId)}
            restoring={restoringIds.has(viewerChatId)}
            summarizing={summarizingIds.has(viewerChatId)}
            onClose={handleCloseViewer}
            noEnterAnimation={viewerFromModal}
          />
        </Suspense>
      )}
    </div>
  );
});
