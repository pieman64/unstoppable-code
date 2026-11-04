'use client';

import { memo, type JSX } from 'react';
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import { AgentIcon, WorkflowIcon } from '../../icons/AppIcons';
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
   * steering title beside it; a tool sender's marker stands alone.
   */
  steering?: boolean;
  /**
   * `block` (the default) is the title row above a bubble. `inline` leads a
   * one-line queued row at the row's own text size, in the tertiary ink.
   */
  layout?: 'block' | 'inline';
}

const TITLE_CLASS =
  'mb-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-3xs font-medium fg-secondary';
const INLINE_TITLE_CLASS =
  'flex min-w-0 items-center gap-1.5 whitespace-nowrap fg-tertiary';

/**
 * The title row above a user message another agent sent, in the watcher
 * title's place. A Canopy chat sender shows its chat title, opening that chat
 * where the host can; a pipeline or automation shows its captured name; an
 * external MCP agent or a managed delegate shows its `Sent by` marker.
 */
export const AgentSentTitle = memo(function AgentSentTitle({
  agentSent,
  receivingContext,
  steering = false,
  layout = 'block',
}: AgentSentTitleProps): JSX.Element {
  // Only tool senders (external agents, managed delegates) carry a `kind`.
  return 'kind' in agentSent ? (
    <AgentSentMarker agentSent={agentSent} layout={layout} />
  ) : (
    <>
      {agentSent.sender.kind === 'pipeline' ? (
        <PipelineAgentSentTitle name={agentSent.chatTitle} layout={layout} />
      ) : (
        <ChatAgentSentTitle
          agentSent={agentSent}
          sender={agentSent.sender}
          receivingContext={receivingContext}
          layout={layout}
        />
      )}
      {steering ? <SteeringTitle /> : null}
    </>
  );
});

/**
 * The automation or pipeline name captured when the message was accepted.
 * Never a button: no host opens a run from a chat yet. `data-sender` carries
 * the kind only, never the name.
 */
function PipelineAgentSentTitle({
  name,
  layout,
}: {
  name: string;
  layout: 'block' | 'inline';
}): JSX.Element {
  const inline = layout === 'inline';
  return (
    <span
      data-testid="agent-sent-title"
      data-sender="pipeline"
      className={inline ? INLINE_TITLE_CLASS : TITLE_CLASS}
    >
      <WorkflowIcon
        width={inline ? 14 : 11}
        height={inline ? 14 : 11}
        className="shrink-0"
        aria-hidden="true"
      />
      <span className={`min-w-0 truncate ${REPLAY_MASK_CLASS}`}>{name}</span>
    </span>
  );
}

/**
 * Captured labels are display text only, never authority. The host's opener
 * navigates by the sender's canonical address, never by its labels.
 */
function ChatAgentSentTitle({
  agentSent,
  sender,
  receivingContext,
  layout,
}: {
  agentSent: ChatAgentSentInfo;
  sender: Exclude<ChatAgentSentInfo['sender'], { kind: 'pipeline' }>;
  receivingContext: AgentSentReceivingContext;
  layout: 'block' | 'inline';
}): JSX.Element {
  const inline = layout === 'inline';
  const titleClass = inline ? INLINE_TITLE_CLASS : TITLE_CLASS;
  const opener = useAgentSentSenderOpener();
  const sameContext =
    sender.kind === 'bot'
      ? receivingContext.kind === 'bot' &&
        sender.botId === receivingContext.botId
      : receivingContext.kind === 'project' &&
        sender.projectId === receivingContext.projectId;
  const content = (
    <>
      <AgentIcon
        width={inline ? 14 : 11}
        height={inline ? 14 : 11}
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
      <span data-testid="agent-sent-title" className={titleClass}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="agent-sent-title"
      className={`${titleClass} w-fit max-w-full cursor-pointer rounded-sm text-left hover:fg-primary hover:underline focus-ring`}
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
