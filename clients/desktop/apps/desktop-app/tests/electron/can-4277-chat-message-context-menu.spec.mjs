// CAN-4277: real Code transcript, clipboard, keyboard, nested native ownership,
// and pulled-out window clipboard fallback. No provider/network execution.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS } from './panelHarness.mjs';
import { writeJson } from './seeders/index.mjs';
import {
  assertCopyActions,
  assertKeyboardAndNestedEditable,
  assertVisibleReplyCopy,
  COPY_PROMPT,
  COPY_REPLY,
  COPY_PLAIN,
  COPY_CHAT_ID,
  COPY_PAUSED_CHAT_ID,
  COPY_QUESTION_CHAT_ID,
  copyMessages,
  seedCopyChat,
} from './fixtures/chat-message-copy.mjs';

for (const look of ['classic', 'clean']) {
  test(`CAN-4704 ${look} historical replies keep Copy at rest and at narrow widths`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-copy-history-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedCopyChat({ userDataDir, history: true, paused: true });
    writeJson(path.join(userDataDir, 'labs-experiments', 'choices.json'), {
      version: 1,
      accounts: { local: { 'clean-chat': look === 'clean' } },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const page = await electronApp.firstWindow();
      const app = new CanopyAppDriver(page);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const copies = page.getByTestId('turn-copy-message');
      await expect(copies).toHaveCount(2);
      await page.setViewportSize({ width: 900, height: 850 });
      for (const [index, markdown] of [
        COPY_REPLY,
        'Second **answer**',
      ].entries()) {
        await assertVisibleReplyCopy(page, copies.nth(index), {
          markdown,
          readClipboard: () =>
            electronApp.evaluate(({ clipboard }) => clipboard.readText()),
          writeClipboard: (text) =>
            electronApp.evaluate(
              ({ clipboard }, value) => clipboard.writeText(value),
              text,
            ),
        });
        const box = await copies.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(900);
      }
      await page
        .getByTestId(`panel-tab-panel-chat-${COPY_PAUSED_CHAT_ID}`)
        .click();
      const pausedPanel = page.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COPY_PAUSED_CHAT_ID}"]`,
      );
      await expect(pausedPanel.getByTestId('turn-timer')).toHaveAttribute(
        'data-state',
        'paused',
      );
      await expect(pausedPanel.getByTestId('turn-copy-message')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Code and pulled-out messages copy exact sources and retain nested editable menus', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-4277-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCopyChat({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const readClipboard = () =>
      electronApp.evaluate(({ clipboard }) => clipboard.readText());
    const menuCount = () =>
      electronApp.evaluate(
        () => globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__?.count ?? 0,
      );
    const before = await menuCount();
    const assistant = page
      .locator('[data-chat-message-id="copy-assistant"]')
      .first();
    const user = page
      .locator('[data-role="user"]')
      .filter({ hasText: 'Please copy this' })
      .first();
    await expect(assistant).toBeVisible();
    // CAN-4704: the finished reply keeps a visible, keyboard-operable Copy.
    const replyCopy = page.getByTestId('turn-copy-message').filter({
      visible: true,
    });
    await expect(replyCopy).toHaveCount(1);
    await assertVisibleReplyCopy(page, replyCopy, {
      markdown: COPY_REPLY,
      readClipboard,
      writeClipboard: (text) =>
        electronApp.evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          text,
        ),
    });
    await assertCopyActions(page, assistant, {
      markdown: COPY_REPLY,
      plain: COPY_PLAIN,
      readClipboard,
    });
    await assertCopyActions(page, user, {
      markdown: COPY_PROMPT,
      plain: 'Please copy this 🌲',
      readClipboard,
    });
    const badge = user.getByRole('button', { name: 'Copy to clipboard' });
    await badge.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('chat-message-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(badge).toBeFocused();
    await assertKeyboardAndNestedEditable(page, assistant);
    await expect.poll(menuCount).toBe(before + 1);

    await page
      .getByTestId(`panel-tab-panel-chat-${COPY_QUESTION_CHAT_ID}`)
      .click();
    await page
      .getByText('Which scope?', { exact: true })
      .click({ button: 'right' });
    await expect(page.getByTestId('chat-message-context-menu')).toBeVisible();
    await page.getByTestId('chat-message-copy-markdown').click();
    await expect.poll(readClipboard).toBe('Which **scope**?');
    await page.getByTestId(`panel-tab-panel-chat-${COPY_CHAT_ID}`).click();

    const auxiliary = electronApp.waitForEvent('window');
    await page
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await page
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const aux = await auxiliary;
    const auxRow = aux
      .locator('[data-chat-message-id="copy-assistant"]')
      .first();
    await expect(auxRow).toBeVisible();
    // The message may have been adopted from the main document. Closing its
    // keyboard menu must return focus across that realm boundary too.
    await auxRow.focus();
    await aux.keyboard.press('Shift+F10');
    await expect(aux.getByTestId('chat-message-context-menu')).toBeVisible();
    await aux.keyboard.press('Escape');
    await expect(auxRow).toBeFocused();
    await assertVisibleReplyCopy(aux, aux.getByTestId('turn-copy-message'), {
      markdown: COPY_REPLY,
      readClipboard,
      writeClipboard: (text) =>
        electronApp.evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          text,
        ),
    });
    await assertCopyActions(aux, auxRow, {
      markdown: COPY_REPLY,
      plain: COPY_PLAIN,
      readClipboard,
    });
    // Force only the owning navigator API off; execCommand still copies for real.
    await aux.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      }),
    );
    await electronApp.evaluate(({ clipboard }) =>
      clipboard.writeText('fallback sentinel'),
    );
    await auxRow.click({ button: 'right' });
    await aux.getByTestId('chat-message-copy-markdown').click();
    await expect.poll(readClipboard).toBe(COPY_REPLY);
    await assertVisibleReplyCopy(aux, aux.getByTestId('turn-copy-message'), {
      markdown: COPY_REPLY,
      readClipboard,
      writeClipboard: (text) =>
        electronApp.evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          text,
        ),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor mounts the same copy menu for both message roles', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-4277-advisor-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
    },
  });
  const workspace = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  writeJson(path.join(workspace, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: 'copy-entry',
        title: 'Message copy',
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  });
  writeJson(path.join(workspace, 'chats', 'copy-entry.json'), {
    version: 1,
    activeTabId: 'copy-advisor',
    tabs: [
      {
        id: 'copy-advisor',
        title: 'Message copy',
        createdAt: '2026-10-01T12:00:00.000Z',
        providerType: 'claude',
        model: 'sonnet',
        messages: copyMessages(),
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    await new CanopyAppDriver(main).waitForShell();
    const opened = electronApp.waitForEvent('window');
    await main.getByTestId('sidebar-nav-app-advisor').click();
    const advisor = await opened;
    await expect(
      advisor.getByTestId('app-advisor-workspace-surface'),
    ).toBeVisible();
    const assistant = advisor
      .locator('[data-chat-message-id="copy-assistant"]')
      .first();
    await expect(assistant).toBeVisible();
    const readClipboard = () =>
      electronApp.evaluate(({ clipboard }) => clipboard.readText());
    await assertCopyActions(advisor, assistant, {
      markdown: COPY_REPLY,
      plain: COPY_PLAIN,
      readClipboard,
    });
    await assertCopyActions(
      advisor,
      advisor.locator('[data-role="user"]').first(),
      { markdown: COPY_PROMPT, plain: 'Please copy this 🌲', readClipboard },
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
