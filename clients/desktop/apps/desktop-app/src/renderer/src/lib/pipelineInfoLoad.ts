import type {
  IPCResult,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';

export interface MergeProjectPipelineInfosResult {
  infos: PipelineInfo[];
  error: string | null;
}

export function mergeProjectPipelineInfos(
  infos: PipelineInfo[],
  projectResult: IPCResult<PipelineInfo[]>,
): MergeProjectPipelineInfosResult {
  if (!projectResult.success || !projectResult.data) {
    return {
      infos,
      error: projectResult.error ?? 'Failed to load project pipelines',
    };
  }

  return {
    infos: [...infos, ...projectResult.data],
    error: null,
  };
}
