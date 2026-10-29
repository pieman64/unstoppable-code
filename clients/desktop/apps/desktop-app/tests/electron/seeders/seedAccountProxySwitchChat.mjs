const BASE_MS = Date.parse('2026-10-15T09:00:00.000Z');

/**
 * A Claude chat the account proxy moved to another account mid-turn
 * (CAN-4021): the persisted transcript the desktop reducer writes for a
 * `canopy_account_proxy_switch` event, between two assistant replies of a
 * finished turn.
 *
 * @param {string} chatId
 * @returns {object} a tab for `seedWorktreeChat`
 */
export function accountProxySwitchChatTab(chatId) {
  return {
    id: chatId,
    title: 'Webhook retries',
    messages: [
      {
        id: `${chatId}-user-1`,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'Add retries to the webhook sender and cover them with tests.',
          },
        ],
        timestamp: BASE_MS,
      },
      {
        id: `${chatId}-assistant-1`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: "The sender posts once and gives up. I'll wrap the call in a retry with exponential backoff.",
          },
        ],
        timestamp: BASE_MS + 2_000,
      },
      {
        id: `${chatId}-switch-1`,
        role: 'system',
        blocks: [
          {
            type: 'account_proxy_switch',
            timestamp: BASE_MS + 3_000,
            account: 'sam@example.com',
            previousAccount: 'ops@example.com',
            previousAtLimit: true,
            provider: 'claude',
            sourceEventId: 'account-proxy-switch:1:1',
          },
        ],
        timestamp: BASE_MS + 3_000,
      },
      {
        id: `${chatId}-assistant-2`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: 'Retries are in place: three attempts, 250 ms doubling, no retry on 4xx.',
          },
        ],
        timestamp: BASE_MS + 5_000,
      },
      {
        // The turn finished, so it collapses its activity like a real one.
        id: `${chatId}-timer-1`,
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: BASE_MS,
            completedAt: BASE_MS + 5_000,
          },
        ],
        timestamp: BASE_MS + 5_000,
      },
    ],
  };
}
