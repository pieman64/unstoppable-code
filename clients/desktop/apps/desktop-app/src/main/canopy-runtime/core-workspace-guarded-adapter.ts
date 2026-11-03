import {
  createCoreWorkspaceGuardedHandlers,
  type CoreWorkspaceGuardedHandlers,
  type CoreWorkspaceGuardedHost,
} from '@canopy/core-runtime/node/workspace/guarded-commands';

// Loaded on the first guarded command, because the host modules import back
// into the runtime.
let loadingHost: Promise<CoreWorkspaceGuardedHost> | undefined;
function loadHost(): Promise<CoreWorkspaceGuardedHost> {
  loadingHost ??= import('../lib/workspace-guarded-host').then(
    (module) => module.desktopWorkspaceGuardedHost,
  );
  return loadingHost;
}

const desktopWorkspaceGuardedHost: CoreWorkspaceGuardedHost = {
  updateHooks: async (input, call) =>
    (await loadHost()).updateHooks(input, call),
  updatePlugins: async (input, call) =>
    (await loadHost()).updatePlugins(input, call),
  updateRetention: async (input, call) =>
    (await loadHost()).updateRetention(input, call),
  updateCoworkSettings: async (input, call) =>
    (await loadHost()).updateCoworkSettings(input, call),
  updateWorktree: async (input, call) =>
    (await loadHost()).updateWorktree(input, call),
  reorderWorktree: async (input, call) =>
    (await loadHost()).reorderWorktree(input, call),
  setWorktreeHooksPaused: async (input, call) =>
    (await loadHost()).setWorktreeHooksPaused(input, call),
};

/**
 * The guarded W5 commands (W7b-1b and 1c) over the desktop's W5d2 boundaries,
 * reached only through the dispatcher's grant check.
 */
export function createCoreWorkspaceGuardedAdapter(
  host: CoreWorkspaceGuardedHost = desktopWorkspaceGuardedHost,
): { instructions: CoreWorkspaceGuardedHandlers } {
  return { instructions: createCoreWorkspaceGuardedHandlers(host) };
}
