import { memo, type JSX } from 'react';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import { McpIcon } from '../../icons';

interface AgentSentMarkerProps {
  agentSent: ExternalAgentSender;
}

/**
 * Title row above a user message an external MCP agent (Cursor, Claude Code,
 * …) sent on the person's behalf, in the watcher title's place:
 * `Sent by Cursor`, plus `Unverified app` when the connection's redirect trust
 * was not verified.
 *
 * `clientName` is untrusted display text from the connection record. React
 * renders it as a text node only; a long name truncates and keeps its full
 * value in the native title. It names an app, not a person, so it takes no
 * session-replay class.
 */
export const AgentSentMarker = memo(function AgentSentMarker({
  agentSent,
}: AgentSentMarkerProps): JSX.Element {
  return (
    <span
      data-testid="agent-sent-marker"
      data-verified={agentSent.verified ? 'true' : 'false'}
      className="mb-1 flex min-w-0 max-w-full items-center gap-1.5 text-3xs font-medium fg-secondary"
    >
      <McpIcon aria-hidden="true" width={11} height={11} className="shrink-0" />
      <span
        data-testid="agent-sent-marker-name"
        className="min-w-0 truncate"
        title={agentSent.clientName}
      >
        Sent by {agentSent.clientName}
      </span>
      {agentSent.verified ? null : (
        <span
          data-testid="agent-sent-marker-unverified"
          className="shrink-0 fg-warning"
        >
          Unverified app
        </span>
      )}
    </span>
  );
});
