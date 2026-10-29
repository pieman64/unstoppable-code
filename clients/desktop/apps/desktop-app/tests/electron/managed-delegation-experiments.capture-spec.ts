// @capture-keep: reusable before/after proof for the managed delegation settings relocation
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// Managed delegation moves from Models to its own Experiments section.
// Deterministic fresh local preferences, no live agents or inference.
// Run DELEGATION_LOCATION_STAGE=before|after pnpm run test:electron:captures:built managed-delegation-experiments.capture-spec.ts --reporter=line;
// repeat with --dark-mode. Durable coverage: managed-delegation-settings.spec.mjs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
const stage =
  process.env.DELEGATION_LOCATION_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/delegation-experiments',
);
test('managed delegation settings location', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection(stage === 'before' ? 'chat' : 'experiments');
    const setting = window.getByTestId('managed-delegation-settings');
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toHaveValue('off');
    mkdirSync(captureDir, { recursive: true });
    await setting.screenshot({
      path: path.join(captureDir, `section-${stage}.png`),
      animations: 'disabled',
    });
    await app.openSettingsSection('experiments');
    const page = window.getByTestId('settings-tab-experiments');
    await expect(
      page.getByRole('heading', { name: 'Labs', exact: true }),
    ).toBeVisible();
    // Capture the scroll viewport so below-fold content is not black/clipped.
    const content = window.getByTestId('settings-content');
    await content.screenshot({
      path: path.join(captureDir, `experiments-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
