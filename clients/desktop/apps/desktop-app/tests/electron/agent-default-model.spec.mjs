// CAN-3999: an Agent can use "Default model". A chat that picks it pins the
// chat's Settings default once; later Settings changes only reach new chats.
// Shared/public imports keep the default. Seeded, mock providers, no network.
//
//   pnpm run test:electron:built agent-default-model.spec.mjs --reporter=line
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectModelOption } from './model-selection-fixture.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const AGENT_ID = 'agent_model_follows_default';
const IMPORTED_ID = 'agent_model_shared_default';

function seedDefaults(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify({
      version: 1,
      preferences: {
        defaultWorktreeProvider: 'claude',
        defaultWorktreeModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
        },
      },
    })}\n`,
  );
}

function readTabs(window) {
  return window.evaluate(
    async ({ projectId, worktreeId }) => {
      const { tabsFile } = await window.api.chat.getState({
        projectId,
        worktreeId,
      });
      return {
        activeTabId: tabsFile.activeTabId,
        models: Object.fromEntries(tabsFile.tabs.map((t) => [t.id, t.model])),
      };
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

async function startChatWithAgent(app, window, expectedModel) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await window.getByTestId('panel-add-tab-group-chat').click();
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await picker.click();
  await selectModelOption(window, AGENT_ID);
  await expect(picker).toContainText('Follows Default');
  await expect
    .poll(async () => {
      const { activeTabId, models } = await readTabs(window);
      return models[activeTabId];
    })
    .toBe(expectedModel);
  return (await readTabs(window)).activeTabId;
}

test('an Agent on the default model pins each new chat to its Settings default', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-default-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'seeded', title: 'Seeded chat', model: 'sonnet' }],
  });
  seedDefaults(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // 1. Create the Agent with "Default model".
    await app.openMarketplaceAgents();
    await app.createMarketplaceAgent();
    await window.getByTestId('agent-model-name').fill('Follows Default');
    await window.getByTestId('agent-model-base-default').check();
    await expect(window.getByTestId('agent-model-base-model')).toHaveCount(0);
    await window.getByTestId('agent-model-instructions').fill('Be brief.');
    await window.getByTestId('agent-model-submit').click();
    const createdDetail = await app.openLocalAgentDetail(AGENT_ID);
    await expect(createdDetail).toContainText('Default model');
    await app.closeMarketplaceEntryDetail();
    expect(
      await window.evaluate((id) => window.agents.get(id), AGENT_ID),
    ).toMatchObject({ baseModel: 'default' });

    // 2. Picking it in a chat pins the current worktree default.
    const firstChat = await startChatWithAgent(
      app,
      window,
      `${AGENT_ID}@sonnet`,
    );

    // 3. A Settings change reaches new chats only. The Settings UI reloads
    // the renderer's defaults after saving; a reload does the same here.
    await window.evaluate(() =>
      window.api.savePreferences({ defaultWorktreeProvider: 'codex' }),
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    const secondChat = await startChatWithAgent(
      app,
      window,
      `${AGENT_ID}@gpt-5.6-sol`,
    );
    expect(secondChat).not.toBe(firstChat);
    expect((await readTabs(window)).models[firstChat]).toBe(
      `${AGENT_ID}@sonnet`,
    );

    // 4. A public import keeps "Default model".
    const imported = await window.evaluate(
      (id) =>
        window.agents.importPublic({
          agent: {
            version: 1,
            id,
            name: 'Shared Default',
            baseModel: 'default',
            instructions: 'Review the change.',
            plugins: [],
          },
          externalId: '3f6c2a8e-6d4b-4f53-9b1e-2a7d5c9e0f11',
          contentHash: 'sha256-can-3999-e2e',
        }),
      IMPORTED_ID,
    );
    expect(imported).toMatchObject({ id: IMPORTED_ID, baseModel: 'default' });
    expect(
      await window.evaluate((id) => window.agents.get(id), IMPORTED_ID),
    ).toMatchObject({ baseModel: 'default' });
    await app.openMarketplaceAgents();
    const importedDetail = await app.openLocalAgentDetail(IMPORTED_ID);
    await expect(importedDetail).toContainText('Default model');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
