import type { TranscriptSearchSelection } from '@/hooks/useTranscriptSearch';
import {
  collectDesktopChatVisualOwners,
  createDesktopChatVisualHost,
  desktopChatVisualsKey,
} from '@/lib/desktop-chat-visual-host';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { useActivityStore } from '@/stores/activityStore';
import {
  useChatStore,
  useChatTabRenderState,
  type AppliedOrgMemoryTurn,
  type ChatMessage,
  type ChatRenderTarget,
  type PendingQuestion,
  type QueuedChatMessage,
} from '@/stores/chatStore';
import type { DelegationTranscriptSource } from '@/stores/delegationTranscriptStore';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import { detectSentPrompt, type SentPromptSummary } from '@canopy/app-state';
import { inputDeliveryViews } from '@canopy/desktop-shared/chat-input-delivery';
import type {
  AgentArtifactCarryByTurn,
  AgentArtifactReceiptV1,
  AgentUsage,
  BackgroundProcess,
  ChatAttachmentPromptContext,
  ChatToolOutputResponse,
  FileReference,
  TurnDiffData,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  ChatVisualHostProvider,
  useChatVisualsPublisher,
} from '@canopy/ui-app';
import {
  AgentSentReceivingContextProvider,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import {
  useVirtualizer,
  type Range,
  type VirtualItem,
} from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { ChatBlockRenderer } from './ChatBlockRenderer';
import {
  ToolOutputReaderContext,
  type ToolOutputReader,
} from './DeferredToolOutput';
import { DelegationTranscriptSourceContext } from './delegated-agent-transcript';
import { getDisplayBlockKey } from './display-block-keys';
import { PinUserMessagesContext } from './pin-user-messages-context';

import {
  SubagentEntryActionsContext,
  useSubagentEntryActionsValue,
} from '@/components/subagents/subagent-entry-actions';
import { useInvocableInventory } from '@/hooks/useInvocableInventory';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
import { getCwdFromFileIndex } from '@/lib/file-reference-paths';
import {
  getFilePathMentionIndex,
  type FilePathMentionIndex,
} from '@/lib/filePathMentionIndex';
import { buildInvocableMentionIndex } from '@/lib/invocableMentionIndex';
import {
  getChatScrollPosition,
  getSavedChatScrollPosition,
  saveChatScrollPosition,
  type ChatScrollPositionTarget,
} from '@/lib/tab-scroll-positions';
import {
  beginTranscriptPerformanceStage,
  createTranscriptPerformanceFrameQueue,
  finishTranscriptPerformanceCommit,
  registerTranscriptPerformanceCommitTarget,
  scheduleTranscriptPerformanceSnapshot,
  setTranscriptPerformanceCounter,
  type TranscriptPerformanceFrameQueue,
} from '@/lib/transcript-performance';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';
import { hydratedKeys } from '@/stores/chat/hydration';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  ChatMessageLinkActionsProvider,
  InputDeliveryList,
  OverlayScrollArea,
  ScrollToBottomButton,
} from '@canopy/ui-shared/components';
import {
  PANEL_CONTENT_ADOPTED_EVENT,
  PANEL_CONTENT_HOST_ATTRIBUTE,
} from '@canopy/ui-shared/panels';
import { ActiveAgentActivitySection } from './ActiveAgentActivitySection';
import {
  createEmptyAgentArtifactProjectionCache,
  projectAgentArtifactsWithCarry,
  selectActiveAgentBlocks,
  type AgentArtifactProjection,
  type AgentArtifactProjectionCache,
} from './agent-artifact-projection';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';
import { useChatMessageLinkActions } from './chat-message-link-actions';
import {
  estimateTranscriptSectionHeight,
  progressiveTranscriptRange,
  shouldPreloadTranscriptFileIndex,
  shouldVirtualizeTranscript,
} from './chat-message-list-state';
import { ChatMessageItem } from './ChatMessageItem';
import { ForkedFromLink } from './ForkedFromLink';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  findLastForkableTurnGroupIndex,
} from './incremental-turn-groups';
import {
  ManagedDelegationStopContext,
  selectManagedDelegationStopState,
  type ManagedDelegationStopControls,
} from './managed-delegation-stop';
import { QueuedMessageBubble } from './QueuedMessageBubble';
import { QueuedMessageEditor } from './QueuedMessageEditor';
import { computeRevertedUserMessageIds } from './revert-region';
import {
  publishStickyUserHeight,
  readStickyUserHeight,
} from './sticky-user-height';
import {
  computeTranscriptStickySections,
  type TranscriptStickySection,
} from './transcriptStickySections';
import {
  turnBackgroundProcesses,
  useChatBackgroundProcessesByTurn,
} from './turn-background-processes';
import { TurnGroupRenderer } from './TurnGroupRenderer';
import type {
  ActiveComposerView,
  TurnGroup,
  TurnGroupOrMessage,
} from './types';

const EMPTY_AGENT_ARTIFACTS: readonly AgentArtifactReceiptV1[] = [];
const EMPTY_BACKGROUND_PROCESSES: readonly BackgroundProcess[] = [];
const NO_VIRTUAL_ITEMS: VirtualItem[] = [];
const NO_MOUNTED_TRANSCRIPT_SECTIONS: ReadonlySet<number> = new Set();
const NEAR_BOTTOM_THRESHOLD = 80;
const TRANSCRIPT_OVERSCAN_ITEMS = 2;
const MAX_VIRTUALIZED_STICKY_SECTION_ITEMS = 20;
/**
 * How long a deep-linked turn keeps its highlight ring (ECW-8684). Applied as
 * a `data-*` attribute directly on the section wrapper — the transcript's
 * existing `data-stuck` / `data-pinned` idiom — so the highlight never forces
 * a React re-render of the transcript mid-scroll.
 */
const CHAT_TURN_FOCUS_HIGHLIGHT_MS = 2400;
/** Upper bound on history pages fetched while honoring one deep link. */
const CHAT_TURN_FOCUS_MAX_PAGE_LOADS = 64;

interface StickyUserMessageHeaderProps {
  group: TurnGroup;
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  appliedMemory?: AppliedOrgMemoryTurn;
  chatPendingQuestions: PendingQuestion[];
  invocableMentionIndex: ReturnType<typeof buildInvocableMentionIndex> | null;
  filePathMentionIndex: FilePathMentionIndex | null;
  chatId: string;
  forceExpandedUserMessage: boolean;
  onJumpToMessage?: (element: HTMLElement) => void;
}

/**
 * Assign a stable React key per queued message object. Switching the edit
 * target between two queued messages must remount the editor so its local
 * state (editor content, attachments) resets to the newly-selected message
 * rather than carrying over from the previous one. Keying off the message
 * object's identity also lets the editor stay mounted across local queue
 * index shifts. Host snapshots replace message objects, so host-owned rows
 * use their durable queue entry id to keep an in-progress edit mounted.
 */
function useQueuedMessageKey(): (message: QueuedChatMessage) => string {
  const keysRef = useRef<WeakMap<QueuedChatMessage, string> | null>(null);
  if (keysRef.current === null) {
    keysRef.current = new WeakMap();
  }
  const counterRef = useRef(0);
  return useCallback((message: QueuedChatMessage): string => {
    if (message.hostQueueEntryId) return `host-${message.hostQueueEntryId}`;
    const cache = keysRef.current;
    if (!cache) return 'qm-0';
    const existing = cache.get(message);
    if (existing !== undefined) return existing;
    counterRef.current += 1;
    const id = `qm-${counterRef.current}`;
    cache.set(message, id);
    return id;
  }, []);
}

function isNearBottom(el: HTMLElement): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
  );
}

function useIncrementalTurnGroups(
  chatId: string,
  messages: ChatMessage[],
  agentUsage: Record<string, AgentUsage> | undefined,
): TurnGroupOrMessage[] {
  const cacheRef = useRef(createEmptyTurnGroupCache());
  return useMemo(
    (): TurnGroupOrMessage[] =>
      computeIncrementalTurnGroups(
        chatId,
        messages,
        agentUsage,
        cacheRef.current,
      ),
    [chatId, messages, agentUsage],
  );
}

/**
 * Per-turn memo for the agent-artifact projection. Like the turn-group cache
 * above, completed turns keep their `agentArtifacts` array identity across
 * streaming deltas so the memoized `TurnGroupRenderer` can skip them; a chat
 * switch drops the cache.
 */
function useAgentArtifactProjection(
  chatId: string,
  messages: ChatMessage[],
  carryByTurn: AgentArtifactCarryByTurn | undefined,
): AgentArtifactProjection {
  const cacheRef = useRef<{
    chatId: string;
    cache: AgentArtifactProjectionCache;
  }>({ chatId, cache: createEmptyAgentArtifactProjectionCache() });
  return useMemo((): AgentArtifactProjection => {
    if (cacheRef.current.chatId !== chatId) {
      cacheRef.current = {
        chatId,
        cache: createEmptyAgentArtifactProjectionCache(),
      };
    }
    return projectAgentArtifactsWithCarry(
      messages,
      carryByTurn,
      cacheRef.current.cache,
    );
  }, [chatId, messages, carryByTurn]);
}

/**
 * Sticky section header: the head user message hoisted out of its turn group
 * so `position: sticky` can pin it to the top of the scrollport for the whole
 * section — including watcher-fired turns, which deliberately do not break
 * the stick.
 *
 * While pinned (detected via a sentinel at the section top), the bubble gains
 * a full-width opaque `bg-base` backing so transcript content passes behind
 * it. Nothing else is painted: bands and fades around the pinned stack read
 * as black bars sitting on the transcript, and content disappearing behind an
 * opaque bubble is the intended effect. The measured header height is
 * published to the section's summary chips (`publishStickyUserHeight`) so
 * they can pin directly beneath it.
 */
