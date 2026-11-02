// Badges and counts: one Badge (an 18px capsule with six tones), one Count
// and one Dot. Roles and plans are neutral badges (they no longer borrow run
// states or the accent), and a count on an icon is a 16px capsule.
//
// Determinism: organizations come from the mock cloud's hosted-settings
// fixture; the worktree and its chats are seeded on disk, and closing a chat
// with messages archives it through the real main-process IPC handlers.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';
import {
  connectMockCloudAccount,
  registerHostedSettingsScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { openOrganizationsList } from './hostedSettingsLocators.mjs';

/** Rendered geometry and colour of one element, for comparing markers. */
async function markerStyle(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      height: Math.round(box.height),
      width: Math.round(box.width),
      radius: Number.parseFloat(style.borderTopLeftRadius),
      borderWidth: Number.parseFloat(style.borderTopWidth),
      boxShadow: style.boxShadow,
      background: style.backgroundColor,
      color: style.color,
      fontWeight: style.fontWeight,
      textTransform: style.textTransform,
    };
  });
}

function expectCapsule(style, height) {
  expect(style.height).toBe(height);
  // Fully rounded: the radius covers half the height.
  expect(style.radius).toBeGreaterThanOrEqual(height / 2);
  expect(style.borderWidth).toBe(0);
  expect(style.textTransform).toBe('none');
  expect(Number(style.fontWeight)).toBeLessThan(500);
}

test('roles are one neutral badge in the organization list and on Members', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_badges_and_counts_roles';
  await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in');
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await app.openSettings();
    await openOrganizationsList(window);
    const panel = window
      .getByTestId('hosted-settings-content')
      .getByTestId('team-panel');
    await expect(panel).toBeVisible();

    // The fixture's viewer owns one team, is a member of another and an
    // admin of a third: every role reads the same.
    const roles = await Promise.all(
      ['Owner', 'Member', 'Admin'].map((label) =>
        markerStyle(panel.getByText(label, { exact: true }).first()),
      ),
    );
    for (const style of roles) expectCapsule(style, 18);
    expect(new Set(roles.map((style) => style.background)).size).toBe(1);
    expect(new Set(roles.map((style) => style.color)).size).toBe(1);

    // A member sees every role as a badge, not a role picker.
    await window
      .getByTestId('hosted-settings-content')
      .getByTestId('team-panel-org')
      .filter({ hasText: 'Fabrikam Research' })
      .first()
      .click();
    await window.getByTestId('settings-nav-organization-members').click();
    const members = window
      .locator(
        '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/members"]',
      )
      .getByTestId('team-members-section');
    await expect(members).toBeVisible();
    await expect(members.getByTestId('team-member-role')).toHaveCount(0);
    const memberRoles = await Promise.all(
      ['Owner', 'Member'].map((label) =>
        markerStyle(members.getByText(label, { exact: true }).first()),
      ),
    );
    for (const style of memberRoles) expectCapsule(style, 18);
    expect(memberRoles[0].background).toBe(roles[0].background);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the archived chats count is a 16px capsule on its icon', async () => {
  test.setTimeout(150_000);
  const app = 'ts-pnpm-vite';
  const workspaceId = `demo-${app}`;
  const branch = 'demo-main';
  const archived = ['count-1', 'count-2', 'count-3'];
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-badges-'));
  seedDemoWorkspaces({ userDataDir, apps: [app] });
  const nowIso = new Date().toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: branch,
    providerType: 'claude',
    activeTabId: 'keeper',
    tabs: ['keeper', ...archived].map((id) => ({
      id,
      title: id === 'keeper' ? 'Keeper' : `Archived ${id}`,
      providerType: 'claude',
      createdAt: nowIso,
      messages: [
        {
          id: `${id}-user`,
          role: 'user',
          blocks: [{ type: 'text', text: `Question for ${id}.` }],
          timestamp: Date.parse(nowIso),
        },
        {
          id: `${id}-assistant`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `Answer for ${id}.` }],
          timestamp: Date.parse(nowIso) + 10_000,
        },
      ],
    })),
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    branch,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  try {
    for (const id of archived) {
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${id}`),
      ).toBeVisible({ timeout: 20_000 });
      await closePanelTab(window, `panel-chat-${id}`);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${id}`),
      ).toHaveCount(0);
    }
    const count = window
      .getByTestId('pr-status-bar')
      .getByTestId('chat-tab-archive-count');
    await expect(count).toHaveText(String(archived.length), {
      timeout: 15_000,
    });
    await expect(count).toHaveAttribute('data-count-tone', 'neutral');
    const style = await markerStyle(count);
    expectCapsule(style, 16);
    expect(style.width).toBeGreaterThanOrEqual(16);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
