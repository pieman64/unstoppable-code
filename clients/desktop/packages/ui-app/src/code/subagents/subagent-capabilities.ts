import {
  isNativeSubagentKind,
  isSubagentGroupKind,
  nativeSubagentInterruptSupported,
  type SubagentKind,
} from '@canopy/ui-shared';
import type { SubagentViewerCapabilities } from './types';

/**
 * Narrows a host's viewer flags for one subagent. Managed delegates keep the
 * host's flags. Workflow agents and workflow groups are read-only (workflow
 * actions stay). A provider-native subagent offers Interrupt only when
 * `nativeSubagentInterruptSupported` allows its kind (Claude Task agents
 * today). Returns the same object when nothing changes.
 */
export function subagentCapabilitiesForKind(
  capabilities: SubagentViewerCapabilities,
  kind: SubagentKind,
): SubagentViewerCapabilities {
  if (kind === 'managed') return capabilities;

  const workflowReadOnly =
    kind === 'workflow-agent' || isSubagentGroupKind(kind);
  const nativeInterrupt =
    workflowReadOnly ||
    (isNativeSubagentKind(kind) && !nativeSubagentInterruptSupported(kind))
      ? false
      : capabilities.nativeInterrupt;
  const stop = workflowReadOnly ? false : capabilities.stop;
  const messaging = workflowReadOnly ? false : capabilities.messaging;
  const worktreeDetails = workflowReadOnly
    ? false
    : capabilities.worktreeDetails;
  if (
    nativeInterrupt === capabilities.nativeInterrupt &&
    stop === capabilities.stop &&
    messaging === capabilities.messaging &&
    worktreeDetails === capabilities.worktreeDetails
  ) {
    return capabilities;
  }
  return { ...capabilities, nativeInterrupt, stop, messaging, worktreeDetails };
}