const StickyUserMessageHeader = memo(function StickyUserMessageHeader({
  group,
  onResetToPoint,
  appliedMemory,
  chatPendingQuestions,
  invocableMentionIndex,
  filePathMentionIndex,
  chatId,
  forceExpandedUserMessage,
  onJumpToMessage,
}: StickyUserMessageHeaderProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Early access only bottom-pins prompts that can collapse; with it off, any
  // prompt reported as expanded keeps develop's pin edge.

  // Stuck state itself is owned by the transcript's geometric scroll pass
  // (`updateStickySummaryPinnedState`), which sets `data-stuck` here
  // imperatively — CSS variants react to it with no React re-render and no
  // IntersectionObserver. (An observer's isIntersecting does NOT change when
  // a scroll jump teleports the sentinel from above the viewport to below
  // it, which left stale stuck states behind.)
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const section = wrapper.closest('[data-chat-sticky-section]');
    if (!(section instanceof HTMLElement)) return undefined;

    // Two jobs, one measurement pass:
    //
    // 1. Pick the pin edge. A collapsed (or short) message pins its top edge
    //    (`top: 0`). A message expanded past its collapsed clamp pins its
    //    BOTTOM edge instead: the sticky `top` goes negative by the expansion
    //    overflow (`content height − collapsed clamp`), so the expansion
    //    scrolls naturally out of view and only a collapsed-sized tail —
    //    including its Show less toggle — stays pinned. Without this, a
    //    taller-than-viewport expanded message pinned at the top made its
    //    own bottom unreachable.
    // 2. Publish the pinned VISIBLE height (wrapper height + the negative
    //    top) so per-turn summary chips can stick right below the pinned
    //    stack (`top: var(--chat-sticky-user-height)`), tracking
    //    expand/collapse height changes live.
    let content = wrapper.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    let height = 0;
    let contentHeight = 0;
    const syncStickyGeometry = (entries: ResizeObserverEntry[]): void => {
      for (const entry of entries) {
        const measuredHeight = Math.round(
          entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height,
        );
        if (entry.target === wrapper) height = measuredHeight;
        if (entry.target === content) contentHeight = measuredHeight;
      }
      // A message refresh can replace the inner content without remounting
      // its sticky wrapper. Transfer observation to the new element.
      const nextContent = wrapper.querySelector<HTMLElement>(
        '[data-testid="user-message-content"]',
      );
      if (nextContent !== content) {
        if (content) resizeObserver.unobserve(content);
        content = nextContent;
        contentHeight = 0;
        if (content) resizeObserver.observe(content, { box: 'border-box' });
      }
      let stickyTop = 0;
      // Only a prompt that can collapse is "expanded". One just past the
      // clamp but within its overflow tolerance shows in full with no
      // toggle; shifting it up by that overflow clipped its first line.
      if (
        content &&
        content.dataset.collapsible === 'true' &&
        content.dataset.collapsed === 'false'
      ) {
        const collapsedMax = Number.parseFloat(
          content.dataset.collapsedMaxPx ?? '',
        );
        if (Number.isFinite(collapsedMax)) {
          stickyTop = -Math.max(0, contentHeight - collapsedMax);
        }
      }
      // ResizeObserver delivers geometry before paint. Reading offsetHeight
      // after setting top forced a fresh document layout for every header,
      // including the initial layout-effect pass of every chat switch.
      const top = `${stickyTop}px`;
      if (wrapper.style.top !== top) wrapper.style.top = top;
      publishStickyUserHeight(section, `${height + stickyTop}px`);
    };
    const resizeObserver = new ResizeObserver(syncStickyGeometry);
    resizeObserver.observe(wrapper, { box: 'border-box' });
    if (content) resizeObserver.observe(content, { box: 'border-box' });
    // A forced-open prompt (transcript search) is already full height when
    // its collapse measurement marks it collapsible. That attribute change
    // resizes nothing, so re-run the geometry pass on it.
    const collapseObserver = new MutationObserver(() => syncStickyGeometry([]));
    collapseObserver?.observe(wrapper, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-collapsible', 'data-collapsed'],
    });
    return (): void => {
      resizeObserver.disconnect();
      collapseObserver?.disconnect();
      publishStickyUserHeight(section, undefined);
    };
  }, []);

  // The hoisted prompt is no longer inside its own turn's `group/turn`
  // wrapper, so CSS alone cannot link the two. Mirror hover onto that wrapper
  // by id: `data-hover` is what the turn's controls react to, exactly as if
  // the prompt had been hovered in place. Scoped by id rather than by section,
  // so watcher-fired follow-ups in the same section stay untouched.
  const setTurnHover = useCallback(
    (hovered: boolean): void => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const section = wrapper.closest('[data-chat-sticky-section]');
      if (!(section instanceof HTMLElement)) return;
      const turn = section.querySelector<HTMLElement>(
        `[data-chat-turn-group="${CSS.escape(group.userMessage.id)}"]`,
      );
      turn?.toggleAttribute('data-hover', hovered);
    },
    [group.userMessage.id],
  );

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={(): void => setTurnHover(true)}
      onMouseLeave={(): void => setTurnHover(false)}
      // The scroller's `py-2` insets the pinned position by 8px, leaving a
      // strip where content would otherwise scroll past above the bubble. The
      // `before` strip (anchored to this unbordered wrapper so the card's
      // border width cannot offset it) paints the surface color over that
      // band; in normal flow it covers the already-`bg-base` inter-item gap,
      // so it is invisible there.
      className="group/sticky sticky top-0 z-20 before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base"
      data-testid="sticky-user-message"
      data-sticky-user-message-id={group.userMessage.id}
    >
      {/* Only paints while a summary banner or a follow-up user bubble is
          sliding behind this bubble (`data-underlap`). The bubble is opaque,
          so it already hides the banner — but it ends in a hard edge, and the
          banner emerging from under it reads as a flat-topped,
          square-cornered slab. This gradient starts at the bubble's own
          bottom edge and fades out below it, so the banner dissolves across
          the seam instead of being cut by it.

          An overlay rather than a clip or mask on the banner: those crop the
          banner's box shadow, which must stay intact.

          Rendered BEFORE the bubble on purpose. Both are positioned, so DOM
          order decides paint order within the header — first here means the
          bubble's own drop shadow, which falls into exactly this band, paints
          over the gradient instead of being washed out by it. It still covers
          the banner, which sits a stacking level below the whole header.
          Absolutely positioned, so it never alters layout. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full hidden h-2.5 bg-gradient-to-b from-base/80 via-base/30 to-transparent group-data-[underlap]/sticky:block"
      />
      {/* While stuck, the bubble gets an opaque `bg-base` backing so the
          transcript passes behind the pinned stack rather than through it.
          The backing covers the banners and the gap above them and stops at
          the last banner's edge — it must not run past it, which is what read
          as a black bar laid across the transcript. All stuck styling is
          paint-only and attribute-driven, so stuck-state changes NEVER alter
          layout — a layout-affecting toggle here feeds back into the sticky
          math and oscillates the scroller. */}
      <div className="relative group-data-[stuck]/sticky:bg-base">
        <ChatMessageItem
          message={group.userMessage}
          appliedMemory={appliedMemory}
          chatPendingQuestions={chatPendingQuestions}
          onResetToPoint={onResetToPoint}
          invocableMentionIndex={invocableMentionIndex}
          filePathMentionIndex={filePathMentionIndex}
          originChatTabId={chatId}
          forceExpandedUserMessage={forceExpandedUserMessage}
          onJumpToMessage={onJumpToMessage}
        />
      </div>
    </div>
  );
});

