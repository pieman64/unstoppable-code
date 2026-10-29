/**
 * Maps the desktop host's `CanopyCapabilities` onto the subagent viewer's
 * capability flags. Components never hardcode a capability: they read the
 * host client's flags through here. Per-kind narrowing lives in
 * `@canopy/ui-app/subagents` (`subagentCapabilitiesForKind`).
 */
import { useMemo } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';

/** The viewer's flags for a host, before any per-subagent narrowing. */
export function subagentViewerCapabilitiesFrom(
  capabilities: CanopyCapabilities,
): SubagentViewerCapabilities {
  return {
    stop: capabilities.delegationStop === true,
    messaging: capabilities.delegationMessaging === true,
    worktreeDetails: capabilities.delegationWorktreeDetails === true,
    nativeInterrupt: capabilities.nativeSubagentInterrupt === true,
    openWorkflow: true,
    stopWorkflow: true,
  };
}

/** The desktop host's viewer capabilities; stable for the client's lifetime. */
export function useSubagentViewerCapabilities(
  capabilities: CanopyCapabilities = ipcCanopyClient.capabilities,
): SubagentViewerCapabilities {
  return useMemo(
    () => subagentViewerCapabilitiesFrom(capabilities),
    [capabilities],
  );
}
