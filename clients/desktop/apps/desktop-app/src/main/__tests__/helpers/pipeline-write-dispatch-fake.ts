// Stands in for core in unit tests that mock the pipeline store: a write
// reaches the (mocked) store and then the real desktop effects, as the
// desktop writer runs them behind `core.pipeline.definition.*`. The goldens
// cover the real dispatch.
import type {
  IPCResult,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { UserPipelineWrite } from '../../canopy-runtime/pipeline-definition-dispatch';
import {
  applyUserPipelineDeleteEffects,
  applyUserPipelineSaveEffects,
} from '../../pipelines/core-pipeline-definition-sources';
import * as pipelineService from '../../pipelines/pipeline-service';

const AGENT_CALLER = {};

export function fakeSaveUserPipeline(
  write: UserPipelineWrite,
  caller?: object,
): Promise<IPCResult<PipelineInfo>> {
  const input = {
    name: write.name,
    description: write.description,
    icon: write.icon,
    content: write.content,
    ...(write.rawContent === undefined ? {} : { rawContent: write.rawContent }),
  };
  // The agent actions updated through the store's update, which refuses an
  // unknown id; the editor saved through its save.
  const result =
    write.id !== undefined && caller === AGENT_CALLER
      ? pipelineService.updatePipeline(write.id, input)
      : pipelineService.savePipeline({
          ...(write.id === undefined ? {} : { id: write.id }),
          ...input,
        });
  if (result.success) applyUserPipelineSaveEffects(write.id ?? null);
  return Promise.resolve(result);
}

export function fakeDeleteUserPipeline(id: string): Promise<IPCResult> {
  const result = pipelineService.deletePipeline(id);
  if (result.success) applyUserPipelineDeleteEffects(id);
  return Promise.resolve(result);
}

/** The `jest.mock` factory for `canopy-runtime/pipeline-definition-dispatch`. */
export const pipelineWriteDispatchFake = {
  PIPELINE_DEFINITION_AGENT_CALLER: AGENT_CALLER,
  PIPELINE_DEFINITION_DESKTOP_CALLER: {},
  saveUserPipeline: fakeSaveUserPipeline,
  deleteUserPipeline: fakeDeleteUserPipeline,
};
