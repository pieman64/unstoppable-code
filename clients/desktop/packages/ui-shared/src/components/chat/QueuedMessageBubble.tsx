import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import {
  AgentSentTitle,
  type AgentSentReceivingContext,
} from './AgentSentTitle';
import { useAgentSentReceivingContext } from './AgentSentReceivingContext';
import { memo, type JSX, type ReactNode } from 'react';
import { SteerIcon, TrashIcon } from '../../icons';
import { StopIcon } from '../../icons/AppIcons';
import {
  BUBBLE_ACTION_BADGE_DESTRUCTIVE_CLASS,
  BUBBLE_PILL_ACTION_CLASS,
} from '../bubble-badge';
import { ActionTooltip } from '../ActionTooltip';
import { hostMessagePresentation } from './SteeringRequestTitle';
import {
  MessageEditBadge,
  MessageEditSurface,
  type MessageEditHandler,
} from './MessageEditEntry';

export const QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP =
  'This message changes agent capabilities. Interrupt the active turn to send it immediately, or wait for the turn to finish.';
export const QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE =
  'Steering unavailable';

export interface QueuedMessageBubbleMessage {
  readonly agentSent?: AgentSentInfo;
  readonly id: string;
  readonly text: string;
  readonly editLocked?: boolean;
  /** The host cannot hold the row while editing, so double-click stays off. */
  readonly editLockAdvisory?: boolean;
  readonly forceLocked?: boolean;
  readonly steerBlockedByCapabilityChange?: boolean;
}

export interface QueuedMessageBubbleProps {
  readonly receivingContext?: AgentSentReceivingContext;
  readonly message: QueuedMessageBubbleMessage;
  /** Optional attachment rendered above the bubble surface. */
  readonly attachment?: ReactNode;
  readonly onCancel?: () => void;
  /** Opens the editor from the Edit badge or a double-click on the bubble. */
  readonly onEdit?: MessageEditHandler;
  readonly onForce?: () => void;
  readonly onSteer?: () => void;
  readonly steeringSupported?: boolean;
}

export const QueuedMessageBubble = memo(function QueuedMessageBubble({
  message,
  receivingContext: explicitContext,
  attachment,
  onCancel,
  onEdit,
  onForce,
  onSteer,
  steeringSupported = false,
}: QueuedMessageBubbleProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  // A delegate's steering request or a fired watcher arrives as a hidden
  // instruction block; show its readable part under its title instead.
  const steeringRequest = hostMessagePresentation(message.text);
  const paragraphs = (steeringRequest?.text ?? message.text).split(/\n{2,}/);
  const showDisabledSteer =
    steeringSupported && message.steerBlockedByCapabilityChange === true;
  const editHandler = message.editLocked ? undefined : onEdit;
  return (
    <div className="flex justify-end" data-testid="queued-message-bubble">
      {/*
        `min-w-0` is load-bearing: as a flex item this bubble's automatic
        minimum size is its content's min-content width, so a single
        unbreakable token (a pasted URL) would size the box wider than the
        row and `justify-end` would push the excess off the panel's left
        edge. The inner `break-words` can only wrap once the box is
        constrained.
      */}
      <div className="group relative min-w-0 max-w-full">
        {attachment ? (
          <div className="mb-1 flex justify-end" data-no-double-click-edit>
            {attachment}
          </div>
        ) : null}
        <MessageEditSurface
          onEdit={message.editLockAdvisory ? undefined : editHandler}
          variant="draft"
          tone={steeringRequest?.variant === 'info' ? 'info' : 'default'}
        >
          {onEdit || onCancel ? (
            <div className="absolute -right-2 -top-2 z-10 flex gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              {editHandler ? (
                <MessageEditBadge
                  testId="queued-message-edit"
                  label="Edit queued message"
                  onEdit={editHandler}
                />
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  data-testid="queued-message-cancel"
                  onClick={onCancel}
                  className={BUBBLE_ACTION_BADGE_DESTRUCTIVE_CLASS}
                  aria-label="Clear queued message"
                >
                  <TrashIcon width={14} height={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="mb-1 text-3xs fg-secondary">Queued</div>
          {message.agentSent && (
            <AgentSentTitle
              agentSent={message.agentSent}
              receivingContext={receivingContext}
            />
          )}
          {steeringRequest?.title}
          <div className="break-words">
            {paragraphs.map((paragraph, index) => (
              <p
                key={`${message.id}-${index}`}
                className={
                  index === 0
                    ? 'whitespace-pre-wrap'
                    : 'mt-2 whitespace-pre-wrap'
                }
              >
                {paragraph}
              </p>
            ))}
          </div>
        </MessageEditSurface>
        {((onSteer || showDisabledSteer) && !message.editLocked) ||
        (onForce && !(message.forceLocked ?? message.editLocked)) ? (
          <div className="mt-1 flex justify-end gap-2">
            {(onSteer || showDisabledSteer) && !message.editLocked && (
              <ActionTooltip
                title={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE}
                description={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP}
                disabled={!showDisabledSteer}
              >
                <button
                  type="button"
                  onClick={onSteer}
                  disabled={showDisabledSteer}
                  aria-description={
                    showDisabledSteer
                      ? QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP
                      : undefined
                  }
                  data-testid="queued-message-steer"
                  className={BUBBLE_PILL_ACTION_CLASS}
                >
                  <SteerIcon
                    data-testid="queued-message-steer-icon"
                    className="-my-1"
                  />
                  Steer
                </button>
              </ActionTooltip>
            )}
            {onForce && !(message.forceLocked ?? message.editLocked) && (
              <button
                type="button"
                data-testid="queued-message-interrupt"
                onClick={onForce}
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
        ) : null}
      </div>
    </div>
  );
});
