// Module-level registries for unread-chat agent response previews and
// App Advisor mirror provider-type hints.
import { markdownToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { isRecord } from './utils';
import { resolveTabProviderType } from './tab-utils';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ChatTab } from './types';

const UNREAD_CHAT_RESPONSE_PREVIEW_LIMIT = 200;

const unreadChatAgentResponsePreviews = new Map<string, string>();
const stalePreviewKeysByChatId = new Map<string, Set<string>>();
const STALE_PREVIEW_LIMIT = 512;
let stalePreviewCount = 0;

const appAdvisorMirrorProviderTypes = new Map<string, AgentProviderType>();

/** One line of plain text: agent replies are Markdown, previews are not. */
export function normalizeUnreadChatPreview(text: string): string | undefined {
  const normalized = markdownToPlainText(text);
  if (!normalized) return undefined;
  return normalized.length > UNREAD_CHAT_RESPONSE_PREVIEW_LIMIT
    ? `${normalized.slice(0, UNREAD_CHAT_RESPONSE_PREVIEW_LIMIT)}...`
    : normalized;
}

export function getUnreadChatAgentResponsePreview(
  tab: Pick<ChatTab, 'messages'> &
    Partial<Pick<ChatTab, 'id' | 'transcriptStale'>>,
  scope?: { projectId: string; worktreeId: string },
): string | undefined {
  const keys = tab.id ? stalePreviewKeysByChatId.get(tab.id) : undefined;
  const key =
    scope && tab.id
      ? getUnreadChatPreviewKey(scope.projectId, scope.worktreeId, tab.id)
      : keys?.size === 1
        ? Array.from(keys)[0]
        : undefined;
  if (tab.transcriptStale) {
    const preview = key ? unreadChatAgentResponsePreviews.get(key) : undefined;
    if (preview) return preview;
  } else if (tab.id && keys) {
    // Sidebar callers have no scope; ambiguous ids must never select a preview.
    for (const staleKey of Array.from(keys)) {
      if (!scope || staleKey === key) clearStalePreview(tab.id, staleKey);
    }
  }
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    if (!message || message.role !== 'assistant') continue;

    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const preview = normalizeUnreadChatPreview(text);
    if (preview) return preview;
  }

  return undefined;
}

/**
 * Public wrapper around {@link getUnreadChatAgentResponsePreview} so sidebar
 * surfaces (e.g. the worktree row's unread / awaiting-approval tooltips) can
 * derive the same normalized last-agent-response preview shown in unread-chat
 * toasts without duplicating the message-walking logic.
 */
export function getChatTabAgentResponsePreview(
  tab: Pick<ChatTab, 'messages'> &
    Partial<Pick<ChatTab, 'id' | 'transcriptStale'>>,
): string | undefined {
  return getUnreadChatAgentResponsePreview(tab);
}

export function getUnreadChatPreviewKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

export function getChatProviderHintKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

export function inferProviderTypeFromChatEvent(
  data: Record<string, unknown>,
): AgentProviderType | undefined {
  if (data.type === 'codex') {
    return 'codex';
  }

  if (
    data.type === 'assistant' ||
    data.type === 'canopy_user_prompt' ||
    data.type === 'system' ||
    data.type === 'user'
  ) {
    return 'claude';
  }

  return undefined;
}

export function recordAppAdvisorMirrorProviderType(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: Record<string, unknown>,
): void {
  const providerType = inferProviderTypeFromChatEvent(data);
  if (!providerType) return;

  appAdvisorMirrorProviderTypes.set(
    getChatProviderHintKey(projectId, worktreeId, chatId),
    providerType,
  );
}

