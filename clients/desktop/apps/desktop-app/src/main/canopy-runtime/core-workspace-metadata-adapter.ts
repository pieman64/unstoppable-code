import {
  createCoreWorkspaceMetadataHandlers,
  type CoreWorkspaceMetadataHandlers,
  type CoreWorkspaceMetadataHost,
} from '@canopy/core-runtime/node/workspace/metadata-commands';

// Loaded on the first metadata command, because the host modules import back
// into the runtime.
let loadingHost: Promise<CoreWorkspaceMetadataHost> | undefined;
function loadHost(): Promise<CoreWorkspaceMetadataHost> {
  loadingHost ??= import('../lib/workspace-metadata-host').then(
    (module) => module.desktopWorkspaceMetadataHost,
  );
  return loadingHost;
}

const desktopWorkspaceMetadataHost: CoreWorkspaceMetadataHost = {
  update: async (input, call) => (await loadHost()).update(input, call),
  reorder: async (input, call) => (await loadHost()).reorder(input, call),
  updateScripts: async (input, call) =>
    (await loadHost()).updateScripts(input, call),
  updatePlanDetection: async (input, call) =>
    (await loadHost()).updatePlanDetection(input, call),
  updatePrivateMemory: async (input, call) =>
    (await loadHost()).updatePrivateMemory(input, call),
  addRepository: async (input, call) =>
    (await loadHost()).addRepository(input, call),
  removeRepository: async (input, call) =>
    (await loadHost()).removeRepository(input, call),
};

/**
 * `core.workspace.*` metadata commands (W7a) over the desktop's W5 command
 * cores, reached only through the dispatcher's `core.workspace.write` check.
 */
export function createCoreWorkspaceMetadataAdapter(
  host: CoreWorkspaceMetadataHost = desktopWorkspaceMetadataHost,
): { instructions: CoreWorkspaceMetadataHandlers } {
  return { instructions: createCoreWorkspaceMetadataHandlers(host) };
}
