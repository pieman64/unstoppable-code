'use client';

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import {
  ChatCopyAction,
  CollapsedTurnSummary,
  getElapsedSecond,
  getToolDisplayFamily,
  isAskUserQuestionToolName,
  matchAskUserQuestionState,
  parseAskUserQuestionTexts,
  TurnFooterReveal,
  TurnFooterRow,
  TurnWorkHeader,
  useCleanChatLook,
  type TurnSummary,
} from '@canopy/ui-shared/components';
import { ChatMessageView, normalizeChatMessageParts } from './ChatMessageView';
import { useAskUserQuestionInteraction } from './ChatPartView';
import { ChatVisualBlock } from './ChatVisualBlock';
import { readChatToolResultVisual } from './ChatToolResultPart';
import { useChatVisualHost } from './chat-visual-host';
import { TurnAgentArtifacts } from './agent-activity/TurnAgentArtifacts';

/**
 * Renders one {@link PortalChatTurnGroup}: the user prompt, the collapsed
 * "intermediate" tool/thinking steps behind a {@link CollapsedTurnSummary} chip
 * (expandable), then the inline "final" assistant messages. Mirrors the desktop
 * `TurnGroupRenderer` / web collapsed-turn UX over the neutral store types.
 *
 * Messages are looked up by id from `messagesById` (the transcript owns the
 * flat message map); ids that are not present are skipped.
 */
export interface TurnGroupViewProps {
  readonly turnGroup: PortalChatTurnGroup;
  readonly messagesById: Readonly<Record<string, PortalChatMessage>>;
  readonly appIcon?: ReactNode;
  /**
   * Turn-level thumbs up/down control (CAN-1521), rendered at the foot of the
   * turn beside its completion stamp. Omitted when the host does not report
   * the `turnFeedback` capability, so an unwired host renders nothing rather
   * than throwing on dispatch.
   */
  readonly feedbackSlot?: ReactNode;
  /** Optional host-owned action rendered at the foot of this turn. */
  readonly actionSlot?: ReactNode;
  /**
   * The transcript's fallback working indicator, for the send→timer gap on the
   * last turn only. It renders exactly where this turn's `turn_timer` row would
   * (after the finals, before {@link actionSlot}) so the indicator does not move
   * when the real timer frame arrives and takes over.
   */
  readonly workingSlot?: ReactNode;
  /**
   * Whether this is the newest turn. Under the clean chat look its reply row
   * stays in view, as ChatGPT does; older rows show on hover or focus.
   */
  readonly latest?: boolean;
}

/**
 * Map the `*Count` wire summary onto the ui-shared camelCase {@link TurnSummary}.
 * Note: `TurnSummary.appAdvisor` / `pipelineEditor` are intentionally unset —
 * the shared protocol summary folds those tool families into `otherCount`, so
 * they render in the generic "other" chip. Add mappings here if the wire summary
 * grows dedicated count fields.
 */
function toTurnSummary(
  summary: NonNullable<PortalChatTurnGroup['summary']>,
  intermediates: readonly PortalChatMessage[],
): TurnSummary {
  const displaySummary: TurnSummary = {
    thinking: summary.thinkingCount,
    messages: summary.messageCount,
    bash: summary.bashCount,
    read: summary.readCount,
    edit: summary.editCount,
    write: summary.writeCount,
    plan: summary.planCount,
    grep: summary.grepCount,
    glob: summary.globCount,
    todo: summary.todoCount,
    web: summary.webCount,
    agent: summary.agentCount,
    askUser: summary.askUserCount,
    scriptOutput: summary.scriptOutputCount,
    claude: summary.claudeCount,
    watcher: summary.watcherCount,
    canopy: summary.canopyCount,
    graph: summary.graphCount,
    computerUse: summary.computerUseCount,
    other: summary.otherCount,
  };
  if (!summary.bashCount) return displaySummary;
  for (const message of intermediates) {
    for (const part of normalizeChatMessageParts(message.parts ?? [])) {
      if (part.kind !== 'tool_use' || part.toolFamily !== 'bash') continue;
      const data = isRecord(part.data) ? part.data : {};
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      const input =
        typeof data.input === 'string'
          ? data.input
          : JSON.stringify(data.input ?? '');
      const family = getToolDisplayFamily(toolName, input, part.toolFamily);
      if (family !== 'read' && family !== 'skill') continue;
      displaySummary.bash = Math.max(0, (displaySummary.bash ?? 0) - 1);
      const key = family === 'read' ? 'read' : 'other';
      displaySummary[key] = (displaySummary[key] ?? 0) + 1;
    }
  }
  return displaySummary;
}

