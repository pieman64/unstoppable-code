import type { ManagedDelegationMode } from '@canopy/protocol/delegation/discovery';
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
  return (
    options.managedDelegationSurface === 'worktree-chat' &&
    (process.platform === 'darwin' || process.platform === 'win32') &&
    (mode === 'explicit-only' || mode === 'proactive') &&
    !options.appAdvisorRuntime &&
    !options.pipelineEditorRuntime &&
    Boolean(
      options.projectId && options.worktreeId && options.chatId && options.cwd,
    )
  );
}
