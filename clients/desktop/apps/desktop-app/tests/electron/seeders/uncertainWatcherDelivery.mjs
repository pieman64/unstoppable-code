import { seedWorktreeChat } from './seedWorktreeChat.mjs';

const UNCERTAIN_WATCHER_CHAT_ID = 'uncertain-watchers';
const UNCERTAIN_WATCHER_ROW_IDS = [
  'watcher-first',
  'watcher-second',
  'watcher-third',
];

/** Persist real delivery history; startup hydrates it through canonical V2 storage. */
export function seedUncertainWatcherDeliveries(userDataDir) {
  const projectId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: UNCERTAIN_WATCHER_CHAT_ID,
    providerType: 'claude',
    tabs: [
      {
        id: UNCERTAIN_WATCHER_CHAT_ID,
        title: 'Watcher deliveries',
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
            settingsKey: 'seeded',
            payload: {
              projectId,
              worktreeId,
              chatId: UNCERTAIN_WATCHER_CHAT_ID,
              userMessageId: id,
              text: `Watcher fired.\nDelegate completion ${index + 1}`,
              watcherFired: { kind: 'Delegate watch completed' },
            },
            currentAttemptId: `attempt-${id}`,
            attempts: [
              {
                id: `attempt-${id}`,
                generation: 'ended-session',
                provider: 'claude',
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
