import type {
  PersistedChatMessage,
  UsageInitiationSource,
} from '@canopy/desktop-shared/types';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';

function getRequestInitiationSource(
  request: unknown,
): UsageInitiationSource | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const value = (request as Record<string, unknown>)['initiationSource'];
  return isUsageInitiationSource(value) ? value : undefined;
}

function getRequestAutomationName(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const value = (request as Record<string, unknown>)['automationName'];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Stable id of the automation banner that precedes one automation-initiated
 * prompt. Every writer (the main-owned worktree and Cowork send paths, the
 * trusted-send materialization, and the renderer's optimistic copy) derives
 * the same id from the prompt's user-message id, so the banner is written once
 * and a retry, queued drain, or reload never duplicates or re-times it.
 */
export function automationInfoMessageId(userMessageId: string): string {
  return `${userMessageId}-automation-info`;
}

/**
 * The automation banner for an automation-initiated prompt, or `null` for any
 * other send. When `existingMessages` already hold this prompt's banner, that
 * message is returned unchanged so its launch time survives retries.
 */
export function buildAutomationInfoMessage(
  request: unknown,
  userMessageId: string,
  existingMessages: readonly PersistedChatMessage[] = [],
): PersistedChatMessage | null {
  if (getRequestInitiationSource(request) !== 'automation') {
    return null;
  }
  const id = automationInfoMessageId(userMessageId);
  const existing = existingMessages.find((message) => message.id === id);
  if (existing) return existing;
  const automationName = getRequestAutomationName(request);
  const timestamp = Date.now();
  return {
    id,
    role: 'system',
    timestamp,
    blocks: [
      {
        type: 'automation_info',
        timestamp,
        ...(automationName ? { activityName: automationName } : {}),
      },
    ],
  };
}
