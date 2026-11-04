import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

const FEATURE_IDS = ['minimal-layout', 'comet-spinners'];
// Independent experiments that were never part of Early access.
const INDEPENDENT_IDS = [
  'chat-tab-previews',
  'subagents-view',
  'archived-chats-card',
  'compact-queue',
  'proxy-account-cards',
  'pr-hover-cards',
  'smooth-streaming',
];
const SWITCH_IDS = [...FEATURE_IDS, ...INDEPENDENT_IDS];
const GRADUATED_IDS = [
  ...SWITCH_IDS,
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
test('new users only see Files reads, daemon terminals and code graph, chat automation pipelines and page experiments in Labs', async () => {
  const launched = await launchCanopy();
  try {
    const page = await openLabs(launched);
    const ids = [
      'daemon-files-reads',
      'daemon-terminals',
      'daemon-code-graph',
      'chat-automation-pipelines',
      'overview-page',
      'kanban-page',
      'statistics-page',
      'audit-trail-page',
    ];
    for (const id of ids)
      await expect(
        page.getByTestId(`labs-experiment-toggle-${id}`),
      ).toHaveCount(1);
    await expect(
      page.locator('[data-testid^="labs-experiment-toggle-"]'),
    ).toHaveCount(ids.length);
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

test('Activity card is configurable in Appearance and absent from Labs', async () => {
  const launched = await launchCanopy();
  try {
    const page = await openLabs(launched);
    await expect(
      page.getByTestId('labs-experiment-toggle-activity-card'),
    ).toHaveCount(0);
    const app = new CanopyAppDriver(page);
    await app.openSettingsSection('display');
    const toggle = page.getByTestId('settings-activity-card-toggle');
    await expect(toggle).toBeEnabled();
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await expect(toggle).toHaveAttribute(
      'aria-checked',
      before === 'true' ? 'false' : 'true',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
