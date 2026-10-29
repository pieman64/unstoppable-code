import type {
  AgentProviderType,
  ChatModel,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import { getExecutionHarnessForModel } from '@canopy/desktop-shared/types';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';

interface UseThinkingHarnessOptions {
  lockedHarness: ModelHarness | undefined;
  executionHarness?: ModelHarness;
  model: ChatModel | undefined;
  effectiveProviderType: AgentProviderType | undefined;
}

/** Resolve the execution harness that controls composer thinking semantics. */
export function useThinkingHarness({
  lockedHarness,
  executionHarness,
  model,
  effectiveProviderType,
}: UseThinkingHarnessOptions): ModelHarness {
  useModelCatalogStore((state) => state.harnessAssignments);

  return (
    lockedHarness ??
    executionHarness ??
    (model ? getExecutionHarnessForModel(model) : undefined) ??
    (effectiveProviderType === 'claude' || effectiveProviderType === undefined
      ? 'claude'
      : 'codex')
  );
}
