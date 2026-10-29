import { expect, test } from '@playwright/test';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

for (const truncated of [false, true]) {
  test(`Copilot ${truncated ? 'historical' : 'whole-chat'} fork receives its selected history once and resumes after restart`, async () => {
    test.setTimeout(180_000);
    const time = Date.parse('2026-10-12T00:00:00Z');
    const messages = [
      {
        id: 'u1',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'Remember COPILOT_FORK_HISTORY_CANARY for the release.',
          },
        ],
        timestamp: time,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'The release decision is recorded.' }],
        timestamp: time + 1000,
      },
      {
        id: 'timer1',
        role: 'system',
        blocks: [
          { type: 'turn_timer', startedAt: time, completedAt: time + 2000 },
        ],
        timestamp: time + 2000,
      },
      ...(truncated
        ? [
            {
              id: 'u2',
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  text: 'COPILOT_FUTURE_SOURCE_CANARY must remain in the source.',
                },
              ],
              timestamp: time + 3000,
            },
            {
              id: 'timer2',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: time + 3000,
                  completedAt: null,
                },
              ],
              timestamp: time + 3000,
            },
          ]
        : []),
    ];
    const f = await launchCopilotSelectionFixture({
      seedBeforeLaunch: ({ userDataDir }) =>
        seedWorktreeChat({
          userDataDir,
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          providerType: 'copilot',
          tabs: [
            {
              id: 'copilot-selection',
              title: 'Copilot fork source',
              model: 'copilot:fixture-model',
              sdkSessionId: 'source-native-session',
              hasStartedSession: true,
              messages,
            },
          ],
        }),
    });
    try {
      await f.connect();
      await f.openChat();
      await f.panel.getByTestId('fork-chat-button').last().click();
      await expect(
        f.window.locator('[role="tab"][data-panel-kind="chat"]'),
      ).toHaveCount(2);
      const panel = f.window
        .getByTestId('panel-content-chat')
        .filter({ visible: true })
        .last();
      let fork;
      await expect
        .poll(
          async () => {
            const state = await f.window.evaluate(
              (scope) => window.api.chat.loadTabs(scope),
              f.target,
            );
            fork = state.tabs.find(
              (tab) => tab.forkedFrom?.chatId === f.target.chatId,
            );
            return fork?.id;
          },
          { timeout: 30_000 },
        )
        .toBeTruthy();
      expect(fork.sdkSessionId).toBeUndefined();
      expect(fork.providerType).toBe('copilot');
      await expect(panel).not.toContainText('COPILOT_FUTURE_SOURCE_CANARY');
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          'COPILOT_FORK_ASSERT: continue from the recorded release decision.',
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText('Copilot fork inherited selected history.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 60_000 });
      await f.restart();
      await f.openChat();
      await f.window.getByTestId(`panel-tab-panel-chat-${fork.id}`).click();
      const resumed = f.window
        .getByTestId('panel-content-chat')
        .filter({ visible: true })
        .last();
      await resumed
        .getByRole('textbox')
        .first()
        .fill('COPILOT_FORK_ASSERT: continue again.');
      await resumed
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        resumed.getByText('Copilot fork reused native history.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        resumed.getByText('<forked_conversation>', { exact: false }),
      ).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}
