import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { PipelinePluginCollectionRunContext } from '@/components/activity/PipelineTriggerModal';

type PlanReadyExecuteOptions = Parameters<typeof window.pipelines.execute>[1];

interface BuildPlanReadyExecuteOptionsParams {
  cwd: string;
  pipeline: PipelineData;
  projectId: string;
  worktreeId: string;
  planId: string;
  planContent: string;
  inputs: Record<string, string> | undefined;
  pluginCollectionContext: PipelinePluginCollectionRunContext;
}

export function buildPlanReadyExecuteOptions({
  cwd,
  pipeline,
  projectId,
  worktreeId,
  planId,
  planContent,
  inputs,
  pluginCollectionContext,
}: BuildPlanReadyExecuteOptionsParams): PlanReadyExecuteOptions {
  return {
    cwd,
    pipelineId: pipeline.info.id,
    projectId,
    worktreeId,
    planId,
    eventName: 'plan_ready',
    eventData: {
      plan_ready: { plan_text: planContent },
    },
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
    pluginCollectionPreferences: pluginCollectionContext.preferences,
    ...(pluginCollectionContext.modelAliasPreferences
      ? { modelAliasPreferences: pluginCollectionContext.modelAliasPreferences }
      : {}),
    modelConfig: pluginCollectionContext.modelConfig,
    ...(pluginCollectionContext.pipelinePreferenceLocator
      ? {
          pipelinePreferenceLocator:
            pluginCollectionContext.pipelinePreferenceLocator,
        }
      : {}),
    ...(pipeline.info.source === 'shared' &&
    pipeline.info.serverId &&
    pipeline.info.remoteId
      ? {
          sharedPipeline: {
            serverId: pipeline.info.serverId,
            remoteId: pipeline.info.remoteId,
          },
        }
      : {}),
  };
}
