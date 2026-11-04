// New Task's project, worktree, and base branch pickers. With early access on
// they stay on one line: a long project name truncates so the worktree and
// branch pickers keep their full labels. With early access off the row still
// wraps onto a second line, as on develop.
//
// Run after building the implementation:
//   pnpm run test:electron:built home-context-row.spec.mjs --reporter=line
//
// Set HOME_CONTEXT_ROW_CAPTURE_DIR to an absolute directory to also save light
// and dark captures of the row there.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import {
  seedPostImportRulesFixture,
  importFirstRunRuleProjects,
} from './postImportRules.mjs';
import { setUiScale } from './uiScale.mjs';

const LONG_PROJECT_NAME = 'unstoppable-domains-website-monorepo-production';
const CAPTURE_DIR = process.env.HOME_CONTEXT_ROW_CAPTURE_DIR;

test('CAN-4674 long project and branch controls fit a narrow scaled window', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4674-row-'));
  const fixture = seedPostImportRulesFixture(
    userDataDir,
    `side-quest-${LONG_PROJECT_NAME}`,
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { onboardingCompleted: [] } }),
  );
  const launch = await launchCanopy({
    userDataDir,
    env: fixture.env,
    viewportSize: { width: 1050, height: 800 },
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const home = await importFirstRunRuleProjects(window, fixture);
    await setUiScale(window, 125);
    for (const dark of [false, true]) {
      await window.evaluate(
        (enabled) => document.documentElement.classList.toggle('dark', enabled),
        dark,
      );
      await expect(
        home.getByRole('button', { name: 'Switch project', exact: true }),
      ).toHaveCount(0);
      const geometry = await home
        .getByTestId('home-composer-context')
        .evaluate((row) => {
          const controls = Array.from(row.children).map((child) =>
            child.getBoundingClientRect(),
          );
          const bounds = row.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            controls: controls.map((box) => ({
              left: box.left,
              right: box.right,
              center: box.top + box.height / 2,
            })),
          };
        });
      for (const control of geometry.controls) {
        expect(control.left).toBeGreaterThanOrEqual(geometry.left - 1);
        expect(control.right).toBeLessThanOrEqual(geometry.right + 1);
        expect(control.center).toBeCloseTo(geometry.controls[0].center, 0);
      }
      for (let index = 1; index < geometry.controls.length; index += 1) {
        expect(geometry.controls[index - 1].right).toBeLessThanOrEqual(
          geometry.controls[index].left + 1,
        );
      }
      const [project, , base] = await readPickers(home);
      expect(project.truncated).toBe(true);
      expect(base.truncated).toBe(false);
    }
  } finally {
    await closeCanopy(launch.electronApp, userDataDir);
    fixture.cleanup();
  }
});

async function openNewTask({ earlyAccess }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-home-row-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces[0].name = LONG_PROJECT_NAME;
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  if (earlyAccess) seedEarlyAccess({ userDataDir });

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 820, height: 700 },
  });
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window
    .getByTestId('app-sidebar')
    .getByRole('button', { name: 'New task', exact: true })
    .first()
    .click();
  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  await expect(homePage.getByTestId('home-base-branch-picker')).toBeVisible();
  return { electronApp, userDataDir, window, homePage };
}

/** Each picker's top, and whether its label is cut short. */
function readPickers(homePage) {
  return homePage.getByTestId('home-composer-context').evaluate((row) =>
    [
      'home-workspace-picker',
      'home-branch-picker',
      'home-base-branch-picker',
    ].map((testId) => {
      const picker = row.querySelector(`[data-testid="${testId}"]`);
      const label = picker?.querySelector('.truncate');
      // The visible extent is the picker's button, which can paint past a
      // shrunken picker.
      const button = picker?.querySelector('button');
      return {
        testId,
        top: picker?.getBoundingClientRect().top ?? Number.NaN,
        left: button?.getBoundingClientRect().left ?? Number.NaN,
        right: button?.getBoundingClientRect().right ?? Number.NaN,
        truncated:
          label instanceof HTMLElement && label.scrollWidth > label.clientWidth,
      };
    }),
  );
}

async function capture(window, homePage, name) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const overhang = homePage.getByTestId('home-composer-context-overhang');
  for (const mode of ['light', 'dark']) {
    await window.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark);
    }, mode === 'dark');
    await overhang.screenshot({
      path: path.join(CAPTURE_DIR, `${name}-desktop-${mode}.png`),
    });
  }
  await window.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
}

test('early access keeps the New Task pickers on one line by truncating the project', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, homePage } = await openNewTask({
    earlyAccess: true,
  });
  try {
    await expect(homePage.getByTestId('home-workspace-select')).toContainText(
      'unstoppable',
    );
    const [project, worktree, base] = await readPickers(homePage);
    expect(worktree.top).toBeCloseTo(project.top, 0);
    expect(base.top).toBeCloseTo(project.top, 0);
    // Side by side, never overlapping.
    expect(project.right).toBeLessThanOrEqual(worktree.left);
    expect(worktree.right).toBeLessThanOrEqual(base.left);
    expect(project.truncated).toBe(true);
    expect(worktree.truncated).toBe(false);
    expect(base.truncated).toBe(false);

    await capture(window, homePage, 'context-row-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('without early access the New Task pickers remain on one row', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, homePage } = await openNewTask({
    earlyAccess: false,
  });
  try {
    const [project, , base] = await readPickers(homePage);
    expect(base.top).toBeCloseTo(project.top, 0);

    await capture(window, homePage, 'context-row-before');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
