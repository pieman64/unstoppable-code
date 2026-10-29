import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { createFixture } from './codexPipelineRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';
import {
  connectChatShareAccount,
  seedChatSkillShare,
  SHARE_KEY,
  SHARE_SKILL,
  SHARE_WORKTREE,
} from './seeders/chatSkillShare.mjs';

test('eligible turn persists threshold, waits for authentication, dismisses once across restart', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3611-nudge-'));
  seedChatSkillShare(userDataDir);
  const fixture = createFixture('normal', 'Share fixture completed');
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() => window.api.disconnectCanopyCloudAccount());
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`/${SHARE_SKILL} check this change`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      panel.getByText('Share fixture completed', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const item = () =>
      JSON.parse(
        readFileSync(path.join(userDataDir, 'skill-usage.json'), 'utf8'),
      ).items[SHARE_KEY];
    await expect.poll(() => item().count).toBe(3);
    // No count-derived suggestion is spent until the audience is known.
    await expect(window.getByTestId('skill-share-nudge-banner')).toHaveCount(0);
    expect(item().nudge).toBeUndefined();
    await connectChatShareAccount(window);
    const banner = window.getByTestId('skill-share-nudge-banner');
    await expect(banner).toBeVisible();
    await expect.poll(() => item().nudge).toBe('shown');
    await banner.getByTestId('skill-share-nudge-banner-share').click();
    await expect(window.getByTestId('share-skill-modal')).toBeVisible();
    // A dialog takes Escape once it holds focus: its Escape listener and focus
    // trap attach together, just after it first paints.
    await expect(
      window.getByTestId('share-skill-modal').locator(':focus'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    await expect(banner).toBeVisible();
    await banner.getByTestId('skill-share-nudge-banner-dismiss').click();
    await expect.poll(() => item().nudge).toBe('dismissed');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    await expect(window.getByTestId('skill-share-nudge-banner')).toHaveCount(0);
    expect(item().nudge).toBe('dismissed');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('dismissal remains hidden across navigation while persistence retries recover', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3611-retry-'));
  seedChatSkillShare(userDataDir);
  const fixture = createFixture('normal', 'Retry fixture completed');
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  let failedWrites = 0;
  electronApp.on('console', (message) => {
    if (
      message
        .text()
        .includes('Failed to persist local share suggestion resolution')
    )
      failedWrites += 1;
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectChatShareAccount(window);
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`/${SHARE_SKILL} check this change`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    const banner = window.getByTestId('skill-share-nudge-banner');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    const usagePath = path.join(userDataDir, 'skill-usage.json');
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(usagePath, 'utf8')).items[SHARE_KEY].nudge,
      )
      .toBe('shown');
    const savedUsage = readFileSync(usagePath);
    // A directory at the destination makes the real atomic rename fail.
    rmSync(usagePath);
    mkdirSync(usagePath);
    await banner.getByTestId('skill-share-nudge-banner-dismiss').click();
    await expect(banner).toHaveCount(0);
    await expect
      .poll(() => failedWrites, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(4);
    await app.openUsagePage();
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    await expect(
      window.getByTestId('panel-content-chat').getByRole('textbox').first(),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
    rmSync(usagePath, { recursive: true });
    writeFileSync(usagePath, savedUsage);
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(usagePath, 'utf8')).items[SHARE_KEY].nudge,
        { timeout: 65_000 },
      )
      .toBe('dismissed');
    await expect(banner).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

for (const variant of ['already-shared', 'curated', 'plugin']) {
  test(`${variant} eligibility follows real user-turn usage and plugin completion`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `can3611-${variant}-`),
    );
    seedChatSkillShare(userDataDir);
    let key = SHARE_KEY;
    let message = `/${SHARE_SKILL} check this change`;
    if (variant === 'already-shared')
      writeJson(path.join(userDataDir, 'skills', '.share-links.json'), {
        [`custom:app/${SHARE_SKILL}`]: {
          remoteId: 'fixture-shared',
          contentHash: 'hash',
          shareScope: 'team',
          sharedAt: '2026-10-03T12:00:00.000Z',
          ownerName: 'Platform',
        },
      });
    if (variant !== 'already-shared') {
      const marketplaceId =
        variant === 'curated' ? 'curated/cloud' : 'demo/market';
      key = JSON.stringify(['plugin', marketplaceId, 'release-tools']);
      writeJson(path.join(userDataDir, 'skill-usage.json'), {
        version: 1,
        items: { [key]: { count: variant === 'plugin' ? 1 : 2 } },
      });
      const inventoryPath = path.join(
        userDataDir,
        'invocable-inventory-cache.json',
      );
      const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      inventory.entries[1].enableRef.marketplaceId = marketplaceId;
      inventory.entries.push({
        ...inventory.entries[1],
        id: 'second-plugin-member',
        name: 'second-review',
        displayName: '$release-tools:second-review',
        invocationKey: '$release-tools:second-review',
        insertText: '$release-tools:second-review ',
      });
      writeJson(inventoryPath, inventory);
      const pluginPath = path.join(userDataDir, 'plugins-cache.json');
      const plugins = JSON.parse(readFileSync(pluginPath, 'utf8'));
      plugins.marketplaces[0].id = marketplaceId;
      plugins.marketplaces[0].plugins[0].marketplaceId = marketplaceId;
      writeJson(pluginPath, plugins);
      message = '$release-tools:plugin-review check this change';
    }
    const fixture = createFixture('normal', 'Eligibility fixture completed');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectChatShareAccount(
        window,
        `csk_can3611_${variant.replaceAll('-', '_')}`,
      );
      await app.openMainPage();
      await app.selectWorktree(SHARE_WORKTREE);
      const panel = window.getByTestId('panel-content-chat');
      const item = () =>
        JSON.parse(
          readFileSync(path.join(userDataDir, 'skill-usage.json'), 'utf8'),
        ).items[key];
      await panel.getByRole('textbox').first().fill(message);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel
          .getByText('Eligibility fixture completed', { exact: true })
          .first(),
      ).toBeVisible({ timeout: 60_000 });
      if (variant === 'plugin') {
        await expect.poll(() => item().count).toBe(2);
        await expect(
          window.getByTestId('skill-share-nudge-banner'),
        ).toHaveCount(0);
        await panel
          .getByRole('textbox')
          .first()
          .fill('$release-tools:second-review check another change');
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect.poll(() => item().count).toBe(3);
        const banner = window.getByTestId('skill-share-nudge-banner');
        await expect(banner).toHaveAttribute('data-share-kind', 'plugin');
        await banner.getByTestId('skill-share-nudge-banner-share').click();
        const modal = window.getByTestId('share-plugin-modal');
        await expect(modal).toBeVisible();
        await expect(modal.locator(':focus')).toHaveCount(1);
        await window.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
        await expect(banner).toBeVisible();
        await banner.getByTestId('skill-share-nudge-banner-share').click();
        await expect(modal).toBeVisible();
        await modal.getByTestId('share-plugin-submit').click();
        await expect(modal).toHaveCount(0);
        await expect.poll(() => item().nudge).toBe('shared');
        await expect(banner).toHaveCount(0);
      } else {
        await expect.poll(() => item().nudge).toBe('ineligible');
        expect(item().count).toBe(3);
        await expect(
          window.getByTestId('skill-share-nudge-banner'),
        ).toHaveCount(0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixture.runtimeDir, { recursive: true, force: true });
    }
  });
}
