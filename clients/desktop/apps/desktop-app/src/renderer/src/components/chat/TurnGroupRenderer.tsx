import { CanopyLogo } from '@/components/CanopyLogo';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { WorkflowIcon } from '@/components/activity/WorkflowIcon';
import { ShareSessionControl } from '@/components/shared/ShareSessionControl';
import { ChatWatcherButton } from '@/components/watchers/ChatWatcherButton';
import { useTurnFileLocations } from '@/hooks/useTurnFileLocations';
import { isCoworkChatTarget } from '@/lib/cowork';
import type { FilePathMentionIndex } from '@/lib/filePathMentionIndex';
import type { InvocableMentionIndex } from '@/lib/invocableMentionIndex';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useChatGroupToolCallsEnabled } from '@/stores/chatGroupToolCallsStore';
import { useChatLiveStepWindowEnabled } from '@/stores/chatLiveStepWindowStore';
import type { AppliedOrgMemoryTurn, PendingQuestion } from '@/stores/chatStore';
import {
  useChatStore,
  useChatTabRenderState,
  type ChatRenderTarget,
} from '@/stores/chatStore';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import {
  displayMessageHasVisual,
  visualOnlyDisplayMessage,
} from '@canopy/desktop-shared/lib/display-message-visual';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import {
  computeTurnSummary,
  splitFinalMessages,
} from '@canopy/desktop-shared/lib/turn-utils';
import type {
  AgentArtifactReceiptV1,
  BackgroundProcess,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type TurnDiffData,
} from '@canopy/desktop-shared/types';
import {
  ChatCopyAction,
  CollapsedTurnSummaryRow,
  describeStepCounts,
  TranscriptPagingControls,
  TurnFooterRow,
  TurnWorkHeader,
  useCleanChatLook,
  useIsPhone,
} from '@canopy/ui-shared/components';
import {
  AgentIcon,
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClaudeLogo,
  CodeBracketsIcon,
  DocumentIcon,
  DocumentSearchIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  McpIcon,
  MessageIcon,
  MonitorIcon,
  PipelineIcon,
  PlanModeIcon,
  QuestionMarkIcon,
  SkillIcon,
  StopIcon,
  StopwatchIcon,
  TaskIcon,
  TerminalBorderedIcon,
  TerminalIcon,
  ThinkingIcon,
  TrashIcon,
  WrenchIcon,
} from '@canopy/ui-shared/icons';
import { DocumentPencilIcon, PickIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ActiveAgentActivitySection } from './ActiveAgentActivitySection';
import { AutoArchiveToggleButton } from './AutoArchiveToggleButton';
import { ChatMessageItem } from './ChatMessageItem';
import { ResetToPointDialog } from './ResetToPointDialog';
import { TurnMoreActions } from './TurnMoreActions';
import { DesktopAgentActivitySection } from './DesktopAgentActivitySection';
import { RunCommentsButton } from './RunCommentsButton';
import { StickyTurnSummary } from './StickyTurnSummary';
import { ToolStepGroup } from './ToolStepGroup';
import { TurnDiffSummary } from './TurnDiffSummary';
import { TurnFeedbackSlot } from './TurnFeedbackHosts';
import { TurnTimer } from './TurnTimer';
import { readStickyUserHeight } from './sticky-user-height';
import {
  liveStepWindow,
  segmentToolSteps,
  stepPieceOf,
  turnStepCounts,
} from './tool-step-groups';
import type { DisplayMessage, TurnGroup, TurnSummaryCounts } from './types';
import { TASK_MGMT_TOOLS, toActiveComposerView } from './types';

const EMPTY_TURN_BACKGROUND_PROCESSES: readonly BackgroundProcess[] = [];
const PROGRESSIVE_TURN_MESSAGE_THRESHOLD = 100;
const PROGRESSIVE_TURN_MESSAGE_BATCH = 8;

// ---------------------------------------------------------------------------
// Collapsed turn summary
// ---------------------------------------------------------------------------

/**
 * Travel time when expanding a turn scrolls its section head to the top of the
 * transcript. Long enough to read as a movement between two places rather than
 * a cut, short enough not to hold up the reader.
 */
const SECTION_SCROLL_DURATION_MS = 320;

/**
 * Finds the rendered user bubble of the turn `userMessageId`: hoisted into
 * its section's sticky header, or inline in the turn group.
 */
function findTurnUserBubble(
  from: HTMLElement,
  userMessageId: string,
): HTMLElement | null {
  const scope =
    from.closest('[data-chat-sticky-section]') ??
    from.closest('[data-chat-turn-group]');
  if (!scope) return null;
  const id = CSS.escape(userMessageId);
  return scope.querySelector<HTMLElement>(
    `[data-sticky-user-message-id="${id}"] [data-role="user"], [data-chat-turn-group="${id}"] [data-role="user"]`,
  );
}

/**
 * Early access, narrow transcripts (the App Advisor panel): the user bubble
 * shrinks to its text and sits flush right, so the steps banner below it
 * takes the bubble's width and right edge to read as one stack with it.
 * Elsewhere the bubble spans the column and the banner keeps `w-full`.
 */
