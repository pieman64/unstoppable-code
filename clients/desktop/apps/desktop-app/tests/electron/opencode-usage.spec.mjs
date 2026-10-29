import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { seedAgentModels } from './seeders/index.mjs';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';

for (const failure of [false, true]) {
  test(`OpenCode reports turn usage and clears it on ${failure ? 'failed initialization' : 'an unreported follow-up'}`, async () => {
    const fixture = await launchOpenCodeSelectionFixture({
      env: { OPENCODE_FIXTURE_USAGE: '1' },
    });
    try {
      await fixture.connect();
      await fixture.select();
      await fixture.send('OPENCODE_USAGE_REPORTED');
      await expect(
        fixture.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
      ).toBeVisible();
      await expect(
        fixture.panel.getByRole('button', {
          name: 'Stop generation',
          exact: true,
        }),
      ).toHaveCount(0);
      await fixture.panel.getByTestId('usage-indicator').click();
      const popover = fixture.window.getByTestId('usage-indicator-popover');
      await expect(popover).toContainText('Latest reported turn');
      // V2 reports turn tokens but only cumulative session cost. Do not label
      // that total as the price of this turn.
      await expect(popover).not.toContainText('Estimated cost');
      await expect(popover).not.toContainText('$100.75');
      await expect(popover).toContainText('Reasoning');
      await expect(popover).toContainText('1.2k');
      await expect(popover).toContainText('10.0k');
      await expect(popover).not.toContainText('Turns');
      await expect(popover).not.toContainText('See detailed breakdown');
      await fixture.window.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(fixture.panel.getByTestId('usage-indicator')).toBeFocused();
      await fixture.panel.getByTestId('usage-indicator').click();
      await expect(popover).toContainText('Latest reported turn');
      await expect(popover).toContainText('Reasoning');
      await expect(popover).toContainText('1.2k');
      await expect(popover).toContainText('10.0k');
      await fixture.restart();
      await fixture.openChat();
      await fixture.panel.getByTestId('usage-indicator').click();
      await expect(
        fixture.window.getByTestId('usage-indicator-popover'),
      ).toContainText('Latest reported turn');
      await expect(
        fixture.window.getByTestId('usage-indicator-popover'),
      ).not.toContainText('Estimated cost');
      await fixture.panel.getByTestId('usage-indicator').click();
      if (failure)
        await writeFile(
          path.join(fixture.worktreePath, '.fixture-usage-init-failure'),
          'fail',
        );
      await fixture.send('Follow up without a usage report.');
      if (failure) {
        await expect(
          fixture.panel.getByText('Error: ACP agent request failed', {
            exact: true,
          }),
        ).toBeVisible();
        // The recovery panel replaces the composer after failed initialization.
        // Verify the canonical report before any recovery action can reset it.
        await expect
          .poll(async () => (await fixture.tab())?.usage?.opencodeReportedUsage)
          .toBeUndefined();
        expect((await fixture.tab())?.usage).toMatchObject({
          contextTokens: 0,
          contextWindow: 0,
        });
        return;
      } else
        await expect(
          fixture.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
        ).toBeVisible();
      await expect(
        fixture.panel.getByRole('button', {
          name: 'Stop generation',
          exact: true,
        }),
      ).toHaveCount(0);
      await fixture.panel.getByTestId('usage-indicator').click();
      const cleared = fixture.window.getByTestId('usage-indicator-popover');
      await expect(cleared).toContainText(
        'OpenCode has not reported token usage for this turn.',
      );
      await expect(cleared).not.toContainText('Estimated cost');
      await expect(cleared).not.toContainText('1.2k');
      await expect(cleared).not.toContainText('$0.0000');
    } finally {
      await fixture.close();
    }
  });
}

test('a saved OpenCode Agent shows its reported turn usage', async () => {
  const agentId = 'agent_model_usage_reviewer';
  const fixture = await launchOpenCodeSelectionFixture({
    env: { OPENCODE_FIXTURE_USAGE: '1' },
    seedBeforeLaunch: ({ userDataDir }) =>
      seedAgentModels(userDataDir, [
        {
          id: agentId,
          name: 'Usage reviewer',
          baseModel: 'opencode:fixture%2Fmodel',
          instructions: 'Be brief.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        },
      ]),
  });
  try {
    await fixture.connect();
    await fixture.openChat();
    await fixture.panel.getByTestId('chat-model-picker').click();
    await fixture.window.getByTestId('chat-model-harness-tab-opencode').click();
    await fixture.window.getByTestId(`chat-model-option-${agentId}`).click();
    await expect.poll(async () => (await fixture.tab())?.model).toBe(agentId);
    await fixture.send('OPENCODE_USAGE_REPORTED');
    await expect(
      fixture.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(
      fixture.panel.getByRole('button', {
        name: 'Stop generation',
        exact: true,
      }),
    ).toHaveCount(0);
    await fixture.panel.getByTestId('usage-indicator').click();
    const popover = fixture.window.getByTestId('usage-indicator-popover');
    await expect(popover).toContainText('Latest reported turn');
    await expect(popover).not.toContainText('Estimated cost');
    await expect(popover).not.toContainText('$100.75');
    await expect(popover).toContainText('Reasoning');
    await expect(popover).not.toContainText('See detailed breakdown');
  } finally {
    await fixture.close();
  }
});
