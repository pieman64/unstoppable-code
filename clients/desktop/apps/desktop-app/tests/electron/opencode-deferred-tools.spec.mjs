import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
import { seedDeferredEchoServer } from './seeders/deferredToolsReloadFixture.mjs';

test('OpenCode persists the native load result before retiring and resuming once with the selected MCP tool', async () => {
  test.setTimeout(120_000);
  let logPath;
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
    env: { OPENCODE_FIXTURE_DEFERRED_GATE: '1' },
    seedBeforeLaunch({ userDataDir }) {
      ({ logPath } = seedDeferredEchoServer(userDataDir));
    },
  });
  try {
    await f.connect();
    await f.select();
    const prompt =
      'OPENCODE_DEFERRED_LOAD: search for the requested fixture, load it and use its echo tool.';
    await f.send(prompt);
    await expect
      .poll(() =>
        existsSync(
          path.join(f.worktreePath, '.opencode-deferred-tools-listed'),
        ),
      )
      .toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          path.join(f.worktreePath, '.opencode-deferred-tools-listed'),
          'utf8',
        ),
      ),
    ).toEqual(
      expect.arrayContaining(['SearchDeferredTools', 'LoadDeferredTools']),
    );
    await expect
      .poll(
        () =>
          existsSync(
            path.join(f.worktreePath, '.opencode-deferred-http-result'),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const pending = await f.tab();
    expect(pending.pluginSelections?.mcpServerRefs ?? []).toEqual([]);
    expect(
      existsSync(path.join(f.worktreePath, '.opencode-deferred-resumed')),
    ).toBe(false);
    expect(existsSync(logPath)).toBe(false);
    writeFileSync(
      path.join(f.worktreePath, '.opencode-deferred-allow-completion'),
      'continue',
    );
    await expect(
      f.panel.getByText('OpenCode resumed once with its requested MCP tool.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const resumed = JSON.parse(
      readFileSync(
        path.join(f.worktreePath, '.opencode-deferred-resumed'),
        'utf8',
      ),
    );
    expect(resumed.after.turns).toBe(resumed.before.turns + 1);
    expect(resumed.after.pid).not.toBe(resumed.before.pid);
    expect(resumed.after.sessionId).toBe(resumed.before.sessionId);
    await expect
      .poll(() => {
        try {
          process.kill(resumed.before.pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      })
      .toBe(false);
    const final = await f.tab();
    expect(final.pluginSelections.mcpServerRefs).toContainEqual({
      serverId: 'dr',
      configId: 'd',
    });
    expect(
      final.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(
      final.messages.filter((message) => message.role === 'user')[0].blocks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('OPENCODE_DEFERRED_LOAD'),
        }),
      ]),
    );
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
      'called: OpenCode after reload',
    ]);
    await expect(
      f.panel.getByText(
        'Requested items now enabled, continue the interrupted request.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await f.restart();
    await f.openChat();
    await expect(
      f.panel.getByText('OpenCode resumed once with its requested MCP tool.', {
        exact: true,
      }),
    ).toBeVisible();
    expect((await f.tab()).sdkSessionId).toBe(final.sdkSessionId);
  } finally {
    await f.close();
  }
});

for (const surface of ['Cowork', 'App Advisor']) {
  test(`OpenCode loads and resumes with a selected tool in ${surface}`, async () => {
    test.setTimeout(120_000);
    let logPath;
    const f = await launchOpenCodeSelectionFixture({
      seedBeforeLaunch({ userDataDir }) {
        ({ logPath } = seedDeferredEchoServer(userDataDir));
        if (surface === 'Cowork')
          seedCoworkWorkspace({
            userDataDir,
            mergeIndex: true,
            collapsed: false,
            externalPath: path.join(
              userDataDir,
              'workspaces/demo-ts-pnpm-vite',
            ),
          });
      },
    });
    try {
      await f.connect();
      let win = f.window;
      let composer;
      let controls;
      let send;
      if (surface === 'Cowork') {
        await win.getByTestId('sidebar-create-task').click();
        const home = win.getByTestId('page-home');
        await home.getByTestId('home-workspace-select').click();
        await win.getByTestId('home-workspace-option-seeded-cowork').click();
        controls = home;
        composer = home.getByTestId('home-composer-editor');
        send = home.getByTestId('home-send-button');
      } else {
        win = await f.driver.openAppAdvisorWindow(f.app);
        await win.setViewportSize({ width: 1200, height: 800 });
        controls = win;
        composer = win.getByRole('textbox').first();
        send = win.getByRole('button', { name: 'Send message', exact: true });
      }
      await controls
        .getByTestId('chat-model-picker')
        .filter({ visible: true })
        .first()
        .click();
      await win.getByTestId('chat-model-harness-tab-opencode').click();
      await win
        .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
        .click();
      await controls
        .getByTestId('approval-mode-picker')
        .filter({ visible: true })
        .first()
        .click();
      await win.getByTestId('approval-mode-option-full-access').click();
      await composer.fill(
        'OPENCODE_DEFERRED_LOAD: load the requested fixture and use its echo tool.',
      );
      await send.click();
      await expect(
        win.getByText('OpenCode resumed once with its requested MCP tool.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(win.getByTestId('chat-stop-generation')).toBeHidden();
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'called: OpenCode after reload',
      ]);
      await expect(
        win.getByText(
          'Requested items now enabled, continue the interrupted request.',
          { exact: true },
        ),
      ).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}

test('OpenCode retains the disabled discovery grant and withdraws both tools', async () => {
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.select();
    await f.panel.getByTestId('chat-input-plus-button').click();
    await f.window.getByTestId('chat-plugins-button').click();
    const dialog = f.window.getByRole('dialog').filter({ hasText: 'Plugins' });
    await dialog.getByTestId('chat-plugins-deferred-tools-toggle').click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => (await f.tab()).deferredToolsAllowed)
      .toBe(false);
    await f.restart();
    await f.openChat();
    expect((await f.tab()).deferredToolsAllowed).toBe(false);
    await f.send('OPENCODE_DEFERRED_DISABLED');
    await expect(
      f.panel.getByText('OpenCode discovery tools are disabled.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('Stop before the native load result prevents capability enablement and continuation', async () => {
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
    env: { OPENCODE_FIXTURE_DEFERRED_GATE: '1' },
    seedBeforeLaunch({ userDataDir }) {
      seedDeferredEchoServer(userDataDir);
    },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_DEFERRED_LOAD');
    await expect
      .poll(
        () =>
          existsSync(
            path.join(f.worktreePath, '.opencode-deferred-http-result'),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await f.panel.getByTestId('chat-stop-generation').click();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    writeFileSync(
      path.join(f.worktreePath, '.opencode-deferred-allow-completion'),
      'too late',
    );
    expect((await f.tab()).pluginSelections?.mcpServerRefs ?? []).toEqual([]);
    await f.send('Continue after cancelling discovery');
    await expect(
      f.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
    ).toBeVisible();
    expect((await f.tab()).pluginSelections?.mcpServerRefs ?? []).toEqual([]);
    expect(
      existsSync(path.join(f.worktreePath, '.opencode-deferred-resumed')),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
