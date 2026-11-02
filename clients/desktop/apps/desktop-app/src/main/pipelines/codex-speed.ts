import type { AgentModelConfig } from '@canopy/desktop-shared/types';
import { readCodexSpeedRecord } from '@canopy/desktop-shared/lib/codex-speed';

/** Pipelines retain their existing Regular/Fast execution contract. */
export function pipelineSpeedError(
  modelConfig: AgentModelConfig | undefined,
): string | undefined {
  return readCodexSpeedRecord(modelConfig) === 'ultrafast'
    ? 'Workflows do not support Ultra fast. Choose Regular or Fast.'
    : undefined;
}
