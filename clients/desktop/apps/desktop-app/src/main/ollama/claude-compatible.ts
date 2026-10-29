import {
  isOllamaModel,
  stripOllamaModelPrefix,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { resolveAnthropicMockEnvOverride } from '@canopy/desktop-shared/node/e2e-mock-env';
import { buildClaudeCompatibleOllamaEnv, getOllamaService } from './index';
import { OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE } from './service';

export interface ClaudeCompatibleInvocation {
  providerType: 'claude' | 'ollama';
  sdkModel?: string;
  envOverride?: Record<string, string>;
}

export async function resolveClaudeCompatibleInvocation(
  model: ChatModel | undefined,
  options?: {
    providerType?: 'claude' | 'ollama';
    ensureRunningReason?:
      | 'chat'
      | 'helper'
      | 'pipeline'
      | 'settings-refresh'
      | 'pull';
    assertInstalled?: boolean;
  },
): Promise<ClaudeCompatibleInvocation> {
  const shouldUseOllama =
    options?.providerType === 'ollama' || isOllamaModel(model);

  if (shouldUseOllama && !isOllamaSupportedOnPlatform()) {
    throw new Error(OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE);
  }

  if (!shouldUseOllama) {
    // UI-automation seam: redirect the Claude SDK at the deterministic mock
    // provider. The build-time `__CANOPY_E2E__` gate and every mock string
    // literal live inside the shared helper, which production builds fold to
    // `return undefined` — a runtime env var can never reach it. See
    // docs/ui-automation-coverage/11-build-time-gating-principle.md.
    const envOverride = resolveAnthropicMockEnvOverride();
    return {
      providerType: 'claude',
      ...(model ? { sdkModel: model } : {}),
      ...(envOverride ? { envOverride } : {}),
    };
  }

  const rawModelId = stripOllamaModelPrefix(model ?? '').trim();
  if (options?.assertInstalled && rawModelId.length === 0) {
    throw new Error('Invalid Ollama model ID');
  }

  const ollamaService = getOllamaService();
  if (options?.ensureRunningReason) {
    await ollamaService.ensureServerRunning(options.ensureRunningReason);
  }
  await ollamaService.assertAnthropicCompatibleApi();
  if (options?.assertInstalled) {
    await ollamaService.assertInstalled(rawModelId);
  }

  const state = await ollamaService.getState();
  return {
    providerType: 'ollama',
    sdkModel: rawModelId,
    envOverride: buildClaudeCompatibleOllamaEnv(state.port),
  };
}
