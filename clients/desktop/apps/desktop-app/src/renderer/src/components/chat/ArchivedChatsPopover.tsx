import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  getModelDisplayName,
  type ArchivedChatSummary,
} from '@canopy/desktop-shared/types';
import {
  ArchivedChatsCard,
  type ArchivedChatsCardItem,
} from '@canopy/ui-shared/components';
import { AgentProviderIcon } from '@/lib/providerUi';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';
import {
  ANCHORED_POPOVER_PADDING,
  computePopoverViewportShift,
  findPopoverBoundary,
} from '@/lib/anchoredPopoverPosition';
import { ArchivedChatRow } from './ArchivedChatRow';

const POPOVER_LIMIT = 5;

export interface ArchivedChatsPopoverProps {
  summaries: ArchivedChatSummary[];
  /** Open the read-only transcript viewer for a chat (row click). */
  onOpenChat: (chatId: string) => void;
  onRestore: (chatId: string) => void;
  onSummarize: (chatId: string) => void;
  /** Open the full modal (also used by the "N more…" row). */
  onOpenModal: () => void;
  summarizingIds: ReadonlySet<string>;
  restoringIds: ReadonlySet<string>;
  /**
   * Which trigger edge the card anchors to: `'right'` (default) aligns its
   * right edge to the icon and opens down-and-left; `'left'` opens
   * down-and-right so a left-edge trigger is not clipped by the window.
   */
  align?: 'left' | 'right';
  /**
   * When set, the card renders on the anchor's document body in fixed
   * position below the anchor (above it when the window has more room
   * there), instead of absolutely inside its parent. The
   * tab-strip control (early access) uses it: its panel leaf clips overflow,
   * so a short or collapsed group would cut an in-place card off. React
   * still treats the portaled card as inside the control, so pointer-leave
   * dismissal keeps working.
   */
  anchor?: HTMLElement | null;
  /**
   * `card` draws the shared `ArchivedChatsCard` (the Archived chats card
   * Labs experiment); `classic` (default) keeps today's popover.
   */
  look?: 'classic' | 'card';
}

/** The sub-line facts: the model and the turn count. */
function archivedChatMeta(summary: ArchivedChatSummary): string {
  const turns = `${summary.turnCount} ${
    summary.turnCount === 1 ? 'turn' : 'turns'
  }`;
  return summary.model
    ? `${getModelDisplayName(summary.model)} · ${turns}`
    : turns;
}

function toCardItem(
  summary: ArchivedChatSummary,
  summarizingIds: ReadonlySet<string>,
  restoringIds: ReadonlySet<string>,
): ArchivedChatsCardItem {
  return {
    id: summary.chatId,
    title: getArchivedChatDisplayLabel(summary),
    meta: archivedChatMeta(summary),
    icon: summary.providerType ? (
      <AgentProviderIcon
        provider={summary.providerType}
        width={14}
        height={14}
      />
    ) : undefined,
    unread: summary.unread,
    restorable: summary.restorable,
    restoring: restoringIds.has(summary.chatId),
    summarizing: summarizingIds.has(summary.chatId),
  };
}

interface FixedPosition {
  top: number;
  left: number;
  /** Opens above the anchor: too little room below, more above. */
  above: boolean;
  /** Caps the card to the window space on its side; it scrolls past it. */
  maxHeight: number;
}

/**
 * Hover popover showing the 5 most recently archived chats for the worktree.
 * When more than 5 are archived, a trailing "N more…" row opens the full modal.
 * Positioned by its parent (anchored below the archive icon, toward `align`).
 */
