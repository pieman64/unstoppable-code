import {
  createCoreWorkspaceRepoRulesHandlers,
  type CoreWorkspaceRepoRulesBinding,
  type CoreWorkspaceRepoRulesHandlers,
  type CoreWorkspaceRepoRulesHost,
} from '@canopy/core-runtime/node/workspace/workspace-repo-rules';

// Loaded on the first repo-rules call, because the host modules import back
// into the runtime. The policy is the instance session composition uses, over
// the same store writer.
export const desktopRepoRulesHost: CoreWorkspaceRepoRulesHost = {
  load: async (): Promise<CoreWorkspaceRepoRulesBinding> => {
    const [{ repoRulesService }, { repoRulesStoreErrorCode }] =
      await Promise.all([
        import('../repo-rules/host'),
        import('../repo-rules/state'),
      ]);
    return { policy: repoRulesService, errorCode: repoRulesStoreErrorCode };
  },
};

/** `core.workspace.repoRules.*` handlers over the desktop host modules. */
export function createCoreWorkspaceRepoRulesAdapter(
  host: CoreWorkspaceRepoRulesHost = desktopRepoRulesHost,
): CoreWorkspaceRepoRulesHandlers {
  return createCoreWorkspaceRepoRulesHandlers(host);
}