function useMatchUserBubbleWidth(
  bannerRef: RefObject<HTMLButtonElement | null>,
  userMessageId: string | undefined,
  enabled: boolean,
): void {
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    if (!enabled || !banner || !userMessageId) return;
    const bubble = findTurnUserBubble(banner, userMessageId);
    if (!bubble) return;
    // Never narrower than its own step chips (a short prompt makes a narrow
    // bubble); it then grows past the bubble's left edge instead of clipping.
    banner.style.minWidth = 'max-content';
    const apply = (): void => {
      banner.style.width = `${bubble.getBoundingClientRect().width}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(bubble);
    return (): void => {
      observer.disconnect();
      banner.style.width = '';
      banner.style.minWidth = '';
    };
  }, [bannerRef, enabled, userMessageId]);
}

/** A turn's timer, as the clean chat look's header reads it. */
interface TurnHeaderTimer {
  startedAt?: number;
  completedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
}

function CollapsedTurnSummary({
  counts,
  isExpanded,
  onToggle,
  isCodeReviewChat = false,
  userMessageId,
  timer,
  outcome,
}: {
  counts: TurnSummaryCounts;
  isExpanded: boolean;
  onToggle: () => void;
  /** True inside a Code Review sidecar chat — every call bucketed into
   * `counts.plan` there is `RespondToComment`/`GetReviewComments`, so the
   * whole chip swaps to the code-flavored icon instead of the Plan Explore
   * map glyph. */
  isCodeReviewChat?: boolean;
  /** The turn's user message; the banner matches its bubble's width. */
  userMessageId?: string;
  /** Clean chat look: the turn's time, for "Worked for 3m 24s". */
  timer?: TurnHeaderTimer;
  /** Clean chat look: how the turn ended. */
  outcome?: 'failed' | 'cancelled';
}): JSX.Element {
  const bannerRef = useRef<HTMLButtonElement>(null);

  const isPhone = useIsPhone();
  // Clean chat look: the turn's header, "Worked for 3m 24s", opens the
  // steps; what they did reads as words on hover.
  const clean = useCleanChatLook();
  useMatchUserBubbleWidth(bannerRef, userMessageId, isPhone && !clean);
  const stepCounts = clean ? turnStepCounts(counts) : [];
  const items: Array<{
    icon: JSX.Element;
    count: number;
    label: string;
  }> = [];

  if (counts.messages > 0) {
    items.push({
      icon: <MessageIcon />,
      count: counts.messages,
      label: 'messages',
    });
  }
  if (counts.thinking > 0) {
    items.push({
      icon: <ThinkingIcon />,
      count: counts.thinking,
      label: 'thinking',
    });
  }
  if (counts.bash > 0) {
    items.push({ icon: <TerminalIcon />, count: counts.bash, label: 'bash' });
  }
  if (counts.read > 0) {
    items.push({ icon: <DocumentIcon />, count: counts.read, label: 'read' });
  }
  if (counts.readLines > 0) {
    items.push({
      icon: <DocumentIcon />,
      count: counts.readLines,
      label: 'read lines',
    });
  }
  if (counts.writeEdit > 0) {
    items.push({
      icon: <DocumentPencilIcon />,
      count: counts.writeEdit,
      label: 'write/edit',
    });
  }
  if (counts.plan > 0) {
    items.push({
      icon: isCodeReviewChat ? <CodeBracketsIcon /> : <PlanModeIcon />,
      count: counts.plan,
      label: isCodeReviewChat ? 'review comments' : 'plan',
    });
  }
  if (counts.fileEdit > 0) {
    items.push({
      icon: <DocumentPencilIcon />,
      count: counts.fileEdit,
      label: 'edit',
    });
  }
  if (counts.fileAdd > 0) {
    items.push({
      icon: <DocumentPencilIcon />,
      count: counts.fileAdd,
      label: 'write',
    });
  }
  if (counts.fileDelete > 0) {
    items.push({
      icon: <TrashIcon />,
      count: counts.fileDelete,
      label: 'delete',
    });
  }
  if (counts.search > 0) {
    items.push({
      icon: <MagnifyingGlassIcon />,
      count: counts.search,
      label: 'search',
    });
  }
  if (counts.grep > 0) {
    items.push({
      icon: <DocumentSearchIcon />,
      count: counts.grep,
      label: 'grep',
    });
  }
  if (counts.web > 0) {
    items.push({ icon: <GlobeIcon />, count: counts.web, label: 'web' });
  }
  if (counts.agent > 0) {
    items.push({ icon: <AgentIcon />, count: counts.agent, label: 'agents' });
  }
  if (counts.workflow > 0) {
    items.push({
      icon: <WorkflowIcon />,
      count: counts.workflow,
      label: 'workflows',
    });
  }
  if (counts.tasks > 0) {
    items.push({ icon: <TaskIcon />, count: counts.tasks, label: 'tasks' });
  }
  if (counts.taskStop > 0) {
    items.push({ icon: <StopIcon />, count: counts.taskStop, label: 'stop' });
  }
  if (counts.skills > 0) {
    items.push({ icon: <SkillIcon />, count: counts.skills, label: 'skills' });
  }
  if (counts.monitor > 0) {
    items.push({
      icon: <MonitorIcon />,
      count: counts.monitor,
      label: 'monitor',
    });
  }
  if (counts.claude > 0) {
    items.push({
      icon: <ClaudeLogo width={14} height={14} />,
      count: counts.claude,
      label: 'claude',
    });
  }
  if (counts.scheduleWakeup > 0) {
    items.push({
      icon: <StopwatchIcon />,
      count: counts.scheduleWakeup,
      label: 'wakeups',
    });
  }
  if (counts.askUser > 0) {
    items.push({
      icon: <QuestionMarkIcon />,
      count: counts.askUser,
      label: 'questions',
    });
  }
  if (counts.scriptOutput > 0) {
    items.push({
      icon: <TerminalBorderedIcon />,
      count: counts.scriptOutput,
      label: 'script output',
    });
  }
  if (counts.watcher > 0) {
    items.push({
      icon: <AppAdvisorWatcherIcon />,
      count: counts.watcher,
      label: 'watcher',
    });
  }
  if (counts.canopy > 0) {
    items.push({
      icon: <CanopyLogo width={14} height={14} aria-hidden="true" />,
      count: counts.canopy,
      label: 'app',
    });
  }
  if (counts.graph > 0) {
    items.push({
      icon: <GraphIcon />,
      count: counts.graph,
      label: 'code graph',
    });
  }
  if (counts.appAdvisor > 0) {
    items.push({
      icon: <AppAdvisorIcon />,
      count: counts.appAdvisor,
      label: 'app advisor',
    });
  }
  if (counts.pipelineEditor > 0) {
    items.push({
      icon: <PipelineIcon />,
      count: counts.pipelineEditor,
      label: 'pipeline',
    });
  }
  if (counts.computerUse > 0) {
    items.push({
      icon: <PickIcon />,
      count: counts.computerUse,
      label: 'computer use',
    });
  }
  if (counts.mcp > 0) {
    items.push({ icon: <McpIcon />, count: counts.mcp, label: 'mcp' });
  }
  if (counts.other > 0) {
    items.push({ icon: <WrenchIcon />, count: counts.other, label: 'other' });
  }

  const ariaLabel = items
    .map((item) => `${item.count} ${item.label}`)
    .join(', ');

  const handleToggle = (event: MouseEvent<HTMLButtonElement>): void => {
    const wasExpanded = isExpanded;
    const section = event.currentTarget.closest('[data-chat-sticky-section]');
    const turnGroup = event.currentTarget.closest('[data-chat-turn-group]');
    const scroller = event.currentTarget.closest(
      '[data-testid="chat-message-list-scroll"]',
    );
    onToggle();
    if (wasExpanded) return;
    if (!(section instanceof HTMLElement)) return;
    if (!(scroller instanceof HTMLElement)) return;

    // Expanding inserts the turn's steps above whatever the reader was
    // looking at, so without this the prompt they just opened scrolls out
    // of view. Travel to its section head at the top of the scrollport
    // (where it also becomes the pinned header).
    //
    // Hand-animated rather than `scrollTo({behavior: 'smooth'})`, because
    // a native smooth scroll is cancelled outright by the first competing
    // `scrollTop` write — and there are two of those here:
    //
    //  - the transcript re-pins to the bottom whenever content grows while
    //    the reader was near the bottom, which is exactly the case here;
    //  - under virtualization the expanded rows are re-measured and every
    //    later row is repositioned, so the destination itself moves.
    //
    // Driving the scroll frame by frame wins against both: every frame
    // re-measures the destination (so a moving target is followed rather
    // than a stale offset chased) and writes the eased position, which
    // also keeps the transcript out of its near-bottom state so nothing
    // pulls back once the travel finishes.
    //
    // The offset is computed explicitly rather than via `scrollIntoView` —
    // the section's head is `position: sticky`, so scrollIntoView targets
    // the pinned box instead of the section's real top and lands short.
    // The scrollport's own top padding is the resting gap above the first
    // item. Landing on the section's raw offset scrolls that padding away,
    // which pins the banners one notch higher than they sit at rest and
    // closes the gap between the last banner and the content under it —
    // the same turn then reads tighter after the travel than it does
    // anywhere else. Stopping the padding short of the edge reproduces the
    // resting layout exactly.
    const scrollerInset =
      Number.parseFloat(window.getComputedStyle(scroller).paddingTop) || 0;

    // A turn that does not head its section (a watcher-fired follow-up,
    // or any turn in a virtualized continuation) sits below a section head
    // that belongs to an earlier prompt. Travelling to the section top
    // would leave the opened turn far below the viewport, so land the
    // turn itself just under the pinned head and its 8px gap, the way
    // `jumpToUserMessage` lands in-flow bubbles.
    const headsSection =
      turnGroup instanceof HTMLElement &&
      section.querySelector(
        `[data-sticky-user-message-id="${CSS.escape(turnGroup.dataset.chatTurnGroup ?? '')}"]`,
      ) !== null;
    const target =
      turnGroup instanceof HTMLElement && !headsSection ? turnGroup : section;
    const pinnedHeadHeight =
      target === section ? 0 : readStickyUserHeight(section);
    const pinnedHeadInset = pinnedHeadHeight > 0 ? pinnedHeadHeight + 8 : 0;
    const restingInset = scrollerInset + pinnedHeadInset;

    // Reduced motion gets the destination, not the journey. Still applied
    // over several frames rather than once, because the destination moves
    // as the expanded rows are measured — it just does so without easing.
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      let settleFrame = 0;
      const settle = (): void => {
        scroller.scrollTop =
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          restingInset;
        settleFrame += 1;
        if (settleFrame < 4) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
      return;
    }

    const from = scroller.scrollTop;
    const startedAt = performance.now();
    let cancelled = false;
    // A deliberate scroll of their own outranks the travel; without this
    // the animation would fight the wheel for its remaining frames.
    const cancel = (): void => {
      cancelled = true;
    };
    scroller.addEventListener('wheel', cancel, {
      passive: true,
      once: true,
    });

    const step = (now: number): void => {
      if (cancelled) return;
      // `getBoundingClientRect().top - scrollerTop + scrollTop` is the
      // target's absolute offset in the content, so re-reading it mid
      // animation is safe: it does not drift with our own scrolling.
      const to =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        restingInset;
      const progress = Math.min(
        1,
        (now - startedAt) / SECTION_SCROLL_DURATION_MS,
      );
      // easeOutCubic: leaves quickly, settles gently.
      const eased = 1 - (1 - progress) ** 3;
      scroller.scrollTop = from + (to - from) * eased;
      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }
      scroller.removeEventListener('wheel', cancel);
    };
    requestAnimationFrame(step);
  };

  if (clean) {
    return (
      <TurnWorkHeader
        ref={bannerRef}
        startedAt={timer?.startedAt}
        finishedAt={timer?.completedAt ?? null}
        pausedAt={timer?.pausedAt}
        resumedAt={timer?.resumedAt}
        accumulatedPausedDurationMs={timer?.accumulatedPausedDurationMs}
        live={false}
        completionStatus={outcome ?? 'complete'}
        expandable
        isOpen={isExpanded}
        onToggle={handleToggle}
        ariaLabel={`Agent steps: ${ariaLabel}`}
        title={describeStepCounts(stepCounts) || undefined}
        dataTestId="turn-work-header"
      />
    );
  }

  return (
    <CollapsedTurnSummaryRow
      ref={bannerRef}
      onClick={handleToggle}
      isExpanded={isExpanded}
      ariaLabel={`Agent steps: ${ariaLabel}`}
      phoneTouchTarget={false}
      // No surface of its own: the row sits on the transcript background.
      // While pinned, the sticky wrapper's opaque backing is what masks content
      // scrolling behind it, so nothing here needs to be opaque.
      //
      // `relative` keeps the keyboard focus outline visible while pinned. The
      // sticky wrapper's `::before` gap-filler is absolutely positioned, so it
      // paints above in-flow siblings — including this button's outline, which
      // reaches into exactly that 8px band. Positioning the button puts it in
      // the same layer, after the pseudo-element, so the outline survives.
      className="relative ml-auto"
    >
      {items.map((item) => (
        <span
          key={item.label}
          className="flex items-center gap-1"
          title={item.label}
        >
          <span className="flex-shrink-0">{item.icon}</span>
          {item.count > 0 && (
            <span className="text-2xs font-medium">{item.count}</span>
          )}
        </span>
      ))}
    </CollapsedTurnSummaryRow>
  );
}

// ---------------------------------------------------------------------------
// Reverted-turn wrapper — module-level so its component identity is stable
// across re-renders (an inline definition would create a new component type
// per render, forcing React to unmount/remount its children — see
// CLAUDE.md "Performance Patterns").
// ---------------------------------------------------------------------------

function RevertedTurnWrapper({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="-ml-3 space-y-2 border-l-2 border-line-attention/40 pl-3 opacity-60"
      aria-label="Reverted turn"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turn group renderer
// ---------------------------------------------------------------------------

export const TurnGroupRenderer = memo(function TurnGroupRenderer({
  transcriptTurn,
  onLoadHistory,
  searchMessageId,
  historyLoading = false,
  historyError = null,
  historySuspended = false,
  chatId,
  group,
  pendingTimer = false,
  chatPendingQuestions,
  turnDiff,
  appliedMemory,
  isLastTurnGroup,
  isLastForkableTurnGroup,
  onResetToPoint,
  isReverted = false,
  targetOverride,
  hideBranchActions = false,
  sourceSdkSessionId,
  suppressActiveForkAction = false,
  invocableMentionIndex,
  filePathMentionIndex,
  agentArtifacts = [],
  backgroundProcesses = EMPTY_TURN_BACKGROUND_PROCESSES,
  knownPipelineRuns,
  hideUserMessage = false,
  stickyTurnSummary = false,
  forceExpandedUserMessage = false,
  footerAlwaysVisible = false,
  onJumpToMessage,
}: {
  transcriptTurn?: TranscriptTurnSummary;
  /**
   * Loads the owning turn's missing history page. Receives the turn's user
   * message id so the list can hand every row the same stable callback
   * instead of a per-row closure that would defeat this component's memo.
   */
  onLoadHistory?: (userMessageId: string) => void | Promise<void>;
  searchMessageId?: string;
  historyLoading?: boolean;
  historyError?: string | null;
  historySuspended?: boolean;
  chatId?: string;
  group: TurnGroup;
  pendingTimer?: boolean;
  chatPendingQuestions: PendingQuestion[];
  turnDiff?: TurnDiffData;
  appliedMemory?: AppliedOrgMemoryTurn;
  /** Still drives turn-diff summary placement even when another turn owns fork actions. */
  isLastTurnGroup: boolean;
  /**
   * Keeps the completed turn footer visible at rest. Set by hosts that do not
   * wrap each turn in a `group/turn` scope, where the footer's hover/focus
   * reveal could never fire (CAN-4278).
   */
  footerAlwaysVisible?: boolean;
  isLastForkableTurnGroup: boolean;
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  /**
   * True when this turn's code changes have been rolled back by a later
   * `revert_info` marker in the transcript. Renders the whole turn with a
   * faded + bordered treatment so the reverted attempt is visually
   * distinguishable from active history.
   */
  isReverted?: boolean;
  targetOverride?: { projectId: string; worktreeId: string; chatId: string };
  hideBranchActions?: boolean;
  sourceSdkSessionId?: string;
  suppressActiveForkAction?: boolean;
  invocableMentionIndex?: InvocableMentionIndex | null;
  filePathMentionIndex?: FilePathMentionIndex | null;
  agentArtifacts?: readonly AgentArtifactReceiptV1[];
  /**
   * Background processes this turn launched. Supplied by the transcript list
   * from its single activity-store subscription, never read per turn — see
   * `useChatBackgroundProcessesByTurn`.
   */
  backgroundProcesses?: readonly BackgroundProcess[];
  knownPipelineRuns?: Readonly<Record<string, PipelineRunArtifactReceiptV1>>;
  /**
   * True when the transcript list hoisted this turn's user message into a
   * sticky section header and renders it there itself. The group then skips
   * its own user bubble so the message appears exactly once. Never combined
   * with `isReverted` — reverted turns keep their internal collapsed
   * rendering and are not hoisted.
   */
  hideUserMessage?: boolean;
  /**
   * True when this turn renders inside a sticky transcript section: its
   * completed-turn summary chip pins just below the sticky user message
   * (`top: var(--chat-sticky-user-height)`), bounded to this turn's own
   * wrapper — so in a section with watcher-fired turns, each turn's summary
   * scrolls into the pinned slot as its content reaches the top.
   */
  stickyTurnSummary?: boolean;
  forceExpandedUserMessage?: boolean;
  /** Transcript-supplied click-to-jump handler for this turn's user bubble. */
  onJumpToMessage?: (element: HTMLElement) => void;
}): JSX.Element {
  const forkTab = useChatStore((s) => s.forkTab);
  const turnFiles = useMemo(
    () =>
      transcriptTurn?.files && transcriptTurn.complete && group.isComplete
        ? transcriptTurn.files
        : collectTurnFiles(group.assistantMessages, transcriptTurn?.files),
    [
      transcriptTurn?.files,
      transcriptTurn?.complete,
      group.isComplete,
      group.assistantMessages,
    ],
  );
  const branchTab = useChatStore((s) => s.branchTab);
  const setAutoArchiveForActiveTurn = useChatStore(
    (s) => s.setAutoArchiveForActiveTurn,
  );
  const selectedWorktreeProjectId = useChatStore(
    (s) => targetOverride?.projectId ?? s.selectedWorktree?.projectId,
  );
  const selectedWorktreeWorktreeId = useChatStore(
    (s) => targetOverride?.worktreeId ?? s.selectedWorktree?.worktreeId,
  );
  // This turn's chat. Its selectors run only when this chat's tab changes,
  // never for another chat's commit.
  const chatTarget = useMemo(
    (): ChatRenderTarget | null =>
      chatId !== undefined &&
      selectedWorktreeProjectId !== undefined &&
      selectedWorktreeWorktreeId !== undefined
        ? {
            projectId: selectedWorktreeProjectId,
            worktreeId: selectedWorktreeWorktreeId,
            chatId,
          }
        : null,
    [chatId, selectedWorktreeProjectId, selectedWorktreeWorktreeId],
  );
  const hasRoutingTarget =
    !!chatId && !!selectedWorktreeProjectId && !!selectedWorktreeWorktreeId;
  const routedChatTarget =
    hasRoutingTarget && chatTarget !== null ? chatTarget : undefined;
  const {
    pending: pendingTurnFiles,
    located: locatedTurnFiles,
    settled: turnFilesSettled,
  } = useTurnFileLocations(routedChatTarget, turnFiles, group.isComplete);
  const modelRoutingStartedAt = useChatTabRenderState(chatTarget, ({ tab }) =>
    hasRoutingTarget ? tab?.modelRoutingStartedAt : undefined,
  );
  // The model Auto picked for this turn, recorded by main per user message.
  const autoRoutedModel = useChatTabRenderState(chatTarget, ({ tab }) =>
    hasRoutingTarget
      ? tab?.autoRoutedModels?.[group.userMessage.id]
      : undefined,
  );
  const turnOutcome = useChatTabRenderState(
    chatTarget,
    ({ tab }) =>
      tab?.turnEnds?.[group.userMessage.id]?.outcome ??
      tab?.unacceptedTurnEnds?.[group.userMessage.id],
  );
  const [showChoosingModel, setShowChoosingModel] = useState(false);
  const cleanChatLook = useCleanChatLook();
  useEffect(() => {
    if (modelRoutingStartedAt === undefined) {
      setShowChoosingModel(false);
      return;
    }
    const remaining = Math.max(0, 250 - (Date.now() - modelRoutingStartedAt));
    const timeout = window.setTimeout(
      () => setShowChoosingModel(true),
      remaining,
    );
    return (): void => window.clearTimeout(timeout);
  }, [modelRoutingStartedAt]);
  // Threaded down to `ChatMessageItem` → `ChatBlockRenderer` → `ToolCallBlock`
  // and used locally for the collapsed-turn summary chip so the shared
  // plan/review comment tools (`RespondToComment`, `GetReviewComments`) get
  // the code-flavored icon in a Code Review sidecar chat instead of the Plan
  // Explore map glyph (see `ToolDisplayScope`).
  const isCodeReviewChat =
    selectedWorktreeProjectId === CODE_REVIEW_CHAT_PROJECT_ID;
  const forkTarget = targetOverride
    ? {
        projectId: targetOverride.projectId,
        worktreeId: targetOverride.worktreeId,
      }
    : undefined;
  const autoArchiveTurnState = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab }) => {
      if (!tab || tab.kind === 'file') {
        return null;
      }
      return {
        enabled: tab.autoArchive === true,
        visible:
          tab.autoArchive === true || tab.autoArchiveToggleVisible === true,
      };
    }),
  );
  // Share-session state for the completed-turn Share button. Reuse the
  // composer view's idle/session fields so the guard stays consistent across
  // both surfaces.
  const shareTabState = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab }) => {
      if (!tab || tab.kind === 'file') {
        return null;
      }
      const composerView = toActiveComposerView(tab);
      return {
        title: composerView.title,
        hasMessages: composerView.hasStartedSession,
        busy: composerView.shareSessionBusy,
        sharedRun: composerView.sharedRun,
      };
    }),
  );
  // Read-only scopes (a shared-container recipient) keep the transcript and
  // drop every footer control that forks, branches, shares, rates, comments
  // on, watches or rewinds a turn.
  const readOnly = useWorkspaceIsReadOnly();
  const subagentsView = useLabsExperimentEnabled('subagents-view');
  const canBranch =
    !readOnly &&
    !hideBranchActions &&
    selectedWorktreeProjectId !== undefined &&
    !isCoworkChatTarget(selectedWorktreeProjectId);
  const [collapsed, setIsCollapsed] = useState(group.isComplete);
  const isCollapsed = searchMessageId ? false : collapsed;
  const [progressiveMessageTick, setProgressiveMessageTick] = useState(0);
  const userMessageId = group.userMessage.id;
  const progressivelyMountedMessageIdsRef = useRef<Set<string>>(new Set());
  const progressiveTurnIdRef = useRef(userMessageId);
  if (progressiveTurnIdRef.current !== userMessageId) {
    progressiveTurnIdRef.current = userMessageId;
    progressivelyMountedMessageIdsRef.current.clear();
  }
  // Latest-ref so the refresh effect below keys on transcript state only. A
  // parent re-rendering during a streaming turn may hand this row a new
  // callback identity; that must not re-request the same history page.
  const onLoadHistoryRef = useRef(onLoadHistory);
  onLoadHistoryRef.current = onLoadHistory;
  const loadHistory = useCallback(
    (): void | Promise<void> => onLoadHistoryRef.current?.(userMessageId),
    [userMessageId],
  );
  useEffect(() => {
    // A resumed, partially loaded turn can finish while this view is open.
    // Refresh its completed preview/counts once; keep already inspected rows.
    if (
      group.isComplete &&
      transcriptTurn?.complete === false &&
      transcriptTurn.before !== undefined &&
      !historySuspended &&
      !historyError
    )
      void loadHistory();
  }, [
    group.isComplete,
    transcriptTurn,
    historySuspended,
    historyError,
    loadHistory,
  ]);
  const toggleCollapsed = (): void => {
    progressivelyMountedMessageIdsRef.current.clear();
    if (isCollapsed && transcriptTurn?.before !== undefined && onLoadHistory) {
      // Install the initial lazy page while the turn is still collapsed. The
      // subsequent expansion then uses the existing section-head scroll; it
      // must not be mistaken for an infinite-scroll prepend above the viewport.
      void Promise.resolve(loadHistory()).then(() => {
        setProgressiveMessageTick((current) => current + 1);
        setIsCollapsed(false);
      });
    } else if (isCollapsed) {
      setProgressiveMessageTick((current) => current + 1);
      setIsCollapsed(false);
    } else {
      setProgressiveMessageTick((current) => current + 1);
      setIsCollapsed(true);
    }
  };
  const [isRevertedCollapsed, setIsRevertedCollapsed] = useState(isReverted);
  const prevRevertedRef = useRef(isReverted);
  const prevCompleteRef = useRef(group.isComplete);

  // When a turn newly transitions to reverted (a later marker covered it),
  // collapse it. Doesn't auto-expand if the turn becomes un-reverted, which
  // shouldn't happen in normal flow but is a defensive default.
  useEffect(() => {
    if (!prevRevertedRef.current && isReverted) {
      setIsRevertedCollapsed(true);
    }
    prevRevertedRef.current = isReverted;
  }, [isReverted]);

  useEffect(() => {
    if (!prevCompleteRef.current && group.isComplete) {
      setIsCollapsed(true);
    }
    prevCompleteRef.current = group.isComplete;
  }, [group.isComplete]);

  const { intermediateMessages, finalMessages, trailingToolMessages } =
    useMemo(() => {
      if (transcriptTurn?.before === undefined)
        return splitFinalMessages(group.assistantMessages);
      // A sparse preview can omit the tool row separating a question from the
      // final response. Keep the selection computed from the complete turn.
      const finalIds = new Set(transcriptTurn.finalMessageIds);
      return {
        finalMessages: group.assistantMessages.filter((message) =>
          finalIds.has(message.id),
        ),
        intermediateMessages: group.assistantMessages.filter(
          (message) => !finalIds.has(message.id),
        ),
        trailingToolMessages: [],
      };
    }, [group.assistantMessages, transcriptTurn]);

  // Summary counts include both intermediate and trailing tool messages
  // since both are hidden when collapsed.
  const computedSummary = useMemo(
    () =>
      computeTurnSummary([...intermediateMessages, ...trailingToolMessages]),
    [intermediateMessages, trailingToolMessages],
  );

  const summary =
    transcriptTurn?.before !== undefined
      ? transcriptTurn.summary
      : computedSummary;

  const hasIntermediateContent =
    transcriptTurn?.before !== undefined ||
    intermediateMessages.length > 0 ||
    trailingToolMessages.length > 0;

  // Pre-compute whether any final message has visible (non-task-mgmt) content,
  // so we don't recompute inside the .map() on every render.
  const hasVisibleFinalContent = useMemo(
    () =>
      finalMessages.some(
        (m) =>
          !m.blocks.every(
            (b) =>
              (b.type === 'tool_use' && TASK_MGMT_TOOLS.has(b.toolName)) ||
              b.type === 'turn_timer',
          ),
      ),
    [finalMessages],
  );

  const needsCollapsedMessages =
    group.isComplete &&
    (isCollapsed ||
      (searchMessageId === undefined &&
        group.assistantMessages.length >= PROGRESSIVE_TURN_MESSAGE_THRESHOLD));
  const collapsedMessages = useMemo(() => {
    if (!needsCollapsedMessages) return [];
    const retainedFinalMessages = finalMessages.filter((message) => {
      const isTaskMgmtOnly =
        message.blocks.length > 0 &&
        message.blocks.every(
          (block) =>
            (block.type === 'tool_use' &&
              TASK_MGMT_TOOLS.has(block.toolName)) ||
            block.type === 'turn_timer',
        );
      return (
        !isTaskMgmtOnly || !(hasIntermediateContent || hasVisibleFinalContent)
      );
    });
    const retainedQuestionIds = new Set(
      chatPendingQuestions
        // Answer reservation is optimistic. Keep its component mounted until
        // the card finishes submission, so rollback retains input and errors.
        // Settled answered cards render nothing themselves.
        .filter((question) => question.dismissedAt === undefined)
        .map((question) => question.requestId),
    );
    // Keep the narrow final-message path when there are neither questions nor
    // visuals. The WeakMap predicate avoids rescanning hidden blocks on updates.
    if (
      retainedQuestionIds.size === 0 &&
      !group.assistantMessages.some(displayMessageHasVisual)
    ) {
      return retainedFinalMessages;
    }
    const finalIds = new Set(
      retainedFinalMessages.map((message) => message.id),
    );
    return group.assistantMessages.flatMap((message) => {
      if (finalIds.has(message.id)) return [message];
      if (displayMessageHasVisual(message)) {
        return [visualOnlyDisplayMessage(message)];
      }
      const blocks = message.blocks.filter(
        (block) =>
          block.type === 'text' &&
          block.asyncQuestion &&
          retainedQuestionIds.has(block.asyncQuestion.requestId),
      );
      if (blocks.length === 0) return [];
      return [
        blocks.length === message.blocks.length
          ? message
          : { ...message, blocks },
      ];
    });
  }, [
    needsCollapsedMessages,
    group.assistantMessages,
    finalMessages,
    chatPendingQuestions,
    hasIntermediateContent,
    hasVisibleFinalContent,
  ]);
  const visibleMessages =
    !group.isComplete || !isCollapsed
      ? group.assistantMessages
      : collapsedMessages;
  const progressiveMountEligible =
    group.isComplete &&
    !isCollapsed &&
    searchMessageId === undefined &&
    group.assistantMessages.length >= PROGRESSIVE_TURN_MESSAGE_THRESHOLD;

  const renderedVisibleMessages = useMemo(() => {
    // Mounted IDs live in a ref so admitting a batch does not itself force an
    // extra commit. The revision invalidates this memo on the next animation
    // frame after that ref has been populated.
    void progressiveMessageTick;
    if (!progressiveMountEligible) return visibleMessages;
    const retainedIds = new Set(
      collapsedMessages
        .filter((message) => !displayMessageHasVisual(message))
        .map((message) => message.id),
    );
    let unmountedAllowance = PROGRESSIVE_TURN_MESSAGE_BATCH;
    return visibleMessages.filter((message) => {
      if (
        retainedIds.has(message.id) ||
        progressivelyMountedMessageIdsRef.current.has(message.id)
      ) {
        return true;
      }
      if (unmountedAllowance === 0) return false;
      unmountedAllowance -= 1;
      return true;
    });
  }, [
    collapsedMessages,
    progressiveMessageTick,
    progressiveMountEligible,
    visibleMessages,
  ]);
  // Settings → "Group tool calls": back-to-back tool calls fold into one row
  // ("Ran 3 commands"). Off by default, so every tool call is its own row.
  const groupToolCalls = useChatGroupToolCallsEnabled();
  // Its own setting (CAN-4274): the run a turn is still adding to shows only
  // its newest steps. It builds on the same rows, whether grouping is on or
  // not.
  const liveStepWindowEnabled = useChatLiveStepWindowEnabled();
  const toolStepSegments = useMemo(() => {
    if (liveStepWindowEnabled) {
      return segmentToolSteps(renderedVisibleMessages, {
        liveStepWindow: true,
      });
    }
    return groupToolCalls ? segmentToolSteps(renderedVisibleMessages) : null;
  }, [groupToolCalls, liveStepWindowEnabled, renderedVisibleMessages]);
  const liveStepSegment =
    liveStepWindowEnabled && !group.isComplete
      ? toolStepSegments?.[toolStepSegments.length - 1]
      : undefined;
  const renderMessageItem = (msg: DisplayMessage): JSX.Element => {
    // With the live step window a row can be part of a message, or a trimmed
    // copy of one; key, settle and place it by the message it came from.
    const piece = stepPieceOf(msg);
    return (
      <ChatMessageItem
        key={piece.key}
        message={msg}
        blockKeyOffset={piece.blockOffset}
        visualOnly={
          isCollapsed &&
          displayMessageHasVisual(msg) &&
          !finalMessages.includes(piece.source)
        }
        turnExpanded={!isCollapsed}
        forceSearchExpanded={searchMessageId === msg.id}
        streaming={!group.isComplete}
        settled={
          group.isComplete ||
          !piece.endsSource ||
          piece.source !== visibleMessages[visibleMessages.length - 1]
        }
        chatPendingQuestions={chatPendingQuestions}
        invocableMentionIndex={invocableMentionIndex}
        filePathMentionIndex={filePathMentionIndex}
        originChatTabId={chatId}
        isCodeReviewChat={isCodeReviewChat}
      />
    );
  };
  useLayoutEffect(() => {
    if (isCollapsed) {
      progressivelyMountedMessageIdsRef.current.clear();
      return;
    }
    for (const message of renderedVisibleMessages) {
      progressivelyMountedMessageIdsRef.current.add(message.id);
    }
  }, [isCollapsed, renderedVisibleMessages]);
  useEffect(() => {
    if (
      !progressiveMountEligible ||
      renderedVisibleMessages.length >= visibleMessages.length
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setProgressiveMessageTick((current) => current + 1);
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [
    progressiveMountEligible,
    renderedVisibleMessages.length,
    visibleMessages.length,
  ]);

  // Reset is eligible only on turns whose snapshot was captured, that
  // produced visible file changes, AND that haven't already been rolled
  // back by a later marker — there's nothing to undo on a turn with no
  // diff stats or on an already-reverted turn (its snapshot is what's
  // currently checked out), and the action would be confusing.
  const turnEligibleForReset =
    (turnDiff?.treeRefs?.length ?? 0) > 0 &&
    (turnDiff?.files.length ?? 0) > 0 &&
    !isReverted;
  const userResetHandler =
    !readOnly && onResetToPoint && turnEligibleForReset
      ? onResetToPoint
      : undefined;
  // The clean changes card's Undo asks first, like the prompt's Revert.
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  // The reply's Copy button copies the turn's answer, the final messages'
  // text, or every reply text when there is no final one (CAN-4704).
  const replyCopyText = useMemo((): string => {
    const textOf = (messages: readonly DisplayMessage[]): string =>
      messages
        .flatMap((message) =>
          message.blocks.flatMap((block) =>
            block.type === 'text' && block.text.trim() !== ''
              ? [block.text]
              : [],
          ),
        )
        .join('\n\n');
    return textOf(finalMessages) || textOf(group.assistantMessages);
  }, [finalMessages, group.assistantMessages]);
  const fallbackCopyAction =
    group.isComplete && replyCopyText.trim() !== '' ? (
      <ChatCopyAction
        key={group.userMessage.id}
        text={replyCopyText}
        dataTestId="turn-copy-message"
      />
    ) : undefined;
  const timerBlock =
    group.timerMessage.blocks.length === 1 &&
    group.timerMessage.blocks[0].type === 'turn_timer'
      ? group.timerMessage.blocks[0]
      : null;
  const isActiveTimer =
    timerBlock !== null &&
    (timerBlock.completedAt === null || timerBlock.completedAt === undefined);
  const headerOutcome =
    turnOutcome === 'failed' || turnOutcome === 'cancelled'
      ? turnOutcome
      : undefined;
  // Clean chat look: a step still on screen shimmers what the turn is doing
  // (a running call or helper agent, thinking in progress), so the timer row
  // stays quiet.
  const lastShownBlocks =
    renderedVisibleMessages[renderedVisibleMessages.length - 1]?.blocks ?? [];
  const lastShownBlock = lastShownBlocks[lastShownBlocks.length - 1];
  const liveStepShown =
    cleanChatLook &&
    !group.isComplete &&
    lastShownBlock !== undefined &&
    (((lastShownBlock.type === 'tool_use' || lastShownBlock.type === 'agent') &&
      lastShownBlock.result === undefined) ||
      lastShownBlock.type === 'thinking');
  const showForkAction =
    !readOnly &&
    Boolean(chatId) &&
    (isActiveTimer
      ? sourceSdkSessionId !== undefined && !suppressActiveForkAction
      : isLastForkableTurnGroup);
  // Note: in raw `source.messages` the turn timer is appended right after
  // the user message (before any assistant content arrives) — only
  // `reorderMessagesForDisplay` floats it to the end for rendering. So we
  // identify the turn for fork/branch truncation by the user message id;
  // the store cuts up to the next user message.
  const forkAfterUserMessageId = group.userMessage.id;

  // Watcher (eye) button next to the active-turn fork action. Only shown for a
  // real worktree chat while its turn is active — a chat-completion watcher can
  // only be created against a turn that is still running (or held open).
  const canWatch =
    !readOnly &&
    isActiveTimer &&
    Boolean(chatId) &&
    selectedWorktreeProjectId !== undefined &&
    selectedWorktreeWorktreeId !== undefined &&
    !isCoworkChatTarget(selectedWorktreeProjectId) &&
    selectedWorktreeProjectId !== APP_ADVISOR_PROJECT_ID &&
    selectedWorktreeProjectId !== PIPELINE_EDITOR_PROJECT_ID &&
    selectedWorktreeProjectId !== PLAN_EXPLORE_CHAT_PROJECT_ID;
  const watcherButton =
    canWatch &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId ? (
      <ChatWatcherButton
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
      />
    ) : undefined;
  const archiveToggleButton =
    !readOnly &&
    isActiveTimer &&
    autoArchiveTurnState?.visible === true &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId ? (
      <AutoArchiveToggleButton
        enabled={autoArchiveTurnState.enabled}
        target={{
          projectId: selectedWorktreeProjectId,
          worktreeId: selectedWorktreeWorktreeId,
          chatId,
        }}
        onToggle={(): void => {
          setAutoArchiveForActiveTurn(
            {
              projectId: selectedWorktreeProjectId,
              worktreeId: selectedWorktreeWorktreeId,
              chatId,
            },
            !autoArchiveTurnState.enabled,
          );
        }}
      />
    ) : undefined;
  // Share affordance sits with the fork/branch actions on the last forkable
  // completed turn (its natural "share this finished session" home now that it
  // has moved out of the composer). Only rendered for a real, non-file chat tab
  // resolved from the store; enablement (busy/empty) is handled by the control.
  // Turn-level thumbs up/down (CAN-1521). The `chatId === undefined` check is
  // the ENTIRE read-only gate: `TranscriptViewer` passes no `chatId` and is the
  // only consumer behind the audit trail, pipeline step detail, and workflow
  // run views, so those surfaces are excluded by construction.
  //
  // Reverted turns intentionally keep the control — a reverted turn is the
  // highest-signal thumbs-down there is.
  const feedbackControl =
    !readOnly &&
    group.isComplete &&
    !isActiveTimer &&
    chatId !== undefined &&
    selectedWorktreeProjectId !== undefined &&
    selectedWorktreeWorktreeId !== undefined ? (
      <TurnFeedbackSlot
        target={{
          projectId: selectedWorktreeProjectId,
          worktreeId: selectedWorktreeWorktreeId,
          chatId,
        }}
        userMessageId={group.userMessage.id}
      />
    ) : undefined;
  const shareButton =
    !isActiveTimer &&
    showForkAction &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    canTransferChatSession(selectedWorktreeProjectId) &&
    shareTabState ? (
      <ShareSessionControl
        variant="icon-button"
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        title={shareTabState.title}
        hasMessages={shareTabState.hasMessages}
        busy={shareTabState.busy}
        sharedRun={shareTabState.sharedRun}
        testId="turn-share-session"
      />
    ) : undefined;

  // Comments affordance rides next to the share control, but only once the
  // session is actually shared as a run (CAN-397) — an unshared session has no
  // comment surface, so the footer stays exactly as it was.
  const commentsButton =
    !isActiveTimer &&
    showForkAction &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    shareTabState?.sharedRun ? (
      <RunCommentsButton
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        title={shareTabState.title}
        unreadCount={shareTabState.sharedRun.unreadCommentCount ?? 0}
      />
    ) : undefined;

  // Clean chat look: the reply row is Copy, Fork, then "•••" with Branch,
  // Share (and Run comments) and Good / Bad response, then the time.
  const branchHandler =
    showForkAction && canBranch && !isActiveTimer && chatId
      ? (): void => {
          void branchTab(chatId, forkTarget, { forkAfterUserMessageId });
        }
      : undefined;
  const moreMenu =
    cleanChatLook &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    (branchHandler !== undefined ||
      shareButton !== undefined ||
      feedbackControl !== undefined) ? (
      <TurnMoreActions
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        {...(branchHandler !== undefined ? { onBranch: branchHandler } : {})}
        {...(shareButton !== undefined && shareTabState
          ? { share: shareTabState }
          : {})}
        {...(feedbackControl !== undefined
          ? {
              feedback: {
                target: {
                  projectId: selectedWorktreeProjectId,
                  worktreeId: selectedWorktreeWorktreeId,
                  chatId,
                },
                userMessageId: group.userMessage.id,
              },
            }
          : {})}
      />
    ) : undefined;

  // When this turn was rolled back by a later revert_info marker, wrap the
  // whole turn output in a faded + bordered container so the discarded
  // attempt reads as inactive without altering the data model. Plain
  // function so the wrapper component identity is stable across renders.
  const wrapReverted = (children: ReactNode): JSX.Element =>
    isReverted ? (
      <RevertedTurnWrapper>{children}</RevertedTurnWrapper>
    ) : (
      <>{children}</>
    );

  // Reverted turns collapse to a single bar by default — the bad attempt
  // shouldn't dominate the transcript. The bar shows a preview of the
  // user's prompt so it's still scannable; click expands the full content.
  const userPromptPreview = useMemo(() => {
    const text = group.userMessage.blocks
      .flatMap((b) => (b.type === 'text' ? [b.text.trim()] : []))
      .filter((t) => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ');
    if (text.length <= 80) return text;
    return text.slice(0, 80).trimEnd() + '…';
  }, [group.userMessage.blocks]);

  if (isReverted && isRevertedCollapsed) {
    return wrapReverted(
      <button
        type="button"
        onClick={(): void => setIsRevertedCollapsed(false)}
        aria-expanded={false}
        aria-label="Expand reverted turn"
        className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition hover:bg-fg-primary/[0.04]"
      >
        <span className="flex-shrink-0">
          <ChevronRightIcon />
        </span>
        <span className="font-medium fg-primary/80">Reverted</span>
        {userPromptPreview ? (
          <span className="truncate">— {userPromptPreview}</span>
        ) : null}
      </button>,
    );
  }

  return wrapReverted(
    <>
      {isReverted && (
        <button
          type="button"
          onClick={(): void => setIsRevertedCollapsed(true)}
          aria-expanded={true}
          aria-label="Collapse reverted turn"
          className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition hover:bg-fg-primary/[0.04]"
        >
          <span className="flex-shrink-0">
            <ChevronDownIcon />
          </span>
          <span className="font-medium fg-primary/80">Reverted</span>
          {userPromptPreview ? (
            <span className="truncate">— {userPromptPreview}</span>
          ) : null}
        </button>
      )}
      {!hideUserMessage && (
        <ChatMessageItem
          message={group.userMessage}
          appliedMemory={appliedMemory}
          chatPendingQuestions={chatPendingQuestions}
          onResetToPoint={userResetHandler}
          invocableMentionIndex={invocableMentionIndex}
          filePathMentionIndex={filePathMentionIndex}
          originChatTabId={chatId}
          forceExpandedUserMessage={forceExpandedUserMessage}
          onJumpToMessage={onJumpToMessage}
        />
      )}
      {/* Clean chat look: more room under the prompt than between steps. */}
      {cleanChatLook && !hideUserMessage ? (
        <div aria-hidden="true" className="h-2.5" />
      ) : null}

      {/* Clean chat look: the running turn opens with "Working for 28s"; once
          it is done the folded steps' header reads "Worked for 3m 24s". */}
      {cleanChatLook && !group.isComplete ? (
        <TurnWorkHeader
          startedAt={timerBlock?.startedAt}
          finishedAt={null}
          pausedAt={timerBlock?.pausedAt}
          resumedAt={timerBlock?.resumedAt}
          accumulatedPausedDurationMs={timerBlock?.accumulatedPausedDurationMs}
          live
          dataTestId="turn-work-header"
        />
      ) : null}

      {hasIntermediateContent && group.isComplete ? (
        <>
          {stickyTurnSummary && !isReverted ? (
            // Pins below the sticky user message. The containing block is
            // this turn's own wrapper, so the summary unsticks at the turn's
            // end and the next turn's summary (e.g. a watcher-fired
            // follow-up's) scrolls into the pinned slot in its place. The
            // fade band mirrors the sticky header's: sized to the inter-item
            // gap, invisible in normal flow, softening content that slides
            // under the pinned row.
            <StickyTurnSummary>
              {/* Opaque backdrop behind the flat summary row plus a `before`
                  strip filling the gap above it, so the pinned bubble and this
                  row read as one covered stack with no content showing between
                  them. It deliberately stops at the row's bottom edge: a band
                  running past the last banner is what read as a black bar
                  sitting on the transcript. */}
              <div className="relative bg-base before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base">
                <CollapsedTurnSummary
                  counts={summary}
                  isExpanded={!isCollapsed}
                  onToggle={toggleCollapsed}
                  isCodeReviewChat={isCodeReviewChat}
                  userMessageId={group.userMessage.id}
                  timer={timerBlock ?? undefined}
                  outcome={headerOutcome}
                />
              </div>
            </StickyTurnSummary>
          ) : (
            <CollapsedTurnSummary
              counts={summary}
              isExpanded={!isCollapsed}
              onToggle={toggleCollapsed}
              isCodeReviewChat={isCodeReviewChat}
              userMessageId={group.userMessage.id}
              timer={timerBlock ?? undefined}
              outcome={headerOutcome}
            />
          )}
        </>
      ) : null}

      {(historyLoading || !isCollapsed || !group.isComplete) &&
        transcriptTurn?.before !== undefined &&
        onLoadHistory && (
          <TranscriptPagingControls
            key={transcriptTurn.before}
            loading={historyLoading}
            suspended={historySuspended}
            error={historyError}
            hasEarlier
            onLoadEarlier={loadHistory}
            onReload={loadHistory}
          />
        )}

      {/* One keyed list keeps question input mounted through turn completion
          and expand/collapse, while preserving the original message order.
          Questions never fold into a tool-step group, so they stay keyed at
          this level. */}
      {toolStepSegments
        ? toolStepSegments.map((segment) =>
            segment.kind === 'message' ? (
              renderMessageItem(segment.message)
            ) : (
              <ToolStepGroup
                // Live step window: text ending a run, or the turn finishing,
                // compresses the group, so it remounts closed at those points
                // and stays mounted (and open) while its own run grows.
                key={
                  liveStepWindowEnabled
                    ? `tool-steps-${segment.key}:${
                        group.isComplete
                          ? 'complete'
                          : segment === liveStepSegment
                            ? 'live'
                            : 'closed'
                      }`
                    : `tool-steps-${segment.key}`
                }
                toolUses={segment.toolUses}
                steps={segment.steps}
                streaming={!group.isComplete}
                forceExpanded={
                  searchMessageId !== undefined &&
                  segment.messages.some(
                    (message) => message.id === searchMessageId,
                  )
                }
                isCodeReviewChat={isCodeReviewChat}
                liveSteps={
                  segment === liveStepSegment
                    ? liveStepWindow(segment.messages).map(renderMessageItem)
                    : undefined
                }
              >
                {segment.messages.map(renderMessageItem)}
              </ToolStepGroup>
            ),
          )
        : renderedVisibleMessages.map(renderMessageItem)}

      {/* A watcher can be created after this turn's prompt while its chat is
          unmounted. Recover its carry when opening the completed latest turn,
          just as the active section does while a foreground turn is running.
          Under the Subagents view there is no pinned section, so the latest
          turn lists its artifacts, background tasks and runs here while it
          runs too; its subagents are counted in the top bar. */}
      {(group.isComplete || subagentsView) &&
      isLastTurnGroup &&
      routedChatTarget ? (
        <ActiveAgentActivitySection
          key={group.userMessage.id}
          projectedArtifacts={agentArtifacts}
          backgroundProcesses={backgroundProcesses}
          knownPipelineRuns={knownPipelineRuns}
          variant="completed"
          ownerUserMessageId={group.userMessage.id}
          // Stable across renders: its effect records carry, and each new
          // target object would re-record on every transcript update.
          chatTarget={routedChatTarget}
        />
      ) : group.isComplete &&
        (agentArtifacts.length > 0 || backgroundProcesses.length > 0) ? (
        <DesktopAgentActivitySection
          key={group.userMessage.id}
          artifacts={agentArtifacts}
          backgroundProcesses={backgroundProcesses}
          variant="completed"
          defaultExpanded={isLastTurnGroup}
          ownerUserMessageId={group.userMessage.id}
          chatTarget={routedChatTarget}
        />
      ) : null}

      {(group.isComplete && turnDiff && turnDiff.files.length > 0) ||
      locatedTurnFiles.length > 0 ||
      pendingTurnFiles.length > 0 ? (
        <TurnDiffSummary
          turnDiff={group.isComplete ? turnDiff : undefined}
          files={locatedTurnFiles}
          pendingFiles={pendingTurnFiles}
          fileTarget={routedChatTarget}
          filesSettled={turnFilesSettled}
          turnId={group.userMessage.id}
          isLastTurnGroup={isLastTurnGroup}
          originChatTabId={chatId}
          {...(cleanChatLook && userResetHandler && group.isComplete
            ? {
                onUndo: (): void => {
                  setUndoConfirmOpen(true);
                },
              }
            : {})}
        />
      ) : null}
      {undoConfirmOpen && userResetHandler ? (
        <ResetToPointDialog
          onConfirm={async (): Promise<void> => {
            await userResetHandler(group.userMessage.id);
            setUndoConfirmOpen(false);
          }}
          onCancel={(): void => {
            setUndoConfirmOpen(false);
          }}
        />
      ) : null}

      {timerBlock ? (
        <TurnTimer
          key={`timer-${group.userMessage.id}`}
          pending={pendingTimer}
          startedAt={timerBlock.startedAt}
          pausedAt={timerBlock.pausedAt}
          resumedAt={timerBlock.resumedAt}
          accumulatedPausedDurationMs={timerBlock.accumulatedPausedDurationMs}
          completedAt={timerBlock.completedAt ?? null}
          alwaysVisible={
            footerAlwaysVisible ||
            // Clean chat look: the newest reply keeps its row in view, as
            // ChatGPT does; older ones show it on hover or focus.
            (cleanChatLook && isLastTurnGroup) ||
            turnOutcome === 'failed' ||
            turnOutcome === 'cancelled'
          }
          workingLabel={showChoosingModel ? 'Choosing a model…' : undefined}
          liveStatusShown={liveStepShown}
          autoRoutedModel={autoRoutedModel}
          watcherButton={watcherButton}
          archiveToggleButton={archiveToggleButton}
          shareButton={moreMenu ? undefined : shareButton}
          moreMenu={moreMenu}
          feedbackControl={moreMenu ? undefined : feedbackControl}
          {...(group.isComplete ? { copyText: replyCopyText } : {})}
          commentsButton={moreMenu ? undefined : commentsButton}
          showForkAction={showForkAction}
          onFork={
            showForkAction && chatId
              ? (): void => {
                  if (isActiveTimer) {
                    forkTab(chatId, forkTarget, {
                      includeActiveTurn: true,
                      ...(sourceSdkSessionId ? { sourceSdkSessionId } : {}),
                    });
                    return;
                  }
                  forkTab(chatId, forkTarget, { forkAfterUserMessageId });
                }
              : undefined
          }
          showBranchAction={
            !moreMenu && showForkAction && canBranch && !isActiveTimer
          }
          onBranch={
            showForkAction && canBranch && chatId
              ? (): void => {
                  void branchTab(chatId, forkTarget, {
                    forkAfterUserMessageId,
                  });
                }
              : undefined
          }
        />
      ) : (
        <>
          <ChatMessageItem
            message={group.timerMessage}
            chatPendingQuestions={chatPendingQuestions}
            invocableMentionIndex={null}
            filePathMentionIndex={null}
            originChatTabId={chatId}
          />
          {/*
            `timerBlock` is null whenever the timer message carries anything
            other than exactly one `turn_timer` block, and the feedback control
            normally rides beside `TurnTimer`'s completion stamp. Without
            this branch a completed turn in that shape would render no thumbs at
            all, so the control is pinned to its own right-aligned row here and
            the affordance stays available for every completed turn. The
            reply's Copy joins it there for the same reason (CAN-4704). Like
            the timer row's, both stay visible at rest.
          */}
          {(fallbackCopyAction !== undefined ||
            feedbackControl !== undefined) && (
            <TurnFooterRow variant="actions" data-testid="turn-feedback-row">
              {fallbackCopyAction}
              {feedbackControl}
            </TurnFooterRow>
          )}
        </>
      )}
    </>,
  );
});
