'use client';

import { memo, useMemo, type JSX } from 'react';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  CapabilityTile,
  capabilityTileModel,
  type CapabilityTileAction,
} from '@canopy/ui-shared/components';
import { AgentActivitySection } from './AgentActivitySection';
import { useAgentArtifactTileHost } from './agent-artifact-tile-host';
import { collectTurnAgentArtifacts } from './turn-agent-artifacts';

const NO_HOST_ACTION: CapabilityTileAction = { kind: 'none' };

export interface TurnAgentArtifactsProps {
  /** The turn's assistant messages, in transcript order. */
  readonly messages: readonly PortalChatMessage[];
}

/**
 * A turn's capability tiles inside the shared Agent activity section. Renders
 * nothing when the turn produced no receipts.
 */
export const TurnAgentArtifacts = memo(function TurnAgentArtifacts({
  messages,
}: TurnAgentArtifactsProps): JSX.Element | null {
  const host = useAgentArtifactTileHost();
  const receipts = useMemo(
    () => collectTurnAgentArtifacts(messages),
    [messages],
  );
  if (receipts.length === 0) return null;
  const items = receipts.map((receipt) => (
    <CapabilityTile
      key={receipt.dedupeKey}
      model={capabilityTileModel(receipt)}
      action={host ? host.resolveAction(receipt) : NO_HOST_ACTION}
      testId={`agent-artifact-${receipt.kind}`}
    />
  ));
  return (
    <AgentActivitySection
      artifactItems={items}
      variant="completed"
      defaultExpanded
    />
  );
});
