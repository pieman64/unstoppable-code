import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import { INVOCABLE_INVENTORY_CACHE_VERSION } from './seeders/invocableInventoryCache.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedPluginConnectionDesign,
  installPluginConnectionDesignHandlers,
} from './pluginConnectionDesignFixture.mjs';
import {
  publisherSkills,
  startPublisherSkillsFixture,
} from './publisherSkillsFixture.mjs';

for (const inventoryWhileStaging of [false, true]) {
  test(`CAN-5218 Grace installs a share and stages one editable worktree draft${inventoryWhileStaging ? ' with inventory selection during staging' : ''}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-try-it-draft-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    if (inventoryWhileStaging) {
      const { cacheFilePath } = seedPluginsCache({ userDataDir });
      const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
      const plugin = cache.marketplaces[0].plugins.find(
        (entry) => entry.name === 'delta-tool',
      );
      plugin.facets.claude = {
        provider: 'claude',
        mode: 'native',
        name: plugin.name,
        sourcePath: plugin.sourcePath,
        details: {
          ...plugin.details,
          commands: [
            {
              name: 'delta-command',
              description: 'Delta command',
              filePath: 'commands/delta-command.md',
            },
          ],
        },
      };
      writeFileSync(cacheFilePath, JSON.stringify(cache));
      writeFileSync(
        path.join(userDataDir, 'invocable-inventory-cache.json'),
        JSON.stringify({
          version: INVOCABLE_INVENTORY_CACHE_VERSION,
          builtAt: '2026-10-30T00:00:00.000Z',
          entries: [
            {
              id: 'claude:plugin_command:demo/market:delta-tool:delta-command',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'delta-command',
              displayName: '/delta-command',
              description: 'Delta command',
              insertText: '/delta-command ',
              invocationKey: '/delta-command',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'demo/market',
                pluginName: 'delta-tool',
              },
              sourceLabel: 'delta-tool',
            },
          ],
        }),
      );
    }
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      activeTabId: 'incident-chat',
      tabs: [
        {
          id: 'incident-chat',
          title: 'Checkout latency spike',
          messages: [
            {
              id: 'previous-request',
              role: 'user',
              blocks: [{ type: 'text', text: 'Review the previous incident.' }],
              timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
            },
            {
              id: 'previous-response',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Checkout latency is elevated.' }],
              timestamp: Date.parse('2026-04-10T12:00:01.000Z'),
            },
          ],
        },
      ],
    });
    const fixture = await startPublisherSkillsFixture();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const editor = window
        .locator('[data-slate-editor="true"]:visible')
        .first();
      await editor.fill('Preserve the incident evidence.');
      await window.evaluate(() =>
        document.dispatchEvent(
          new CustomEvent('canopy:insert-file-reference', {
            detail: {
              displayPath: 'INCIDENT.md',
              absolutePath: '/fixture/INCIDENT.md',
            },
          }),
        ),
      );
      const pill = editor.locator('[data-slate-void="true"]');
      await expect(pill).toHaveCount(1);
      const reference = await pill.innerHTML();
      await editor.press('ControlOrMeta+Home');
      await editor.press('Shift+ArrowRight');
      const readChat = () =>
        window.evaluate(async () => {
          const state = await window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          });
          return {
            ids: state.tabsFile.tabs.map((tab) => tab.id),
            messages: state.tabsFile.tabs.map((tab) => tab.messages),
            queue: state.queue,
          };
        });
      const before = await readChat();
      const skill = publisherSkills[0];
      await electronApp.evaluate(
        ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
        `canopy://share/skills/${skill.externalId}`,
      );
      const landing = window.getByTestId('deep-link-share-landing');
      await expect(landing).toBeVisible();
      await landing.getByTestId('deep-link-share-install').click();
      await expect(landing).toHaveCount(0);
      await expect
        .poll(() =>
          existsSync(
            path.join(
              userDataDir,
              'skills',
              'custom:app',
              skill.name,
              'SKILL.md',
            ),
          ),
        )
        .toBe(true);
      const openDetail = async (selectedSkill = skill, forceList = false) => {
        await window.getByTestId('sidebar-nav-plugins').click();
        const primary = window.getByTestId('detail-primary-cta');
        await expect(
          primary.or(
            window.getByRole('heading', { name: 'Customize', exact: true }),
          ),
        ).toBeVisible();
        if ((await primary.isVisible()) && !forceList) {
          await primary.click();
          return;
        }
        if (await primary.isVisible())
          await window
            .getByTestId('plugins-entry-detail-breadcrumb-root')
            .click();
        await app.openPluginsTab('skills');
        await window
          .getByTestId('plugins-search')
          .fill(selectedSkill.displayName);
        await window
          .getByTestId('customize-section-installed')
          .getByText(selectedSkill.displayName, { exact: true })
          .click();
        await window.getByTestId('deep-link-share-kebab').click();
        await window.getByTestId('deep-link-share-manage').click();
        await window.getByTestId('detail-primary-cta').click();
      };
      await openDetail();
      await expect(editor).toContainText('Preserve the incident evidence.');
      await expect(pill).toHaveCount(1);
      expect(await pill.innerHTML()).toBe(reference);
      await expect(
        window.getByTestId('panel-tab-panel-chat-incident-chat'),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(editor).toBeFocused();
      await expect
        .poll(() =>
          window.evaluate(async (skillName) => {
            const state = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return state.tabsFile.tabs.find((tab) => tab.id === 'incident-chat')
              ?.pluginSelections?.skillRefs;
          }, skill.name),
        )
        .toContainEqual({ sourceId: 'custom:app', skillName: skill.name });
      const staged = await editor.innerText();
      expect(staged.length).toBeGreaterThan(
        'Preserve the incident evidence.'.length,
      );
      expect(await readChat()).toEqual(before);
      // Slate mirrors native selection on a 100 ms throttle. Replace the rich
      // draft with ordinary typing after select-all has had time to settle.
      await expect(async () => {
        await editor.press('ControlOrMeta+A', { delay: 150 });
        await editor.pressSequentially('My edited incident prompt', {
          delay: 10,
        });
        await expect(editor).toHaveText('My edited incident prompt', {
          timeout: 1_000,
        });
      }).toPass({ timeout: 15_000 });
      await window
        .getByRole('button', { name: `Remove ${skill.name} from this chat` })
        .click();
      await openDetail();
      await expect(editor).toHaveText('My edited incident prompt');
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const state = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return state.tabsFile.tabs.find((tab) => tab.id === 'incident-chat')
              ?.pluginSelections?.skillRefs;
          }),
        )
        .toContainEqual({ sourceId: 'custom:app', skillName: skill.name });
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(editor).toHaveText('My edited incident prompt');
      expect(await readChat()).toEqual(before);
      await window.evaluate(() =>
        document.dispatchEvent(
          new CustomEvent('canopy:insert-file-reference', {
            detail: {
              displayPath: 'INCIDENT.md',
              absolutePath: '/fixture/INCIDENT.md',
            },
          }),
        ),
      );
      await expect(pill).toHaveCount(1);
      const editedRichDraft = await editor.innerText();
      await editor.press('Escape');
      await editor.press('ControlOrMeta+A');
      await editor.press('ArrowLeft');
      // Wait for Slate to mirror selection and show the history preview.
      await expect
        .poll(
          async () => {
            const text = await editor.innerText();
            if (text === 'Review the previous incident.') return text;
            await editor.press('ArrowUp');
            return editor.innerText();
          },
          { intervals: [150, 250], timeout: 15_000 },
        )
        .toBe('Review the previous incident.');
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(editor).toHaveText(editedRichDraft);
      await expect(pill).toHaveCount(1);
      expect(await readChat()).toEqual(before);
      // A different capability needs a fresh insertion while history is visible.
      const retainedReference = await pill.innerHTML();
      const nextSkill = publisherSkills[1];
      await electronApp.evaluate(
        ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
        `canopy://share/skills/${nextSkill.externalId}`,
      );
      await expect(landing).toBeVisible();
      await landing.getByTestId('deep-link-share-install').click();
      await expect(landing).toHaveCount(0);
      await electronApp.evaluate(
        ({ ipcMain }, { skillName, inventory }) => {
          const original = ipcMain._invokeHandlers.get('chat:update-plugins');
          ipcMain.removeHandler('chat:update-plugins');
          let held = false;
          let inventoryWrite;
          ipcMain.handle('chat:update-plugins', async (event, request) => {
            if (
              held &&
              request.pluginSelections.pluginRefs.some(
                (ref) => ref.pluginName === 'delta-tool',
              )
            ) {
              inventoryWrite = original(event, request);
              return inventoryWrite;
            }
            if (
              !held &&
              request.pluginSelections.skillRefs.some(
                (ref) => ref.skillName === skillName,
              )
            ) {
              held = true;
              const result = inventory
                ? undefined
                : await original(event, request);
              globalThis.__tryItPluginsHeld = true;
              await new Promise((resolve) => {
                globalThis.__releaseTryItPlugins = async () => {
                  await inventoryWrite;
                  resolve();
                };
              });
              return inventory ? original(event, request) : result;
            }
            return original(event, request);
          });
        },
        { skillName: nextSkill.name, inventory: inventoryWhileStaging },
      );
      await openDetail(nextSkill, true);
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__tryItPluginsHeld))
        .toBe(true);
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(editor).toHaveText(editedRichDraft);
      if (inventoryWhileStaging) {
        await window.evaluate(() =>
          document.dispatchEvent(
            new CustomEvent('canopy:insert-chat-text', {
              detail: { text: '/delt' },
            }),
          ),
        );
        await editor.press('a');
        const command = window.getByTestId(
          'chat-input-capability-delta-command',
        );
        await expect(command).toBeVisible();
        await command.click();
        await expect(editor).toContainText('/delta-command');
      }
      await editor.press('Escape');
      if (inventoryWhileStaging) {
        await window.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await editor.click({ position: { x: 1, y: 5 } });
        await editor.press('Home');
      } else {
        await editor.press('ControlOrMeta+A');
        await editor.press('ArrowLeft');
      }
      await expect
        .poll(
          async () => {
            if ((await editor.innerText()) !== 'Review the previous incident.')
              await editor.press('ArrowUp');
            return editor.innerText();
          },
          { intervals: [150, 250], timeout: 15_000 },
        )
        .toBe('Review the previous incident.');
      await electronApp.evaluate(() => globalThis.__releaseTryItPlugins());
      await expect(editor).toContainText('My edited incident prompt');
      await expect(editor).toContainText(nextSkill.name);
      await expect(editor).not.toContainText('Review the previous incident.');
      await expect(pill).toHaveCount(1);
      expect(await pill.innerHTML()).toBe(retainedReference);
      if (inventoryWhileStaging) {
        await expect(editor).toContainText('/delta-command');
        await expect(
          window
            .getByTestId('chat-plugins-activity')
            .getByText('delta-tool', { exact: true }),
        ).toBeVisible();
      }
      const expectSelections = async () => {
        if (!inventoryWhileStaging) return;
        const state = await window.evaluate(() =>
          window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
        const selections = state.tabsFile.tabs.find(
          (tab) => tab.id === 'incident-chat',
        )?.pluginSelections;
        expect(selections?.pluginRefs).toContainEqual({
          marketplaceId: 'demo/market',
          pluginName: 'delta-tool',
        });
        expect(selections?.skillRefs).toContainEqual(
          expect.objectContaining({ skillName: nextSkill.name }),
        );
      };
      await expectSelections();
      const stagedFromHistory = await editor.innerText();
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(editor).toHaveText(stagedFromHistory);
      await expectSelections();
      await expect(pill).toHaveCount(1);
      expect(await readChat()).toEqual(before);
    } finally {
      await electronApp
        .evaluate(() => globalThis.__releaseTryItPlugins?.())
        .catch(() => {});
      await closeCanopy(electronApp, userDataDir);
      await fixture.close();
    }
  });
}

