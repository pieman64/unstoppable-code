import {
  AgentSentTitle,
  useAgentSentReceivingContext,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import { memo, useCallback, type JSX } from 'react';
import type {
  ChatTurnPhase,
  SettingsHeldChange,
} from '@canopy/desktop-shared/types';
import {
  QUEUED_MESSAGE_LABEL_CLASS,
  QueuedMessageActions,
  QueuedMessageReason,
} from '@canopy/ui-shared';
import { ScheduleIcon } from '@canopy/ui-shared/icons';
import {
  BubbleCopyBadge,
  steeringRequestPresentation,
  MessageEditSurface,
} from '@canopy/ui-shared/components';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { MessageAttachments } from './MessageAttachments';
import { WatcherFiredTitle } from './WatcherFiredTitle';
import { CollapsibleUserMessageContent } from './CollapsibleUserMessageContent';
import { formatScheduledSendLabel } from '@/lib/worktreeSessionPromptAutomations';
import {
  SUBAGENT_REFERENCE_PREFIX,
  SubagentReferenceAttachment,
  splitSubagentReference,
} from '@canopy/ui-shared/components';

/**
 * Scheduled-message descriptor. When present, the bubble renders the derived
 * one-time `worktree_session_prompt` scheduled-send variant (a single
 * "Sends 6:00 PM" row over the prompt, clamped like a sent message) and routes
 * Edit/Clear/Interrupt to the automation-backed handlers rather than the
 * chat-queue handlers. Recurring automations never render as a bubble; they
 * surface as `ScheduledAutomationsNotice` above the composer.
 */
export interface ScheduledMessageBubbleDescriptor {
  automationId: string;
  activityName: string;
  scheduledAt: string;
  /** While true, the Interrupt action is mid-flight (runNow + disable). */
  running?: boolean;
  onEdit: () => void;
  onClear: () => void;
  onInterrupt: () => void;
}

interface QueuedMessageBubbleProps {
  receivingContext?: AgentSentReceivingContext;
  message: QueuedChatMessage;
  index: number;
  onClear: (index: number) => void;
  /** Interrupt: stops the running turn so this message sends now. */
  onForce?: (index: number) => void;
  /** Retry a send that failed, for example a Claude terminal launch. */
  onRetry?: (index: number) => void;
  /** Start a message that waits on something other than a running turn. */
  onRunNow?: (index: number) => void;
  onSteer?: (index: number) => void;
  steeringSupported?: boolean;
  /** Settings that wait for live background work; see `QueuedMessageActions`. */
  settingsHeld?: readonly SettingsHeldChange[];
  /**
   * Opens the editor. `message` identifies the target so the store can
   * resolve it again if the queue advanced since this bubble rendered.
   */
  onEdit?: (index: number, message: QueuedChatMessage) => void;
  /** Head-row gate for Interrupt, Retry and Run now. */
  canForce?: boolean;
  /**
   * Host-reported turn phase of the chat. Steer and Interrupt render only in
   * `foreground`; `undefined` keeps the pre-phase rule for older hosts.
   */
  turnPhase?: ChatTurnPhase;
  /**
   * True when a queued or scheduled message in this tab is being edited (in
   * the composer's place). Hides Edit, since only one editor can be open, and
   * a queued row's Interrupt so the user can't bypass the queue while an edit
   * is pending.
   */
  anyEditing?: boolean;
  /**
   * When provided, render the scheduled-automation variant of the bubble and
   * route actions to the automation handlers instead of the chat queue.
   */
  scheduled?: ScheduledMessageBubbleDescriptor;
}

export const QueuedMessageBubble = memo(function QueuedMessageBubble({
  message,
  receivingContext: explicitContext,
  index,
  onClear,
  onForce,
  onRetry,
  onRunNow,
  onSteer,
  steeringSupported = false,
  settingsHeld,
  onEdit,
  canForce = false,
  turnPhase,
  anyEditing = false,
  scheduled,
}: QueuedMessageBubbleProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  const agentSent = message.agentSent ?? message.dispatchOptions?.agentSent;
  const referenceSplit = message.text.startsWith(
    `${SUBAGENT_REFERENCE_PREFIX} `,
  )
    ? splitSubagentReference(message.text)
    : null;
  const attachedSubagentReference = referenceSplit?.reference
    ? { title: referenceSplit.reference.title, body: referenceSplit.body }
    : null;
  // A delegate's steering request arrives as a hidden instruction block; show
  // the request and its sender instead.
  const steeringRequest = steeringRequestPresentation(message.text);
  const visibleText =
    steeringRequest?.text ?? attachedSubagentReference?.body ?? message.text;
  const paragraphs = visibleText.split(/\n{2,}/);
  const isScheduled = scheduled !== undefined;
  // Host-mirror rows carry the marker directly; renderer-local rows carry it
  // inside their queued dispatch options.
  const watcherFired =
    message.watcherFired ?? message.dispatchOptions?.watcherFired;

  const copyText = [
    ...(message.fileReferences?.map((file) => `@${file.displayPath}`) ?? []),
    ...(message.attachmentPaths?.map((p) => `[attachment: ${p}]`) ?? []),
    visibleText,
  ]
    .filter(Boolean)
    .join('\n');

  const handleForce = useCallback((): void => {
    if (scheduled) {
      scheduled.onInterrupt();
      return;
    }
    onForce?.(index);
  }, [index, onForce, scheduled]);

  const handleRetry = useCallback((): void => {
    onRetry?.(index);
  }, [index, onRetry]);

  const handleRunNow = useCallback((): void => {
    onRunNow?.(index);
  }, [index, onRunNow]);

  const handleSteer = useCallback((): void => {
    onSteer?.(index);
  }, [index, onSteer]);

  const handleEdit = useCallback((): void => {
    if (scheduled) {
      scheduled.onEdit();
      return;
    }
    onEdit?.(index, message);
  }, [index, message, onEdit, scheduled]);

  const handleClear = useCallback((): void => {
    if (scheduled) {
      scheduled.onClear();
      return;
    }
    onClear(index);
  }, [index, onClear, scheduled]);

  const scheduledLabel = scheduled
    ? formatScheduledSendLabel(scheduled.scheduledAt)
    : null;

  const messageParagraphs = (
    <div className="break-words">
      {paragraphs.map((paragraph, paragraphIndex) => (
        <p
          key={`${index}-${paragraphIndex}`}
          className={
            paragraphIndex === 0
              ? 'whitespace-pre-wrap'
              : 'mt-2 whitespace-pre-wrap'
          }
        >
          {paragraph}
        </p>
      ))}
    </div>
  );

  const showEdit = isScheduled
    ? !anyEditing
    : !message.pendingSend &&
      !message.editLocked &&
      Boolean(onEdit) &&
      message.queuedHookQueueId === undefined &&
      !anyEditing;
  const showInterrupt = isScheduled
    ? true
    : !message.pendingSend && Boolean(canForce && onForce) && !anyEditing;
  // The scheduled variant keeps its own Interrupt (run now) action.
  const showRetry = !isScheduled && canForce && Boolean(onRetry);
  const showRunNow = !isScheduled && canForce && Boolean(onRunNow);

  return (
    <div
      className={
        attachedSubagentReference
          ? 'flex flex-col items-end'
          : 'flex justify-end'
      }
      data-testid="queued-message-bubble"
    >
      {attachedSubagentReference ? (
        <SubagentReferenceAttachment title={attachedSubagentReference.title} />
      ) : null}
      {/*
        `min-w-0` is load-bearing: as a flex item this bubble's automatic
        minimum size is its content's min-content width, so a single
        unbreakable token (a pasted URL) would size the box wider than the
        row and `justify-end` would push the excess off the panel's left
        edge, where the transcript viewport's overflow-x-hidden clips it.
        The inner `break-words` can only wrap once the box is constrained.
      */}
      <div className="group relative min-w-0 max-w-full">
        <MessageEditSurface
          onEdit={showEdit ? handleEdit : undefined}
          tone={
            watcherFired || steeringRequest?.variant === 'info'
              ? 'info'
              : 'default'
          }
        >
          <QueuedMessageActions
            placement="corner"
            variant="badge"
            cornerLeading={
              <BubbleCopyBadge copyText={copyText} label="Copy to clipboard" />
            }
            onEdit={showEdit ? handleEdit : undefined}
            onCancel={handleClear}
            pending={message.pendingSend === true}
            editLabel={
              isScheduled ? 'Edit scheduled message' : 'Edit queued message'
            }
            cancelLabel={
              isScheduled ? 'Clear scheduled message' : 'Clear queued message'
            }
          />
          {isScheduled ? (
            <div
              data-testid="scheduled-message-send-label"
              className="mb-1 flex items-center gap-1 text-xs fg-secondary"
            >
              <ScheduleIcon width={11} height={11} className="shrink-0" />
              <span>
                {scheduledLabel ? `Sends ${scheduledLabel}` : 'Scheduled'}
              </span>
            </div>
          ) : (
            <>
              <div className={QUEUED_MESSAGE_LABEL_CLASS}>Queued</div>
              {agentSent && (
                <AgentSentTitle
                  agentSent={agentSent}
                  receivingContext={receivingContext}
                />
              )}
              {watcherFired ? (
                <WatcherFiredTitle watcherFired={watcherFired} />
              ) : (
                steeringRequest?.title
              )}
              {/*
                Prefer the per-message reason (hook-chat queue path), then the
                host's waiting reason. With none, no reason row renders (the
                streaming-queue look).
              */}
              {message.reason ? (
                <QueuedMessageReason reason={message.reason} />
              ) : message.waitingReason !== undefined ? (
                <QueuedMessageReason waitingReason={message.waitingReason} />
              ) : null}
            </>
          )}
          {isScheduled ? (
            // Same clamp as the sent bubble: a long scheduled prompt shows
            // three rows and a fade instead of taking over the transcript.
            <CollapsibleUserMessageContent>
              {messageParagraphs}
            </CollapsibleUserMessageContent>
          ) : (
            messageParagraphs
          )}
        </MessageEditSurface>
        <MessageAttachments attachmentPaths={message.attachmentPaths} />
        <QueuedMessageActions
          placement="footer"
          variant="badge"
          turnPhase={isScheduled ? undefined : turnPhase}
          onSteer={onSteer ? handleSteer : undefined}
          onInterrupt={showInterrupt ? handleForce : undefined}
          onRetry={showRetry ? handleRetry : undefined}
          onRunNow={showRunNow ? handleRunNow : undefined}
          // Like Retry, only the head row explains a hold.
          retryBlockedReason={
            !isScheduled && canForce ? message.retryBlockedReason : undefined
          }
          steeringSupported={steeringSupported}
          steerBlockedByCapabilityChange={
            message.steerBlockedByCapabilityChange
          }
          // A row behind a turn its worktree's setup holds keeps Edit and
          // Clear; Run now waits for that turn.
          forceLocked={
            !isScheduled && message.forceLocked === true ? true : undefined
          }
          settingsHeld={isScheduled ? undefined : settingsHeld}
          pending={!isScheduled && message.pendingSend === true}
          anyEditing={!isScheduled && anyEditing}
          interruptDisabled={scheduled?.running === true}
        />
      </div>
    </div>
  );
});
