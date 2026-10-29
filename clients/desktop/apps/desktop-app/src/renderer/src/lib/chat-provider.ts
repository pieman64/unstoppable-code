import {
  getModelSource,
  getProviderForModel,
  type AgentProviderType,
  type ChatModel,
} from '@canopy/desktop-shared/types';

export interface ChatProviderTarget {
  providerType?: AgentProviderType;
  model?: ChatModel;
}

export function getEffectiveChatProvider(
  tab: ChatProviderTarget,
): AgentProviderType {
  return (
    tab.providerType ??
    (tab.model ? (getProviderForModel(tab.model) ?? 'claude') : 'claude')
  );
}

export function isClaudeBackedChatTab(tab: ChatProviderTarget): boolean {
  return getEffectiveChatProvider(tab) === 'claude';
}

export function isClaudeTerminalEligibleChatTab(
  tab: ChatProviderTarget,
): boolean {
  const source = tab.model ? getModelSource(tab.model) : undefined;
  return (
    getEffectiveChatProvider(tab) === 'claude' &&
    (source === undefined || source === 'claude-managed')
  );
}