for (const provider of ['copilot', 'opencode']) {
  test(`CAN-5218 keeps a compatible ${provider} worktree chat`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-try-it-provider-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPluginConnectionDesign(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: provider,
      tabs: [{ id: 'compatible-chat', title: 'Provider incident' }],
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-copilot-harness': true,
          'canopy-desktop-opencode-harness': true,
        }),
      },
    });
    try {
      await installPluginConnectionDesignHandlers(electronApp);
      const window = await electronApp.firstWindow();
      await window.reload();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const editor = window
        .locator('[data-slate-editor="true"]:visible')
        .first();
      await editor.fill('Keep this incident draft');
      const readState = () =>
        window.evaluate(() =>
          window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
      const before = await readState();
      const original = before.tabsFile.tabs.find(
        (tab) => tab.id === 'compatible-chat',
      );
      expect(original.providerType).toBe(provider);
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill('Gmail');
      await window.getByTestId('customize-row-mkt:demo/market/gmail').click();
      await expect(
        window.getByTestId(`plugin-harness-${provider}`),
      ).toContainText('Installed');
      const primary = window.getByTestId('detail-primary-cta');
      await expect(primary).toHaveText('Try it');
      await primary.click();
      await expect(editor).toContainText('Keep this incident draft');
      await expect(editor).toContainText('Gmail');
      const after = await readState();
      expect(after.tabsFile.tabs.map((tab) => tab.id)).toEqual(
        before.tabsFile.tabs.map((tab) => tab.id),
      );
      const preserved = after.tabsFile.tabs.find(
        (tab) => tab.id === 'compatible-chat',
      );
      expect(preserved?.providerType).toBe(provider);
      expect(preserved?.model).toBe(original.model);
      expect(after.tabsFile.activeTabId).toBe('compatible-chat');
      expect(after.queue).toEqual(before.queue);
      await expect(window.getByTestId('user-message-content')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('CAN-5218 creates a supported chat beside an unresolved-provider draft', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-try-it-unresolved-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPluginConnectionDesign(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'legacy-chat',
        title: 'Legacy incident',
        messages: [
          {
            id: 'previous-incident',
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep the previous incident.' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await installPluginConnectionDesignHandlers(electronApp);
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await editor.fill('Preserve the legacy incident draft.');
    const readState = () =>
      window.evaluate(() =>
        window.api.chat.getState({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      );
    const before = await readState();
    const original = before.tabsFile.tabs.find(
      (tab) => tab.id === 'legacy-chat',
    );
    expect(original.providerType).toBeUndefined();
    expect(original.model).toBeUndefined();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Gmail');
    await window.getByTestId('customize-row-mkt:demo/market/gmail').click();
    const primary = window.getByTestId('detail-primary-cta');
    await expect(primary).toHaveText('Try it');
    await primary.click();
    await expect(editor).toContainText('Gmail');
    const after = await readState();
    expect(after.tabsFile.activeTabId).not.toBe('legacy-chat');
    expect(after.tabsFile.tabs).toHaveLength(before.tabsFile.tabs.length + 1);
    const created = after.tabsFile.tabs.find(
      (tab) => tab.id === after.tabsFile.activeTabId,
    );
    expect(created.providerType).toBe('codex');
    expect(created.model).toBeTruthy();
    const preserved = after.tabsFile.tabs.find(
      (tab) => tab.id === 'legacy-chat',
    );
    expect(preserved.providerType).toBeUndefined();
    expect(preserved.model).toBeUndefined();
    expect(preserved.transcript).toEqual(original.transcript);
    expect(after.queue).toEqual(before.queue);
    await expect(window.getByTestId('user-message-content')).toHaveCount(0);
    await window.getByTestId('panel-tab-panel-chat-legacy-chat').click();
    await expect(editor).toContainText('Preserve the legacy incident draft.');
    await expect(editor).not.toContainText('Gmail');
    await expect(window.getByTestId('user-message-content')).toHaveCount(1);
    await window.getByTestId(`panel-tab-panel-chat-${created.id}`).click();
    await expect(editor).toContainText('Gmail');
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(editor).toContainText('Gmail');
    const reloaded = await readState();
    expect(
      reloaded.tabsFile.tabs.find((tab) => tab.id === created.id),
    ).toMatchObject({
      providerType: 'codex',
      model: created.model,
    });
    await window.getByTestId('panel-tab-panel-chat-legacy-chat').click();
    await expect(editor).not.toContainText('Gmail');
    await expect(window.getByTestId('user-message-content')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-5218 cancels staging when a tab switch happens during creation', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-try-it-creation-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seeded.workspaces[0].worktreePath;
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'notes-one',
    tabs: [
      { id: 'locked-chat', title: 'Read-only conversation', readOnly: true },
      {
        id: 'notes-one',
        title: 'First notes',
        kind: 'file',
        filePath: path.join(worktreePath, 'package.json'),
      },
      {
        id: 'notes-two',
        title: 'Other notes',
        kind: 'file',
        filePath: path.join(worktreePath, 'README.md'),
      },
    ],
  });
  const fixture = await startPublisherSkillsFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('chat:command');
      ipcMain.removeHandler('chat:command');
      ipcMain.handle('chat:command', async (event, request) => {
        const result = await original(event, request);
        if (
          request.command.type === 'chat.create_tab' &&
          request.command.starter !== true &&
          request.command.tabId !== 'locked-chat'
        ) {
          globalThis.__tryItHeldTab = request.command.tabId;
          await new Promise((resolve) => {
            globalThis.__releaseTryItCreation = resolve;
          });
        }
        return result;
      });
    });
    const skill = publisherSkills[0];
    await electronApp.evaluate(
      ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
      `canopy://share/skills/${skill.externalId}`,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toBeVisible();
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toHaveCount(0);
    await window.getByTestId('sidebar-nav-plugins').click();
    await app.openPluginsTab('skills');
    await window.getByTestId('plugins-search').fill(skill.displayName);
    await window
      .getByTestId('customize-section-installed')
      .getByText(skill.displayName, { exact: true })
      .click();
    await window.getByTestId('deep-link-share-kebab').click();
    await window.getByTestId('deep-link-share-manage').click();
    await window.getByTestId('detail-primary-cta').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__tryItHeldTab))
      .toBeTruthy();
    const heldTab = await electronApp.evaluate(() => globalThis.__tryItHeldTab);
    expect(
      await window.evaluate(
        (chatId) =>
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('canopy:try-it-launch:'))
            .some(([, raw]) => JSON.parse(raw).chatId === chatId),
        heldTab,
      ),
    ).toBe(true);
    await app.openMainPage();
    const other = window.getByTestId('panel-tab-panel-file-notes-two');
    await other.click();
    await expect(other).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const state = await window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          });
          return state.tabsFile.activeTabId;
        }),
      )
      .toBe('notes-two');
    await electronApp.evaluate(() => globalThis.__releaseTryItCreation());
    let stableObservations = 0;
    await expect
      .poll(
        async () => {
          const state = await window.evaluate(async () => {
            const chat = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return {
              activeTabId: chat.tabsFile.activeTabId,
              stagedDrafts: Object.keys(localStorage).filter((key) =>
                key.startsWith('canopy:try-it-draft:v1:'),
              ),
            };
          });
          expect(state.activeTabId).toBe('notes-two');
          expect(state.stagedDrafts).toEqual([]);
          return ++stableObservations;
        },
        { intervals: [100], timeout: 5000 },
      )
      .toBe(6);
    await expect(
      window.locator(
        '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-notes-two"]',
      ),
    ).toBeVisible();
  } finally {
    await electronApp
      .evaluate(() => globalThis.__releaseTryItCreation?.())
      .catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
