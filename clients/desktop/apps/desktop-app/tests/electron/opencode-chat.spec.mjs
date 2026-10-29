import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { opencodeRuntimeFixture } from './fixtures/opencode-runtime.mjs';

// Real main/preload chat and Agent persistence. Only the downloaded provider
// executable is the offline ACP fixture, whose model has no effort variants.
test('an OpenCode-backed Agent completes a chat with the default high thinking level', async ({}, testInfo) => {
  const fixture = await opencodeRuntimeFixture();
  const lifecycleLog = testInfo.outputPath('agent-chat-lifecycle.jsonl');
  mkdirSync(path.dirname(lifecycleLog), { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'opencode-agent-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'opencode',
    tabs: [
      {
        id: 'opencode-agent-chat',
        title: 'OpenCode Agent chat',
        thinkingLevel: 'high',
      },
    ],
  });
  let launched;
  try {
    launched = await launchCanopy({
      userDataDir,
      env: {
        ...fixture.env,
        XDG_DATA_HOME: path.join(userDataDir, 'opencode-native-data'),
        OPENCODE_FIXTURE_EFFORT: 'absent',
        OPENCODE_FIXTURE_LIFECYCLE_LOG: lifecycleLog,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-opencode-harness': true,
        }),
      },
    });
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await window.evaluate(() => window.api.opencodeConnection.connect());
    const agent = await window.evaluate(() =>
      window.agents.save({
        name: 'OpenCode fixture Agent',
        baseModel: 'opencode:fixture%2Fmodel',
        instructions: 'Respond to the user using the configured provider.',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
    );
    await driver.openMainPage();
    await driver.selectWorktree('demo-main', {
      expandDefaultActivityRail: false,
    });
    await window.evaluate(
      (model) =>
        window.api.chat.sendMessage({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          chatId: 'opencode-agent-chat',
          userMessageId: 'opencode-agent-prompt',
          text: 'Hello from the OpenCode Agent test.',
          model,
          thinkingLevel: 'high',
        }),
      agent.id,
    );
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect
      .poll(() =>
        window
          .evaluate(() =>
            window.api.chat.loadTabs({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            }),
          )
          .then((tabs) => JSON.stringify(tabs)),
      )
      .toContain('OpenCode fixture reply 1.');
    const requests = readFileSync(lifecycleLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.some((entry) => entry.method === 'session/prompt')).toBe(
      true,
    );
    expect(requests.some((entry) => entry.configId === 'effort')).toBe(false);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
    await fixture.close();
  }
});
