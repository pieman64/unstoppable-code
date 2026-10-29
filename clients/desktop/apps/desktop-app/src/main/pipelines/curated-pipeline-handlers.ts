import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type {
  ImportCuratedPipelineRequest,
  ListCuratedPipelinesRequest,
} from '@canopy/desktop-shared/types/curated-pipelines';
import { registerIpcHandler } from '../ipc/register';
import {
  getCuratedPipeline,
  importCuratedPipeline,
  listCuratedPipelines,
} from './curated-pipeline-catalog';

async function result<T>(operation: () => Promise<T>): Promise<IPCResult<T>> {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function registerCuratedPipelineHandlers(): void {
  registerIpcHandler(
    PIPELINE_CHANNELS.CURATED_LIST,
    (_, request?: ListCuratedPipelinesRequest) =>
      result(() => listCuratedPipelines(request)),
  );
  registerIpcHandler(PIPELINE_CHANNELS.CURATED_GET, (_, key: string) =>
    result(() => getCuratedPipeline(key)),
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.CURATED_IMPORT,
    (_, request: ImportCuratedPipelineRequest) =>
      result(() => importCuratedPipeline(request)),
  );
}
