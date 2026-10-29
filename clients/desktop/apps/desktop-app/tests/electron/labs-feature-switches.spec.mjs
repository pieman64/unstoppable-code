import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

const FEATURE_IDS = ['activity-card', 'minimal-layout', 'comet-spinners'];
// Independent experiments that were never part of Early access.
const INDEPENDENT_IDS = [
  'chat-tab-previews',
  'subagents-view',
  'archived-chats-card',
  'clean-chat',
  'proxy-account-cards',
  'pr-hover-cards',
];
const SWITCH_IDS = [...FEATURE_IDS, ...INDEPENDENT_IDS];
const GRADUATED_IDS = [
  'pointer-menus',
  'stacked-notifications',
  'compact-tool-calls',
  'user-messages',
  'collapsible-prompts',
  'compact-composer',
  'deferred-branch-picker',
  'compact-settings',
  'inset-layout',
  'panel-tabs',
  'panel-layout-controls',
  'browser-toolbar',
  'browser-warm-views',
  'floating-advisor',
  'short-summaries',
  'single-tooltips',
  'loading-spinners',
  'updated-icons',
  'sentence-case-titles',
  'launch-shimmer',
  'usage-indicators',
  'plugin-error-notices',
];
async function snapshot(page) {
  return page.evaluate(async () => {
    const value = await window.api.experiments.getSnapshot();
    return Object.fromEntries(
      value.experiments.map((entry) => [entry.id, entry.enabled]),
    );
  });
}
async function openLabs(launched) {
  const page = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(page);
  await app.waitForShell({ timeout: 30000 });
  await app.openSettings();
  await app.openSettingsSection('experiments');
  await expect(page.getByTestId('experimental-features-toggle')).toHaveCount(0);
  for (const id of [...GRADUATED_IDS, 'archived-chat-tabs', 'sidebar']) {
    await expect(page.getByTestId(`labs-experiment-toggle-${id}`)).toHaveCount(
      0,
    );
    if (id !== 'sidebar') expect(await snapshot(page)).not.toHaveProperty(id);
  }
  return page;
}
test('every feature starts off and changes independently through Labs, then survives restart', async () => {
  test.setTimeout(180000);
  const launched = await launchCanopy();
  const expected = Object.fromEntries(SWITCH_IDS.map((id) => [id, false]));
  try {
    const page = await openLabs(launched);
    expect(await snapshot(page)).toMatchObject(expected);
    for (const id of SWITCH_IDS) {
      const toggle = page.getByTestId(`labs-experiment-toggle-${id}`);
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      expected[id] = true;
      await expect.poll(() => snapshot(page)).toMatchObject(expected);
      await toggle.click();
      expected[id] = false;
      await expect.poll(() => snapshot(page)).toMatchObject(expected);
    }
    for (const id of ['activity-card', 'comet-spinners', 'chat-tab-previews']) {
      const toggle = page.getByTestId(`labs-experiment-toggle-${id}`);
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      expected[id] = true;
      await expect.poll(() => snapshot(page)).toMatchObject(expected);
    }
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir, {
      keepUserData: true,
    });
  }
  const restored = await launchCanopy({ userDataDir: launched.userDataDir });
  try {
    const page = await openLabs(restored);
    expect(await snapshot(page)).toMatchObject(expected);
  } finally {
    await closeCanopy(restored.electronApp, restored.userDataDir);
  }
});

test('an existing Early access opt-in is preserved for every feature without a master dependency', async () => {
  test.setTimeout(90000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'labs-feature-upgrade-'),
  );
  seedEarlyAccess({ userDataDir });
  const launched = await launchCanopy({ userDataDir });
  try {
    const page = await openLabs(launched);
    const expected = {
      ...Object.fromEntries(FEATURE_IDS.map((id) => [id, true])),
      // No extracted choice: the legacy opt-in does not switch these on.
      ...Object.fromEntries(INDEPENDENT_IDS.map((id) => [id, false])),
    };
    expect(await snapshot(page)).toMatchObject(expected);
    await page.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    expect(await snapshot(page)).toMatchObject(expected);
    const tools = page.getByTestId('labs-experiment-toggle-activity-card');
    await tools.click();
    expected['activity-card'] = false;
    await expect.poll(() => snapshot(page)).toMatchObject(expected);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('graduated presentation is standard for new accounts and existing opt-outs', async () => {
  test.setTimeout(90000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'labs-graduated-optouts-'),
  );
  seedEarlyAccess({ userDataDir });
  const { readFileSync, writeFileSync } = await import('node:fs');
  const file = path.join(userDataDir, 'labs-experiments', 'choices.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.accounts.local = {
    'early-access': false,
    ...Object.fromEntries(GRADUATED_IDS.map((id) => [id, false])),
  };
  writeFileSync(file, JSON.stringify(saved));
  const launched = await launchCanopy({ userDataDir });
  try {
    const page = await openLabs(launched);
    // Inset frame and compact action geometry must survive old false choices.
    await expect(page.locator('[data-settings-layout="inset"]')).toHaveCount(1);
    await page.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: true,
      }),
    );
    await expect.poll(() => snapshot(page)).toMatchObject({ sidebar: true });
    await expect(
      page.getByTestId('labs-experiment-toggle-sidebar'),
    ).toHaveCount(0);
    for (const id of GRADUATED_IDS)
      expect(await snapshot(page)).not.toHaveProperty(id);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
