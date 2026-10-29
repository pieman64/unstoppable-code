'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type {
  CapabilityTileAction,
  CapabilityTileReceipt,
} from '@canopy/ui-shared/components';

/**
 * How a host opens the capability tiles in its transcript. Hosts map each
 * receipt's navigation target onto the routes or actions they actually have;
 * a target they cannot open returns `{ kind: 'none' }` with a hint.
 */
export interface AgentArtifactTileHost {
  resolveAction: (receipt: CapabilityTileReceipt) => CapabilityTileAction;
}

const AgentArtifactTileHostContext =
  createContext<AgentArtifactTileHost | null>(null);

export function AgentArtifactTileHostProvider({
  host,
  children,
}: {
  host: AgentArtifactTileHost;
  children: ReactNode;
}): JSX.Element {
  return (
    <AgentArtifactTileHostContext.Provider value={host}>
      {children}
    </AgentArtifactTileHostContext.Provider>
  );
}

/** The mounted host, or null where tiles have no navigation. */
export function useAgentArtifactTileHost(): AgentArtifactTileHost | null {
  return useContext(AgentArtifactTileHostContext);
}
