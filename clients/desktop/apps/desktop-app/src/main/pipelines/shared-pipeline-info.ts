import {
  CANOPY_CLOUD_DISPLAY_NAME,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import { buildSharedPipelineId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import type {
  PipelineInfo,
  SharedPipelineSummary,
} from '@canopy/execution-engine/types/pipeline';

/** The desktop's row for a Canopy Cloud share. */
export function buildSharedPipelineInfo(args: {
  pipeline: SharedPipelineSummary;
  scopes?: PipelineInfo['scopes'];
}): PipelineInfo {
  const { pipeline } = args;
  return {
    id: buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, pipeline.id),
    name: pipeline.name,
    filename: '',
    description: pipeline.description,
    icon: pipeline.icon,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
    triggerTypes: pipeline.triggerTypes,
    scopes: args.scopes ?? pipeline.scopes ?? ['directory'],
    source: 'shared',
    readonly: !pipeline.canUpdate,
    serverId: CANOPY_CLOUD_SERVER_ID,
    serverName: CANOPY_CLOUD_DISPLAY_NAME,
    remoteId: pipeline.id,
    canUpdate: pipeline.canUpdate,
    canDelete: pipeline.canDelete,
    shareScope: pipeline.shareScope ?? 'private',
    distributionMode: pipeline.distributionMode ?? 'definition_only',
    ...(pipeline.owner ? { owner: pipeline.owner } : {}),
  };
}
