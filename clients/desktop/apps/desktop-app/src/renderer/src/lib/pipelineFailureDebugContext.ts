export {
  buildPipelineFailureDebugPrompt,
  type PipelineFailureDebugContextOptions,
  type PipelineFailureDebugContextResult,
} from '@canopy/desktop-shared/lib/pipelineFailureDebugPrompt';
import {
  buildPipelineFailureDebugPrompt,
  type PipelineFailureDebugContextResult,
} from '@canopy/desktop-shared/lib/pipelineFailureDebugPrompt';

export interface PipelineFailureDebugContext {
  executionId: string;
  pipelineId: string;
  pipelineName?: string;
  status: string;
}

export async function buildPipelineFailureDebugContext(
  executionId: string,
): Promise<PipelineFailureDebugContext | null> {
  const result = await window.pipelines.getExecution(executionId);
  if (!result.success || !result.data || result.data.status !== 'failure') {
    return null;
  }
  return {
    executionId: result.data.id,
    pipelineId: result.data.pipeline_id,
    pipelineName: result.data.pipeline_snapshot.name,
    status: result.data.status,
  };
}

export async function buildPipelineFailureDebugPromptForExecution(
  executionId: string,
): Promise<string | null> {
  const result = await window.pipelines.getExecution(executionId);
  if (!result.success || !result.data || result.data.status !== 'failure') {
    return null;
  }
  const promptResult: PipelineFailureDebugContextResult =
    await buildPipelineFailureDebugPrompt(result.data, {
      readStepLog: (locator) => window.pipelines.readStepLog(locator),
      readReportFile: (executionIdToRead, kind) =>
        window.pipelines.readReportFile(executionIdToRead, kind),
    });
  return promptResult.prompt;
}
