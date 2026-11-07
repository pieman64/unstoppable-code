import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type AgentProviderType,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { MemorySearchFact } from '@canopy/protocol/memory';
import { normalizeOrgMemoryTurn } from '@canopy/desktop-shared/lib/org-memory';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { completePersistedTabTurnTimers, writeChatTabsFile } from './chat-tabs';
import { readChatTabsFile } from './chat-tabs-reader';
import { enqueueChatTabMutation } from './chat-tab-mutation-queue';
import { sendToWindow } from './window-send';
import {
  getChatStateService,
  type ProviderEventIngestResult,
} from '../services/chat-state-service';

async function waitForE2eHookChatPersistBarrier(
  tab: PersistedChatTab,
): Promise<void> {
  const titlePrefix = process.env.CANOPY_E2E_HOOK_CHAT_PERSIST_DELAY_TITLE;
  const delayMs = Number.parseInt(
    process.env.CANOPY_E2E_HOOK_CHAT_PERSIST_DELAY_MS ?? '',
    10,
  );
  if (
    !__CANOPY_E2E__ ||
    !titlePrefix ||
    !tab.title.startsWith(titlePrefix) ||
    !Number.isFinite(delayMs) ||
    delayMs <= 0
  ) {
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  if (process.env.CANOPY_E2E_HOOK_CHAT_PERSIST_FAIL_AFTER_DELAY === '1') {
    throw new Error('E2E hook chat persistence failure after delayed write');
  }
}

/**
 * Returns canonical ingestion detail for ordinary events and starting
 * pickups, whose acceptance can differ from the event's ordinary outcome.
 */
export async function commitProviderChatEvent(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  providerType?: AgentProviderType;
  event: {
    data: unknown;
    sequence: number;
    sequenceNamespace: string;
    turnUserMessageId?: string;
    providerType?: AgentProviderType;
  };
}): Promise<ProviderEventIngestResult> {
  // The provider that ran wins: lane selection may substitute one.
  const providerType = args.event.providerType ?? args.providerType;
  return getChatStateService().ingestProviderEventWithResult({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    chatId: args.chatId,
    data: args.event.data,
    mutationId: `${args.chatId}:${args.userMessageId}:provider:${args.event.sequenceNamespace}:${args.event.sequence}`,
    ...(providerType ? { providerType } : {}),
    ...(args.event.turnUserMessageId
      ? { turnUserMessageId: args.event.turnUserMessageId }
      : {}),
  });
}

export async function upsertPersistedChatTab(args: {
  projectId: string;
  worktreeId: string;
  tab: PersistedChatTab;
  activateTab: boolean;
}): Promise<void> {
  await enqueueChatTabMutation(args.projectId, args.worktreeId, async () => {
    const existing = await readChatTabsFile(args.projectId, args.worktreeId);
    const nextTabs = existing.tabs.some((tab) => tab.id === args.tab.id)
      ? existing.tabs.map((tab) => (tab.id === args.tab.id ? args.tab : tab))
      : [...existing.tabs, args.tab];
    // Never persist tabs without an active tab: a background upsert into a
    // worktree with no tabs file yet (e.g. a hook chat with activateTab: false
    // racing worktree creation) used to write activeTabId: '', leaving the chat
    // panel with no visible tab. An id that names no tab counts as none too,
    // matching the trusted-send rule in ChatStateService.
    const fallbackActiveTabId = nextTabs.some(
      (tab) => tab.id === existing.activeTabId,
    )
      ? existing.activeTabId
      : args.tab.id;
    await writeChatTabsFile(args.projectId, args.worktreeId, {
      ...existing,
      tabs: nextTabs,
      activeTabId: args.activateTab ? args.tab.id : fallbackActiveTabId,
    });
    await waitForE2eHookChatPersistBarrier(args.tab);
  });
}

/**
 * Persist several tabs with one read and one write. Bulk imports (CAN-2439)
 * add up to hundreds of transcript-bearing tabs to a fresh scope; writing
 * the whole file per tab was quadratic in serialized payload.
 */
