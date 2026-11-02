import { expect, test } from '@playwright/test';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';

async function scheduledMessage(f, prompt) {
  const snapshot = await f.window.evaluate(() => window.api.automations.list());
  return snapshot.activities.find(
    (activity) =>
      activity.action.type === 'worktree_session_prompt' &&
      activity.action.chatId === f.target.chatId &&
      activity.action.prompt === prompt,
  );
}

test('OpenCode scheduled message survives restart and resumes the same chat', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Before scheduling');
    await expect(f.panel).toContainText('OpenCode fixture reply 1.');
    const before = await f.tab();
    const prompt = 'Continue with the scheduled message';
    await f.panel.getByRole('textbox').first().fill(prompt);
    await f.panel.getByTestId('chat-input-plus-button').click();
    await f.window.getByTestId('chat-input-schedule-button').click();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await f.window
      .getByTestId('schedule-message-date')
      .fill(tomorrow.toISOString().slice(0, 10));
    await f.window.getByTestId('schedule-message-time').fill('12:00');
    await f.window.getByTestId('schedule-message-save').click();
    await expect(
      f.panel.getByTestId('chat-input-scheduled-send-pill'),
    ).toBeVisible();
    await f.panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect
      .poll(async () => (await scheduledMessage(f, prompt))?.id)
      .toBeTruthy();
    const scheduled = await scheduledMessage(f, prompt);
    expect(scheduled.action).toMatchObject({
      workspaceId: f.target.projectId,
      worktreeId: f.target.worktreeId,
      chatId: f.target.chatId,
      purpose: 'scheduled_send',
    });
    await expect(f.panel).not.toContainText('OpenCode fixture reply 2.');
    await expect(
      f.panel.getByTestId('chat-input-scheduled-send-pill'),
    ).toBeHidden();
    await f.restart();
    await f.openChat();
    expect((await scheduledMessage(f, prompt))?.id).toBe(scheduled.id);
    // The real automation dispatch is used without waiting a day for its clock.
    const run = await f.window.evaluate(
      (id) => window.api.automations.runNow({ id }),
      scheduled.id,
    );
    expect(run).toMatchObject({ ok: true, run: { status: 'success' } });
    await expect(f.panel).toContainText('OpenCode fixture reply 2.');
    // CAN-4549 D4: a composer-scheduled send stays the user's own message.
    await expect(f.panel.getByTestId('agent-sent-title')).toHaveCount(0);
    expect(await f.tab()).toMatchObject({
      sdkSessionId: before.sdkSessionId,
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
    });
  } finally {
    await f.close();
  }
});

test('OpenCode scheduled message fails before dispatch after disconnect', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    const prompt = 'Must not run while disconnected';
    const created = await f.window.evaluate(
      ({ target, prompt }) =>
        window.api.automations.create({
          name: 'OpenCode disconnect regression',
          schedule: {
            kind: 'one_time',
            runAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            timezone: 'local',
          },
          action: {
            type: 'worktree_session_prompt',
            workspaceId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
            prompt,
            purpose: 'scheduled_send',
          },
        }),
      { target: f.target, prompt },
    );
    expect(created.ok).toBe(true);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('opencode-connect').click();
    await expect(f.window.getByTestId('opencode-connection-status')).toHaveText(
      'Ready to connect',
    );
    await f.driver.closeSettings();
    await f.openChat();
    const before = await f.tab();
    const run = await f.window.evaluate(
      (id) => window.api.automations.runNow({ id }),
      created.activity.id,
    );
    expect(run).toMatchObject({ ok: true, run: { status: 'failure' } });
    expect(run.run.error).toMatch(
      /OpenCode.*(connect|unavailable)|Connect OpenCode/i,
    );
    expect((await f.tab()).messages).toEqual(before.messages);
    await expect(f.panel).not.toContainText('OpenCode fixture reply');
  } finally {
    await f.close();
  }
});
