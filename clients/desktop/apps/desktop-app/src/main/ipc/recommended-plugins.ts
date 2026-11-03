import {
  IPC_CHANNELS,
  type ApplyRecommendedPluginsRequest,
  type ApplyRecommendedPluginsResponse,
  type InspectRecommendedPluginsRequest,
  type InspectRecommendedPluginsResponse,
} from '@canopy/desktop-shared/types';
import {
  applyRecommendedPlugins,
  inspectRecommendedPlugins,
} from '../lib/recommended-plugins';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectedWorkspaceGuardedCommands } from '../canopy-runtime/workspace-guarded-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

export function registerRecommendedPluginHandlers(runtime: {
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  registerIpcHandler(
    IPC_CHANNELS.recommendedPluginsInspect,
    async (
      _event,
      request: InspectRecommendedPluginsRequest,
    ): Promise<InspectRecommendedPluginsResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId, 'repoId');
      return inspectRecommendedPlugins(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.recommendedPluginsApply,
    async (
      event,
      request: ApplyRecommendedPluginsRequest,
    ): Promise<ApplyRecommendedPluginsResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId, 'repoId');
      // The selection write projects core.workspace.plugins.update (W7b-1c).
      const commands = projectedWorkspaceGuardedCommands({
        dispatcher: runtime.dispatcher,
        caller: runtime.resolveCaller(event),
      });
      return applyRecommendedPlugins(request, (update) =>
        commands.updatePlugins(update),
      );
    },
  );
}
