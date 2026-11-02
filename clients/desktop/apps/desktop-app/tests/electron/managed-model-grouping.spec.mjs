import { expect, test } from '@playwright/test';
import { seedModelDefaultsGatewayCatalog } from './seeders/seedUnavailableModelDefaults.mjs';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';
import { launchCursorSelectionFixture } from './fixtures/cursor-selection.mjs';
import {
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';

test('Cursor Claude model honors an explicit Claude harness selection before and after a turn', async () => {
  test.setTimeout(180_000);
  const cursorModel = `cursor:${encodeURIComponent('claude-sonnet-5-5[]')}`;
  const f = await launchCursorSelectionFixture({ sharedClaudeModel: true });
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    const pick = async (harness) => {
      await panel.getByTestId('chat-model-picker').click();
      await f.window.getByTestId(`chat-model-harness-tab-${harness}`).click();
      await f.window
        .getByTestId('chat-model-option-sonnet')
        .filter({ visible: true })
        .click();
    };
    await pick('cursor');
    await expect.poll(() => f.tab()).toMatchObject({ model: cursorModel });
    await pick('claude');
    await expect.poll(() => f.tab()).toMatchObject({ model: 'sonnet' });
    await pick('cursor');
    await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_TEXT');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect
      .poll(() => f.tab())
      .toMatchObject({
        model: cursorModel,
        providerType: 'cursor',
      });
    expect(
      (await f.tab()).messages.some((message) => message.role === 'user'),
    ).toBe(true);
    await pick('claude');
    const expectHarnessRecovery = async () => {
      await expect(f.window.getByRole('dialog')).toContainText(
        'Start a new chat with the Claude harness?',
      );
      await expect(
        f.window.getByTestId('model-recovery-new-chat-body'),
      ).toHaveText(
        "This chat uses the Cursor harness and can't switch to the Claude harness. Starting a new chat leaves this one unchanged.",
      );
    };
    await expectHarnessRecovery();
    await f.window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-search').fill('Sonnet');
    await f.window
      .getByRole('group', { name: 'Claude', exact: true })
      .getByTestId('chat-model-option-sonnet')
      .click();
    await expectHarnessRecovery();
    await f.window.getByTestId('model-recovery-start-new-chat').click();
    const tabs = () =>
      f.window.evaluate((target) => window.api.chat.loadTabs(target), f.target);
    await expect
      .poll(async () => {
        const state = await tabs();
        return state.tabs.find((tab) => tab.id === state.activeTabId);
      })
      .toMatchObject({ model: 'sonnet' });
    const state = await tabs();
    expect(state.activeTabId).not.toBe(f.target.chatId);
    expect(state.tabs.find((tab) => tab.id === f.target.chatId)).toMatchObject({
      model: cursorModel,
      providerType: 'cursor',
    });
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Sonnet',
    );
  } finally {
    await f.close();
  }
});

