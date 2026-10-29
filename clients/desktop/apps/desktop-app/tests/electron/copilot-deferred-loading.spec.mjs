import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedDeferredEchoServer, seedWorktreeChat } from './seeders/index.mjs';

for (const mode of ['allowed', 'opt-out', 'duplicate']) {
  const allowed = mode !== 'opt-out';
  const name =
    mode === 'duplicate'
      ? 'rejects concurrent identical loads and resumes the first call'
      : allowed
        ? 'resumes one conversation with the newly enabled tool'
        : 'honors the chat opt-out';
  test(`Copilot deferred loading ${name}`, async () => {
    test.setTimeout(150_000);
    let echoLog;
    const f = await launchCopilotSelectionFixture({
      approvalMode: 'full-access',
      seedBeforeLaunch: ({ userDataDir }) => {
        echoLog = seedDeferredEchoServer(userDataDir).logPath;
        seedWorktreeChat({
          userDataDir,
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          providerType: 'claude',
          tabs: [
            {
              id: 'copilot-selection',
              title: 'Copilot integration',
              model: 'sonnet',
              approvalMode: 'full-access',
              deferredToolsAllowed: allowed,
            },
          ],
        });
      },
    });
    try {
      await f.connect();
      await f.select();
      const prompt =
        mode === 'duplicate'
          ? 'COPILOT_DEFERRED_LOAD_DUPLICATE: enable the installed fixture when two identical loads race.'
          : allowed
            ? 'COPILOT_DEFERRED_LOAD: find, enable and use the installed fixture.'
            : 'COPILOT_DEFERRED_POLICY: verify the disabled discovery policy.';
      await f.send(prompt);
      await expect(f.panel).toContainText(
        allowed
          ? 'Copilot loaded and resumed once.'
          : 'Copilot deferred discovery is disabled.',
        { timeout: 75_000 },
      );
      await expect(f.panel.getByText(prompt, { exact: true })).toHaveCount(1);
      await expect(
        f.panel.getByText('OLD_TURN_SHOULD_NOT_CONTINUE'),
      ).toHaveCount(0);
      await expect(
        f.panel.getByText('Requested items now enabled', { exact: false }),
      ).toHaveCount(0);
      const calls =
        echoLog && existsSync(echoLog)
          ? readFileSync(echoLog, 'utf8').trim().split('\n').filter(Boolean)
          : [];
      expect(calls).toEqual(allowed ? ['called: copilot after reload'] : []);
      const tab = await f.tab();
      expect(tab.pluginSelections?.mcpServerRefs ?? []).toEqual(
        allowed ? [{ serverId: 'dr', configId: 'd' }] : [],
      );
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}

test('Copilot App Advisor reloads one conversation with the selected tool', async () => {
  test.setTimeout(150_000);
  let echoLog;
  const f = await launchCopilotSelectionFixture({
    seedBeforeLaunch: ({ userDataDir }) => {
      echoLog = seedDeferredEchoServer(userDataDir).logPath;
    },
  });
  try {
    await f.connect();
    const advisor = await f.driver.openAppAdvisorWindow(f.app);
    await advisor.setViewportSize({ width: 1200, height: 800 });
    const composer = advisor.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await advisor
      .getByTestId('chat-model-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('chat-model-harness-tab-copilot').click();
    await advisor
      .getByTestId('chat-model-option-copilot:fixture-model')
      .click();
    await advisor
      .getByTestId('approval-mode-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('approval-mode-option-full-access').click();
    const prompt =
      'COPILOT_DEFERRED_LOAD: find, enable and use the installed fixture.';
    await composer.fill(prompt);
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      advisor.getByText('Copilot loaded and resumed once.', { exact: true }),
    ).toBeVisible({ timeout: 75_000 });
    await expect(advisor.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(advisor.getByText('OLD_TURN_SHOULD_NOT_CONTINUE')).toHaveCount(
      0,
    );
    expect(
      echoLog && existsSync(echoLog)
        ? readFileSync(echoLog, 'utf8').trim().split('\n')
        : [],
    ).toEqual(['called: copilot after reload']);
  } finally {
    await f.close();
  }
});
