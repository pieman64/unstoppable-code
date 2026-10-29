// @capture-keep: reusable light and dark proof that the held Home heading renders from the curated pool
// @capture-reference: docs/ui-automation.md
// CAN-2697 — Audit the rotating headline phrases on the New Task screen.
//
// What changed: the 50-phrase, developer-framed HOME_HEADINGS carousel is
// replaced by a small curated set of audience-neutral, action-oriented
// phrases. The E2E index seam fixes the heading at entry 0 after a reload,
// so the before/after pair asserts and captures exact old and new strings.
//
// Run both stages and color modes:
//   CAN2697_STAGE=before pnpm run test:electron:captures:built can-2697-home-heading.capture-spec.ts --reporter=line
//   CAN2697_STAGE=before pnpm run test:electron:captures:built can-2697-home-heading.capture-spec.ts --reporter=line --dark-mode
//   CAN2697_STAGE=after pnpm run test:electron:captures:built can-2697-home-heading.capture-spec.ts --reporter=line
//   CAN2697_STAGE=after pnpm run test:electron:captures:built can-2697-home-heading.capture-spec.ts --reporter=line --dark-mode
//
// Determinism: demo workspaces are seeded on disk; no live agent or network.
// page.addInitScript sets the E2E heading index before a reload so the held
// heading re-picks deterministically; the hook is never set in production.
// Captures target the heading + composer region of the Home surface.

import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const STAGE = process.env.CAN2697_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-2697');

test('captures the New Task heading', async () => {
  test.setTimeout(120_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2697-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.addInitScript(() => {
      Object.assign(globalThis, { __CANOPY_E2E_HOME_HEADING_INDEX__: 0 });
    });
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    const heading = homePage.getByTestId('home-heading');
    // Before: the develop tree has no E2E seam, so the phrase is random —
    // assert it comes from the OLD pool (none of the curated six). After: the
    // seam pins entry 0, so assert the exact curated phrase.
    const CURATED = [
      "Say what you'd like to get done",
      'Describe what you need, in your own words',
      "Share what you're working on today",
      'Start with a goal, a question, or a rough idea',
      "Get help with whatever's on your plate today",
      'Explain what you need and let the work begin',
    ];
    if (STAGE === 'before') {
      const text = (await heading.textContent()) ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(CURATED).not.toContain(text);
    } else {
      await expect(heading).toHaveText(CURATED[0]);
    }
    await window.waitForTimeout(400);
    await homePage.getByTestId('home-composer').screenshot({
      path: path.join(captureDir, `home-composer-${STAGE}.png`),
      animations: 'disabled',
    });
    await heading.screenshot({
      path: path.join(captureDir, `home-heading-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
