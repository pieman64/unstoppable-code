import {
  isOllamaModel,
  stripOllamaModelPrefix,
  type ChatModel,
  type ModelHarnessInvocation,
} from '@canopy/desktop-shared/types';
import { buildCodexCompatibleOllamaConfig } from '@canopy/desktop-shared/node/ollama';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { getOllamaService } from './index';
import { OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE } from './service';

/**
 * Guard message for a non-Ollama model reaching the Ollama harness resolver.
 *
 * Deliberately module-local. Callers that rewrite this function's rejection
 * into user-facing guidance must gate that rewrite positively on
 * `isOllamaServerUnavailableError`, not enumerate the failures to pass through
 * — the enumeration silently misclassifies every failure added later (missing
 * model, missing capabilities, too-old server) as "the server is down".
 */
const CODEX_OLLAMA_MODEL_REQUIRED_MESSAGE =
  'Codex-compatible Ollama invocation requires an Ollama model';

export async function resolveCodexCompatibleOllamaInvocation(
  model: ChatModel | undefined,
  options?: {
    ensureRunningReason?: 'chat' | 'helper' | 'pipeline';
    assertInstalled?: boolean;
  },
): Promise<ModelHarnessInvocation> {
  if (!isOllamaSupportedOnPlatform()) {
    throw new Error(OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE);
  }
  if (!model || !isOllamaModel(model)) {
    throw new Error(CODEX_OLLAMA_MODEL_REQUIRED_MESSAGE);
  }
  const rawModelId = stripOllamaModelPrefix(model).trim();
  const service = getOllamaService();
  if (options?.ensureRunningReason) {
    await service.ensureServerRunning(options.ensureRunningReason);
  }
  await service.assertResponsesCompatibleApi();
  if (options?.assertInstalled) {
    await service.assertInstalled(rawModelId);
  }
  const state = await service.getState();
  return {
    source: 'ollama',
    harness: 'codex',
    runtimeModel: rawModelId,
    aiCreditsRouted: false,
    codexConfig: buildCodexCompatibleOllamaConfig(state.port, rawModelId),
  };
}