export function ChatMessageList({
  pagingControls,
  transcriptTurns,
  turnPageId,
  onLoadTurn,
  turnLoading,
  turnError,
  messages,
  loadedBytesEstimate = 0,
  pendingTurnTimerId,
  queuedMessages,
  chatId,
  agentUsage,
  turnDiffs,
  memoryByMessageId,
  onClearQueuedMessage,
  onForceQueuedMessage,
  onEditQueuedMessage,
  onCancelEditQueuedMessage,
  onSaveEditQueuedMessage,
  editingQueuedMessageIndex,
  editingQueuedMessageFocusAllowed,
  pendingQueuedMessageEditId,
  queuedMessageSchedulingEnabled = false,
  composerTab,
  onResetToPoint,
  queuedForSetup = false,
  targetOverride: targetOverrideProp,
  archivedContainerId,
  standaloneHistory,
  hideBranchActions = false,
  containerRef,
  searchActive = false,
  canonicalSearch = false,
  searchSelection,
  materializeAllTranscriptItems = false,
  suppressAutoScroll = false,
  scheduledMessages = [],
  onEditScheduledMessage,
  onCancelEditScheduledMessage,
  onSaveEditScheduledMessage,
  onClearScheduledMessage,
  onInterruptScheduledMessage,
  editingScheduledMessageId = null,
  runningScheduledMessageId = null,
  enableForkedFromLink = false,
}: {
  pagingControls?: ReactNode;
  transcriptTurns?: TranscriptTurnSummary[];
  turnPageId?: string | null;
  onLoadTurn?: (id: string) => void | Promise<void>;
  turnLoading?: boolean;
  turnError?: string | null;
  messages: ChatMessage[];
  loadedBytesEstimate?: number;
  pendingTurnTimerId?: string;
  queuedMessages: QueuedChatMessage[];
  chatId: string;
  agentUsage?: Record<string, AgentUsage>;
  turnDiffs?: Record<string, TurnDiffData>;
  memoryByMessageId?: Record<string, AppliedOrgMemoryTurn>;
  onClearQueuedMessage: (index: number) => void;
  onForceQueuedMessage?: (index: number) => void;
  onEditQueuedMessage?: (index: number, message?: QueuedChatMessage) => void;
  onCancelEditQueuedMessage?: () => void;
  onSaveEditQueuedMessage?: (
    index: number,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
    expected?: QueuedChatMessage,
  ) => void;
  /** Index of the queued message currently being edited inline, if any. */
  editingQueuedMessageIndex?: number;
  editingQueuedMessageFocusAllowed?: boolean;
  pendingQueuedMessageEditId?: string;
  /** Allow queued-message inline editors to add/edit/remove a one-time schedule. */
  queuedMessageSchedulingEnabled?: boolean;
  /** Active composer tab — supplies model/plan/thinking context to the inline editor. */
  composerTab?: ActiveComposerView | null;
  /**
   * Per-turn revert handler. Worktree chats only — eligibility is
   * gated on the turn having a captured snapshot in `turnDiffs`.
   */
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  /**
   * When true, the queued messages are waiting for two-phase worktree
   * creation to finish (`setupPhase === 'git-pending'`) — used to swap the
   * generic "Queued" label for the more specific "queued — worktree setting up".
   */
  queuedForSetup?: boolean;
  archivedContainerId?: string;
  standaloneHistory?: boolean;
  targetOverride?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    allowRemoteImages?: boolean;
  };
  hideBranchActions?: boolean;
  /** Optional external ref to the scroll container for DOM-based search. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** While the find bar searches this chat; mounts every row for the DOM fallback search. */
  searchActive?: boolean;
  canonicalSearch?: boolean;
  searchSelection?: TranscriptSearchSelection | null;
  /** Mount every transcript row so an external DOM search can inspect it. */
  materializeAllTranscriptItems?: boolean;
  /** When true, suppress auto-scroll to bottom (e.g. during active search navigation). */
  suppressAutoScroll?: boolean;
  /**
   * Scheduled `worktree_session_prompt` messages derived from the automations
   * store, rendered after the ordinary queue (so future scheduled work does not
   * block the immediate active queue).
   */
  scheduledMessages?: ScheduledQueuedMessage[];
  onEditScheduledMessage?: (automationId: string) => void;
  onCancelEditScheduledMessage?: () => void;
  onSaveEditScheduledMessage?: (
    automationId: string,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
    expected?: QueuedChatMessage,
  ) => void;
  onClearScheduledMessage?: (automationId: string) => void;
  onInterruptScheduledMessage?: (automationId: string) => void;
  editingScheduledMessageId?: string | null;
  /** Automation id whose Interrupt (runNow + disable) is mid-flight. */
  runningScheduledMessageId?: string | null;
  /**
   * When true, render the "Forked from conversation" divider at the fork point
   * in the timeline for chats that carry fork-source metadata. Only the live
   * chat surface opts in; read-only archive viewers leave it off.
   */
  enableForkedFromLink?: boolean;
}): JSX.Element {
  const oneTimeScheduledMessages = useMemo(
    (): ScheduledQueuedMessage[] =>
      scheduledMessages.filter(
        (scheduled) => scheduled.scheduleKind === 'one_time',
      ),
    [scheduledMessages],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const performanceFrameQueueRef =
    useRef<TranscriptPerformanceFrameQueue | null>(null);
  if (__CANOPY_E2E__ && performanceFrameQueueRef.current === null)
    performanceFrameQueueRef.current = createTranscriptPerformanceFrameQueue();
  const pageViewportRef = useRef({ height: 0, top: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const lastScrollTargetRef = useRef<ChatScrollPositionTarget | null>(null);
  const activeScrollTargetRef = useRef<ChatScrollPositionTarget>(chatId);
  const pendingScrollTopRef = useRef<number | null>(null);
  const observedViewportHeightRef = useRef<number | null>(null);
  const lastSavedScrollSourceRef = useRef<'user' | 'programmatic' | null>(null);
  const isApplyingScrollRef = useRef(false);
  const lastAppliedScrollTopRef = useRef<number | null>(null);
  const releaseScrollGuardFrameRef = useRef<number | null>(null);
  // Callers commonly pass `targetOverride` as an inline literal. Key it by
  // value so the store selectors below and every memoized turn row see one
  // identity per target rather than a new object on each parent render.
  const targetOverrideProjectId = targetOverrideProp?.projectId;
  const targetOverrideWorktreeId = targetOverrideProp?.worktreeId;
  const targetOverrideChatId = targetOverrideProp?.chatId;
  // Read-only scopes (a shared-container recipient) never load remote images
  // from a publisher's transcript unless a caller explicitly allows them.
  const readOnlyScope = useWorkspaceIsReadOnly();
  const targetOverrideAllowRemoteImages =
    targetOverrideProp?.allowRemoteImages ??
    (readOnlyScope ? false : undefined);
  const targetOverride = useMemo(
    () =>
      targetOverrideProjectId !== undefined &&
      targetOverrideWorktreeId !== undefined &&
      targetOverrideChatId !== undefined
        ? {
            projectId: targetOverrideProjectId,
            worktreeId: targetOverrideWorktreeId,
            chatId: targetOverrideChatId,
            allowRemoteImages: targetOverrideAllowRemoteImages,
          }
        : undefined,
    [
      targetOverrideAllowRemoteImages,
      targetOverrideChatId,
      targetOverrideProjectId,
      targetOverrideWorktreeId,
    ],
  );
  const outputProjectId = useChatStore(
    (state) => targetOverride?.projectId ?? state.selectedWorktree?.projectId,
  );
  const outputWorktreeId = useChatStore(
    (state) => targetOverride?.worktreeId ?? state.selectedWorktree?.worktreeId,
  );
  const readToolOutput = useMemo<ToolOutputReader | null>(
    () =>
      outputProjectId && outputWorktreeId && chatId
        ? async (
            messageId,
            toolUseId,
            reference,
            offset,
            signal,
          ): Promise<ChatToolOutputResponse> => {
            signal.throwIfAborted();
            const requestId = crypto.randomUUID();
            const cancel = (): void => {
              void window.api.chat
                .cancelToolOutput({ requestId })
                .catch(() => undefined);
            };
            signal.addEventListener('abort', cancel, { once: true });
            try {
              return await window.api.chat.readToolOutput({
                projectId: outputProjectId,
                worktreeId: outputWorktreeId,
                chatId,
                messageId,
                toolUseId,
                requestId,
                archivedContainerId,
                standaloneHistory,
                reference,
                offset,
                limit: 65536,
              });
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          }
        : null,
    [
      outputProjectId,
      outputWorktreeId,
      chatId,
      archivedContainerId,
      standaloneHistory,
    ],
  );
  // A live chat can show its visuals in the worktree's Chat visuals panel; an
  // archived or history transcript has no panel beside it and keeps the dialog.
  const chatVisualsKey =
    outputProjectId &&
    outputProjectId !== APP_ADVISOR_PROJECT_ID &&
    outputWorktreeId &&
    chatId &&
    !archivedContainerId &&
    !standaloneHistory
      ? desktopChatVisualsKey({
          projectId: outputProjectId,
          worktreeId: outputWorktreeId,
          chatId,
        })
      : null;
  const chatVisualHost = useMemo(
    () =>
      outputProjectId &&
      outputProjectId !== APP_ADVISOR_PROJECT_ID &&
      outputWorktreeId &&
      chatId
        ? createDesktopChatVisualHost(
            {
              projectId: outputProjectId,
              worktreeId: outputWorktreeId,
              chatId,
              archivedContainerId,
              standaloneHistory,
            },
            undefined,
            undefined,
            { expandInPanel: chatVisualsKey !== null },
          )
        : null,
    [
      outputProjectId,
      outputWorktreeId,
      chatId,
      archivedContainerId,
      standaloneHistory,
      chatVisualsKey,
    ],
  );
  const chatVisualOwners = useMemo(
    () =>
      chatVisualsKey === null ? [] : collectDesktopChatVisualOwners(messages),
    [chatVisualsKey, messages],
  );
  useChatVisualsPublisher(chatVisualsKey, chatVisualOwners, chatVisualHost);
  const delegationTranscriptSource = useMemo<DelegationTranscriptSource | null>(
    () =>
      outputProjectId && outputWorktreeId && chatId
        ? {
            projectId: outputProjectId,
            worktreeId: outputWorktreeId,
            chatId,
            ...(archivedContainerId ? { archivedContainerId } : {}),
            ...(standaloneHistory ? { standaloneHistory: true } : {}),
          }
        : null,
    [
      outputProjectId,
      outputWorktreeId,
      chatId,
      archivedContainerId,
      standaloneHistory,
    ],
  );
  const suppressAutoScrollRef = useRef(suppressAutoScroll);
  suppressAutoScrollRef.current = suppressAutoScroll;
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [retainedInteractionKeys, setRetainedInteractionKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const framedMessages = useMemo(() => {
    const frames = new Map(
      transcriptTurns?.flatMap((turn) =>
        // Inferred frames stabilize partially loaded legacy turns. Once all
        // rows are present, normal grouping preserves their original display
        // without inventing live timers for historical replies.
        turn.before !== undefined && turn.frameTimer
          ? [[turn.id, turn.frameTimer] as const]
          : [],
      ),
    );
    if (frames.size === 0) return messages;
    let owner: string | undefined;
    for (const message of messages) {
      if (isUserTurnBoundary(message)) owner = message.id;
      if (message.blocks.some((block) => block.type === 'turn_timer') && owner)
        frames.delete(owner);
    }
    return messages.flatMap((message) => {
      const frame = frames.get(message.id);
      return frame ? [message, frame] : [message];
    });
  }, [messages, transcriptTurns]);
  const turnGroups = useIncrementalTurnGroups(
    chatId,
    framedMessages,
    agentUsage,
  );
  const lastTurnGroupIndex = useMemo(() => {
    for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
      if (turnGroups[index]?.kind === 'turn-group') return index;
    }
    return -1;
  }, [turnGroups]);
  const lastForkableTurnGroupIndex = useMemo(
    () => findLastForkableTurnGroupIndex(turnGroups),
    [turnGroups],
  );
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  const worktreeTarget = targetOverride ?? selectedWorktree;
  const receivingProjectId = worktreeTarget?.projectId;
  const receivingContext = useMemo<AgentSentReceivingContext | undefined>(
    () =>
      receivingProjectId
        ? receivingProjectId === APP_ADVISOR_PROJECT_ID
          ? { kind: 'bot', botId: 'app_advisor' }
          : { kind: 'project', projectId: receivingProjectId }
        : undefined,
    [receivingProjectId],
  );
  // This chat's tab fields; the selector runs only when this chat's tab or
  // runtime changes, never for another chat's commit.
  const chatTarget = useMemo(
    (): ChatRenderTarget | null =>
      worktreeTarget
        ? {
            projectId: worktreeTarget.projectId,
            worktreeId: worktreeTarget.worktreeId,
            chatId,
          }
        : null,
    [worktreeTarget, chatId],
  );
  const linkActions = useChatMessageLinkActions(worktreeTarget);
  const {
    sourceSdkSessionId,
    sourceIsClaudeTerminal,
    forkedFrom,
    selectedRepoId,
    agentArtifactCarryByTurn,
    inputDelivery,
    steeringCapabilities,
    chatIsOpen,
  } = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab, runtime }) => {
      if (!tab || tab.kind === 'file') {
        return {
          sourceSdkSessionId: undefined,
          sourceIsClaudeTerminal: false,
          forkedFrom: undefined,
          selectedRepoId: undefined,
          agentArtifactCarryByTurn: undefined,
          chatIsOpen: false,
        };
      }
      return {
        sourceSdkSessionId: tab.sdkSessionId,
        sourceIsClaudeTerminal:
          tab.interfaceMode === 'claude-code' ||
          tab.claudeTerminal !== undefined,
        forkedFrom: tab.forkedFrom,
        selectedRepoId: tab.selectedRepoId,
        agentArtifactCarryByTurn: tab.agentArtifactCarryByTurn,
        chatIsOpen: true,
        inputDelivery: tab.inputDelivery,
        steeringCapabilities: runtime?.steeringCapabilities,
      };
    }),
  );
  const subagentEntryActions = useSubagentEntryActionsValue(
    worktreeTarget,
    chatId,
    !readOnlyScope && worktreeTarget !== null && chatIsOpen,
  );
  const artifactProjection = useAgentArtifactProjection(
    chatId,
    messages,
    agentArtifactCarryByTurn,
  );
  // The Subagents view experiment replaces the pinned Agent activity section
  // with the top bar's running count and the Subagents panel.
  const subagentsView = useLabsExperimentEnabled('subagents-view');
  const activeTurn = useMemo(
    () =>
      [...turnGroups]
        .reverse()
        .find((item) => item.kind === 'turn-group' && !item.isComplete),
    [turnGroups],
  );
  const backgroundProcesses = useActivityStore(
    useShallow((state) =>
      worktreeTarget && !subagentsView
        ? state.bgProcesses[
            `${worktreeTarget.projectId}/${worktreeTarget.worktreeId}`
          ]
        : undefined,
    ),
  );
  const activeAgents = useMemo(
    () =>
      subagentsView
        ? []
        : selectActiveAgentBlocks(
            turnGroups,
            backgroundProcesses ?? [],
            chatId,
          ),
    [subagentsView, turnGroups, backgroundProcesses, chatId],
  );
  const activeArtifacts =
    activeTurn?.kind === 'turn-group'
      ? (artifactProjection.byTurn[activeTurn.userMessage.id] ?? [])
      : [];
  // One activity-store subscription for the whole transcript. Each turn is
  // handed its own slice below; see `useChatBackgroundProcessesByTurn`.
  const backgroundProcessesByTurn = useChatBackgroundProcessesByTurn(
    worktreeTarget?.projectId,
    worktreeTarget?.worktreeId,
    chatId,
    turnGroups,
  );
  const activeBackgroundProcesses =
    activeTurn?.kind === 'turn-group'
      ? turnBackgroundProcesses(
          backgroundProcessesByTurn,
          activeTurn.userMessage.id,
        )
      : EMPTY_BACKGROUND_PROCESSES;
  const artifactChatTarget = worktreeTarget
    ? {
        projectId: worktreeTarget.projectId,
        worktreeId: worktreeTarget.worktreeId,
        chatId,
      }
    : undefined;
  // Every managed delegation queued or running in this chat, at any depth.
  // The delegated cards get their Stop from this, and the pinned Agent
  // activity section (or, under the Subagents view, the Subagents panel)
  // its Stop all. Read-only views offer neither.
  const delegationStopState = useMemo(
    () => selectManagedDelegationStopState(turnGroups),
    [turnGroups],
  );
  const canStopDelegations = !readOnlyScope && worktreeTarget !== null;
  const liveDelegationKey = delegationStopState.liveDelegationIds.join('\n');
  const liveDelegationIds = useMemo(
    () => (liveDelegationKey ? liveDelegationKey.split('\n') : []),
    [liveDelegationKey],
  );
  const liveDescendantKey = delegationStopState.withLiveDescendants.join('\n');
  const stopTargetProjectId = worktreeTarget?.projectId;
  const stopTargetWorktreeId = worktreeTarget?.worktreeId;
  const delegationStopControls =
    useMemo((): ManagedDelegationStopControls | null => {
      if (
        !canStopDelegations ||
        stopTargetProjectId === undefined ||
        stopTargetWorktreeId === undefined
      ) {
        return null;
      }
      return {
        target: {
          projectId: stopTargetProjectId,
          worktreeId: stopTargetWorktreeId,
          chatId,
        },
        withLiveDescendants: new Set(
          liveDescendantKey ? liveDescendantKey.split('\n') : [],
        ),
      };
    }, [
      canStopDelegations,
      chatId,
      liveDescendantKey,
      stopTargetProjectId,
      stopTargetWorktreeId,
    ]);
  // Anchor the "Forked from conversation" divider to the fork point in the
  // timeline rather than the bottom of the transcript. `null` hides it (no
  // fork metadata, disabled, or the anchor message no longer exists — e.g.
  // reverted away); `-1` renders it above the first item (empty-history fork);
  // otherwise it renders immediately after the turn-group/message at that
  // index, so new turns accumulate below it.
  const forkDividerIndex = useMemo((): number | null => {
    if (!enableForkedFromLink || !forkedFrom) return null;
    const atId = forkedFrom.atMessageId;
    if (!atId) return -1;
    for (let i = 0; i < turnGroups.length; i += 1) {
      const item = turnGroups[i];
      if (item.kind === 'turn-group') {
        if (
          item.userMessage.id === atId ||
          item.assistantMessages.some((m) => m.id === atId) ||
          item.timerMessage.id === atId
        ) {
          return i;
        }
      } else if (item.message.id === atId) {
        return i;
      }
    }
    return null;
  }, [enableForkedFromLink, forkedFrom, turnGroups]);

  const getQueuedMessageKey = useQueuedMessageKey();
  const invocableInventory = useInvocableInventory(null);
  const invocableMentionIndex = useMemo(
    () =>
      invocableInventory.entries.length > 0
        ? buildInvocableMentionIndex(invocableInventory.entries)
        : null,
    [invocableInventory.entries],
  );
  const fileListKey = worktreeTarget
    ? getWorktreeCacheKey(worktreeTarget.projectId, worktreeTarget.worktreeId)
    : null;
  const { fileIndexEntry, fileIndexError, fileIndexLoading, fetchFileIndex } =
    useFileListStore(
      useShallow((state) => ({
        fileIndexEntry: fileListKey ? state.indexCache[fileListKey] : undefined,
        fileIndexError: fileListKey
          ? state.indexErrors[fileListKey]
          : undefined,
        fileIndexLoading: fileListKey
          ? state.indexLoading.has(fileListKey)
          : false,
        fetchFileIndex: state.fetchFileIndex,
      })),
    );
  // File-path decoration belongs to the transcript, not the composer. Loading
  // the index only once history exists keeps a brand-new worktree's empty chat
  // off the startup hot path while ensuring persisted user and assistant
  // messages become clickable without requiring Cmd+P or an `@` popup first.
  useEffect(() => {
    if (
      !worktreeTarget ||
      !shouldPreloadTranscriptFileIndex(
        messages.length > 0,
        fileIndexEntry,
        fileIndexLoading,
        fileIndexError,
      )
    ) {
      return;
    }
    void fetchFileIndex(worktreeTarget.projectId, worktreeTarget.worktreeId);
  }, [
    fetchFileIndex,
    fileIndexEntry,
    fileIndexError,
    fileIndexLoading,
    fileListKey,
    messages.length,
    worktreeTarget,
  ]);
  const computedFilePathMentionIndex = useMemo(() => {
    const repos = fileIndexEntry?.data.repos ?? [];
    const cwd = getCwdFromFileIndex(repos, selectedRepoId);
    return getFilePathMentionIndex(repos, cwd);
  }, [fileIndexEntry, selectedRepoId]);
  const filePathMentionCacheKey = fileListKey
    ? `${fileListKey}:${selectedRepoId ?? ''}`
    : null;
  const filePathMentionCacheRef = useRef<{
    key: string | null;
    index: FilePathMentionIndex | null;
  }>({ key: null, index: null });
  let filePathMentionIndex = computedFilePathMentionIndex;
  if (filePathMentionCacheRef.current.key !== filePathMentionCacheKey) {
    filePathMentionCacheRef.current = {
      key: filePathMentionCacheKey,
      index: computedFilePathMentionIndex,
    };
  } else if (computedFilePathMentionIndex) {
    filePathMentionCacheRef.current.index = computedFilePathMentionIndex;
  } else {
    filePathMentionIndex = filePathMentionCacheRef.current.index;
  }
  const revertedUserMessageIds = useMemo(
    () => computeRevertedUserMessageIds(messages),
    [messages],
  );
  const virtualizationEnabled = useMemo(
    () => shouldVirtualizeTranscript(turnGroups),
    [turnGroups],
  );
  const pinUserMessages = useContext(PinUserMessagesContext);
  // Sticky sections: each real (typed, non-watcher) user turn heads a section
  // whose user message renders as a sticky header while the section's agent
  // output scrolls by. Watcher-fired turns continue the previous section, so
  // the previous real user message stays stuck through them.
  const stickySections = useMemo(
    () =>
      computeTranscriptStickySections(
        turnGroups,
        revertedUserMessageIds,
        virtualizationEnabled
          ? MAX_VIRTUALIZED_STICKY_SECTION_ITEMS
          : Number.POSITIVE_INFINITY,
      ),
    [turnGroups, revertedUserMessageIds, virtualizationEnabled],
  );
  const scrollProjectId = worktreeTarget?.projectId;
  const scrollWorktreeId = worktreeTarget?.worktreeId;
  const scrollTarget = useMemo<ChatScrollPositionTarget>(
    () =>
      scrollProjectId && scrollWorktreeId
        ? {
            projectId: scrollProjectId,
            worktreeId: scrollWorktreeId,
            chatId,
          }
        : chatId,
    [chatId, scrollProjectId, scrollWorktreeId],
  );
  const getTranscriptScrollElement = useCallback(
    (): HTMLDivElement | null => scrollRef.current,
    [],
  );
  const getTranscriptItemKey = useCallback(
    (index: number): string => {
      const item = turnGroups[index];
      if (!item) return `transcript-item-${index}`;
      return item.kind === 'turn-group' ? item.userMessage.id : item.message.id;
    },
    [turnGroups],
  );
  const getStickySectionKey = useCallback(
    (index: number): string =>
      stickySections[index]?.key ?? `transcript-section-${index}`,
    [stickySections],
  );
  const chatPendingQuestions = useChatStore(
    useShallow((s): PendingQuestion[] =>
      Object.values(s.pendingQuestions).filter((pq) => pq.chatId === chatId),
    ),
  );
  const retainedInteractionTargetRef =
    useRef<ChatScrollPositionTarget>(scrollTarget);
  useEffect(() => {
    if (retainedInteractionTargetRef.current === scrollTarget) return;
    retainedInteractionTargetRef.current = scrollTarget;
    setRetainedInteractionKeys(new Set());
  }, [scrollTarget]);
  const retainedInteractionIndexes = useMemo((): number[] => {
    const hasPendingQuestion = chatPendingQuestions.some(
      (question) => question.answeredAt === undefined,
    );
    if (retainedInteractionKeys.size === 0 && !hasPendingQuestion) return [];
    const pendingQuestionIds = new Set(
      chatPendingQuestions
        .filter((question) => question.answeredAt === undefined)
        .map((question) => question.requestId),
    );
    const pendingToolUseIds = new Set(
      chatPendingQuestions.flatMap((question) =>
        question.answeredAt === undefined && question.toolUseId
          ? [question.toolUseId]
          : [],
      ),
    );
    const hasUncorrelatedPendingQuestion = chatPendingQuestions.some(
      (question) =>
        question.answeredAt === undefined && question.toolUseId === undefined,
    );
    const indexes: number[] = [];
    for (let index = 0; index < stickySections.length; index += 1) {
      const section = stickySections[index];
      const messages = section.items.flatMap((item) =>
        item.kind === 'turn-group'
          ? [item.userMessage, ...item.assistantMessages, item.timerMessage]
          : [item.message],
      );
      const containsPendingQuestion = messages.some((message) =>
        message.blocks.some(
          (block) =>
            (block.type === 'text' &&
              block.asyncQuestion !== undefined &&
              pendingQuestionIds.has(block.asyncQuestion.requestId)) ||
            (block.type === 'tool_use' &&
              block.result === undefined &&
              isAskUserQuestionToolName(block.toolName) &&
              (hasUncorrelatedPendingQuestion ||
                pendingToolUseIds.has(block.toolUseId))),
        ),
      );
      if (containsPendingQuestion || retainedInteractionKeys.has(section.key)) {
        indexes.push(index);
      }
    }
    return indexes;
  }, [chatPendingQuestions, retainedInteractionKeys, stickySections]);
  const materializeTranscriptItems =
    (searchActive && !canonicalSearch) || materializeAllTranscriptItems;
  const allTranscriptIndexes = useMemo(
    (): number[] =>
      Array.from({ length: stickySections.length }, (_, index) => index),
    [stickySections.length],
  );
  const initialTranscriptMeasurements = useMemo(
    (): VirtualItem[] =>
      getSavedChatScrollPosition(scrollTarget)?.measurements ?? [],
    [scrollTarget],
  );
  // A restored position places sections from their saved sizes. Those mount
  // with the visible ones: mounted on a later frame, a section would be
  // re-measured after the restore settled and shift the restored view.
  const savedTranscriptMeasurementKeys = useMemo(
    () => new Set(initialTranscriptMeasurements.map((item) => item.key)),
    [initialTranscriptMeasurements],
  );
  const isTranscriptSectionMeasured = useCallback(
    (index: number): boolean =>
      savedTranscriptMeasurementKeys.has(getStickySectionKey(index)),
    [getStickySectionKey, savedTranscriptMeasurementKeys],
  );
  // Sections committed by the previous render, for the chat they belong to.
  // Overscan grows from these one section per frame (see
  // `progressiveTranscriptRange`); each pass bumps `transcriptOverscanPass` so
  // the virtualizer extracts its range again. A chat switched in place starts
  // from none: the previous chat's indexes name other sections.
  const mountedTranscriptSectionsRef = useRef<{
    target: ChatScrollPositionTarget;
    indexes: ReadonlySet<number>;
  } | null>(null);
  const [transcriptOverscanPass, setTranscriptOverscanPass] = useState(0);
  const extractTranscriptRange = useCallback(
    (range: Range): number[] => {
      if (materializeTranscriptItems) return allTranscriptIndexes;
      const mountedSections = mountedTranscriptSectionsRef.current;
      const indexes = new Set(
        progressiveTranscriptRange(
          range,
          mountedSections?.target === scrollTarget
            ? mountedSections.indexes
            : NO_MOUNTED_TRANSCRIPT_SECTIONS,
          isTranscriptSectionMeasured,
        ),
      );
      if (searchSelection)
        stickySections.forEach((section, index) => {
          if (
            section.items.some((item) =>
              item.kind === 'turn-group'
                ? item.userMessage.id === searchSelection.turnId
                : item.message.id === searchSelection.messageId,
            )
          )
            indexes.add(index);
        });
      for (const index of retainedInteractionIndexes) {
        indexes.add(index);
      }
      return Array.from(indexes).sort((left, right) => left - right);
    },
    // `transcriptOverscanPass` only changes the callback's identity, which is
    // what makes the virtualizer extract its range again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      searchSelection,
      stickySections,
      allTranscriptIndexes,
      materializeTranscriptItems,
      retainedInteractionIndexes,
      isTranscriptSectionMeasured,
      scrollTarget,
      transcriptOverscanPass,
    ],
  );
  const retainInteractiveTranscriptItem = useCallback(
    (index: number): void => {
      const key = getStickySectionKey(index);
      setRetainedInteractionKeys((current) => {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
    },
    [getStickySectionKey],
  );
  // Start the window where the transcript will open: the saved offset, or the
  // tail for a first visit and for a chat left at the bottom, clamped to the
  // real bottom by the browser. From offset 0 the
  // first render would mount the oldest sections, then replace them when the
  // open restores or pins the position: several large turns built, styled and
  // laid out for nothing.
  const initialTranscriptOffset = useMemo((): number => {
    const saved = getSavedChatScrollPosition(scrollTarget);
    if (!saved) return Number.MAX_SAFE_INTEGER;
    return saved.atBottom ? Number.MAX_SAFE_INTEGER : saved.top;
  }, [scrollTarget]);
  const estimateTranscriptSectionSize = useCallback(
    (index: number): number =>
      estimateTranscriptSectionHeight(stickySections[index]?.items ?? []),
    [stickySections],
  );
  const transcriptVirtualizer = useVirtualizer({
    count: virtualizationEnabled ? stickySections.length : 0,
    getScrollElement: getTranscriptScrollElement,
    estimateSize: estimateTranscriptSectionSize,
    getItemKey: getStickySectionKey,
    rangeExtractor: extractTranscriptRange,
    overscan: TRANSCRIPT_OVERSCAN_ITEMS,
    initialMeasurementsCache: initialTranscriptMeasurements,
    initialOffset: initialTranscriptOffset,
    // Resolve a prepended page's stable row before rendering/measuring it.
    // A later scrollTop correction races estimate-to-measurement adjustments.
    anchorTo: 'end',
    useAnimationFrameWithResizeObserver: true,
  });
  // A host that keeps one list across chat tabs (the pipeline chat panel, plan
  // explore) switches chats in place. The virtualizer reads `initialOffset`
  // only while it holds no offset of its own, so the switched chat's first
  // render would extract sections at the previous chat's position, which the
  // restore or pin below then scrolls away from. Dropping the offset opens the
  // switched chat as a new list would: at its saved offset or its tail.
  const [positionedScrollTarget, setPositionedScrollTarget] =
    useState(scrollTarget);
  if (positionedScrollTarget !== scrollTarget) {
    setPositionedScrollTarget(scrollTarget);
    transcriptVirtualizer.scrollOffset = null;
  }
  const measureTranscriptElement = useCallback(
    (element: HTMLDivElement | null): void => {
      const finishPerformanceStage = beginTranscriptPerformanceStage(
        'virtual_measure',
        { elements: element ? 1 : 0 },
      );
      transcriptVirtualizer.measureElement(element);
      finishPerformanceStage();
    },
    [transcriptVirtualizer],
  );
  const transcriptTotalSize = transcriptVirtualizer.getTotalSize();
  const transcriptMeasurementSnapshotRef = useRef<{
    target: ChatScrollPositionTarget;
    measurements: VirtualItem[];
  } | null>(null);
  useLayoutEffect(() => {
    if (!virtualizationEnabled) return;
    transcriptMeasurementSnapshotRef.current = {
      target: scrollTarget,
      measurements: transcriptVirtualizer.takeSnapshot(),
    };
  }, [
    scrollTarget,
    transcriptTotalSize,
    transcriptVirtualizer,
    virtualizationEnabled,
  ]);

  const updateScrollState = useCallback((el: HTMLElement): void => {
    const nearBottom = isNearBottom(el);
    isNearBottomRef.current = nearBottom;
    setShowScrollButton(!nearBottom);
  }, []);

  // Scroll pass for the sticky container's bottom edge: mark each pinned
  // turn-summary chip (`data-pinned`, read by UI automation) and
  // its section (`data-chat-sticky-summary-pinned`, hides the stuck user
  // message's own bottom border so the single border renders under the chip
  // — the workspace-header container shape). Imperative DOM attributes styled
  // by CSS variants, so no React re-render happens per scroll frame; the few
  // rect reads run after layout is already clean.
  const updateStickySummaryPinnedState = useCallback(
    (el: HTMLElement): void => {
      const sections = el.querySelectorAll<HTMLElement>(
        '[data-chat-sticky-section]',
      );
      const finishPerformanceStage = beginTranscriptPerformanceStage(
        'sticky_geometry',
        { sections: sections.length },
      );
      sections.forEach((section) => {
        const header = section.querySelector<HTMLElement>(
          '[data-testid="sticky-user-message"]',
        );
        const chips = Array.from(
          section.querySelectorAll<HTMLElement>(
            '[data-testid="sticky-turn-summary"]',
          ),
        );
        if (!header) {
          section.removeAttribute('data-chat-sticky-summary-pinned');
          chips.forEach((chip) => chip.removeAttribute('data-pinned'));
          return;
        }
        const sectionRect = section.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        // A sticky header is stuck exactly when it is displaced downward
        // from its natural position at the section top. Pure geometry —
        // unlike an IntersectionObserver sentinel, this cannot go stale
        // when a scroll jump teleports the section without an intersection
        // change, and a header resting at the top of the transcript is
        // correctly NOT stuck.
        const stuck = headerRect.top > sectionRect.top + 1;
        if (stuck) {
          header.setAttribute('data-stuck', 'true');
        } else {
          header.removeAttribute('data-stuck');
          section.removeAttribute('data-chat-sticky-summary-pinned');
          chips.forEach((chip) => chip.removeAttribute('data-pinned'));
          header.removeAttribute('data-underlap');
          return;
        }
        // Only the LAST matching chip owns the pinned slot: during a
        // handoff the outgoing chip still overlaps the slot while the
        // incoming chip pins, and both carrying the container's bottom
        // border would draw a double line.
        let winner: HTMLElement | null = null;
        chips.forEach((chip) => {
          const rect = chip.getBoundingClientRect();
          if (
            rect.top <= headerRect.bottom + 9 &&
            rect.bottom > headerRect.bottom
          ) {
            winner = chip;
          }
        });
        // The seam only exists while a chip or a follow-up user bubble
        // (steering, watcher-fired) STRADDLES the header's bottom edge: part
        // of it hidden behind the opaque backing, part of it emerging below
        // the backing's hard edge, which reads as a flat-topped,
        // square-cornered slab. Flag that, and only that, so the header can
        // fade it across the seam.
        //
        // Both halves of the test are load-bearing. Without the `bottom`
        // half, a chip resting entirely above the header — fully hidden,
        // no seam — sets the flag, and the gradient then paints in the
        // ordinary pinned state where it washes out the pinned chip's own
        // shadow. Without the `top` half, every pinned chip qualifies.
        const straddles = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          return (
            rect.top < headerRect.bottom - 1 && rect.bottom > headerRect.bottom
          );
        };
        let straddling = false;
        chips.forEach((chip) => {
          chip.toggleAttribute('data-pinned', chip === winner);
          if (straddles(chip)) straddling = true;
        });
        // Only check bubbles while the pinned slot is empty. A pinned chip's
        // opaque backing already covers bubbles in its turn; fading at the
        // header seam would paint over the chip instead.
        // The hoisted header sits outside every `data-chat-turn-group`
        // wrapper, so its own bubble never matches.
        if (!straddling && winner === null) {
          straddling = Array.from(
            section.querySelectorAll<HTMLElement>(
              '[data-chat-turn-group] [data-testid="portal-chat-message-content"]',
            ),
          ).some(straddles);
        }
        header.toggleAttribute('data-underlap', straddling);
        section.toggleAttribute(
          'data-chat-sticky-summary-pinned',
          winner !== null,
        );
      });
      finishPerformanceStage();
    },
    [],
  );

  // Scroll events drive the pass; this covers everything else that can move
  // sections without scrolling (initial mount at a restored offset, section
  // list changes, expand/collapse relayouts are covered by the scroller's
  // ResizeObserver).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) updateStickySummaryPinnedState(el);
  }, [stickySections, updateStickySummaryPinnedState]);

  const applyScrollTop = useCallback(
    (el: HTMLElement, top: number): void => {
      isApplyingScrollRef.current = true;
      el.scrollTop = top;
      lastAppliedScrollTopRef.current = el.scrollTop;
      updateScrollState(el);
      if (releaseScrollGuardFrameRef.current !== null) {
        cancelAnimationFrame(releaseScrollGuardFrameRef.current);
      }
      releaseScrollGuardFrameRef.current = requestAnimationFrame(() => {
        releaseScrollGuardFrameRef.current = null;
        isApplyingScrollRef.current = false;
      });
    },
    [updateScrollState],
  );

  const pinToBottom = useCallback(
    (el: HTMLElement, persist = true): void => {
      applyScrollTop(el, el.scrollHeight);
      if (persist) {
        saveChatScrollPosition(
          activeScrollTargetRef.current,
          el.scrollTop,
          undefined,
          true,
        );
        lastSavedScrollSourceRef.current = 'programmatic';
      }
    },
    [applyScrollTop],
  );

  const restorePendingPosition = useCallback(
    (el: HTMLElement): boolean => {
      const saved = pendingScrollTopRef.current;
      if (saved === null) return false;

      applyScrollTop(el, saved);
      // A transcript can mount before its rich content has reached its final
      // height. Keep retrying an offset that the current layout cannot reach;
      // the content ResizeObserver below will finish the restore later.
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScrollTop >= saved - 1) {
        pendingScrollTopRef.current = null;
      }
      return true;
    },
    [applyScrollTop],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A panel host can move this transcript's container after the offset was
    // restored, e.g. when a worktree switch rebuilds the grid. The move resets
    // scrollTop to 0 and the browser reports that as a scroll event. Reapply
    // the intended offset so the reset is never saved as a user scroll.
    let reapplyAfterAdoption = false;
    let adoptionFrame: number | null = null;
    const reapplyIntendedPosition = (): void => {
      reapplyAfterAdoption = false;
      if (restorePendingPosition(el)) return;
      if (isNearBottomRef.current && !suppressAutoScrollRef.current) {
        pinToBottom(el);
        return;
      }
      const saved = getChatScrollPosition(activeScrollTargetRef.current);
      if (saved !== undefined) applyScrollTop(el, saved);
    };
    const onPanelContentAdopted = (): void => {
      if (el.clientHeight > 0) {
        reapplyIntendedPosition();
        return;
      }
      // The new parent is not laid out yet. The scroll event or resize caused
      // by its attachment reapplies the position; a stale request expires so
      // it can never swallow a later user scroll.
      reapplyAfterAdoption = true;
      if (adoptionFrame !== null) cancelAnimationFrame(adoptionFrame);
      adoptionFrame = requestAnimationFrame(() => {
        adoptionFrame = requestAnimationFrame(() => {
          adoptionFrame = null;
          reapplyAfterAdoption = false;
        });
      });
    };
    const onScroll = (): void => {
      pageViewportRef.current = { height: el.scrollHeight, top: el.scrollTop };
      updateStickySummaryPinnedState(el);
      // A user can scroll before our programmatic-scroll frame settles. Only
      // suppress the event for the offset we actually applied (after clamping).
      if (
        isApplyingScrollRef.current &&
        el.scrollTop === lastAppliedScrollTopRef.current
      )
        return;
      if (reapplyAfterAdoption && el.clientHeight > 0) {
        reapplyIntendedPosition();
        return;
      }
      pendingScrollTopRef.current = null;
      updateScrollState(el);
      saveChatScrollPosition(
        activeScrollTargetRef.current,
        el.scrollTop,
        undefined,
        isNearBottomRef.current,
      );
      lastSavedScrollSourceRef.current = 'user';
    };
    const onResize = (): void => {
      const finishPerformanceStage =
        beginTranscriptPerformanceStage('resize_observer');
      const viewportHeight = el.clientHeight;
      pageViewportRef.current = { height: el.scrollHeight, top: el.scrollTop };
      observedViewportHeightRef.current = viewportHeight;
      // Inactive panel tabs remain mounted but collapse to zero height. Ignore
      // that transient layout so it cannot turn a manually scrolled chat into
      // a near-bottom chat that gets pinned when the panel becomes visible.
      if (viewportHeight === 0) {
        finishPerformanceStage({ collapsed: 1 });
        return;
      }
      updateStickySummaryPinnedState(el);
      if (reapplyAfterAdoption) {
        reapplyIntendedPosition();
        finishPerformanceStage({ restored: 1 });
        return;
      }
      if (restorePendingPosition(el)) {
        finishPerformanceStage({ restored: 1 });
        return;
      }
      if (isNearBottomRef.current && !suppressAutoScrollRef.current) {
        pinToBottom(el);
        finishPerformanceStage({ pinned: 1 });
        return;
      }
      updateScrollState(el);
      finishPerformanceStage();
    };
    const panelContentHost = el.closest(`[${PANEL_CONTENT_HOST_ATTRIBUTE}]`);
    panelContentHost?.addEventListener(
      PANEL_CONTENT_ADOPTED_EVENT,
      onPanelContentAdopted,
    );
    el.addEventListener('scroll', onScroll, { passive: true });
    // Observe both the fixed viewport and its content. Markdown, tool output,
    // images, and lazy subtrees can grow after the first layout; observing only
    // the viewport misses that growth and leaves a first visit at the top.
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    if (contentRef.current) {
      ro.observe(contentRef.current);
    }
    return (): void => {
      panelContentHost?.removeEventListener(
        PANEL_CONTENT_ADOPTED_EVENT,
        onPanelContentAdopted,
      );
      if (adoptionFrame !== null) cancelAnimationFrame(adoptionFrame);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (releaseScrollGuardFrameRef.current !== null) {
        cancelAnimationFrame(releaseScrollGuardFrameRef.current);
        releaseScrollGuardFrameRef.current = null;
      }
      isApplyingScrollRef.current = false;
    };
  }, [
    applyScrollTop,
    pinToBottom,
    restorePendingPosition,
    updateScrollState,
    updateStickySummaryPinnedState,
  ]);

  // A worktree/workspace transition normally unmounts the whole panel. Save
  // synchronously during layout cleanup so the last offset is retained even
  // when no final scroll event is emitted by the browser.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    return (): void => {
      // Keep an unreachable saved offset intact. A genuine user scroll clears
      // the pending restore before teardown, so only the clamped programmatic
      // position is excluded here.
      // A panel-tab switch collapses the outgoing panel before React unmounts
      // its chat surface. That zero-height layout clamps scrollTop to 0; keep
      // the offset already captured by the scroll handler instead of
      // overwriting it during cleanup. When no prior position exists,
      // workspace transitions still capture a measurable live offset below.
      const snapshot = transcriptMeasurementSnapshotRef.current;
      const measurements =
        snapshot?.target === scrollTarget ? snapshot.measurements : undefined;
      const saved = getSavedChatScrollPosition(scrollTarget);
      // A pending restoration is authoritative, a ResizeObserver-reported
      // zero-height viewport means the outgoing panel has already collapsed,
      // and a genuine scroll event captured the last user-visible offset before
      // that collapse. Reuse the saved value in those cases without forcing a
      // geometry read. Otherwise capture the live scrollTop: a resize-driven
      // bottom pin can create a saved entry before the native offset changes
      // without emitting a final scroll event during teardown.
      if (
        saved &&
        (pendingScrollTopRef.current !== null ||
          observedViewportHeightRef.current === 0 ||
          lastSavedScrollSourceRef.current === 'user')
      ) {
        if (measurements) {
          saveChatScrollPosition(scrollTarget, saved.top, measurements);
        }
        return;
      }
      // ResizeObserver can lag a same-task panel collapse. Only this uncommon
      // programmatic-save fallback reads geometry synchronously; the common
      // authoritative paths above remain layout-read free.
      if (el && el.clientHeight > 0) {
        saveChatScrollPosition(
          scrollTarget,
          el.scrollTop,
          measurements,
          isNearBottom(el),
        );
      } else if (saved && measurements) {
        saveChatScrollPosition(scrollTarget, saved.top, measurements);
      }
    };
  }, [scrollTarget]);

  // On chatId change (tab switch): restore saved scroll position, or default
  // to the bottom for first-time visits and for chats the user left at the
  // bottom, so replies that arrived meanwhile are in view.
  // Content growth within the same chat is handled by ResizeObserver above. Reading scrollHeight synchronously for
  // every message/queue update forces a full transcript layout before the
  // browser has committed rich descendants, then the observer repeats it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (lastScrollTargetRef.current !== scrollTarget) {
      activeScrollTargetRef.current = scrollTarget;
      lastSavedScrollSourceRef.current = null;
      const saved = getSavedChatScrollPosition(scrollTarget);
      if (saved !== undefined && !saved.atBottom) {
        // A raw offset: sections above the fold that change height on remount
        // still shift the rows in view (CAN-3705 follow-up).
        pendingScrollTopRef.current = saved.top;
        restorePendingPosition(el);
      } else {
        pendingScrollTopRef.current = null;
        // A first visit, or a chat left following its newest content. Start
        // at the bottom; the content observer keeps it there if descendants
        // grow after layout.
        isNearBottomRef.current = true;
        // This first layout can precede a measurable viewport. Let the resize
        // observer persist the real bottom so teardown can still capture a
        // direct live offset if the panel transitions before that happens.
        pinToBottom(el, false);
      }
      lastScrollTargetRef.current = scrollTarget;
    }
  }, [pinToBottom, restorePendingPosition, scrollTarget]);

  // Sending is a request to be at the tail. Nobody types a prompt hoping to
  // watch it land off-screen. A new prompt from the person (sent now or queued
  // behind a running turn) re-arms bottom-follow even when they had scrolled
  // up, and the content observer keeps the streaming reply in view. Watcher
  // and hook prompts arrive on their own and leave the reader where they are.
  const sentPrompts = useMemo((): {
    latest: { id: string; timestamp: number } | null;
    count: number;
  } => {
    let latest: { id: string; timestamp: number } | null = null;
    let count = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user' || message.hidden === true) continue;
      if (
        message.watcherFired !== undefined ||
        (message.userMessageSource !== undefined &&
          message.userMessageSource !== 'human')
      )
        continue;
      latest ??= { id: message.id, timestamp: message.timestamp };
      count += 1;
    }
    return { latest, count };
  }, [messages]);
  const hasTranscriptRows = messages.length > 0;
  const sentQueuedPrompts = useMemo(
    () =>
      queuedMessages.filter(
        (message) =>
          message.watcherFired === undefined &&
          message.queuedHookQueueId === undefined &&
          message.promptSource !== 'automated',
      ),
    [queuedMessages],
  );
  const sentQueuedPromptCount = sentQueuedPrompts.length;
  const sentQueuedPromptIds = useMemo(() => {
    const ids = sentQueuedPrompts.flatMap((message) =>
      message.hostQueueEntryId ? [message.hostQueueEntryId] : [],
    );
    return ids.length === sentQueuedPrompts.length ? ids : undefined;
  }, [sentQueuedPrompts]);
  const sentPromptTrackerRef = useRef<
    | (SentPromptSummary & {
        target: ChatScrollPositionTarget;
        hadTranscriptRows: boolean;
        seenQueuedIds: Set<string>;
      })
    | null
  >(null);
  useLayoutEffect(() => {
    const previous = sentPromptTrackerRef.current;
    const seenQueuedIds =
      previous?.target === scrollTarget
        ? previous.seenQueuedIds
        : new Set<string>();
    const next: SentPromptSummary = {
      latest: sentPrompts.latest,
      promptCount: sentPrompts.count,
      queuedCount: sentQueuedPromptCount,
      queuedIds: sentQueuedPromptIds,
    };
    const sentNewPrompt = previous !== null && detectSentPrompt(previous, next);
    for (const id of sentQueuedPromptIds ?? []) seenQueuedIds.add(id);
    sentPromptTrackerRef.current = {
      ...next,
      target: scrollTarget,
      hadTranscriptRows: hasTranscriptRows,
      seenQueuedIds,
    };
    // A chat switch adopts the new chat's tail as already seen, and so does a
    // transcript that loads after mount: its prompts were sent before this
    // visit, so the restored offset stands.
    if (previous?.target !== scrollTarget || !previous.hadTranscriptRows)
      return;
    // A queued prompt moving into the transcript (it was followed when
    // queued) or its temporary row trading its id for the persisted one is not
    // a send, so a reader who scrolled up since keeps their place.
    if (!sentNewPrompt) return;
    const el = scrollRef.current;
    if (!el || suppressAutoScrollRef.current) return;
    pendingScrollTopRef.current = null;
    isNearBottomRef.current = true;
    pinToBottom(el);
  }, [
    hasTranscriptRows,
    pinToBottom,
    scrollTarget,
    sentPrompts,
    sentQueuedPromptCount,
    sentQueuedPromptIds,
  ]);

  const previousPageLayoutRef = useRef<{
    target: ChatScrollPositionTarget;
    messages: typeof messages;
  } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const previous = previousPageLayoutRef.current;
    const prepended =
      previous?.target === scrollTarget &&
      messages.length > previous.messages.length &&
      messages[messages.length - 1]?.id ===
        previous.messages[previous.messages.length - 1]?.id;
    if (prepended && !virtualizationEnabled && !isNearBottomRef.current) {
      // Non-virtual rows use native browser anchoring. Where it did not move
      // the viewport, preserve the same distance from the unchanged tail.
      const growth = el.scrollHeight - pageViewportRef.current.height;
      if (
        growth > 0 &&
        Math.abs(el.scrollTop - pageViewportRef.current.top) < 1
      )
        applyScrollTop(el, el.scrollTop + growth);
    }
    previousPageLayoutRef.current = {
      target: scrollTarget,
      messages,
    };
  }, [
    applyScrollTop,
    messages,
    scrollTarget,
    transcriptVirtualizer,
    transcriptTotalSize,
    virtualizationEnabled,
  ]);

  // Dynamic virtual rows can be much taller than their initial estimate.
  // Keep a first visit or an actively followed turn pinned to the real tail as
  // those measurements settle. A manual scroll (or a restored non-tail
  // position) clears `isNearBottomRef`, so this does not steal navigation.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (
      !virtualizationEnabled ||
      !el ||
      pendingScrollTopRef.current !== null ||
      !isNearBottomRef.current ||
      suppressAutoScrollRef.current
    ) {
      return;
    }
    pinToBottom(el);
  }, [pinToBottom, transcriptTotalSize, virtualizationEnabled]);

  const handleScrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  // Click-to-jump for user bubbles: scroll the transcript so the clicked
  // message sits at the top of the panel. For a hoisted sticky header —
  // possibly displaced (stuck) far from its natural spot — the message's real
  // position in history is its section's top. An in-flow message (e.g. a
  // watcher-fired follow-up) instead lands just below its section's pinned
  // head prompt, which would otherwise cover it once the scroll settles.
  const jumpToUserMessage = useCallback(
    (element: HTMLElement): void => {
      const el = scrollRef.current;
      if (!el) return;
      const header = element.closest<HTMLElement>(
        '[data-sticky-user-message-id]',
      );
      const userMessageId = header?.dataset.stickyUserMessageId;
      const canonicalSectionIndex = userMessageId
        ? stickySections.findIndex(
            (candidate) =>
              candidate.key === userMessageId &&
              candidate.stickyGroup?.userMessage.id === userMessageId,
          )
        : -1;
      const canonicalSection = userMessageId
        ? Array.from(
            el.querySelectorAll<HTMLElement>('[data-chat-sticky-section]'),
          ).find(
            (candidate) =>
              candidate.dataset.chatStickySection === userMessageId,
          )
        : undefined;
      const closestSection = element.closest<HTMLElement>(
        '[data-chat-sticky-section]',
      );
      const insideHeader = header !== null;

      // A virtualized continuation repeats its section's sticky header. Its
      // canonical first section may not be mounted, so ask the virtualizer to
      // materialize and align that row instead of scrolling to the clone.
      if (
        insideHeader &&
        userMessageId &&
        !canonicalSection &&
        virtualizationEnabled &&
        canonicalSectionIndex >= 0
      ) {
        // The paging lane sits outside the virtual window. Reuse deep-link
        // alignment so the materialized section settles at the viewport inset,
        // including that lane's offset, rather than stopping below it.
        focusUserMessageByIdRef.current(userMessageId);
        return;
      }

      const sectionEl = canonicalSection ?? closestSection;
      const target = insideHeader && sectionEl ? sectionEl : element;
      const padding = Number.parseFloat(window.getComputedStyle(el).paddingTop);
      let topInset = Number.isFinite(padding) ? padding : 0;
      if (!insideHeader && sectionEl) {
        const pinnedHeaderHeight = readStickyUserHeight(sectionEl);
        if (pinnedHeaderHeight > 0) {
          // + the inter-item gap the pinned stack keeps below itself.
          topInset += pinnedHeaderHeight + 8;
        }
      }
      const delta =
        target.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        topInset;
      el.scrollTo({ top: el.scrollTop + delta, behavior: 'smooth' });
    },
    [stickySections, virtualizationEnabled],
  );
  // Every turn row is memoized. `jumpToUserMessage` is rebuilt whenever the
  // sticky sections change (every streamed token), and `onLoadTurn` is an
  // arbitrary caller prop, so the rows receive latest-ref wrappers whose
  // identity never changes instead of those raw callbacks.
  const jumpToUserMessageRef = useRef(jumpToUserMessage);
  jumpToUserMessageRef.current = jumpToUserMessage;
  const stableJumpToUserMessage = useCallback((element: HTMLElement): void => {
    jumpToUserMessageRef.current(element);
  }, []);
  const onLoadTurnRef = useRef(onLoadTurn);
  onLoadTurnRef.current = onLoadTurn;
  const stableLoadTurn = useCallback(
    (userMessageId: string): void | Promise<void> =>
      onLoadTurnRef.current?.(userMessageId),
    [],
  );
  const rowLoadHistory = onLoadTurn ? stableLoadTurn : undefined;
  const transcriptTurnById = useMemo(
    () =>
      new Map(
        transcriptTurns?.map((turn): [string, TranscriptTurnSummary] => [
          turn.id,
          turn,
        ]),
      ),
    [transcriptTurns],
  );

  // --- Deep-linked turn focus (ECW-8684) -----------------------------------
  // An automation run row (and any future caller) can ask the transcript to
  // scroll to one user-authored turn. Kept id-driven rather than
  // element-driven so the target does not have to be mounted: for a
  // virtualized transcript the row usually is not.
  const turnFocusHighlightRef = useRef<{
    element: HTMLElement;
    timer: number;
  } | null>(null);
  const turnFocusFrameRef = useRef<number | null>(null);

  const clearTurnFocusHighlight = useCallback((): void => {
    const active = turnFocusHighlightRef.current;
    if (active) {
      window.clearTimeout(active.timer);
      delete active.element.dataset.chatTurnFocus;
      turnFocusHighlightRef.current = null;
    }
    if (turnFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(turnFocusFrameRef.current);
      turnFocusFrameRef.current = null;
    }
  }, []);

  const highlightSectionElement = useCallback(
    (element: HTMLElement): void => {
      clearTurnFocusHighlight();
      element.dataset.chatTurnFocus = 'true';
      const timer = window.setTimeout(() => {
        delete element.dataset.chatTurnFocus;
        turnFocusHighlightRef.current = null;
      }, CHAT_TURN_FOCUS_HIGHLIGHT_MS);
      turnFocusHighlightRef.current = { element, timer };
    },
    [clearTurnFocusHighlight],
  );

  const findSectionElement = useCallback(
    (sectionKey: string): HTMLElement | undefined => {
      const el = scrollRef.current;
      if (!el) return undefined;
      return Array.from(
        el.querySelectorAll<HTMLElement>('[data-chat-sticky-section]'),
      ).find((candidate) => candidate.dataset.chatStickySection === sectionKey);
    },
    [],
  );

  const focusUserMessageById = useCallback(
    (userMessageId: string): void => {
      const el = scrollRef.current;
      if (!el) return;
      // Only the canonical head section, never a `:continuation:` clone: a
      // continuation's key is `${headKey}:continuation:${itemId}`, so an exact
      // match on the bare message id can only resolve the head. Unlike
      // `jumpToUserMessage` this does not additionally require `stickyGroup`,
      // because a deep link must still reach a turn whose head does not render
      // as a hoisted sticky header (a reverted or in-flight turn).
      const canonicalSectionIndex = stickySections.findIndex(
        (candidate) => candidate.key === userMessageId,
      );
      if (canonicalSectionIndex < 0) return;

      if (virtualizationEnabled) {
        transcriptVirtualizer.scrollToIndex(canonicalSectionIndex, {
          align: 'start',
        });
        clearTurnFocusHighlight();
        let framesLeft = 30;
        let stableFrames = 0;
        const settleVirtualTurn = (): void => {
          const sectionEl = findSectionElement(userMessageId);
          if (!sectionEl) {
            transcriptVirtualizer.scrollToIndex(canonicalSectionIndex, {
              align: 'start',
            });
          } else {
            const padding = Number.parseFloat(
              window.getComputedStyle(el).paddingTop,
            );
            const topInset = Number.isFinite(padding) ? padding : 0;
            const delta =
              sectionEl.getBoundingClientRect().top -
              el.getBoundingClientRect().top -
              topInset;
            if (Math.abs(delta) > 1) {
              el.scrollTop += delta;
              stableFrames = 0;
            } else {
              stableFrames += 1;
            }
            if (stableFrames >= 2) {
              turnFocusFrameRef.current = null;
              highlightSectionElement(sectionEl);
              return;
            }
          }
          framesLeft -= 1;
          if (framesLeft <= 0) {
            turnFocusFrameRef.current = null;
            if (sectionEl) highlightSectionElement(sectionEl);
            return;
          }
          turnFocusFrameRef.current =
            window.requestAnimationFrame(settleVirtualTurn);
        };
        turnFocusFrameRef.current =
          window.requestAnimationFrame(settleVirtualTurn);
        return;
      }

      const sectionEl = findSectionElement(userMessageId);
      if (!sectionEl) return;
      const padding = Number.parseFloat(window.getComputedStyle(el).paddingTop);
      const topInset = Number.isFinite(padding) ? padding : 0;
      const delta =
        sectionEl.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        topInset;
      el.scrollTo({ top: el.scrollTop + delta, behavior: 'smooth' });
      clearTurnFocusHighlight();
      turnFocusFrameRef.current = window.requestAnimationFrame(() => {
        turnFocusFrameRef.current = null;
        highlightSectionElement(sectionEl);
      });
    },
    [
      clearTurnFocusHighlight,
      findSectionElement,
      highlightSectionElement,
      stickySections,
      transcriptVirtualizer,
      virtualizationEnabled,
    ],
  );

  const pendingChatTurnFocus = useNavigationStore(
    (s) => s.pendingChatTurnFocus,
  );
  const transcriptHydrated = worktreeTarget
    ? hydratedKeys.has(
        `${worktreeTarget.projectId}/${worktreeTarget.worktreeId}`,
      )
    : true;

  // Latest-ref so the consumption effect does not list `focusUserMessageById`
  // as a dependency: the effect keys on the sticky sections themselves (to
  // retry once a requested page lands) and must not also churn on the scroll
  // helpers rebuilt alongside them.
  const focusUserMessageByIdRef = useRef(focusUserMessageById);
  focusUserMessageByIdRef.current = focusUserMessageById;
  // One history request per pending deep link. A turn older than the loaded
  // window is fetched through `onLoadTurn`; the request stays pending until
  // its row renders or a completed load makes no progress.
  const turnFocusLoadRef = useRef<{
    nonce: number;
    sectionsAtRequest: typeof stickySections;
    inFlight: boolean;
    attempts: number;
  } | null>(null);
  const [turnFocusLoadGeneration, setTurnFocusLoadGeneration] = useState(0);

  useEffect(() => {
    if (!pendingChatTurnFocus) {
      turnFocusLoadRef.current = null;
      return;
    }
    if (pendingChatTurnFocus.chatId !== chatId) return;
    // Reused chat ids are valid across projects. Match the owning project for
    // every request, then the worktree when the destination supplied one.
    if (
      worktreeTarget === null ||
      worktreeTarget.projectId !== pendingChatTurnFocus.projectId ||
      (pendingChatTurnFocus.worktreeId !== undefined &&
        worktreeTarget.worktreeId !== pendingChatTurnFocus.worktreeId)
    ) {
      return;
    }
    // Gate on a hydrated transcript, then consume exactly once — either when
    // the turn is honored or when it definitively cannot be. A deleted turn
    // must not leave a dangling request that re-fires against an unrelated
    // chat later, but a turn that merely sits on an older page must not be
    // discarded before that page was requested.
    if (!transcriptHydrated) return;
    const { userMessageId, nonce } = pendingChatTurnFocus;
    const consume = (): void => {
      turnFocusLoadRef.current = null;
      useNavigationStore.getState().consumeChatTurnFocus();
    };
    const loaded =
      stickySections.some((candidate) => candidate.key === userMessageId) ||
      messages.some((message) => message.id === userMessageId);
    if (loaded) {
      consume();
      focusUserMessageByIdRef.current(userMessageId);
      return;
    }
    const loadTurn = onLoadTurnRef.current;
    const attempt = turnFocusLoadRef.current;
    if (!loadTurn) {
      consume();
      return;
    }
    if (attempt && attempt.nonce === nonce) {
      if (attempt.inFlight) return;
      if (
        attempt.sectionsAtRequest === stickySections ||
        attempt.attempts >= CHAT_TURN_FOCUS_MAX_PAGE_LOADS
      ) {
        consume();
        return;
      }
    }
    const next = {
      nonce,
      sectionsAtRequest: stickySections,
      inFlight: true,
      attempts: (attempt?.nonce === nonce ? attempt.attempts : 0) + 1,
    };
    turnFocusLoadRef.current = next;
    void Promise.resolve(loadTurn(userMessageId))
      .catch((): void => undefined)
      .then((): void => {
        if (turnFocusLoadRef.current !== next) return;
        next.inFlight = false;
        setTurnFocusLoadGeneration((generation) => generation + 1);
      });
  }, [
    chatId,
    messages,
    pendingChatTurnFocus,
    stickySections,
    transcriptHydrated,
    turnFocusLoadGeneration,
    worktreeTarget,
  ]);

  useEffect(() => clearTurnFocusHighlight, [clearTurnFocusHighlight]);

  const setScrollRef = useCallback(
    (el: HTMLDivElement | null): void => {
      scrollRef.current = el;
      if (containerRef) {
        containerRef.current = el;
      }
    },
    [containerRef],
  );

  const renderTranscriptItem = (
    item: TurnGroupOrMessage,
    index: number,
    sectionOptions?: {
      hideUserMessage?: boolean;
      stickyTurnSummary?: boolean;
      suppressLeadingForkDivider?: boolean;
    },
  ): JSX.Element => {
    const rendered =
      item.kind === 'turn-group' ? (
        <TurnGroupRenderer
          searchMessageId={
            searchSelection?.turnId === item.userMessage.id
              ? (searchSelection.renderMessageId ?? searchSelection.messageId)
              : undefined
          }
          transcriptTurn={transcriptTurnById.get(item.userMessage.id)}
          onLoadHistory={rowLoadHistory}
          historyLoading={turnLoading && turnPageId === item.userMessage.id}
          historyError={turnPageId === item.userMessage.id ? turnError : null}
          historySuspended={turnLoading}
          chatId={chatId}
          group={item}
          pendingTimer={item.timerMessage.id === pendingTurnTimerId}
          chatPendingQuestions={chatPendingQuestions}
          turnDiff={turnDiffs?.[item.userMessage.id]}
          appliedMemory={memoryByMessageId?.[item.userMessage.id]}
          isLastTurnGroup={index === lastTurnGroupIndex}
          isLastForkableTurnGroup={index === lastForkableTurnGroupIndex}
          onResetToPoint={onResetToPoint}
          isReverted={revertedUserMessageIds.has(item.userMessage.id)}
          targetOverride={targetOverride}
          hideBranchActions={hideBranchActions}
          sourceSdkSessionId={sourceSdkSessionId}
          suppressActiveForkAction={sourceIsClaudeTerminal}
          invocableMentionIndex={invocableMentionIndex}
          filePathMentionIndex={filePathMentionIndex}
          agentArtifacts={
            artifactProjection.byTurn[item.userMessage.id] ??
            EMPTY_AGENT_ARTIFACTS
          }
          backgroundProcesses={turnBackgroundProcesses(
            backgroundProcessesByTurn,
            item.userMessage.id,
          )}
          knownPipelineRuns={artifactProjection.chatInitiatedPipelineRuns}
          hideUserMessage={sectionOptions?.hideUserMessage === true}
          stickyTurnSummary={sectionOptions?.stickyTurnSummary === true}
          forceExpandedUserMessage={
            materializeTranscriptItems ||
            Boolean(
              searchSelection &&
              searchSelection.messageId === searchSelection.turnId,
            )
          }
          onJumpToMessage={stableJumpToUserMessage}
        />
      ) : (
        <ChatMessageItem
          message={item.message}
          forceSearchExpanded={
            (searchSelection?.renderMessageId ?? searchSelection?.messageId) ===
            item.message.id
          }
          chatPendingQuestions={chatPendingQuestions}
          invocableMentionIndex={invocableMentionIndex}
          filePathMentionIndex={filePathMentionIndex}
          originChatTabId={chatId}
          forceExpandedUserMessage={
            materializeTranscriptItems ||
            Boolean(
              searchSelection &&
              searchSelection.messageId === searchSelection.turnId,
            )
          }
          onJumpToMessage={jumpToUserMessage}
        />
      );
    const key =
      item.kind === 'turn-group' ? item.userMessage.id : item.message.id;
    return (
      <div
        // `group/turn` scopes the hover reveal of the turn-level feedback
        // control (CAN-1521) and the completion stamp to this turn, and only
        // this turn. No new DOM.
        //
        // It stays here even when this group's user message is hoisted into
        // the sticky header and is no longer a descendant. Hovering the
        // hoisted prompt reaches this scope through `data-hover`, which the
        // header toggles on this element by id — see `StickyUserMessageHeader`.
        // Widening the scope to the section instead would also catch every
        // watcher-fired follow-up turn grouped into it, so hovering one turn
        // would reveal every other turn's controls.
        className={
          item.kind === 'turn-group' ? 'group/turn space-y-2' : undefined
        }
        data-chat-turn-group={item.kind === 'turn-group' ? key : undefined}
      >
        {index === 0 &&
          forkDividerIndex === -1 &&
          forkedFrom &&
          !sectionOptions?.suppressLeadingForkDivider && (
            <ForkedFromLink forkedFrom={forkedFrom} />
          )}
        {rendered}
        {forkDividerIndex === index && forkedFrom && (
          <ForkedFromLink forkedFrom={forkedFrom} />
        )}
      </div>
    );
  };

  // The revert-eligibility gate for the hoisted sticky header mirrors
  // `TurnGroupRenderer`'s own gating for the in-group user bubble.
  const stickyResetHandler = (
    group: TurnGroup,
  ): ((userMessageId: string) => Promise<void>) | undefined => {
    const turnDiff = turnDiffs?.[group.userMessage.id];
    const turnEligibleForReset =
      (turnDiff?.treeRefs?.length ?? 0) > 0 &&
      (turnDiff?.files.length ?? 0) > 0 &&
      !revertedUserMessageIds.has(group.userMessage.id);
    return onResetToPoint && turnEligibleForReset ? onResetToPoint : undefined;
  };

  const renderStickySection = (
    section: TranscriptStickySection,
  ): JSX.Element => {
    // Without pinning, the section's user message renders in its turn like
    // any other message, and nothing sticks.
    const stickyGroup = pinUserMessages ? section.stickyGroup : undefined;
    return (
      <>
        {stickyGroup && (
          <StickyUserMessageHeader
            group={stickyGroup}
            onResetToPoint={stickyResetHandler(stickyGroup)}
            appliedMemory={memoryByMessageId?.[stickyGroup.userMessage.id]}
            chatPendingQuestions={chatPendingQuestions}
            invocableMentionIndex={invocableMentionIndex}
            filePathMentionIndex={filePathMentionIndex}
            chatId={chatId}
            forceExpandedUserMessage={
              materializeTranscriptItems ||
              Boolean(
                searchSelection &&
                searchSelection.messageId === searchSelection.turnId,
              )
            }
            onJumpToMessage={jumpToUserMessage}
          />
        )}
        {section.items.map((item, offset) => {
          const index = section.startIndex + offset;
          return (
            <div key={getTranscriptItemKey(index)}>
              {renderTranscriptItem(item, index, {
                hideUserMessage: item === stickyGroup,
                stickyTurnSummary: stickyGroup !== undefined,
                suppressLeadingForkDivider:
                  section.startIndex === 0 &&
                  forkDividerIndex === -1 &&
                  forkedFrom !== undefined,
              })}
            </div>
          );
        })}
      </>
    );
  };

  const finishVirtualRangePerformanceStage = beginTranscriptPerformanceStage(
    'virtual_range',
    { sections: stickySections.length },
  );
  const transcriptVirtualItems = virtualizationEnabled
    ? transcriptVirtualizer.getVirtualItems()
    : NO_VIRTUAL_ITEMS;
  finishVirtualRangePerformanceStage({
    mountedSections: transcriptVirtualItems.length,
  });

  const transcriptSectionCount = stickySections.length;
  useLayoutEffect(() => {
    const mounted = new Set(transcriptVirtualItems.map((item) => item.index));
    mountedTranscriptSectionsRef.current = {
      target: scrollTarget,
      indexes: mounted,
    };
    const range = transcriptVirtualizer.range;
    if (!range || materializeTranscriptItems) return undefined;
    const next = progressiveTranscriptRange(
      {
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        overscan: TRANSCRIPT_OVERSCAN_ITEMS,
        count: transcriptSectionCount,
      },
      mounted,
      isTranscriptSectionMeasured,
    );
    // Schedule a pass only while it would mount another section.
    if (next.every((index) => mounted.has(index))) return undefined;
    // Queued from a frame callback, the next pass renders after this frame
    // has painted the sections already mounted.
    const frame = requestAnimationFrame(() =>
      setTranscriptOverscanPass((pass) => pass + 1),
    );
    return (): void => cancelAnimationFrame(frame);
  }, [
    isTranscriptSectionMeasured,
    materializeTranscriptItems,
    scrollTarget,
    transcriptSectionCount,
    transcriptVirtualItems,
    transcriptVirtualizer,
  ]);

  useLayoutEffect(
    () => registerTranscriptPerformanceCommitTarget(chatId),
    [chatId],
  );

  useLayoutEffect(() => {
    if (!__CANOPY_E2E__) return;
    const commitCorrelationId = finishTranscriptPerformanceCommit(chatId, {
      loadedRows: messages.length,
    });
    if (!commitCorrelationId) return;
    performanceFrameQueueRef.current?.enqueue(commitCorrelationId, {
      loadedRows: messages.length,
    });
  }, [
    chatId,
    messages,
    chatPendingQuestions,
    stickySections.length,
    transcriptVirtualItems.length,
  ]);

  useEffect(() => (): void => performanceFrameQueueRef.current?.dispose(), []);

  useEffect(() => {
    if (!__CANOPY_E2E__) return;
    return scheduleTranscriptPerformanceSnapshot(() => {
      const mountedMessageRows = contentRef.current?.querySelectorAll(
        '[data-chat-message-id]',
      ).length;
      setTranscriptPerformanceCounter('loaded_message_rows', messages.length);
      setTranscriptPerformanceCounter('loaded_bytes', loadedBytesEstimate);
      setTranscriptPerformanceCounter(
        'mounted_turn_groups',
        stickySections.length,
      );
      setTranscriptPerformanceCounter(
        'mounted_message_rows',
        mountedMessageRows ?? 0,
      );
    });
  }, [
    chatId,
    loadedBytesEstimate,
    messages.length,
    stickySections.length,
    transcriptVirtualItems.length,
  ]);

  const messageList = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <OverlayScrollArea
          // The scroller runs 8px past the list, under the composer's top
          // padding (ChatInput's `pt-2`), so scrolled-up text meets the
          // composer box, or the first banner above it, before it fades.
          // `pb-2` gives that 8px back at rest: scrolled to the bottom, the
          // latest line still sits 8px clear of the box.
          className="absolute inset-x-0 top-0 -bottom-2"
          viewportClassName="overflow-x-hidden px-4 pt-2 pb-2"
          viewportProps={{ 'data-testid': 'chat-message-list-scroll' }}
          viewportRef={setScrollRef}
          // The transcript's height always changes with its DOM, so the
          // content ResizeObserver already catches every growth; a subtree
          // MutationObserver would additionally fire on each streamed token.
          observeMutations={false}
          // Scrolled up, the transcript fades out into the composer (and any
          // banners above it) instead of stopping at a hard edge. At the
          // bottom nothing fades, so the latest line always reads in full.
          edgeFadeSize={16}
          edgeFadeEdges="bottom"
          // The Activity card lies over the chat's right margin; its layout
          // moves the scrollbar out from under it (ActivityCardChatLayout).
          railClassName="right-[var(--chat-scrollbar-inset,0px)]"
        >
          {/* Session replay records this as a same-size placeholder: the
              surrounding panel and navigation stay visible, while the
              recorder skips the transcript's per-token mutations. */}
          <div
            ref={contentRef}
            data-testid="chat-message-list-content"
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} mx-auto w-full max-w-[var(--chat-reading-width)] chat-width-transition space-y-2`}
          >
            {/* Keep the loading lane stable: changing its height outside the
                virtual window would move an otherwise correctly anchored row. */}
            {pagingControls && <div className="h-9">{pagingControls}</div>}
            {turnGroups.length === 0 &&
              forkDividerIndex === -1 &&
              forkedFrom && <ForkedFromLink forkedFrom={forkedFrom} />}
            {!virtualizationEnabled ? (
              stickySections.map((section) => (
                <div key={section.key} className="space-y-2">
                  {section.startIndex === 0 &&
                    forkDividerIndex === -1 &&
                    forkedFrom && <ForkedFromLink forkedFrom={forkedFrom} />}
                  <div
                    data-chat-sticky-section={section.key}
                    className="relative space-y-2 rounded-lg transition-shadow data-[chat-turn-focus]:ring-2 data-[chat-turn-focus]:ring-line-accent"
                  >
                    {renderStickySection(section)}
                  </div>
                </div>
              ))
            ) : (
              <div
                data-testid="chat-transcript-virtual-window"
                className="relative w-full"
                style={{
                  height: `${transcriptTotalSize}px`,
                }}
              >
                {transcriptVirtualItems.map((virtualItem) => {
                  const section = stickySections[virtualItem.index];
                  if (!section) return null;
                  return (
                    <div
                      key={virtualItem.key}
                      ref={measureTranscriptElement}
                      data-index={virtualItem.index}
                      data-section-item-count={section.items.length}
                      onClickCapture={(event): void => {
                        const target = event.target;
                        if (
                          target instanceof Element &&
                          target.closest('button[aria-expanded]')
                        ) {
                          retainInteractiveTranscriptItem(virtualItem.index);
                        }
                      }}
                      onFocusCapture={(event): void => {
                        const target = event.target;
                        if (
                          target instanceof Element &&
                          target.closest(
                            'input, textarea, select, [contenteditable="true"]',
                          )
                        ) {
                          retainInteractiveTranscriptItem(virtualItem.index);
                        }
                      }}
                      // Layout `top` (not `translateY`): a transform would
                      // leave every row's layout position at 0, which breaks
                      // the sticky-header math for the section's hoisted user
                      // message — position: sticky works off layout geometry.
                      className="absolute left-0 w-full space-y-2 pb-2"
                      style={{
                        top: `${virtualItem.start}px`,
                      }}
                    >
                      {section.startIndex === 0 &&
                        forkDividerIndex === -1 &&
                        forkedFrom && (
                          <ForkedFromLink forkedFrom={forkedFrom} />
                        )}
                      <div
                        data-chat-sticky-section={section.key}
                        className="relative space-y-2 rounded-lg transition-shadow data-[chat-turn-focus]:ring-2 data-[chat-turn-focus]:ring-line-accent"
                      >
                        {renderStickySection(section)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {inputDelivery?.version === 1 && worktreeTarget && (
              <InputDeliveryList
                rows={inputDeliveryViews(inputDelivery, steeringCapabilities)}
                onFocusedRowRemoved={() => {
                  document.dispatchEvent(
                    new CustomEvent('canopy:focus-chat-input'),
                  );
                }}
                onAction={async (row, action, text) => {
                  const result = await useChatStore
                    .getState()
                    .dispatchChatCommand(worktreeTarget, {
                      type: 'chat.input_delivery_action',
                      chatId,
                      rowId: row.id,
                      rowRevision: row.revision,
                      action,
                      ...(text !== undefined ? { text } : {}),
                    });
                  if (result !== 'accepted')
                    throw new Error(
                      'The message changed or the action could not be confirmed. Review its current status.',
                    );
                }}
              />
            )}
            {queuedMessages.map((message, i) => {
              const isEditing = editingQueuedMessageIndex === i;
              if (
                isEditing &&
                onCancelEditQueuedMessage &&
                onSaveEditQueuedMessage
              ) {
                // Keying the editor by the queued message's identity makes
                // switching edit targets remount the editor (resetting its
                // content), while a queue-head drain that shifts indices
                // preserves the same message object and keeps state intact.
                return (
                  <QueuedMessageEditor
                    autoFocus={editingQueuedMessageFocusAllowed}
                    key={`editor-${getQueuedMessageKey(message)}`}
                    message={message}
                    index={i}
                    composerTab={composerTab ?? null}
                    onCancel={onCancelEditQueuedMessage}
                    onSave={onSaveEditQueuedMessage}
                    scheduleEnabled={queuedMessageSchedulingEnabled}
                  />
                );
              }
              return (
                <QueuedMessageBubble
                  key={`bubble-${getQueuedMessageKey(message)}`}
                  message={message}
                  index={i}
                  onClear={onClearQueuedMessage}
                  onForce={onForceQueuedMessage}
                  onSteer={
                    !sourceIsClaudeTerminal &&
                    !queuedForSetup &&
                    worktreeTarget &&
                    message.hostQueueEntryId &&
                    message.canSteer === true &&
                    !message.editLocked &&
                    steeringCapabilities?.steer
                      ? (): void => {
                          if (!message.hostQueueEntryId) return;
                          void useChatStore
                            .getState()
                            .dispatchChatCommand(worktreeTarget, {
                              type: 'chat.steer_queued_message',
                              chatId,
                              queuedMessageId: message.hostQueueEntryId,
                            });
                        }
                      : undefined
                  }
                  onEdit={onEditQueuedMessage}
                  steeringSupported={
                    !sourceIsClaudeTerminal &&
                    !queuedForSetup &&
                    Boolean(worktreeTarget && steeringCapabilities?.steer)
                  }
                  canForce={i === 0 && queuedForSetup !== true}
                  queuedForSetup={queuedForSetup}
                  anyEditing={
                    editingQueuedMessageIndex !== undefined ||
                    pendingQueuedMessageEditId !== undefined
                  }
                />
              );
            })}
            {/* Only one-time sends render as bubbles; recurring automations
                surface as a composer notice (`ScheduledAutomationsNotice`),
                since a cron job always has a next run and would otherwise pin
                its prompt under the conversation forever. */}
            {oneTimeScheduledMessages.map((scheduled) => {
              const message: QueuedChatMessage = {
                text: scheduled.text,
                ...(scheduled.fileReferences
                  ? { fileReferences: scheduled.fileReferences }
                  : {}),
                ...(scheduled.attachmentPaths
                  ? { attachmentPaths: scheduled.attachmentPaths }
                  : {}),
                ...(scheduled.attachmentPromptContexts
                  ? {
                      attachmentPromptContexts:
                        scheduled.attachmentPromptContexts,
                    }
                  : {}),
                ...(scheduled.inputMode
                  ? { inputMode: scheduled.inputMode }
                  : {}),
                scheduledSendDraft: { runAt: scheduled.scheduledAt },
              };
              if (
                editingScheduledMessageId === scheduled.automationId &&
                onCancelEditScheduledMessage &&
                onSaveEditScheduledMessage
              ) {
                return (
                  <QueuedMessageEditor
                    key={`scheduled-editor-${scheduled.automationId}`}
                    message={message}
                    index={0}
                    composerTab={composerTab ?? null}
                    onCancel={onCancelEditScheduledMessage}
                    onSave={(
                      _index,
                      text,
                      fileReferences,
                      attachmentPaths,
                      attachmentPromptContexts,
                      inputMode,
                      scheduledSendDraft,
                    ): void =>
                      onSaveEditScheduledMessage(
                        scheduled.automationId,
                        text,
                        fileReferences,
                        attachmentPaths,
                        attachmentPromptContexts,
                        inputMode,
                        scheduledSendDraft,
                      )
                    }
                    scheduleEnabled={queuedMessageSchedulingEnabled}
                  />
                );
              }
              return (
                <QueuedMessageBubble
                  key={`scheduled-${scheduled.automationId}`}
                  index={0}
                  message={message}
                  onClear={(): void => undefined}
                  scheduled={{
                    automationId: scheduled.automationId,
                    activityName: scheduled.activityName,
                    scheduledAt: scheduled.scheduledAt,
                    running:
                      runningScheduledMessageId === scheduled.automationId,
                    onEdit: (): void =>
                      onEditScheduledMessage?.(scheduled.automationId),
                    onClear: (): void =>
                      onClearScheduledMessage?.(scheduled.automationId),
                    onInterrupt: (): void =>
                      onInterruptScheduledMessage?.(scheduled.automationId),
                  }}
                />
              );
            })}
          </div>
        </OverlayScrollArea>
        {showScrollButton && (
          // Above the pinned user bubble (z-20).
          <div className="absolute left-1/2 bottom-3 z-30 flex -translate-x-1/2">
            <ScrollToBottomButton
              onClick={handleScrollToBottom}
              dataTestId="chat-scroll-to-bottom"
              ariaLabel="Scroll to bottom"
            />
          </div>
        )}
      </div>
      {!subagentsView &&
      (activeTurn?.kind === 'turn-group' || activeAgents.length > 0) &&
      artifactChatTarget ? (
        <ActiveAgentActivitySection
          // Background delegates outlive the turn that started them. Keying
          // the pinned section by turn remounted their cards, collapsing them,
          // whenever the parent started or finished a turn.
          key={chatId}
          agentItems={activeAgents.map((block, index) => (
            <ChatBlockRenderer
              key={
                // One card per delegation, so a follow-up run updates the
                // open card in place instead of replacing it.
                block.type === 'delegated_agent_call'
                  ? `delegated-agent:${block.delegationId}`
                  : getDisplayBlockKey(block, index)
              }
              block={block}
              stripAgentCitations
              originChatTabId={chatId}
              chatPendingQuestions={chatPendingQuestions}
              invocableMentionIndex={invocableMentionIndex}
              filePathMentionIndex={filePathMentionIndex}
            />
          ))}
          projectedArtifacts={activeArtifacts}
          backgroundProcesses={activeBackgroundProcesses}
          knownPipelineRuns={artifactProjection.chatInitiatedPipelineRuns}
          ownerUserMessageId={
            activeTurn?.kind === 'turn-group' ? activeTurn.userMessage.id : ''
          }
          chatTarget={artifactChatTarget}
          liveDelegationIds={canStopDelegations ? liveDelegationIds : undefined}
        />
      ) : null}
    </div>
  );
  return (
    <AgentSentReceivingContextProvider receivingContext={receivingContext}>
      <ChatMarkdownFileTargetContext.Provider value={worktreeTarget}>
        <ToolOutputReaderContext.Provider value={readToolOutput}>
          <ChatVisualHostProvider value={chatVisualHost}>
            <SubagentEntryActionsContext.Provider value={subagentEntryActions}>
              <DelegationTranscriptSourceContext.Provider
                value={delegationTranscriptSource}
              >
                <ManagedDelegationStopContext.Provider
                  value={delegationStopControls}
                >
                  <ChatMessageLinkActionsProvider value={linkActions}>
                    {messageList}
                  </ChatMessageLinkActionsProvider>
                </ManagedDelegationStopContext.Provider>
              </DelegationTranscriptSourceContext.Provider>
            </SubagentEntryActionsContext.Provider>
          </ChatVisualHostProvider>
        </ToolOutputReaderContext.Provider>
      </ChatMarkdownFileTargetContext.Provider>
    </AgentSentReceivingContextProvider>
  );
}