export function ArchivedChatsPopover({
  summaries,
  onOpenChat,
  onRestore,
  onSummarize,
  onOpenModal,
  summarizingIds,
  restoringIds,
  align = 'right',
  anchor = null,
  look = 'classic',
}: ArchivedChatsPopoverProps): JSX.Element {
  const visible = summaries.slice(0, POPOVER_LIMIT);
  const overflow = summaries.length - visible.length;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [shiftX, setShiftX] = useState(0);
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  const [fixedPosition, setFixedPosition] = useState<FixedPosition | null>(
    null,
  );

  // Measure after layout, then keep the card inside whatever would clip it.
  // The anchor sits wherever the header cluster lands, so a narrow content
  // region — or a large UI scale, since `w-80` is rem-based and reaches 560px
  // at 175% — pushes a right-anchored card past the region's left edge.
  // Measure from the UNSHIFTED position each time, so re-running is
  // idempotent rather than accumulating shifts.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return undefined;
    const view = card.ownerDocument.defaultView;
    if (view === null) return undefined;

    const apply = (): void => {
      if (anchor !== null) {
        // Fixed on the body: only the window clips the card.
        const boundary = { left: 0, right: view.innerWidth };
        const available =
          boundary.right - boundary.left - ANCHORED_POPOVER_PADDING * 2;
        setMaxWidth(available > 0 ? available : null);
        const anchorRect = anchor.getBoundingClientRect();
        const width = Math.min(
          card.offsetWidth,
          available > 0 ? available : card.offsetWidth,
        );
        const left =
          align === 'left' ? anchorRect.left : anchorRect.right - width;
        // `scrollHeight` is the natural height even while a previous
        // `maxHeight` caps the card, so re-running stays idempotent.
        const height = card.scrollHeight;
        const spaceBelow =
          view.innerHeight - anchorRect.bottom - ANCHORED_POPOVER_PADDING;
        const spaceAbove = anchorRect.top - ANCHORED_POPOVER_PADDING;
        const above = height > spaceBelow && spaceAbove > spaceBelow;
        const maxHeight = Math.max(0, above ? spaceAbove : spaceBelow);
        setFixedPosition({
          top: above
            ? anchorRect.top - Math.min(height, maxHeight)
            : anchorRect.bottom,
          left,
          above,
          maxHeight,
        });
        setShiftX(
          computePopoverViewportShift({
            left,
            right: left + width,
            boundary,
          }),
        );
        return;
      }
      const boundary = findPopoverBoundary(card);
      const available =
        boundary.right - boundary.left - ANCHORED_POPOVER_PADDING * 2;
      setMaxWidth(available > 0 ? available : null);
      const rect = card.getBoundingClientRect();
      setShiftX((previous) =>
        computePopoverViewportShift({
          left: rect.left - previous,
          right: rect.right - previous,
          boundary,
        }),
      );
    };

    apply();
    view.addEventListener('resize', apply);
    return (): void => {
      view.removeEventListener('resize', apply);
    };
    // Re-measure when the row count changes the card's height/width.
  }, [visible.length, overflow, anchor, align]);

  // Both placements sit on the dropdown layer: the native Browser view only
  // yields to the design system's floating layers, so a card on a plain
  // z-index would be cut off where a Browser pane below the header starts.
  const positionClassName =
    anchor === null
      ? `absolute top-full z-dropdown pt-1 ${align === 'left' ? 'left-0' : 'right-0'}`
      : `fixed z-dropdown overflow-y-auto ${
          fixedPosition?.above === true ? 'pb-1' : 'pt-1'
        }`;

  const card = (
    // Outer element spans the full anchored region. The `pt-1` (`pb-1` when
    // a fixed card opens above) is padding, not
    // margin, so the 4px offset below the archive icon stays part of this
    // element's hover area — the cursor can cross the gap from the icon to the
    // card without leaving the wrapper's pointer region and dismissing the
    // popover.
    <div
      ref={cardRef}
      data-testid="chat-tab-archive-popover"
      // `w-80` is rem-based, so the card grows with the UI scale setting — at
      // 175% it is 560px, wider than a narrow content region on its own. The
      // measured `maxWidth` caps it to the clipping ancestor so shifting is
      // enough to fit; without it, no shift could reveal both edges.
      className={`electron-no-drag ${positionClassName} w-80`}
      style={{
        ...(anchor === null
          ? {}
          : {
              top: `${fixedPosition?.top ?? 0}px`,
              left: `${fixedPosition?.left ?? 0}px`,
              ...(fixedPosition === null
                ? {}
                : { maxHeight: `${fixedPosition.maxHeight}px` }),
            }),
        ...(shiftX === 0 ? {} : { transform: `translateX(${shiftX}px)` }),
        ...(maxWidth === null ? {} : { maxWidth: `${maxWidth}px` }),
      }}
    >
      {look === 'card' ? (
        <ArchivedChatsCard
          items={visible.map((summary) =>
            toCardItem(summary, summarizingIds, restoringIds),
          )}
          overflowCount={overflow}
          onOpen={onOpenChat}
          onRestore={onRestore}
          onSummarize={onSummarize}
          onShowAll={onOpenModal}
          className="w-full"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
          <p className="px-3 py-1.5 text-3xs font-semibold fg-secondary">
            Archived chats
          </p>
          <div className="max-h-80 overflow-y-auto">
            {visible.map((summary) => (
              <ArchivedChatRow
                key={summary.chatId}
                summary={summary}
                dataTestId="chat-tab-archive-popover-row"
                onOpen={() => onOpenChat(summary.chatId)}
                onRestore={() => onRestore(summary.chatId)}
                onSummarize={() => onSummarize(summary.chatId)}
                summarizing={summarizingIds.has(summary.chatId)}
                restoring={restoringIds.has(summary.chatId)}
              />
            ))}
          </div>
          {overflow > 0 && (
            <button
              type="button"
              onClick={onOpenModal}
              data-testid="chat-tab-archive-more"
              className="w-full rounded-md px-3 py-2 text-left text-xs font-medium fg-secondary transition-colors hover:bg-fg-primary/[0.04] hover:fg-primary"
            >
              {overflow} more…
            </button>
          )}
        </div>
      )}
    </div>
  );

  return anchor === null ? card : createPortal(card, anchor.ownerDocument.body);
}