for (const harness of ['cursor', 'copilot', 'opencode']) {
  test(`Started Claude chat keeps new-chat recovery for the ${harness} shared model`, async () => {
    test.setTimeout(180_000);
    const raw =
      harness === 'cursor'
        ? 'claude-sonnet-5-5[]'
        : harness === 'copilot'
          ? 'claude-sonnet-5.5'
          : 'anthropic/claude-sonnet-5-5';
    const id = `${harness}:${encodeURIComponent(raw)}`;
    const f =
      harness === 'cursor'
        ? await launchCursorSelectionFixture({ sharedClaudeModel: true })
        : harness === 'copilot'
          ? await launchCopilotSelectionFixture({
              models: [
                {
                  id: raw,
                  name: 'Sonnet 5.5',
                  policy: { state: 'enabled' },
                  capabilities: { supports: { vision: true } },
                },
              ],
            })
          : await launchOpenCodeSelectionFixture({
              models: [{ value: raw, name: 'Sonnet 5.5' }],
            });
    try {
      if (harness === 'cursor') await f.connection(true);
      else await f.connect();
      await f.openChat();
      const panel = f.window.getByTestId('panel-content-chat');
      await panel
        .getByRole('textbox')
        .first()
        .fill('Start this chat on Claude');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect
        .poll(async () =>
          (await f.tab()).messages.some(
            (message) => message.role === 'assistant',
          ),
        )
        .toBe(true);
      await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
      await expect
        .poll(() => f.tab())
        .toMatchObject({ model: 'sonnet', providerType: 'claude' });
      const original = await f.tab();
      await panel.getByTestId('chat-model-picker').click();
      await f.window.getByTestId(`chat-model-harness-tab-${harness}`).click();
      const row = f.window
        .getByTestId('chat-model-option-sonnet')
        .filter({ visible: true });
      await expect(row).toHaveCount(1);
      await expect(
        f.window
          .getByTestId(`chat-model-option-${id}`)
          .filter({ visible: true }),
      ).toHaveCount(0);
      await row.click();
      const label =
        harness === 'cursor'
          ? 'Cursor'
          : harness === 'copilot'
            ? 'GitHub Copilot'
            : 'OpenCode';
      await expect(f.window.getByTestId('model-recovery-modal')).toContainText(
        `Start a new chat with the ${label} harness?`,
      );
      await expect(
        f.window.getByTestId('model-recovery-new-chat-body'),
      ).toContainText('This chat uses the Claude harness');
      await f.window.getByTestId('model-recovery-start-new-chat').click();
      const tabs = () =>
        f.window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          f.target,
        );
      await expect
        .poll(async () => {
          const state = await tabs();
          return state.tabs.find((tab) => tab.id === state.activeTabId);
        })
        .toMatchObject({ model: id });
      const state = await tabs();
      expect(state.activeTabId).not.toBe(f.target.chatId);
      expect(
        state.tabs.find((tab) => tab.id === f.target.chatId),
      ).toMatchObject({
        model: 'sonnet',
        providerType: 'claude',
      });
      // Inactive tabs contain metadata only. Read the canonical transcript to
      // prove starting a new chat preserves every message of the original.
      const originalTranscript = () =>
        f.window.evaluate(
          (target) => window.api.chat.getTranscriptPage(target),
          f.target,
        );
      await expect
        .poll(async () => (await originalTranscript()).messages)
        .toEqual(original.messages);
      await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_TEXT');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect
        .poll(async () => {
          const current = await tabs();
          return current.tabs.find((tab) => tab.id === current.activeTabId);
        })
        .toMatchObject({ model: id, providerType: harness });
      await expect(
        panel.getByText(
          harness === 'cursor'
            ? 'Cursor chat works.'
            : harness === 'copilot'
              ? 'Copilot fixture reply 1.'
              : 'OpenCode fixture reply 1.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await originalTranscript()).messages)
        .toEqual(original.messages);
    } finally {
      await f.close();
    }
  });
}

for (const harness of ['copilot', 'opencode']) {
  for (const nativeConnected of [true, false]) {
    for (const flow of nativeConnected
      ? ['new favorite', 'saved account favorite', 'missing account route']
      : ['new favorite']) {
      test(`${flow}: ${harness} groups models by maker and selects a shared row through its account with native sign-in ${nativeConnected ? 'available' : 'unavailable'}`, async () => {
        test.setTimeout(180_000);
        const authKey = `${harness}-grouping-native-unavailable`;
        if (!nativeConnected)
          await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
            authUsage: { scenario: 'unauthenticated' },
          });
        const env = nativeConnected ? {} : { CANOPY_MOCK_API_KEY: authKey };
        const raw =
          harness === 'copilot'
            ? 'claude-sonnet-5.5'
            : 'anthropic/claude-sonnet-5-5';
        const id = `${harness}:${encodeURIComponent(raw)}`;
        const f =
          harness === 'copilot'
            ? await launchCopilotSelectionFixture({
                env,
                models: [
                  {
                    id: raw,
                    name: 'Sonnet 5.5',
                    policy: { state: 'enabled' },
                    capabilities: { supports: { vision: true } },
                  },
                ],
              })
            : await launchOpenCodeSelectionFixture({
                env,
                models: [{ value: raw, name: 'Sonnet 5.5' }],
              });
        try {
          await f.connect();
          if (flow === 'saved account favorite') {
            await f.window.evaluate((key) => {
              localStorage.setItem(
                'unstoppable:model-picker-favorites',
                JSON.stringify([key]),
              );
            }, `${harness}::${id}`);
          }
          await f.openChat();
          await f.panel.getByTestId('chat-model-picker').click();
          await f.window
            .getByTestId(
              `chat-model-harness-tab-${flow === 'saved account favorite' ? 'favorites' : harness}`,
            )
            .click();
          const row = f.window
            .getByTestId('chat-model-option-sonnet')
            .filter({ visible: true });
          await expect(row).toBeVisible();
          await expect(
            f.window
              .getByTestId(`chat-model-option-${id}`)
              .filter({ visible: true }),
          ).toHaveCount(0);
          if (flow !== 'saved account favorite') {
            await expect(
              row.locator('xpath=ancestor::*[@role="group"][1]'),
            ).toHaveAttribute('aria-label', 'Claude');
          }
          if (flow === 'new favorite') {
            await f.window
              .getByTestId('chat-model-favorite-sonnet')
              .filter({ visible: true })
              .click();
            await expect
              .poll(() =>
                f.window.evaluate(() =>
                  JSON.parse(
                    localStorage.getItem(
                      'unstoppable:model-picker-favorites',
                    ) ?? '[]',
                  ),
                ),
              )
              .toContain(`${harness}::sonnet`);
          }
          if (flow === 'missing account route') {
            await f.window
              .getByTestId('chat-model-favorite-sonnet')
              .filter({ visible: true })
              .click();
            await f.window.keyboard.press('Escape');
            await f.driver.openSettings();
            await f.driver.openSettingsSection('experiments');
            await f.window.getByTestId(`${harness}-connect`).click();
            await expect(
              f.window.getByTestId(`${harness}-connection-status`),
            ).toHaveText('Ready to connect');
            await f.driver.closeSettings();
            await f.openChat();
            await f.panel.getByTestId('chat-model-picker').click();
            await f.window
              .getByTestId('chat-model-harness-tab-favorites')
              .click();
            await expect(row).toBeVisible();
            await expect(row).toHaveAttribute('aria-disabled', 'true');
            await row.click({ force: true });
            await expect.poll(() => f.tab()).toMatchObject({ model: 'sonnet' });
            await f.window.keyboard.press('Escape');
            await f.connect();
            await f.openChat();
            await f.panel.getByTestId('chat-model-picker').click();
            await f.window
              .getByTestId('chat-model-harness-tab-favorites')
              .click();
            await expect(row).not.toHaveAttribute('aria-disabled', 'true');
          }
          await row.click();
          await expect.poll(() => f.tab()).toMatchObject({ model: id });
          await f.send('Check the selected account route');
          await expect
            .poll(() => f.tab())
            .toMatchObject({ model: id, providerType: harness });
          await expect(
            f.panel.getByText(
              `${harness === 'copilot' ? 'Copilot' : 'OpenCode'} fixture reply 1.`,
              { exact: true },
            ),
          ).toBeVisible({ timeout: 60_000 });
          if (flow === 'saved account favorite') {
            await f.panel.getByTestId('chat-model-picker').click();
            await f.window
              .getByTestId('chat-model-harness-tab-favorites')
              .click();
            await f.window
              .getByTestId('chat-model-favorite-sonnet')
              .filter({ visible: true })
              .click();
            await expect(row).toHaveCount(0);
            expect(
              await f.window.evaluate(() =>
                JSON.parse(
                  localStorage.getItem('unstoppable:model-picker-favorites') ??
                    '[]',
                ),
              ),
            ).toEqual([]);
          }
        } finally {
          await f.close();
          if (!nativeConnected)
            await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
        }
      });
    }
  }
}

