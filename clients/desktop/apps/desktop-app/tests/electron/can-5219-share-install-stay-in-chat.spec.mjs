import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  publisherSkills,
  startPublisherSkillsFixture,
} from './publisherSkillsFixture.mjs';

// Real publisher install and Slate composer; no provider execution.
test('CAN-5219: install and reuse a shared skill in the incident chat without sending', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-share-chat-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'incident-chat',
    tabs: [
      {
        id: 'incident-chat',
        title: 'Checkout latency spike',
        blocks: [{ type: 'text', text: 'Checkout latency is elevated.' }],
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
    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await expect(editor).toBeVisible();
    await editor.fill('Preserve the incident evidence.');
    const selected = window.getByTestId('panel-tab-panel-chat-incident-chat');
    const tabs = window.locator('[data-testid^="panel-tab-panel-chat-"]');
    const tabCount = await tabs.count();
    const readChat = () =>
      window.evaluate(async () => {
        const snapshot = await window.api.chat.getState({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        });
        return {
          activeTabId: snapshot.tabsFile.activeTabId,
          tabs: snapshot.tabsFile.tabs.map((tab) => ({
            id: tab.id,
            messages: tab.messages,
          })),
          runtime: snapshot.runtimeByChatId,
          queue: snapshot.queue,
        };
      });
    const initialChat = await readChat();
    const skill = publisherSkills[0];
    const open = async () => {
      await electronApp.evaluate(
        ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
        `canopy://share/skills/${skill.externalId}`,
      );
      await expect(window.getByTestId('deep-link-share-landing')).toBeVisible();
    };
    const review = window.getByTestId('deep-link-share-landing');
    await open();
    await review.getByTestId('deep-link-share-install').click();
    await expect(review).toHaveCount(0);
    await expect(editor).toHaveText('Preserve the incident evidence.');
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(
      existsSync(
        path.join(userDataDir, 'skills', 'custom:app', skill.name, 'SKILL.md'),
      ),
    ).toBe(true);
    const action = window
      .getByTestId('toast-action')
      .filter({ hasText: 'Use in this chat' });
    await expect(action).toBeVisible();
    // Native keyboard activation must stage once and leave focus in Slate.
    await action.focus();
    await action.press('Enter');
    await expect(editor).toHaveText(
      `Preserve the incident evidence.\n\n/${skill.name} `,
    );
    await expect(editor).toBeFocused();
    await expect(action).toHaveCount(0);
    await expect(tabs).toHaveCount(tabCount);
    expect(await readChat()).toEqual(initialChat);
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);

    await open();
    const use = review.getByTestId('deep-link-share-use-in-chat');
    await expect(use).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    await expect(editor).toHaveText(
      `Preserve the incident evidence.\n\n/${skill.name} `,
    );
    await open();
    await use.click();
    await expect(review).toHaveCount(0);
    await expect(editor).toHaveText(
      `Preserve the incident evidence.\n\n/${skill.name} \n\n/${skill.name} `,
    );
    await expect(editor).toBeFocused();
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveCount(tabCount);
    expect(await readChat()).toEqual(initialChat);
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);

    // Preserve a rich inline file reference, not just its rendered text.
    await editor.fill('Incident packet: ');
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
    await open();
    await use.click();
    await expect(review).toHaveCount(0);
    await expect(editor).toContainText(`/${skill.name} `);
    await expect(pill).toHaveCount(1);
    expect(await pill.innerHTML()).toBe(reference);
    await expect(editor).toBeFocused();

    await editor.fill('');
    await open();
    await use.click();
    await expect(review).toHaveCount(0);
    await expect(editor).toHaveText(`/${skill.name} `);
    await expect(editor).toBeFocused();
    expect(await readChat()).toEqual(initialChat);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
