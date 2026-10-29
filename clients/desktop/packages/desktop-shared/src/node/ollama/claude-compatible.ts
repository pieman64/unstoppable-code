import type { ChatModel } from '../../types';

export interface ClaudeCompatibleInvocation {
  providerType: 'claude' | 'ollama';
  sdkModel?: string;
  envOverride?: Record<string, string>;
}

export async function resolveClaudeCompatibleInvocation(
  model: ChatModel | undefined,
  options?: unknown,
): Promise<ClaudeCompatibleInvocation> {
  void options;
  await Promise.resolve();
  return {
    providerType: 'claude',
    ...(model ? { sdkModel: model } : {}),
  };
}
