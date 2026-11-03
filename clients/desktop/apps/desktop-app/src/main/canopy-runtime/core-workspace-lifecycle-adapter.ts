import {
  createCoreWorkspaceLifecycleHandlers,
  type CoreWorkspaceLifecycleHandlers,
  type CoreWorkspaceLifecycleHost,
} from '@canopy/core-runtime/node/workspace/lifecycle-commands';

// Loaded on the first lifecycle command, because the host modules import back
// into the runtime.
let loadingHost: Promise<CoreWorkspaceLifecycleHost> | undefined;
function loadHost(): Promise<CoreWorkspaceLifecycleHost> {
  loadingHost ??= import('../lib/workspace-lifecycle-host').then(
    (module) => module.desktopWorkspaceLifecycleHost,
  );
  return loadingHost;
}

const desktopWorkspaceLifecycleHost: CoreWorkspaceLifecycleHost = {
  createWorkspace: async (request, call) =>
    (await loadHost()).createWorkspace(request, call),
  importWorkspace: async (request, call) =>
    (await loadHost()).importWorkspace(request, call),
  createWorktree: async (request, call) =>
    (await loadHost()).createWorktree(request, call),
  archiveWorktree: async (input, call) =>
    (await loadHost()).archiveWorktree(input, call),
  deleteWorkspace: async (input, call) =>
    (await loadHost()).deleteWorkspace(input, call),
  deleteWorktree: async (input, call) =>
    (await loadHost()).deleteWorktree(input, call),
  restoreArchive: async (input, call) =>
    (await loadHost()).restoreArchive(input, call),
};

/**
 * The lifecycle commands (the W7b-3 creates; W7b-2a archive, delete and
 * restore) over the desktop's typed boundaries, reached only through the
 * dispatcher's grant check and the Q8 caller check.
 */
export function createCoreWorkspaceLifecycleAdapter(
  host: CoreWorkspaceLifecycleHost = desktopWorkspaceLifecycleHost,
): { instructions: CoreWorkspaceLifecycleHandlers } {
  return { instructions: createCoreWorkspaceLifecycleHandlers(host) };
}
