// Inset window layout: the work area is cards inset from the window. The
// worktree page's left card sits one hairline inside the sidebar edge. The
// page clips its panel grid with a margin, leaving the card's edge line and
// shadow visible on its left. Settings is one card like the main window's:
// under the window's empty 46px top row, 6px from the right and bottom edges.
// The layout graduated from early access, so Settings is the same card
// whether or not the user opted in.
//
// Run after building the implementation:
//   pnpm run test:electron:built inset-window-layout-settings.spec.mjs --reporter=line
//
// Set INSET_LAYOUT_CAPTURE_DIR to an absolute directory to also save light
// and dark window captures there.
//
// Determinism: the worktree and its chat are seeded on disk; no provider or
// network request runs.

import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
/** The window's empty top row above the inset cards. */
const TOP_ROW = 46;
/** The cards' gap to the window's right and bottom edges. */
const EDGE_INSET = 6;
const CAPTURE_DIR = process.env.INSET_LAYOUT_CAPTURE_DIR;

async function capture(window, name) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const mode of ['light', 'dark']) {
    await window.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark);
    }, mode === 'dark');
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await window.screenshot({
      path: path.join(CAPTURE_DIR, `${name}-desktop-${mode}.png`),
    });
  }
  await window.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
}

function seed({ earlyAccess }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-inset-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  if (earlyAccess) seedEarlyAccess({ userDataDir });
  return userDataDir;
}

async function launch({ earlyAccess }) {
  const userDataDir = seed({ earlyAccess });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { app, launched, userDataDir, window };
}

async function settingsCard(window) {
  return window.evaluate(() => {
    const card = document.querySelector('[data-testid="settings-content"]');
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return {
      top: rect.top,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      radius: parseFloat(style.borderTopLeftRadius),
      shadow: style.boxShadow,
    };
  });
}

test('insets Settings and keeps the left card edge visible', async () => {
  test.setTimeout(120_000);
  const { app, launched, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const chatCard = window.getByTestId('panel-group-group-chat');
    await expect(chatCard).toBeVisible();

    // #4958 gives the left card one hairline of room and animates its inset.
    // Wait for that geometry; clipping must still preserve the edge/shadow.
    await expect(async () => {
      const clip = await window.evaluate(() => {
        const card = document.querySelector(
          '[data-testid="panel-group-group-chat"]',
        );
        const main = card?.closest('main');
        const part = card?.closest('[data-testid="worktree-part"]');
        return [main, part].map((element) => {
          if (!element) return null;
          const style = getComputedStyle(element);
          return {
            overflow: style.overflowX,
            margin: parseFloat(style.overflowClipMargin) || 0,
            hairline: parseFloat(style.getPropertyValue('--border-hairline')),
            cardGap:
              card.getBoundingClientRect().left -
              element.getBoundingClientRect().left,
          };
        });
      });
      for (const entry of clip) {
        expect(entry).not.toBeNull();
        expect(entry.overflow).toBe('clip');
        expect(entry.hairline).toBeGreaterThan(0);
        expect(entry.cardGap).toBeCloseTo(entry.hairline, 1);
        expect(entry.margin).toBeGreaterThanOrEqual(2);
      }
    }).toPass({ timeout: 5_000 });
    await capture(window, 'worktree');

    await app.openSettings();
    await expect(window.getByTestId('settings-overlay')).toHaveAttribute(
      'data-settings-layout',
      'inset',
    );
    const card = await settingsCard(window);
    expect(card).not.toBeNull();
    expect(Math.round(card.top)).toBe(TOP_ROW);
    expect(Math.round(card.right)).toBe(EDGE_INSET);
    expect(Math.round(card.bottom)).toBe(EDGE_INSET);
    expect(card.radius).toBeGreaterThan(0);
    expect(card.shadow).not.toBe('none');
    // Wait for the page itself, not only the card, before capturing.
    await expect(
      window.getByTestId('settings-content').getByText('General').first(),
    ).toBeVisible();
    await window.waitForTimeout(400);
    await capture(window, 'settings');
    await app.closeSettings();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('without the early access opt-in Settings is still the inset card', async () => {
  test.setTimeout(120_000);
  const { app, launched, userDataDir, window } = await launch({
    earlyAccess: false,
  });
  try {
    await app.openSettings();
    await expect(window.getByTestId('settings-overlay')).toHaveAttribute(
      'data-settings-layout',
      'inset',
    );
    const card = await settingsCard(window);
    expect(card).not.toBeNull();
    expect(Math.round(card.top)).toBe(TOP_ROW);
    expect(Math.round(card.right)).toBe(EDGE_INSET);
    expect(Math.round(card.bottom)).toBe(EDGE_INSET);
    expect(card.radius).toBeGreaterThan(0);
    await expect(
      window.getByTestId('settings-content').getByText('General').first(),
    ).toBeVisible();
    await window.waitForTimeout(400);
    await capture(window, 'settings-without-opt-in');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
