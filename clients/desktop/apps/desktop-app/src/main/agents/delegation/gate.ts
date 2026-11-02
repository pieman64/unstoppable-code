import type { ManagedDelegationMode } from '@canopy/protocol/delegation/discovery';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { AgentSessionOptions } from '../types';

/** The saved user preference is the sole source of delegation policy. */
export function resolveManagedDelegationMode(
  mode: ManagedDelegationMode | undefined,
): ManagedDelegationMode {
  return mode ?? 'off';
}

/** User opt-in is available only on supported desktop worktree surfaces. */
export function managedDelegationEnabled(
  options: AgentSessionOptions,
): boolean {
  const mode = resolveManagedDelegationMode(options.managedDelegationMode);
  // A null host OS is one PlatformServices does not support; delegation runs
  // on every supported host (macOS, Windows, Linux).
  return (
    options.managedDelegationSurface === 'worktree-chat' &&
    hostOperatingSystem() !== null &&
    (mode === 'explicit-only' || mode === 'proactive') &&
    !options.appAdvisorRuntime &&
    !options.pipelineEditorRuntime &&
    Boolean(
      options.projectId && options.worktreeId && options.chatId && options.cwd,
    )
  );
}
