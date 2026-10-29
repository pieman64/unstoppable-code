'use client';

import { hideDelegationTransportParts } from '@canopy/ui-shared/lib';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import {
  ThinkingSpinner,
  useCleanChatLook,
} from '@canopy/ui-shared/components';
import {
  detectSentPrompt,
  hasLiveTurnTimer,
  type ChatThreadStatus,
  type SentPromptSummary,
} from '@canopy/app-state';
import { TurnGroupView } from './TurnGroupView';
import { useChatVisualHost } from './chat-visual-host';
import {
  collectChatVisualOwners,
  useChatVisualsPublisher,
} from './chat-visuals-source';
import { useTurnWorkingStatus } from './ChatPartView';
import { summarizeTranscriptPrompts } from './sent-prompt-summary';

/**
 * Presentational chat transcript: renders the turn groups (via
 * {@link TurnGroupView}) plus empty / streaming / error states, and keeps the
 * view scrolled to the newest message. It takes the thread's neutral data as
 * props; the store read happens one level up in `ChatPanel`, keeping this
 * component pure and directly `renderToString`-testable.
 */
export interface ChatTranscriptProps {
  /**
   * The chat this transcript shows. A prompt the person sends re-arms
   * bottom-follow only within the same chat.
   */
  readonly chatId?: string;
  /** False while the host is hydrating history, including an empty history. */
  readonly initialized?: boolean;
  readonly messages: readonly PortalChatMessage[];
  readonly turnGroups: readonly PortalChatTurnGroup[];
  readonly status: ChatThreadStatus;
  readonly error?: string | null;
  readonly appIcon?: ReactNode;
  /** Overrides the default empty-state placeholder. */
  readonly emptyState?: ReactNode;
  /**
   * Renders the turn-level thumbs up/down control (CAN-1521) for one turn,
   * keyed by the turn's `localMessageId` (the desktop renderer's per-turn
   * `userMessageId`, which `PortalChatMessage.localMessageId` already
   * persists). Omitted by hosts without the `turnFeedback` capability.
   */
  readonly renderTurnFeedback?: (localMessageId: string) => ReactNode;
  /** Host-owned action rendered beside the latest turn only. */
  readonly renderLatestTurnAction?: (context: {
    readonly disabled: boolean;
  }) => ReactNode;
  /**
   * Rendered as the last content inside the scroll container, above the
   * autoscroll sentinel. Queued messages belong here: they are the tail of the
   * conversation, so they must scroll WITH the transcript. Rendering them as a
   * sibling below the scroll container (as the panel used to) let them grow as
   * an unbounded flex item, squeezing the `flex-1` transcript until scroll-back
   * was unreachable (CAN-2524).
   */
  readonly footerSlot?: ReactNode;
  /**
   * Host status that belongs under the queue tail (a first send that has not
   * produced a turn yet). Independent of `status`: a queued first send is not
   * streaming, so the transcript's own working row does not cover it.
   */
  readonly footerStatus?: ReactNode;
  /**
   * Prompts the person has queued in `footerSlot`, excluding host entries.
   * Queuing a prompt is a send, so it re-arms bottom-follow.
   */
  readonly queuedPromptCount?: number;
  readonly queuedPromptIds?: readonly string[];
  /** Canonical user-message identities of those queued sends. */
  readonly queuedPromptMessageIds?: readonly string[];
  readonly onLoadOlder?: () => Promise<void>;
}

export function getLatestMessageSignal(
  messages: readonly PortalChatMessage[],
): string {
  const latestMessage = messages[messages.length - 1];
  return latestMessage
    ? [
        latestMessage.messageId,
        latestMessage.updatedAtMs ?? latestMessage.createdAtMs,
        latestMessage.text.length,
        latestMessage.parts?.length ?? 0,
      ].join(':')
    : '';
}

/** Virtualized transcript geometry before turns are measured. */
const ESTIMATED_TURN_HEIGHT_PX = 200;
const TURN_GAP_PX = 8;
const INITIAL_VIEWPORT_HEIGHT_PX = 600;

/**
 * Whether the latest turn already shows `error` in one of its final messages.
 * A failed provider frame is both a failed message and the thread error, so
 * the error line under the transcript would repeat the same text.
 *
 * Only final messages count: they always render, while a completed turn can
 * fold its intermediate messages away. Any status counts: persisted Portal
 * messages project as `complete`, and a message with the same text already
 * shows the error. Anything else keeps the error line.
 */
function latestTurnShowsError(
  turnGroups: readonly PortalChatTurnGroup[],
  messagesById: Readonly<Record<string, PortalChatMessage | undefined>>,
  error: string,
): boolean {
  const latest = turnGroups[turnGroups.length - 1];
  if (!latest) return false;
  const text = error.trim();
  return latest.finalMessageIds.some((id) => {
    const message = messagesById[id];
    return (
      message !== undefined &&
      message.role !== 'user' &&
      message.text.trim() === text
    );
  });
}

