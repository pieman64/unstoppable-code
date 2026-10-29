import rootPackage from '@repo/package.json';
import { mergeAiGatewayModelCatalog } from '@canopy/desktop-shared/ai-gateway-model-catalog';
import {
  parseModelPackageConfig,
  replaceModelFamilyMetadata,
} from '@canopy/desktop-shared/model-config';
import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initModelHarnessAssignments,
} from '@canopy/desktop-shared/types';
import { parseAiGatewayModelCatalogResponse } from '@canopy/protocol/ai-gateway-models';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
// A recorded hosted-model catalog (DeepSeek, Kimi, GLM, MiniMax and the
// hosted Claude and GPT rows) from the UI automation fixtures; the lab's Vite
// config maps this id to it (see composer-lab-fixtures.d.ts).
import gatewayCatalogFixture from 'composer-lab/gateway-catalog';

/**
 * Loads the model registries the way the app's main process does, from the
 * root package's native Claude and Codex models plus a hosted-model catalog,
 * so the lab's model picker lists exactly what the app's does: native and
 * hosted models, their Legacy flyouts, and a Cursor tab to connect.
 */
export function seedComposerLabModels(): void {
  const packageConfig = parseModelPackageConfig(rootPackage);
  const merged = mergeAiGatewayModelCatalog({
    packageConfig,
    catalog: parseAiGatewayModelCatalogResponse(gatewayCatalogFixture),
  });
  replaceModelFamilyMetadata([...merged.claudeModels, ...merged.codexModels]);
  initClaudeModels(merged.claudeModels);
  initCodexModels(merged.codexModels);
  initAiGatewayModels(merged.aiGatewayModels, merged.gatewayRoutes);
  initModelAliases(merged.modelAliases);
  initModelHarnessAssignments({ revision: 0, assignments: [] });
  useModelCatalogStore.setState({
    snapshot: {
      claude: merged.claudeModels,
      codex: merged.codexModels,
      ollama: [],
      aliases: merged.modelAliases,
      aiGatewayModels: merged.aiGatewayModels,
      gatewayRoutes: merged.gatewayRoutes,
    },
    aiGatewayCatalogStatus: null,
    policy: new Set<string>(),
    modelGatewayEnforced: false,
  });
  // Cursor released, so its harness tab shows (disconnected: connect).
  const flags = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...flags,
      values: {
        ...flags.values,
        'canopy-desktop-cursor-harness': true,
        'canopy-desktop-cursor-harness-released': true,
      },
    },
  });
}