export function getAppAdvisorMirrorProviderType(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentProviderType | undefined {
  return appAdvisorMirrorProviderTypes.get(
    getChatProviderHintKey(projectId, worktreeId, chatId),
  );
}

export function resolveResultNotificationProviderType(
  tab: ChatTab | undefined,
  providerHint?: AgentProviderType,
): AgentProviderType {
  return resolveTabProviderType(tab) ?? providerHint ?? 'claude';
}

export function getUnreadChatAgentResponsePreviewFromAssistantEvent(
  data: Record<string, unknown>,
): string | undefined {
  if (data.type === 'assistant') {
    const message = isRecord(data.message) ? data.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
    return normalizeUnreadChatPreview(text);
  }

  if (data.type === 'codex') {
    const event = isRecord(data.event) ? data.event : undefined;
    if (
      event?.type !== 'item.updated' &&
      event?.type !== 'item.completed' &&
      event?.type !== 'item.started'
    ) {
      return undefined;
    }

    const item = isRecord(event.item) ? event.item : undefined;
    if (item?.type !== 'agent_message' && item?.type !== 'plan') {
      return undefined;
    }
    return typeof item.text === 'string'
      ? normalizeUnreadChatPreview(item.text)
      : undefined;
  }

  return undefined;
}

export function isChatAgentResponseEvent(
  data: Record<string, unknown>,
): boolean {
  if (data.type === 'assistant') {
    return true;
  }

  if (data.type !== 'codex') {
    return false;
  }

  const event = isRecord(data.event) ? data.event : undefined;
  if (
    event?.type !== 'item.updated' &&
    event?.type !== 'item.completed' &&
    event?.type !== 'item.started'
  ) {
    return false;
  }

  const item = isRecord(event.item) ? event.item : undefined;
  return item?.type === 'agent_message' || item?.type === 'plan';
}

export function isUnreadChatAgentResponsePreviewEvent(
  data: Record<string, unknown>,
): boolean {
  return isChatAgentResponseEvent(data);
}

export function recordUnreadChatAgentResponsePreview(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: Record<string, unknown>,
  transcriptStale = false,
): void {
  const key = getUnreadChatPreviewKey(projectId, worktreeId, chatId);
  const event = isRecord(data.event) ? data.event : undefined;
  if (
    transcriptStale &&
    (data.type === 'canopy_user_prompt' ||
      data.type === 'canopy_injected_prompt' ||
      data.type === 'canopy_user_prompt_accepted' ||
      (data.type === 'codex' && event?.type === 'turn.started'))
  ) {
    clearRecordedUnreadChatAgentResponsePreview(projectId, worktreeId, chatId);
  }
  const preview = getUnreadChatAgentResponsePreviewFromAssistantEvent(data);
  if (!preview) {
    if (isUnreadChatAgentResponsePreviewEvent(data)) {
      clearRecordedUnreadChatAgentResponsePreview(
        projectId,
        worktreeId,
        chatId,
      );
    }
    return;
  }
  unreadChatAgentResponsePreviews.set(key, preview);
  if (transcriptStale) {
    const keys = stalePreviewKeysByChatId.get(chatId) ?? new Set<string>();
    if (!keys.has(key)) {
      keys.add(key);
      stalePreviewCount += 1;
    }
    stalePreviewKeysByChatId.set(chatId, keys);
    if (stalePreviewCount > STALE_PREVIEW_LIMIT) {
      const oldest = Array.from(stalePreviewKeysByChatId)[0];
      const oldestKey = oldest && Array.from(oldest[1])[0];
      if (oldest && oldestKey) clearStalePreview(oldest[0], oldestKey);
    }
  }
}

function clearStalePreview(chatId: string, key: string): void {
  unreadChatAgentResponsePreviews.delete(key);
  const keys = stalePreviewKeysByChatId.get(chatId);
  if (keys?.delete(key)) stalePreviewCount -= 1;
  if (keys?.size === 0) stalePreviewKeysByChatId.delete(chatId);
}

export function clearRecordedUnreadChatAgentResponsePreview(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  clearStalePreview(
    chatId,
    getUnreadChatPreviewKey(projectId, worktreeId, chatId),
  );
}

export function getRecordedUnreadChatAgentResponsePreview(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string | undefined {
  return unreadChatAgentResponsePreviews.get(
    getUnreadChatPreviewKey(projectId, worktreeId, chatId),
  );
}
