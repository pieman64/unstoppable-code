'use client';

import { memo, type JSX } from 'react';
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import {
  isExternalAgentSent,
  type AgentSentInfo,
} from '@canopy/protocol/portal/external-agent-sender';
import { AgentIcon } from '../../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { AgentSentMarker } from './AgentSentMarker';
import { useAgentSentSenderOpener } from './AgentSentSenderOpener';
import { SteeringTitle } from './SteeringTitle';

export type AgentSentReceivingContext =
  | { kind: 'project'; projectId: string }
  | { kind: 'bot'; botId: string };

export interface AgentSentTitleProps {
  agentSent: AgentSentInfo;
  receivingContext: AgentSentReceivingContext;
  /**
   * The message steered a running turn. A Canopy chat sender's title shows the
   * steering title beside it; an external agent's marker stands alone.
   */
  steering?: boolean;
}

const TITLE_CLASS =
  'mb-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-3xs font-medium fg-secondary';

/**
 * The title row above a user message another agent sent, in the watcher
 * title's place. A Canopy chat sender shows its chat title, opening that chat
 * where the host can; an external MCP agent shows `Sent by <app>`.
 */
export const AgentSentTitle = memo(function AgentSentTitle({
  agentSent,
  receivingContext,
  steering = false,
}: AgentSentTitleProps): JSX.Element {
  return isExternalAgentSent(agentSent) ? (
    <AgentSentMarker agentSent={agentSent} />
  ) : (
    <>
      <ChatAgentSentTitle
        agentSent={agentSent}
        receivingContext={receivingContext}
      />
      {steering ? <SteeringTitle /> : null}
    </>
  );
});

/**
 * Captured labels are display text only, never authority. The host's opener
 * navigates by the sender's canonical address, never by its labels.
 */
function ChatAgentSentTitle({
  agentSent,
  receivingContext,
}: {
  agentSent: ChatAgentSentInfo;
  receivingContext: AgentSentReceivingContext;
}): JSX.Element {
  const opener = useAgentSentSenderOpener();
  const sender = agentSent.sender;
  const sameContext =
    sender.kind === 'project'
      ? receivingContext.kind === 'project' &&
        sender.projectId === receivingContext.projectId
      : receivingContext.kind === 'bot' &&
        sender.botId === receivingContext.botId;
  const content = (
    <>
      <AgentIcon
        width={11}
        height={11}
        className="shrink-0"
        aria-hidden="true"
      />
      <span className={`min-w-0 truncate ${REPLAY_MASK_CLASS}`}>
        {agentSent.chatTitle}
      </span>
      {!sameContext && (
        <>
          <span aria-hidden="true">·</span>
          <span className={`min-w-0 truncate ${REPLAY_MASK_CLASS}`}>
            {agentSent.projectLabel}
          </span>
        </>
      )}
    </>
  );
  if (!opener?.canOpen(sender)) {
    return (
      <span data-testid="agent-sent-title" className={TITLE_CLASS}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="agent-sent-title"
      className={`${TITLE_CLASS} w-fit max-w-full cursor-pointer rounded-sm text-left hover:fg-primary hover:underline focus-ring`}
      onClick={(event) => {
        // The bubble around the title has its own click behavior.
        event.stopPropagation();
        opener.open(sender);
      }}
    >
      {content}
    </button>
  );
}
