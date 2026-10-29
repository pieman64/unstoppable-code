import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';

const VIEWPORT_SIZE = { width: 1400, height: 800 };
const SETTLE_MS = 500;
const POSITION_TOLERANCE_PX = 0.5;

async function openHome(electronApp, { onboardingCard = false } = {}) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();

  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  // Every install runs the onboarding suggestions module in production; the
  // default harness launch holds it back. Specs that opt the module in wait
  // for its card; the default launch waits for the composer itself (the
  // workspace-readiness block that used to sit under it left with #3519).
  await expect(
    homePage.getByTestId(
      onboardingCard ? 'home-onboarding-suggestions' : 'home-composer-editor',
    ),
  ).toBeVisible();
  await window.waitForTimeout(SETTLE_MS);
  return { window, homePage };
}

async function measureAnchors(homePage) {
  const entries = await Promise.all(
    ['home-composer', 'home-composer-plus-button'].map(async (testId) => {
      const box = await homePage.getByTestId(testId).boundingBox();
      expect(box, `${testId} should have a bounding box`).not.toBeNull();
      return [testId, box];
    }),
  );
  return Object.fromEntries(entries);
}

function expectAnchorsNotToMove(actual, expected) {
  for (const testId of Object.keys(expected)) {
    expect(
      Math.abs(actual[testId].x - expected[testId].x),
      `${testId} x moved by ${actual[testId].x - expected[testId].x}px; movement should stay within ${POSITION_TOLERANCE_PX}px`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(
      Math.abs(actual[testId].y - expected[testId].y),
      `${testId} y moved by ${actual[testId].y - expected[testId].y}px; movement should stay within ${POSITION_TOLERANCE_PX}px`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
  }
}

async function typeAndAssertStable(window, homePage, editor, key, baseline) {
  await editor.pressSequentially(key);
  await window.waitForTimeout(SETTLE_MS);
  expectAnchorsNotToMove(await measureAnchors(homePage), baseline);
}

test('typing and picker activation do not move the composer', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    viewportSize: VIEWPORT_SIZE,
  });

  try {
    const { window, homePage } = await openHome(electronApp);
    const editor = homePage.getByTestId('home-composer-editor');
    await editor.click();
    const baseline = await measureAnchors(homePage);

    await typeAndAssertStable(window, homePage, editor, 'h', baseline);
    await editor.press('Backspace');
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);

    await homePage.getByTestId('home-composer-plus-button').click();
    const actionsMenu = window.getByTestId('home-composer-plus-menu');
    await expect(actionsMenu).toBeVisible();
    await expect(actionsMenu).toHaveAttribute('data-menu-variant', 'add');
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);

    await window.keyboard.press('Escape');
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);

    await editor.pressSequentially('@');
    await expect(actionsMenu).toBeVisible();
    await expect(actionsMenu).toHaveAttribute('data-menu-variant', 'add');
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('typing and picker activation do not move the composer with the onboarding card', async () => {
  // The production default for an existing install: the module is live and
  // its card sits where the chips and readiness block otherwise would.
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    freshOnboardingChecklist: true,
    viewportSize: VIEWPORT_SIZE,
  });

  try {
    const { window, homePage } = await openHome(electronApp, {
      onboardingCard: true,
    });
    const editor = homePage.getByTestId('home-composer-editor');
    await editor.click();
    const baseline = await measureAnchors(homePage);

    await typeAndAssertStable(window, homePage, editor, 'h', baseline);
    await editor.press('Backspace');
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);

    await homePage.getByTestId('home-composer-plus-button').click();
    await expect(window.getByTestId('home-composer-plus-menu')).toBeVisible();
    await window.waitForTimeout(SETTLE_MS);
    expectAnchorsNotToMove(await measureAnchors(homePage), baseline);
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('typing does not move the composer at 125% UI scale', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-2699-'));
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { uiScale: 125 },
  });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: VIEWPORT_SIZE,
  });

  try {
    const { window, homePage } = await openHome(electronApp);
    const editor = homePage.getByTestId('home-composer-editor');
    await editor.click();
    const baseline = await measureAnchors(homePage);
    await typeAndAssertStable(window, homePage, editor, 'h', baseline);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
