import { inputSettingsKeyFor } from './inputSettingsKey.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

const UNCERTAIN_WATCHER_CHAT_ID = 'uncertain-watchers';
const UNCERTAIN_WATCHER_ROW_IDS = [
  'watcher-first',
  'watcher-second',
  'watcher-third',
];

/** Persist real delivery history; startup hydrates it through canonical V2 storage. */
export function seedUncertainWatcherDeliveries(
  userDataDir,
  { providerType = 'claude', ...settings } = {},
) {
  const projectId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  // Seed every setting hydration fills in, so the rows' key matches the chat.
  const tabSettings = { providerType, ...settings };
  // Main-delivered watcher requests carry the tab's resolved provider settings
  // (`deliverWatcherMessageToChat` in watcher-chat-delivery.ts); Resend
  // dispatches the stored payload as is.
  const requestSettings = {
    ...(settings.model ? { model: settings.model } : {}),
    providerType,
    executionHarness: settings.executionHarness ?? providerType,
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: UNCERTAIN_WATCHER_CHAT_ID,
    providerType,
    tabs: [
      {
        id: UNCERTAIN_WATCHER_CHAT_ID,
        title: 'Watcher deliveries',
        ...tabSettings,
        messages: [
          {
            id: 'seeded-assistant',
            role: 'assistant',
            timestamp: 500,
            blocks: [
              { type: 'text', text: 'Waiting for delegate completion.' },
            ],
          },
        ],
        inputDelivery: {
          version: 1,
          epoch: 0,
          rows: UNCERTAIN_WATCHER_ROW_IDS.map((id, index) => ({
            id,
            revision: 1,
            createdAt: 1_000 + index,
            state: 'uncertain',
            text: `Watcher fired.\nDelegate completion ${index + 1}`,
            settingsKey: inputSettingsKeyFor(tabSettings),
            payload: {
              projectId,
              worktreeId,
              chatId: UNCERTAIN_WATCHER_CHAT_ID,
              userMessageId: id,
              text: `Watcher fired.\nDelegate completion ${index + 1}`,
              ...requestSettings,
              watcherFired: { kind: 'Delegate watch completed' },
            },
            currentAttemptId: `attempt-${id}`,
            attempts: [
              {
                id: `attempt-${id}`,
                generation: 'ended-session',
                provider: providerType,
                createdAt: 1_000 + index,
                admittedAt: 1_001 + index,
                uncertainAt: 2_000 + index,
              },
            ],
          })),
        },
      },
    ],
  });
}

const CANCELLED_COPY_CHAT_ID = 'cancelled-copy';

/** A copied chat's cancelled row, as a fork of a chat with queued input held. */
export function seedCancelledCopiedDelivery(userDataDir) {
  const projectId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const tabSettings = { providerType: 'claude' };
  const text = 'Canopy watcher fired.\nDelegate completion';
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: CANCELLED_COPY_CHAT_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CANCELLED_COPY_CHAT_ID,
        title: 'Fork: copied delivery',
        ...tabSettings,
        messages: [
          {
            id: 'seeded-assistant',
            role: 'assistant',
            timestamp: 500,
            blocks: [{ type: 'text', text: 'Copied history.' }],
          },
        ],
        inputDelivery: {
          version: 1,
          epoch: 1,
          rows: [
            {
              id: 'copied-cancelled',
              revision: 1,
              createdAt: 1_000,
              state: 'cancelled',
              text,
              reason:
                'The active session no longer accepts steering. Falling back to ordinary delivery.',
              settingsKey: inputSettingsKeyFor(tabSettings),
              payload: {
                projectId,
                worktreeId,
                chatId: CANCELLED_COPY_CHAT_ID,
                userMessageId: 'copied-cancelled',
                text,
                providerType: 'claude',
                executionHarness: 'claude',
              },
              attempts: [],
            },
          ],
        },
      },
    ],
  });
}