for (const harness of ['copilot', 'opencode', 'cursor']) {
  for (const kind of harness === 'cursor' ? ['native'] : ['hosted', 'native']) {
    test(`Agent editor selects one ${kind} model through the ${harness} harness`, async ({}, testInfo) => {
      test.setTimeout(180_000);
      const canonical =
        kind === 'hosted'
          ? 'e2e-available-gateway-model'
          : harness === 'cursor'
            ? 'gpt-6-astra'
            : 'sonnet';
      const raw =
        harness === 'cursor'
          ? 'gpt-6-astra[reasoning=medium]'
          : kind === 'hosted'
            ? harness === 'copilot'
              ? canonical
              : `opencode/${canonical}`
            : harness === 'copilot'
              ? 'claude-sonnet-5.5'
              : 'anthropic/claude-sonnet-5-5';
      const id = `${harness}:${encodeURIComponent(raw)}`;
      // Match the cache's server binding to the app's E2E cloud origin.
      const env =
        kind === 'hosted'
          ? {
              CANOPY_E2E_CLOUD_BASE_URL:
                process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL,
            }
          : {};
      const seedBeforeLaunch = ({ userDataDir }) =>
        kind === 'hosted'
          ? seedModelDefaultsGatewayCatalog(userDataDir)
          : undefined;
      const f =
        harness === 'cursor'
          ? await launchCursorSelectionFixture({ sharedModel: true })
          : harness === 'copilot'
            ? await launchCopilotSelectionFixture({
                seedBeforeLaunch,
                env,
                models: [
                  {
                    id: raw,
                    name:
                      kind === 'hosted'
                        ? 'Available gateway model'
                        : 'Sonnet 5.5',
                    policy: { state: 'enabled' },
                    capabilities: { supports: { vision: false } },
                  },
                ],
              })
            : await launchOpenCodeSelectionFixture({
                seedBeforeLaunch,
                env,
                models: [
                  {
                    value: raw,
                    name:
                      kind === 'hosted'
                        ? 'Available gateway model'
                        : 'Sonnet 5.5',
                  },
                ],
              });
      const rendererErrors = [];
      f.window.on('pageerror', (error) => rendererErrors.push(error.stack));
      f.window.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(message.text());
      });
      try {
        if (harness === 'cursor') await f.connection(true);
        else await f.connect();
        await f.driver.openMarketplaceAgents();
        await f.driver.createMarketplaceAgent();
        await f.window
          .getByTestId('agent-model-name')
          .fill(`${kind} ${harness}`);
        await f.window.getByTestId('agent-model-base-specific').check();
        await f.window
          .getByTestId('agent-model-base-model')
          .getByTestId('chat-model-picker')
          .click();
        await expect(
          f.window.getByTestId(`chat-model-harness-tab-${harness}`),
        ).toBeVisible();
        await f.window.getByTestId(`chat-model-harness-tab-${harness}`).click();
        await expect(
          f.window
            .getByTestId(`chat-model-option-${canonical}`)
            .filter({ visible: true }),
        ).toBeVisible();
        const accountRow = f.window
          .getByTestId(`chat-model-option-${id}`)
          .filter({ visible: true });
        await expect(accountRow).toHaveCount(0);
        const modelRow = f.window
          .getByTestId(`chat-model-option-${canonical}`)
          .filter({ visible: true });
        await expect(modelRow).toHaveCount(1);
        await modelRow.click();
        await f.window
          .getByTestId('agent-model-instructions')
          .fill('Use the chosen account.');
        await f.window.getByTestId('agent-model-submit').click();
        const agentId = `agent_model_${kind}_${harness}`;
        // Saving opens the new agent's detail.
        await f.driver.expectCreatedLocalAgentDetail(agentId);
        await expect
          .poll(() =>
            f.window.evaluate((key) => window.agents.get(key), agentId),
          )
          .toMatchObject({ baseModel: id });
        await f.window.getByTestId('local-agent-detail-edit').click();
        await f.window
          .getByTestId('agent-model-base-model')
          .getByTestId('chat-model-picker')
          .click();
        await f.window.getByTestId(`chat-model-harness-tab-${harness}`).click();
        await expect(modelRow).toHaveCount(1);
        await expect(modelRow).toHaveAttribute('aria-checked', 'true');
        await expect(accountRow).toHaveCount(0);
        if (kind === 'hosted') {
          // This configuration picker has no credits probe. Keep the hosted
          // credit gate instead of silently selecting the current account.
          await f.window.getByTestId('chat-model-harness-tab-codex').click();
          await expect(
            f.window
              .getByTestId(`chat-model-option-${canonical}`)
              .filter({ visible: true }),
          ).toHaveAttribute('aria-disabled', 'true');
          await f.window.getByTestId('agent-model-submit').click();
          await expect
            .poll(() =>
              f.window.evaluate((key) => window.agents.get(key), agentId),
            )
            .toMatchObject({ baseModel: id });
          return;
        }
        await f.window
          .getByTestId(
            `chat-model-harness-tab-${harness === 'cursor' ? 'codex' : 'claude'}`,
          )
          .click();
        await f.window
          .getByTestId(`chat-model-option-${canonical}`)
          .filter({ visible: true })
          .click();
        await f.window.getByTestId('agent-model-submit').click();
        await expect
          .poll(() =>
            f.window.evaluate((key) => window.agents.get(key), agentId),
          )
          .toMatchObject({ baseModel: canonical });
        await f.window.getByTestId('local-agent-detail-edit').click();
        await f.window
          .getByTestId('agent-model-base-model')
          .getByTestId('chat-model-picker')
          .click();
        await expect(
          f.window
            .getByTestId(`chat-model-option-${canonical}`)
            .filter({ visible: true }),
        ).toHaveAttribute('aria-checked', 'true');
        await expect(accountRow).toHaveCount(0);
      } finally {
        if (rendererErrors.length > 0) {
          await testInfo.attach('renderer-errors', {
            body: JSON.stringify(rendererErrors, null, 2),
            contentType: 'application/json',
          });
        }
        await f.close();
      }
    });
  }
}
