import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { ToolApprovalCard } from './ToolApprovalCard';
import {
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';

const EMPTY_PENDING_APPROVALS: ApprovalRequestEvent[] = [];

export interface ToolApprovalDockProps {
  /** Complete active-chat identity used to isolate pending approvals. */
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Docked tool-approval surface rendered directly above the chat composer
 * (see `docs/tool-approvals.md` "The prompt flow"). Replaces the previous
 * in-transcript `ToolApprovalCard` mount inside `ChatBlockRenderer.tsx`: the
 * card no longer needs to match itself to a specific `tool_use` block by
 * `toolUseId`, because the dock shows every pending approval for the active
 * chat regardless of transcript position (main-turn or subagent-originated).
 *
 * With exactly one pending approval, the dock renders just the card. With
 * two or more (restart-hydrated pendings, or a mixture of main-turn and
 * subagent requests queued up together), a header row shows a non-wrapping
 * "Approval N of M" count plus ← → navigation, and the currently-selected
 * approval's card renders below it.
 *
 * Selection is local component state — a plain index into the chat's
 * pending-approvals array, ordered by store insertion order (stable arrival
 * order; hydration re-populates the store in persisted-array order, so a
 * restored dock's ordering is deterministic too). The index resets to 0 when
 * `chatId` changes and is otherwise just clamped to the current list length
 * on every render: resolving the currently-viewed approval removes it from
 * the record, the list shifts up beneath the same index, and the user lands
 * on whatever is now at that position — the next unresolved approval, or the
 * new last approval if the one they resolved was previously last. When the
 * list empties entirely the dock unmounts.
 */
export const ToolApprovalDock = memo(function ToolApprovalDock({
  projectId,
  worktreeId,
  chatId,
}: ToolApprovalDockProps): JSX.Element | null {
  const pending = useChatStore(
    useShallow((s): ApprovalRequestEvent[] => {
      const forChat = Object.values(s.pendingApprovals).filter(
        (p) =>
          p.projectId === projectId &&
          p.worktreeId === worktreeId &&
          p.chatId === chatId,
      );
      return forChat.length > 0 ? forChat : EMPTY_PENDING_APPROVALS;
    }),
  );

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset navigation position when the active chat changes — a dock should
  // never carry over another chat's scroll position into this one.
  useEffect(() => {
    setSelectedIndex(0);
  }, [projectId, worktreeId, chatId]);

  const activeIndex =
    pending.length === 0 ? 0 : Math.min(selectedIndex, pending.length - 1);
  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex < pending.length - 1;

  const goPrev = useCallback((): void => {
    setSelectedIndex((current) =>
      Math.max(0, Math.min(current, pending.length - 1) - 1),
    );
  }, [pending.length]);

  const goNext = useCallback((): void => {
    setSelectedIndex((current) =>
      Math.min(pending.length - 1, Math.min(current, pending.length - 1) + 1),
    );
  }, [pending.length]);

  const current = pending[activeIndex];
  useCurrentUiStateReporter(
    'chat.toolApprovalDock',
    current
      ? {
          visible: true,
          pendingCount: pending.length,
          selectedIndex: activeIndex,
          provider: current.provider,
          requestKind: current.details.kind,
          subagent: Boolean(current.subagentId),
        }
      : null,
  );
  if (!current) {
    return null;
  }

  return (
    // The dock chrome is recorded; the card blocks the command, path, or
    // input the agent asks to run.
    <div data-testid="tool-approval-dock" className="mb-1.5">
      {pending.length > 1 && (
        <div className="mb-1 flex items-center justify-between px-0.5">
          <span
            data-testid="tool-approval-count"
            className="text-2xs fg-secondary"
          >
            Approval {activeIndex + 1} of {pending.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="tool-approval-nav-prev"
              aria-label="Previous approval"
              disabled={!canGoPrev}
              onClick={goPrev}
              className="rounded p-1 fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80 disabled:pointer-events-none disabled:opacity-30"
            >
              <AppCatalogChevronLeftMediumIcon
                aria-hidden="true"
                width="14"
                height="14"
              />
            </button>
            <button
              type="button"
              data-testid="tool-approval-nav-next"
              aria-label="Next approval"
              disabled={!canGoNext}
              onClick={goNext}
              className="rounded p-1 fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80 disabled:pointer-events-none disabled:opacity-30"
            >
              <AppCatalogChevronRightMediumIcon
                aria-hidden="true"
                width="14"
                height="14"
              />
            </button>
          </div>
        </div>
      )}
      <ToolApprovalCard key={current.requestId} pending={current} />
    </div>
  );
});