export function ChatTranscript({
  chatId,
  initialized = true,
  messages: inputMessages,
  turnGroups,
  status,
  error,
  appIcon,
  emptyState,
  renderTurnFeedback,
  renderLatestTurnAction,
  footerSlot,
  footerStatus,
  queuedPromptCount = 0,
  queuedPromptIds,
  queuedPromptMessageIds,
  onLoadOlder,
}: ChatTranscriptProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const readerScrollTop = useRef(0);
  const scheduledScroll = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const touchY = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const messages = useMemo(
    () => hideDelegationTransportParts(inputMessages),
    [inputMessages],
  );
  // The Chat visuals panel lists what this transcript holds, so it needs no
  // transcript of its own. Nothing is collected where the host has no panel.
  const visualHost = useChatVisualHost();
  const visualsSourceKey = visualHost?.sourceKey ?? null;
  const visualOwners = useMemo(
    () => (visualsSourceKey === null ? [] : collectChatVisualOwners(messages)),
    [visualsSourceKey, messages],
  );
  useChatVisualsPublisher(visualsSourceKey, visualOwners, visualHost);
  const hasMessages = messages.length > 0;
  const hasFooter = footerSlot != null || footerStatus != null;
  const virtualized = turnGroups.length > 50;
  const virtualizer = useVirtualizer({
    count: turnGroups.length,
    enabled: virtualized,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT_PX,
    // Matches the non-virtualized column's gap-2, which TurnGroupView's
    // footer spacing relies on.
    gap: TURN_GAP_PX,
    getItemKey: (index) => turnGroups[index].userMessageId,
    overscan: 5,
    initialRect: { width: 800, height: INITIAL_VIEWPORT_HEIGHT_PX },
    initialOffset: () =>
      Math.max(
        0,
        turnGroups.length * (ESTIMATED_TURN_HEIGHT_PX + TURN_GAP_PX) -
          TURN_GAP_PX -
          INITIAL_VIEWPORT_HEIGHT_PX,
      ),
  });
  const virtualHeight = virtualizer.getTotalSize();
  const messagesById = useMemo(() => {
    const byId: Record<string, PortalChatMessage> = {};
    for (const message of messages) {
      byId[message.messageId] = message;
    }
    return byId;
  }, [messages]);
  const latestMessageSignal = getLatestMessageSignal(messages);
  // Shared predicate from @canopy/app-state (same shape rule as the turn-group
  // float, aligned with the store's liveness rule): scoped to the current turn
  // so an orphaned timer from an interrupted earlier turn cannot suppress the
  // fallback spinner. The real cost win is the predicate's early break at the
  // last user message; the useMemo only skips recomputes for renders that keep
  // the same messages array (e.g. status/error changes).
  const liveTurnTimer = useMemo(() => hasLiveTurnTimer(messages), [messages]);
  const cleanChatLook = useCleanChatLook();
  const workingStatus = useTurnWorkingStatus();
  // Fallback feedback for the send→timer gap and for hosts that never emit turn
  // timers; once a live timer row is on screen it owns the spinner (CAN-2342).
  //
  // Rendered INSIDE the last turn group (see `workingSlot`) so it occupies the
  // same slot the turn's own `turn_timer` row will, rather than below the
  // turn's action row — otherwise the indicator jumps up past the fork control
  // the moment the real timer frame arrives. `px-3` is `ChatMessageView`'s
  // bubble-text inset, which every in-group row including the timer sits on.
  //
  // `role="status"` ONLY when a host supplied a working label. The label is the
  // sole announceable content: the spinner's `aria-label` sits on a roleless
  // `<span>` that Chromium drops, so a region without a label announces nothing
  // it should — while `role="status"` implies `aria-atomic="true"`, so any AT
  // that DOES expose that name would read "Thinking" on every turn. Gating
  // keeps the announcement on the one surface that populates it
  // (`TurnWorkingStatusProvider`, mounted by the web portal's chat panel) and
  // leaves every other caller's DOM unchanged. Chromium fires a live-region
  // change when a populated `status` node is inserted, which is how this row
  // always appears. It does NOT make every working label announceable: on a
  // host that emits turn timers the `liveTurnTimer` guard hides this row
  // mid-turn, and the `TurnTimer` row that then owns the label has no live
  // region.
  // Clean chat look: shimmering words in place of the spinner.
  const workingRow =
    status === 'streaming' && !liveTurnTimer && cleanChatLook ? (
      <div
        {...(workingStatus === null ? {} : { role: 'status' })}
        className="px-3 py-0.5 text-s fg-secondary"
        data-testid="chat-transcript-streaming"
      >
        <span className="canopy-text-shimmer">
          {workingStatus ?? 'Thinking'}
        </span>
      </div>
    ) : status === 'streaming' && !liveTurnTimer ? (
      <div
        {...(workingStatus === null ? {} : { role: 'status' })}
        className="flex items-center gap-2 px-3 py-1 text-xs fg-secondary"
        data-testid="chat-transcript-streaming"
      >
        <ThinkingSpinner />
        {workingStatus !== null && <span>{workingStatus}</span>}
      </div>
    ) : null;

  const leaveBottom = (): void => {
    pinned.current = false;
    readerScrollTop.current = scrollRef.current?.scrollTop ?? 0;
  };

  const followBottom = useCallback(() => {
    if (!pinned.current || scheduledScroll.current !== null) return;
    scheduledScroll.current = requestAnimationFrame(() => {
      scheduledScroll.current = null;
      const viewport = scrollRef.current;
      if (pinned.current && viewport)
        viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(followBottom, [
    followBottom,
    latestMessageSignal,
    messages.length,
    status,
  ]);

  // Sending is a request to be at the tail: a prompt the person sends or
  // queues re-arms bottom-follow even when they had scrolled up, and the
  // follow effects keep the reply in view until they scroll up again. Watcher
  // and steering prompts arrive on their own and leave the reader in place.
  const transcriptPrompts = useMemo(
    () => summarizeTranscriptPrompts(messages),
    [messages],
  );
  const sentPromptTracker = useRef<
    | (SentPromptSummary & {
        chatId: string | undefined;
        initialized: boolean;
        seenQueuedIds: Set<string>;
        seenQueuedPromptIds: Set<string>;
      })
    | null
  >(null);
  useLayoutEffect(() => {
    const previous = sentPromptTracker.current;
    const seenQueuedIds =
      previous !== null && previous.chatId === chatId
        ? previous.seenQueuedIds
        : new Set<string>();
    const seenQueuedPromptIds =
      previous !== null && previous.chatId === chatId
        ? previous.seenQueuedPromptIds
        : new Set<string>();
    for (const id of queuedPromptMessageIds ?? []) seenQueuedPromptIds.add(id);
    const next: SentPromptSummary = {
      ...transcriptPrompts,
      queuedCount: queuedPromptCount,
      queuedIds: queuedPromptIds,
      seenQueuedPromptIds,
    };
    const sentNewPrompt = previous !== null && detectSentPrompt(previous, next);
    for (const id of queuedPromptIds ?? []) seenQueuedIds.add(id);
    sentPromptTracker.current = {
      ...next,
      chatId,
      initialized,
      seenQueuedIds,
      seenQueuedPromptIds,
    };
    // A chat switch or a transcript that loads after mount adopts its
    // prompts as already seen: they were sent before this visit.
    if (
      previous === null ||
      previous.chatId !== chatId ||
      !previous.initialized ||
      !initialized
    )
      return;
    if (!sentNewPrompt) return;
    pinned.current = true;
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    readerScrollTop.current = viewport.scrollTop;
  }, [
    chatId,
    initialized,
    queuedPromptCount,
    queuedPromptIds,
    queuedPromptMessageIds,
    transcriptPrompts,
  ]);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (pinned.current && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [virtualHeight, messages.length]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const viewport = scrollRef.current;
      if (pinned.current && viewport)
        viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    // The column also holds the footer, so a growing queue tail keeps a
    // pinned reader at the bottom.
    if (columnRef.current) observer.observe(columnRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return (): void => observer.disconnect();
  }, [hasMessages, hasFooter]);

  useEffect(
    () => (): void => {
      if (scheduledScroll.current !== null) {
        cancelAnimationFrame(scheduledScroll.current);
        scheduledScroll.current = null;
      }
    },
    [],
  );

  // A queued first send has no messages yet but is not an empty chat: desktop
  // parity keeps the real transcript so the queue sits in the reading column.
  if (messages.length === 0 && footerSlot == null && footerStatus == null) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-center text-s fg-secondary"
        data-testid="chat-transcript-empty"
      >
        {emptyState ?? <span>Send a message to start working</span>}
      </div>
    );
  }

  return (
    <div
      // `overscroll-contain` keeps a momentum scroll that reaches the top or
      // bottom of the transcript from chaining to the page/body behind it on
      // touch devices (CAN-1206). It has no effect on non-overscrolling
      // desktop scroll, so the desktop transcript is unchanged.
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain p-3"
      data-testid="chat-transcript"
      data-turn-count={turnGroups.length}
      ref={scrollRef}
      style={{ overflowAnchor: 'none' }}
      tabIndex={0}
      onWheel={(event) => {
        if (event.deltaY < 0) leaveBottom();
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          (event.target instanceof Element &&
            event.target.closest(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
            ))
        )
          return;
        if (
          ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
          (event.key === ' ' && event.shiftKey)
        )
          leaveBottom();
      }}
      onPointerDown={(event) => {
        const viewport = event.currentTarget;
        const rect = viewport.getBoundingClientRect();
        if (event.clientX >= rect.left + viewport.clientWidth) leaveBottom();
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY;
        if (
          nextY !== undefined &&
          touchY.current !== null &&
          nextY > touchY.current
        )
          leaveBottom();
        touchY.current = nextY ?? null;
      }}
      onScroll={() => {
        const viewport = scrollRef.current;
        if (!viewport) return;
        const nearBottom =
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
          64;
        if (viewport.scrollTop > readerScrollTop.current && nearBottom)
          pinned.current = true;
        // A scroll up and away from the bottom without a gesture (find
        // revealing an earlier match) also releases bottom-follow; layout
        // growth never moves the reader up, and a shrink stays near bottom.
        else if (viewport.scrollTop < readerScrollTop.current && !nearBottom)
          pinned.current = false;
        readerScrollTop.current = viewport.scrollTop;
        if (
          !pinned.current &&
          viewport.scrollTop < 64 &&
          onLoadOlder &&
          !loadingOlder.current
        ) {
          loadingOlder.current = true;
          const height = viewport.scrollHeight;
          const top = viewport.scrollTop;
          void onLoadOlder()
            .then(() => {
              requestAnimationFrame(() => {
                viewport.scrollTop = top + viewport.scrollHeight - height;
              });
            })
            .catch(() => {})
            .finally(() => {
              loadingOlder.current = false;
            });
        }
      }}
    >
      {/* Desktop parity: the desktop message list centers its content on the
          shared `--chat-reading-width` token; the same column here keeps a
          web chat at the desktop's measure instead of running edge to edge. */}
      <div
        ref={columnRef}
        className="mx-auto flex w-full max-w-[var(--chat-reading-width)] chat-width-transition shrink-0 flex-col gap-2"
      >
        <div
          ref={contentRef}
          className={virtualized ? 'relative shrink-0' : 'flex flex-col gap-2'}
          style={
            virtualized ? { height: virtualizer.getTotalSize() } : undefined
          }
        >
          {(virtualized
            ? virtualizer.getVirtualItems()
            : turnGroups.map((_, index) => ({
                index,
                key: turnGroups[index].userMessageId,
                start: 0,
              }))
          ).map((item) => {
            const index = item.index;
            const turnGroup = turnGroups[index];
            return (
              <div
                key={turnGroup.userMessageId}
                data-testid={
                  virtualized ? 'chat-transcript-virtual-turn' : undefined
                }
                data-turn-id={turnGroup.userMessageId}
                data-index={index}
                ref={virtualized ? virtualizer.measureElement : undefined}
                className={virtualized ? 'absolute top-0 w-full' : undefined}
                style={
                  virtualized
                    ? { transform: `translateY(${item.start}px)` }
                    : undefined
                }
              >
                <TurnGroupView
                  key={turnGroup.userMessageId}
                  turnGroup={turnGroup}
                  messagesById={messagesById}
                  appIcon={appIcon}
                  latest={index === turnGroups.length - 1}
                  {...(index === turnGroups.length - 1 && renderLatestTurnAction
                    ? {
                        actionSlot: renderLatestTurnAction({
                          disabled: status === 'streaming',
                        }),
                      }
                    : {})}
                  {...(index === turnGroups.length - 1 && workingRow !== null
                    ? { workingSlot: workingRow }
                    : {})}
                  // `userMessageId` IS the renderer's per-turn `msg-{n}-{epochMs}`:
                  // the persisted-chat projection maps `messageId: message.id`, so no
                  // extra lookup is needed to reach the correlation key.
                  {...(renderTurnFeedback
                    ? {
                        feedbackSlot: renderTurnFeedback(
                          turnGroup.userMessageId,
                        ),
                      }
                    : {})}
                />
              </div>
            );
          })}
        </div>

        {/* Before the first turn group exists there is no slot to sit in, so
            the row renders here instead. `-mt-1` trims the column's `gap-2`
            back to the `space-y-1` rhythm the in-group placement gets. */}
        {turnGroups.length === 0 && workingRow !== null && (
          <div className="-mt-1">{workingRow}</div>
        )}

        {status === 'error' &&
          error &&
          !latestTurnShowsError(turnGroups, messagesById, error) && (
            <div
              className="px-1 py-1 text-xs fg-destructive"
              data-testid="chat-transcript-error"
            >
              {error}
            </div>
          )}

        {footerSlot}

        {footerStatus}

        <div />
      </div>
    </div>
  );
}
