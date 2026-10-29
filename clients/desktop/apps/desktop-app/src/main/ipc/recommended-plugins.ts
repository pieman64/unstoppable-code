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
import { registerIpcHandler } from './register';

export function registerRecommendedPluginHandlers(): void {
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
      _event,
      request: ApplyRecommendedPluginsRequest,
    ): Promise<ApplyRecommendedPluginsResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      validateOptionalRepoId(request.repoId, 'repoId');
      return applyRecommendedPlugins(request);
    },
  );
}
