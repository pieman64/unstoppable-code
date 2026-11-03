// Stands in for core in unit tests that mock the pipeline store: a write
// reaches the (mocked) store and then the real desktop effects, as the
// desktop writer runs them behind `core.pipeline.definition.*`. The goldens
// cover the real dispatch.
import { randomUUID } from 'node:crypto';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type {
  IPCResult,
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { parseSharedPipelineLocalId } from '@canopy/protocol/pipelines';
import { getManagedCuratedPipeline } from '../../pipelines/curated-pipeline-catalog';
import { getSharedPipeline } from '../../pipelines/canopy-server-client';
import type { UserPipelineWrite } from '../../canopy-runtime/pipeline-definition-dispatch';
import {
  applyUserPipelineDeleteEffects,
  applyUserPipelineSaveEffects,
  copyPipelineWithProvenance,
} from '../../pipelines/core-pipeline-definition-sources';
import { recordPipelineEnabled } from '../../pipelines/pipeline-enablement-commit';
import {
  presentPipeline,
  withPipelinePresentation,
} from '../../pipelines/pipeline-definition-presentation';
import { createPipelineReadFake } from './pipeline-read-dispatch-fake';
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

/** A source definition, read from the (mocked) source core would pick. */
async function readFakeSource(
  definitionId: string,
): Promise<IPCResult<PipelineData>> {
  if (definitionId.startsWith('curated:'))
    return {
      success: true,
      data: await getManagedCuratedPipeline(definitionId),
    };
  const shared = parseSharedPipelineLocalId(definitionId);
  if (shared) {
    const detail = await getSharedPipeline(shared.remoteId);
    presentPipeline('read', 'shared', definitionId, {
      kind: 'shared',
      pipeline: detail,
    });
    return {
      success: true,
      data: {
        info: {
          id: definitionId,
          name: detail.name,
          filename: '',
          description: detail.description,
          icon: detail.icon,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          source: 'shared',
          readonly: !detail.canUpdate,
        },
        content: parsePipelineText(detail.rawPipeline),
      },
    };
  }
  return pipelineService.getPipeline(definitionId);
}

/**
 * Copies as core does: reads the source from the (mocked) store, names the
 * copy, and runs the real desktop provenance step over the store.
 */
export function fakeDuplicatePipelineDefinition(
  sourceDefinitionId: string,
  options: { name?: string } = {},
): Promise<IPCResult<PipelineInfo>> {
  return withPipelinePresentation(() =>
    duplicateFromFakeSource(sourceDefinitionId, options),
  );
}

async function duplicateFromFakeSource(
  sourceDefinitionId: string,
  options: { name?: string },
): Promise<IPCResult<PipelineInfo>> {
  let source: IPCResult<PipelineData>;
  try {
    source = await readFakeSource(sourceDefinitionId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!source.success || !source.data)
    return {
      success: false,
      error: source.error ?? `Workflow not found: ${sourceDefinitionId}`,
    };
  const name = options.name ?? `${source.data.info.name} (Copy)`;
  const content = { ...source.data.content, name };
  delete content.readonly;
  const id = randomUUID();
  try {
    const info = await copyPipelineWithProvenance(
      { source: source.data.info.source, definitionId: sourceDefinitionId },
      id,
      {
        create: () => {
          const saved = pipelineService.savePipeline(
            {
              id,
              name,
              description: source.data?.info.description ?? '',
              icon: source.data?.info.icon ?? '',
              content,
            },
            { id },
          );
          if (!saved.success || !saved.data)
            return Promise.reject(
              new Error(saved.error ?? 'Failed to copy the workflow'),
            );
          return Promise.resolve(saved.data);
        },
        idOf: (created) => created.id,
        remove: (created) => {
          const removed = pipelineService.deletePipeline(created.id);
          return removed.success
            ? Promise.resolve()
            : Promise.reject(
                new Error(removed.error ?? 'Failed to delete the workflow'),
              );
        },
        reread: (created) => Promise.resolve(created),
      },
    );
    return { success: true, data: info };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fakeSetPipelineDefinitionEnabled(
  definitionId: string,
  enabled: boolean,
): Promise<undefined> {
  await recordPipelineEnabled(definitionId, enabled);
  return undefined;
}

/** The `jest.mock` factory for `canopy-runtime/pipeline-definition-dispatch`. */
export const pipelineWriteDispatchFake = {
  ...createPipelineReadFake(() => ({
    list: pipelineService.listPipelines,
    get: pipelineService.getPipeline,
  })),
  PIPELINE_DEFINITION_AGENT_CALLER: AGENT_CALLER,
  PIPELINE_DEFINITION_DESKTOP_CALLER: {},
  saveUserPipeline: fakeSaveUserPipeline,
  deleteUserPipeline: fakeDeleteUserPipeline,
  duplicatePipelineDefinition: fakeDuplicatePipelineDefinition,
  setPipelineDefinitionEnabled: fakeSetPipelineDefinitionEnabled,
};
