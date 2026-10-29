import { memo, type JSX } from 'react';
import { subordinateSteeringRequest } from '@canopy/agent-transcript';
import { SubagentIcon } from './subagents/common/SubagentIcon';
import { watcherFiredPresentation } from './WatcherFiredTitle';
import {
  SUBAGENT_STEERING_REQUEST_LABEL,
  subagentSteeringRequestFromLabel,
} from './subagents/subagent-copy';

interface SteeringRequestTitleProps {
  /** The requesting delegate's task description, when the request names it. */
  requestedBy?: string;
}

/**
 * Title row above a delegate's steering request in its root chat, queued or
 * sent, in the watcher title's place: `Steering request from Port handlers`.
 */
export const SteeringRequestTitle = memo(function SteeringRequestTitle({
  requestedBy,
}: SteeringRequestTitleProps): JSX.Element {
  return (
    <span
      data-testid="steering-request-title"
      className="mb-1 flex items-center gap-1.5 text-3xs font-medium fg-info"
    >
      <SubagentIcon size={11} className="shrink-0" />
      <span>
        {requestedBy
          ? subagentSteeringRequestFromLabel(requestedBy)
          : SUBAGENT_STEERING_REQUEST_LABEL}
      </span>
    </span>
  );
});

/**
 * How every queued and sent bubble, on every host, shows a delegate's
 * steering request: its readable text under {@link SteeringRequestTitle}, on
 * the info tint watcher messages use. Undefined for any other message.
 */
export interface SteeringRequestPresentation {
  readonly text: string;
  readonly title: JSX.Element;
  readonly variant: 'info';
}

export function steeringRequestPresentation(
  text: string,
): SteeringRequestPresentation | undefined {
  const request = subordinateSteeringRequest(text);
  if (!request) return undefined;
  return {
    text: request.text,
    title: <SteeringRequestTitle requestedBy={request.requestedBy} />,
    variant: 'info',
  };
}

/**
 * How a bubble shows a host message that reached the chat as its own text: a
 * delegate's steering request or a fired watcher, each as its readable part
 * under its title on the info tint. Undefined for an ordinary message.
 */
export function hostMessagePresentation(
  text: string,
): SteeringRequestPresentation | undefined {
  return steeringRequestPresentation(text) ?? watcherFiredPresentation(text);
}
