import type {
  AgentAuditChatMode,
  AgentProviderType,
  AgentTranscriptInjectedPrompt,
} from '../types';

export interface HelperTranscriptSeed {
  provider: AgentProviderType;
  originalText: string;
  submittedText: string;
  systemPrompt: string;
}

export interface HelperTranscriptObserver {
  seed: (seed: HelperTranscriptSeed) => void | Promise<void>;
  appendEvent: (event: unknown) => void | Promise<void>;
  markChatMode?: (chatMode: AgentAuditChatMode) => void | Promise<void>;
  /** Update the original helper audit entry for a new 1-based attempt. */
  markAttempt?: (attempt: number) => void | Promise<void>;
  /** Attach the resumable provider session to the original helper entry. */
  markSessionId?: (sessionId: string) => void | Promise<void>;
}

export function buildHelperInjectedPrompts(
  provider: AgentProviderType,
  systemPrompt: string,
): AgentTranscriptInjectedPrompt[] {
  const trimmedSystemPrompt = systemPrompt.trim();
  if (trimmedSystemPrompt.length === 0) {
    return [];
  }

  return [
    {
      kind: 'system_prompt_append',
      provider,
      applicationCondition: 'helper_task_system_prompt',
      text: trimmedSystemPrompt,
    },
  ];
}