export async function upsertPersistedChatTabs(args: {
  projectId: string;
  worktreeId: string;
  tabs: PersistedChatTab[];
  /** Tab to activate; defaults to the existing active tab, then the first new tab. */
  activeTabId?: string;
}): Promise<void> {
  if (args.tabs.length === 0) return;
  await enqueueChatTabMutation(args.projectId, args.worktreeId, async () => {
    const existing = await readChatTabsFile(args.projectId, args.worktreeId);
    const incoming = new Map(args.tabs.map((tab) => [tab.id, tab]));
    const nextTabs = [
      ...existing.tabs.map((tab) => incoming.get(tab.id) ?? tab),
      ...args.tabs.filter(
        (tab) => !existing.tabs.some((current) => current.id === tab.id),
      ),
    ];
    const fallbackActiveTabId =
      existing.activeTabId !== '' ? existing.activeTabId : args.tabs[0].id;
    await writeChatTabsFile(args.projectId, args.worktreeId, {
      ...existing,
      tabs: nextTabs,
      activeTabId: args.activeTabId ?? fallbackActiveTabId,
    });
    for (const tab of args.tabs) {
      await waitForE2eHookChatPersistBarrier(tab);
    }
  });
}

export async function removePersistedChatTab(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await enqueueChatTabMutation(args.projectId, args.worktreeId, async () => {
    const current = await readChatTabsFile(args.projectId, args.worktreeId);
    const nextTabs = current.tabs.filter((tab) => tab.id !== args.chatId);
    const nextActiveTabId =
      current.activeTabId === args.chatId
        ? (nextTabs[nextTabs.length - 1]?.id ?? '')
        : current.activeTabId;
    await writeChatTabsFile(
      args.projectId,
      args.worktreeId,
      { ...current, tabs: nextTabs, activeTabId: nextActiveTabId },
      { changedTabIds: [], removedTabIds: [args.chatId] },
    );
  });
}

export async function completePersistedChatTabTurn(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await enqueueChatTabMutation(args.projectId, args.worktreeId, async () => {
    const current = await readChatTabsFile(args.projectId, args.worktreeId, {
      chatIds: [args.chatId],
    });
    const completedAt = Date.now();
    const updatedTabs = current.tabs.map((tab) =>
      tab.id === args.chatId
        ? completePersistedTabTurnTimers(tab, completedAt)
        : tab,
    );
    await writeChatTabsFile(args.projectId, args.worktreeId, {
      ...current,
      tabs: updatedTabs,
    });
  });
}

export async function persistOrgMemoryUsedForChat(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  /** The org that was searched; feedback on this turn goes there (CAN-3457). */
  organizationExternalId?: string;
  searchId?: string;
  facts: MemorySearchFact[];
}): Promise<boolean> {
  const memory = normalizeOrgMemoryTurn({
    organizationExternalId: args.organizationExternalId,
    searchId: args.searchId,
    facts: args.facts,
  });
  if (!memory) return false;

  // Provider events can advance the canonical revision between a compatibility
  // read and write. That stale snapshot merge deliberately keeps only messages,
  // losing this disclosure while the turn still receives its memory. Update
  // the current tab inside the repository transaction instead (CAN-2840).
  const result = await getChatStateService().updateCompatibilityTab(
    { projectId: args.projectId, worktreeId: args.worktreeId },
    args.chatId,
    (tab) => {
      if (
        !tab.messages.some(
          (message) =>
            message.id === args.userMessageId && message.role === 'user',
        )
      ) {
        return null;
      }
      return {
        ...tab,
        memoryByMessageId: {
          ...tab.memoryByMessageId,
          [args.userMessageId]: memory,
        },
      };
    },
  );
  return result.updated;
}

export async function emitChatDispatchFailure(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  errorMessage: string;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  getExecutionObservabilityIngest().completeChatTurn(
    args.projectId,
    args.worktreeId,
    args.chatId,
    'failure',
    args.errorMessage,
    { setupFailure: true },
  );
  const data = {
    type: 'error',
    error: args.errorMessage,
  } as const;
  await getChatStateService().ingestProviderEvent({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    chatId: args.chatId,
    data,
    mutationId: `dispatch-failure:${args.chatId}:${randomUUID()}`,
    source: 'provider',
  });
  sendToWindow(args.getWindow(), IPC_CHANNELS.chatEvent, {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    chatId: args.chatId,
    data,
  });
}
