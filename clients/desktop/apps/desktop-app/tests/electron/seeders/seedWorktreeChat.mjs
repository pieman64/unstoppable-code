import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive H1 — seed a worktree's persisted chat tabs.
 *
 * On-disk path: `workspaces/{workspaceId}/chats/{worktreeId}.json`
 * (`apps/desktop-app/src/main/lib/paths.ts` `getWorkspaceChatTabsFilePath`,
 * dispatched via `resolve-worktree.ts` `resolveChatTabsFilePath`).
 *
 * Shape: `ChatTabsFile` from `packages/desktop-shared/src/types.ts`:
 *   { version: 1, tabs: PersistedChatTab[], activeTabId: string,
 *     pendingQuestions?: PersistedPendingQuestion[],
 *     pendingApprovals?: PersistedPendingApproval[],
 *     lastActiveEditableChatId?: string }
 *
 * The reader (`apps/desktop-app/src/main/lib/chat-tabs-reader.ts`) only
 * accepts the file when `version === 1`, `tabs` is an array, and
 * `activeTabId` is a string; each tab is kept only if it has string `id` +
 * `title` + `createdAt` and an array `messages`. This seeder always produces
 * those required fields and lets callers layer on the optional
 * `PersistedChatTab` fields (`providerType`, `status`-derived
 * `staleSessionDetected`, transcript `blocks`, etc.).
 *
 * `PersistedChatBlock` variants the transcripts use (see types.ts):
 *   { type: 'text', text }
 *   { type: 'thinking', text }
 *   { type: 'image', path, alt }
 *   { type: 'tool_use', toolUseId, toolName, input }
 *   { type: 'tool_result', toolUseId, toolName, output, isError }
 *   { type: 'turn_timer', startedAt?, pausedAt?, completedAt }
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId workspace id (a.k.a. projectId)
 * @param {string} options.worktreeId worktree id
 * @param {import('@canopy/desktop-shared/types').AgentProviderType} [options.providerType]
 *   default provider applied to tabs that do not specify their own
 * @param {import('@canopy/desktop-shared/types').StaleSessionInfo | 'stale'} [options.status]
 *   convenience: pass `'stale'` for a default stale marker, or a full
 *   `StaleSessionInfo` object; applied to tabs that do not set their own
 *   `staleSessionDetected`. Tabs are free to override per-tab.
 * @param {Array<Partial<import('@canopy/desktop-shared/types').PersistedChatTab> & { blocks?: import('@canopy/desktop-shared/types').PersistedChatBlock[] }>} [options.tabs]
 *   tab definitions. Each entry may supply `blocks` (a `PersistedChatBlock[]`)
 *   as a shorthand for a single assistant message, or full `messages`.
 * @param {import('@canopy/desktop-shared/types').PersistedPendingQuestion[]} [options.pendingQuestions]
 *   file-level pending ask-user prompts
 * @param {import('@canopy/desktop-shared/types').PersistedPendingApproval[]} [options.pendingApprovals]
 *   file-level pending tool-approval prompts
 * @param {string} [options.activeTabId] defaults to the first tab's id
 * @param {string} [options.lastActiveEditableChatId] last composer target
 *   retained while a file tab is active
 * @returns {{ filePath: string, file: import('@canopy/desktop-shared/types').ChatTabsFile }}
 */
export function seedWorktreeChat(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    providerType,
    status,
    tabs = [],
    pendingQuestions,
    pendingApprovals,
    activeTabId,
    lastActiveEditableChatId,
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedWorktreeChat requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedWorktreeChat requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedWorktreeChat requires worktreeId');
  }

  const staleDefault =
    status === 'stale'
      ? { droppedMessageText: 'Seeded dropped message' }
      : status;

  const normalizedTabs = tabs.map((tab, index) =>
    normalizeTab(tab, index, providerType, staleDefault),
  );

  const resolvedActiveTabId = activeTabId ?? normalizedTabs[0]?.id ?? '';

  /** @type {import('@canopy/desktop-shared/types').ChatTabsFile} */
  const file = {
    version: 1,
    tabs: normalizedTabs,
    activeTabId: resolvedActiveTabId,
    ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
    ...(pendingQuestions ? { pendingQuestions } : {}),
    ...(pendingApprovals ? { pendingApprovals } : {}),
  };

  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chats',
    `${worktreeId}.json`,
  );

  writeJson(filePath, file);
  return { filePath, file };
}

function normalizeTab(tab, index, providerType, staleDefault) {
  const id = tab.id ?? `seeded-chat-${index + 1}`;

  // Accept a `blocks` shorthand: a single assistant message carrying the
  // supplied transcript blocks. Full `messages` always wins when provided.
  const messages =
    tab.messages ??
    (tab.blocks
      ? [
          {
            id: `${id}-assistant-1`,
            role: 'assistant',
            blocks: tab.blocks,
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
        ]
      : []);

  // Drop the `blocks` shorthand and the required fields we resolve below so
  // arbitrary caller-supplied optional fields pass through, while the resolved
  // required fields (and the seeder-level provider/stale defaults) win.
  const {
    blocks: _ignoredBlocks,
    id: _ignoredId,
    title: _ignoredTitle,
    createdAt: _ignoredCreatedAt,
    messages: _ignoredMessages,
    ...rest
  } = tab;

  return {
    ...rest,
    id,
    title: tab.title ?? `Seeded Chat ${index + 1}`,
    createdAt: tab.createdAt ?? '2026-04-10T12:00:00.000Z',
    messages,
    ...(providerType && !tab.providerType ? { providerType } : {}),
    ...(staleDefault && !tab.staleSessionDetected
      ? { staleSessionDetected: staleDefault }
      : {}),
  };
}
