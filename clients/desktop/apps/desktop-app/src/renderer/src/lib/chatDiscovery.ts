import type {
  AgentProviderType,
  ChatModel,
} from '@canopy/desktop-shared/types';
import { getProviderForModel } from '@canopy/desktop-shared/types';

export { selectDiscoverySlashCommands } from '@canopy/desktop-shared/lib/slash-invocable-inventory';

export function resolveEffectiveProviderType(
  model?: ChatModel,
  providerType?: AgentProviderType,
): AgentProviderType | undefined {
  if (providerType) {
    return providerType;
  }

  return model ? getProviderForModel(model) : undefined;
}
