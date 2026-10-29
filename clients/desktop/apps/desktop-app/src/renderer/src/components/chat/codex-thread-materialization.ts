import type {
  AgentProviderType,
  ModelHarness,
} from '@canopy/desktop-shared/types';

type CodexThreadMaterializationInput = {
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  sdkSessionId?: string;
};

export const shouldMaterializeCodexThread: (
  input: CodexThreadMaterializationInput,
) => boolean = () => {
  // Picker saves persist the desired capability snapshot only. Codex applies
  // it while creating/resuming the next turn, keeping MCP/plugin startup and
  // authentication failures out of the picker UX.
  return false;
};
