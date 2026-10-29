import {
  getProviderForModel,
  pinInheritingAgentModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';

/**
 * The provider a picked model runs on. An Agent on the default model runs on
 * the chat's default, so it is judged by that model's provider.
 */
export function pickProvider(
  model: ChatModel,
  defaultModel: ChatModel | undefined,
): string | undefined {
  return getProviderForModel(pinInheritingAgentModel(model, defaultModel));
}
