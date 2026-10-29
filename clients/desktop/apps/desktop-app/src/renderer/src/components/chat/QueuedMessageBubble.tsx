import {
  AgentSentTitle,
  useAgentSentReceivingContext,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import { memo, useCallback, type JSX } from 'react';
import { ScheduleIcon, SteerIcon } from '@canopy/ui-shared/icons';
import { TrashIcon as AppCatalogTrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import { StopIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  BUBBLE_ACTION_BADGE_CLASS,
  BUBBLE_ACTION_BADGE_DESTRUCTIVE_CLASS,
  BUBBLE_PILL_ACTION_CLASS,
  MessageEditBadge,
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP,
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE,
  ActionTooltip,
  steeringRequestPresentation,
  MessageEditSurface,
} from '@canopy/ui-shared/components';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { MessageCopyButton } from './MessageCopyButton';
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
  onForce?: (index: number) => void;
  onSteer?: (index: number) => void;
  steeringSupported?: boolean;
  /**
   * Opens the editor. `message` identifies the target so the store can
   * resolve it again if the queue advanced since this bubble rendered.
   */
  onEdit?: (index: number, message: QueuedChatMessage) => void;
  canForce?: boolean;
  /**
   * When true, the message is queued because the worktree's two-phase
   * creation (`setupPhase === 'git-pending'`) is still running — show a
   * more specific label than the generic "Queued" used during streaming.
   */
  queuedForSetup?: boolean;
  /**
   * True when any queued message in this tab is currently being edited
   * inline. Hides the Interrupt button so the user can't bypass the queue while
   * an edit is pending.
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
  onSteer,
  steeringSupported = false,
  onEdit,
  canForce = false,
  queuedForSetup = false,
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

  const getCopyText = useCallback((): string => {
    const lines = [
      ...(message.fileReferences?.map((file) => `@${file.displayPath}`) ?? []),
      ...(message.attachmentPaths?.map((p) => `[attachment: ${p}]`) ?? []),
      visibleText,
    ].filter(Boolean);
    return lines.join('\n');
  }, [message, visibleText]);

  const handleForce = useCallback((): void => {
    if (scheduled) {
      scheduled.onInterrupt();
      return;
    }
    onForce?.(index);
  }, [index, onForce, scheduled]);

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
    ? true
    : !message.pendingSend &&
      !message.editLocked &&
      Boolean(onEdit) &&
      message.queuedHookQueueId === undefined &&
      !anyEditing;
  const showInterrupt = isScheduled
    ? true
    : !message.pendingSend && Boolean(canForce && onForce) && !anyEditing;
  const showDisabledSteer =
    steeringSupported && message.steerBlockedByCapabilityChange === true;

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
          <div className="absolute -right-2 -top-2 z-10 flex gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
            <MessageCopyButton
              getText={getCopyText}
              className={BUBBLE_ACTION_BADGE_CLASS}
            />
            {showEdit && (
              <MessageEditBadge
                testId="queued-message-edit"
                label={
                  isScheduled ? 'Edit scheduled message' : 'Edit queued message'
                }
                onEdit={handleEdit}
              />
            )}
            <button
              type="button"
              data-testid="queued-message-cancel"
              disabled={message.pendingSend === true}
              onClick={handleClear}
              className={BUBBLE_ACTION_BADGE_DESTRUCTIVE_CLASS}
              aria-label={
                isScheduled ? 'Clear scheduled message' : 'Clear queued message'
              }
            >
              <AppCatalogTrashIcon width="14" height="14" />
            </button>
          </div>
          {isScheduled ? (
            <div
              data-testid="scheduled-message-send-label"
              className="mb-1 flex items-center gap-1 text-3xs fg-secondary"
            >
              <ScheduleIcon width={11} height={11} className="shrink-0" />
              <span>
                {scheduledLabel ? `Sends ${scheduledLabel}` : 'Scheduled'}
              </span>
            </div>
          ) : (
            <>
              <div className="mb-1 text-3xs fg-secondary">Queued</div>
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
                Prefer the per-message reason (hook-chat queue path); otherwise
                surface the setup-queue reason when applicable. When neither is
                present, no reason row is rendered (preserves the streaming-queue
                look).
              */}
              {(message.reason ??
                (queuedForSetup
                  ? 'Worktree setup is still running.'
                  : null)) && (
                <div className="mb-1 text-3xs fg-secondary">
                  {message.reason ??
                    (queuedForSetup
                      ? 'Worktree setup is still running.'
                      : null)}
                </div>
              )}
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
        {(showInterrupt || onSteer || showDisabledSteer) && (
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            {(onSteer || showDisabledSteer) && !anyEditing && (
              <ActionTooltip
                title={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE}
                description={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP}
                disabled={!showDisabledSteer}
              >
                <button
                  type="button"
                  className={BUBBLE_PILL_ACTION_CLASS}
                  data-testid="queued-message-steer"
                  disabled={showDisabledSteer}
                  aria-description={
                    showDisabledSteer
                      ? QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP
                      : undefined
                  }
                  onClick={() => onSteer?.(index)}
                >
                  <SteerIcon
                    data-testid="queued-message-steer-icon"
                    className="-my-1"
                  />
                  Steer
                </button>
              </ActionTooltip>
            )}
            {showInterrupt && (
              <button
                type="button"
                data-testid="queued-message-interrupt"
                onClick={handleForce}
                disabled={isScheduled ? scheduled?.running === true : false}
                className={BUBBLE_PILL_ACTION_CLASS}
              >
                <StopIcon
                  data-testid="queued-message-interrupt-icon"
                  width={16}
                  height={16}
                  className="-my-1"
                />
                Interrupt
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