function lookup(
  ids: readonly string[],
  messagesById: Readonly<Record<string, PortalChatMessage>>,
): PortalChatMessage[] {
  return ids
    .map((id) => messagesById[id])
    .filter((message): message is PortalChatMessage => message !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAskUserMatch(message: PortalChatMessage): {
  toolUseId?: string;
  questionTexts?: string[];
} | null {
  for (const part of normalizeChatMessageParts(message.parts ?? [])) {
    if (part.kind !== 'tool_use') continue;
    const data = isRecord(part.data) ? part.data : {};
    const toolName =
      typeof data.toolName === 'string'
        ? data.toolName
        : typeof data.name === 'string'
          ? data.name
          : '';
    if (!isAskUserQuestionToolName(toolName)) continue;
    const rawInput = data.input;
    const input =
      typeof rawInput === 'string'
        ? rawInput
        : rawInput === undefined
          ? undefined
          : JSON.stringify(rawInput);
    const toolUseId =
      typeof data.toolUseId === 'string'
        ? data.toolUseId
        : typeof data.tool_use_id === 'string'
          ? data.tool_use_id
          : undefined;
    const questionTexts = input ? parseAskUserQuestionTexts(input) : undefined;
    return {
      ...(toolUseId ? { toolUseId } : {}),
      ...(questionTexts ? { questionTexts } : {}),
    };
  }
  return null;
}

/** A message that only carries the turn's completion stamp. */
function isTimerOnly(message: PortalChatMessage): boolean {
  const parts = message.parts ?? [];
  return (
    message.text.trim().length === 0 &&
    parts.length > 0 &&
    parts.every((part) => part.kind === 'turn_timer')
  );
}

/**
 * Whether a timer-only message renders a timer row. A settled message whose
 * timer never completed is an interrupted turn, and ChatPartView renders
 * nothing for it.
 */
function rendersTimerRow(message: PortalChatMessage): boolean {
  return (
    message.status === 'streaming' ||
    (message.parts ?? []).some(
      (part) =>
        part.kind === 'turn_timer' &&
        isRecord(part.data) &&
        typeof part.data.completedAt === 'number',
    )
  );
}

function hasFoldableContent(message: PortalChatMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    (message.parts ?? []).some((part) => part.kind !== 'turn_timer')
  );
}

function TurnGroupViewImpl({
  turnGroup,
  messagesById,
  appIcon,
  feedbackSlot,
  actionSlot,
  workingSlot,
  latest = false,
}: TurnGroupViewProps): JSX.Element {
  const complete = turnGroup.complete === true;
  const [collapsed, setCollapsed] = useState(complete);
  const wasComplete = useRef(complete);
  const askUserInteraction = useAskUserQuestionInteraction();
  const visualHost = useChatVisualHost();

  const user = messagesById[turnGroup.userMessageId];
  const intermediates = lookup(turnGroup.intermediateMessageIds, messagesById);
  const finals = lookup(turnGroup.finalMessageIds, messagesById);
  const expandedMessages = lookup(
    turnGroup.expandedMessageIds ?? [
      ...turnGroup.intermediateMessageIds,
      ...turnGroup.finalMessageIds,
    ],
    messagesById,
  );
  // Receipts may sit on any assistant row of the turn, folded or not, so the
  // tiles read every intermediate and final message in order.
  const assistantMessages = useMemo(
    () =>
      lookup(
        [...turnGroup.intermediateMessageIds, ...turnGroup.finalMessageIds],
        messagesById,
      ),
    [turnGroup.intermediateMessageIds, turnGroup.finalMessageIds, messagesById],
  );
  // The completion stamp closes the turn, so the capability tiles sit above
  // it, as they do on desktop.
  const lastFinal = finals[finals.length - 1];
  const trailingTimer =
    lastFinal !== undefined && isTimerOnly(lastFinal) ? lastFinal : undefined;
  const summary: TurnSummary = turnGroup.summary
    ? toTurnSummary(turnGroup.summary, intermediates)
    : {};
  const foldable = complete && intermediates.some(hasFoldableContent);
  useEffect(() => {
    if (!wasComplete.current && complete) {
      setCollapsed(true);
    }
    wasComplete.current = complete;
  }, [complete]);
  // A pending projected question must remain visible without asking the user
  // to discover it inside the collapsed agent-steps row. Match the
  // intermediate transcript block using the same Claude/Codex rules as the
  // card renderer.
  // Only an UNANSWERED projection forces the turn open — that is the card the
  // user must not miss. Answered projections exist to converge the tool row
  // to its read-only answered state (CAN-2608 retains them indefinitely for
  // App Advisor), and pinning those turns expanded forever would make every
  // historical question turn non-collapsible.
  const hasProjectedAskUser =
    askUserInteraction !== null &&
    intermediates.some((message) => {
      const match = readAskUserMatch(message);
      return (
        match !== null &&
        matchAskUserQuestionState(askUserInteraction.states, match, {
          answered: false,
        }) !== undefined
      );
    });
  const isExpanded = !collapsed || hasProjectedAskUser;
  const showTrailingTimer =
    trailingTimer !== undefined &&
    (!foldable || !isExpanded || expandedMessages.includes(trailingTimer));
  // The actions and thumbs ride in the timer row only when it renders.
  const inTimerRow =
    showTrailingTimer &&
    trailingTimer !== undefined &&
    rendersTimerRow(trailingTimer);
  const feedback = feedbackSlot ? (
    <span data-testid="chat-turn-feedback">{feedbackSlot}</span>
  ) : undefined;
  const timerMessages = [...intermediates, ...finals].filter((message) =>
    message.parts?.some((part) => part.kind === 'turn_timer'),
  );
  const timerMessage =
    timerMessages[timerMessages.length - 1] ?? finals[finals.length - 1];
  const timerData = timerMessage?.parts?.find(
    (part) => part.kind === 'turn_timer',
  )?.data;
  const endReason = isRecord(timerData) ? timerData.endReason : undefined;
  const outcome =
    endReason === 'failed' || endReason === 'cancelled'
      ? endReason
      : timerMessage?.status === 'failed' ||
          timerMessage?.status === 'cancelled'
        ? timerMessage.status
        : undefined;
  // Clean chat look: the turn opens with "Working for 28s" and, once done,
  // its folded steps' header reads "Worked for 3m 24s"; while a step on
  // screen shimmers, the timer row stays quiet.
  const clean = useCleanChatLook();
  const timer = readTurnHeaderTimer(timerData);
  // The reply's Copy button copies the answer, or every reply text when the
  // turn has no final message, under either chat look (CAN-4704).
  const textOf = (messages: readonly PortalChatMessage[]): string =>
    messages
      .map(replyTextOf)
      .filter((text) => text.trim() !== '')
      .join('\n\n');
  const replyCopyText = textOf(finals) || textOf(intermediates);
  const shownMessages = [...intermediates, ...finals].filter(
    (message) => message !== trailingTimer,
  );
  const lastParts = shownMessages[shownMessages.length - 1]?.parts ?? [];
  const lastPart = lastParts[lastParts.length - 1];
  const liveStepShown =
    clean &&
    !complete &&
    lastPart !== undefined &&
    ((lastPart.kind === 'tool_use' && !hasToolResult(lastPart.data)) ||
      lastPart.kind === 'thinking');
  const fallbackCopy =
    complete && replyCopyText.trim() !== '' ? (
      <ChatCopyAction
        key={turnGroup.userMessageId}
        text={replyCopyText}
        dataTestId="turn-copy-message"
      />
    ) : undefined;
  const actions = actionSlot ? (
    <TurnFooterReveal
      completed={complete}
      completionStatus={outcome}
      // Clean chat look: the newest reply's whole row stays in view.
      alwaysVisible={clean && latest}
      data-testid="chat-turn-action-slot"
    >
      {actionSlot}
    </TurnFooterReveal>
  ) : undefined;

  return (
    // `group/turn` scopes the hover/focus reveal of this turn's footer
    // (CAN-4278) and feedback control (CAN-1521), matching the desktop
    // per-turn wrapper.
    // Clean chat look: the desktop turn's 8px rhythm, with more room under
    // the prompt than between steps.
    <div
      className={`group/turn ${clean ? 'space-y-2' : 'space-y-1'}`}
      data-testid="chat-turn-group"
    >
      {user && <ChatMessageView message={user} appIcon={appIcon} />}
      {clean && user ? <div aria-hidden="true" className="h-2.5" /> : null}

      {clean && !complete && (
        <TurnWorkHeader
          startedAt={timer.startedAt}
          finishedAt={null}
          pausedAt={timer.pausedAt}
          resumedAt={timer.resumedAt}
          accumulatedPausedDurationMs={timer.accumulatedPausedDurationMs}
          live
          dataTestId="turn-work-header"
        />
      )}

      {intermediates.length > 0 &&
        (foldable ? (
          <>
            <CollapsedTurnSummary
              summary={summary}
              isExpanded={isExpanded}
              onToggle={() => setCollapsed((value) => !value)}
              appIcon={appIcon}
              hideLeadingLabel
              completionStatus={outcome}
              dataTestId="chat-turn-summary"
              {...(timer.elapsedMs === undefined
                ? {}
                : { elapsedMs: timer.elapsedMs })}
            />
            {isExpanded &&
              expandedMessages
                .filter((message) => message !== trailingTimer)
                .map((message) => (
                  <ChatMessageView
                    key={message.messageId}
                    message={message}
                    appIcon={appIcon}
                  />
                ))}
            {!isExpanded &&
              visualHost &&
              intermediates.flatMap((message) =>
                (message.parts ?? []).flatMap((part, index) => {
                  const owner =
                    part.kind === 'tool_result'
                      ? readChatToolResultVisual(part.data, message.messageId)
                      : undefined;
                  return owner
                    ? [
                        <ChatVisualBlock
                          key={`${message.messageId}-${index}`}
                          owner={owner}
                          variant="visual-only"
                        />,
                      ]
                    : [];
                }),
              )}
          </>
        ) : (
          intermediates.map((message) => (
            <ChatMessageView
              key={message.messageId}
              message={message}
              appIcon={appIcon}
            />
          ))
        ))}

      {(!foldable || !isExpanded) &&
        finals
          .filter((message) => message !== trailingTimer)
          .map((message) => (
            <ChatMessageView
              key={message.messageId}
              message={message}
              appIcon={appIcon}
            />
          ))}

      <TurnAgentArtifacts messages={assistantMessages} />

      {showTrailingTimer && (
        <ChatMessageView
          key={trailingTimer.messageId}
          message={trailingTimer}
          appIcon={appIcon}
          {...(inTimerRow
            ? {
                turnTimerStampAccessory: feedback,
                // Like desktop, the turn actions follow the elapsed label.
                turnTimerTrailing: actions,
              }
            : {})}
          // ChatTranscript separates turns with an 8px column gap. Only the
          // turn's last row borders that gap; a row below keeps the full margin.
          turnTimerHostTurnGap={workingSlot == null}
          turnTimerLiveStatusShown={liveStepShown}
          // Copy rides in the timer row only when it renders; otherwise the
          // actions row below carries it, so a reply never shows two.
          {...(inTimerRow && complete
            ? { turnTimerCopyText: replyCopyText }
            : {})}
          {...(clean && latest ? { turnTimerAlwaysVisible: true } : {})}
        />
      )}

      {workingSlot}

      {/* Without a timer row, Copy, the actions and thumbs get a row of
          their own. */}
      {!inTimerRow && (actions || feedback || fallbackCopy) && (
        <TurnFooterRow variant="actions" data-testid="chat-turn-actions">
          {clean ? (
            // Copy stays visible; the remaining clean actions reveal together.
            <>
              {fallbackCopy}
              <TurnFooterReveal completed={complete} completionStatus={outcome}>
                <span className="flex items-center gap-0.5">
                  {feedback}
                  {actions}
                </span>
              </TurnFooterReveal>
            </>
          ) : (
            <>
              {actions}
              {/* Copy and the thumbs stay visible at rest, like the
                  completion stamp. */}
              {fallbackCopy}
              {feedback}
            </>
          )}
        </TurnFooterRow>
      )}
    </div>
  );
}

/** A reply's text: its whole-message text, or else its text parts. */
function replyTextOf(message: PortalChatMessage): string {
  if (message.text.trim() !== '') return message.text;
  return (message.parts ?? [])
    .flatMap((part) => {
      const data: unknown = part.data;
      return part.kind === 'text' &&
        typeof data === 'object' &&
        data !== null &&
        'text' in data &&
        typeof data.text === 'string'
        ? [data.text]
        : [];
    })
    .join('\n\n');
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** A turn timer part's times, as the clean chat look's header reads them. */
function readTurnHeaderTimer(data: unknown): {
  startedAt?: number;
  pausedAt?: number;
  resumedAt?: number;
  accumulatedPausedDurationMs?: number;
  elapsedMs?: number;
} {
  if (!isRecord(data)) return {};
  const startedAt = readNumber(data.startedAt);
  const completedAt = readNumber(data.completedAt);
  const pausedAt = readNumber(data.pausedAt);
  const resumedAt = readNumber(data.resumedAt);
  const pausedMs = readNumber(data.accumulatedPausedDurationMs);
  // The classic timer's math, so a saved pause without a total still counts.
  const elapsedSecond =
    completedAt === undefined
      ? null
      : getElapsedSecond(startedAt, completedAt, pausedAt, resumedAt, pausedMs);
  return {
    startedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs: pausedMs,
    elapsedMs: elapsedSecond === null ? undefined : elapsedSecond * 1000,
  };
}

/** Whether a tool call part already carries its result. */
function hasToolResult(data: unknown): boolean {
  return isRecord(data) && data.result !== undefined && data.result !== null;
}

/** Memoized so settled turn groups skip re-render during streaming (CLAUDE.md). */
export const TurnGroupView = memo(TurnGroupViewImpl);
