// @capture-keep: reusable settings evidence for Phase 4 write grants and worktree isolation
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// Phase 4: explicit child grants and optional worktree isolation. Deterministic settings, no inference.
// DELEGATION_STAGE=before|after pnpm run test:electron:captures:built managed-delegation-phase-4.capture-spec.ts --reporter=line [--dark-mode]
// Run both stages on their corresponding builds and both appearances. Durable coverage:
// managed-delegation-settings.spec.mjs and managed-delegation.spec.mjs.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAgentModels } from './seeders/index.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
const stage = process.env.DELEGATION_STAGE === 'before' ? 'before' : 'after';
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/phase-4-delegation',
);
test('captures managed delegation settings', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-delegation-phase-4-capture-'),
  );
  // An explicit empty agent-model store keeps this settings capture independent
  // of host models while exercising the supported deterministic seeding layer.
  seedAgentModels(userDataDir, []);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env:
      stage === 'after'
        ? { CANOPY_E2E_FORCE_DELEGATION_REVOCATION_FAILURE: '1' }
        : {},
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection(stage === 'before' ? 'chat' : 'experiments');
    mkdirSync(directory, { recursive: true });
    const panel = window.getByTestId(
      stage === 'before' ? 'settings-tab-chat' : 'settings-tab-experiments',
    );
    const consultation = window.getByTestId('managed-delegation-settings');
    // The baseline retains the full settings panel for context. After captures
    // focus on the feature element so the permission disclosure is readable.
    const captureTarget = stage === 'after' ? consultation : panel;
    await captureTarget.scrollIntoViewIfNeeded();
    await captureTarget.screenshot({
      path: path.join(directory, `consultation-${stage}.png`),
      animations: 'disabled',
    });
    if (
      stage === 'after' &&
      (process.platform === 'darwin' || process.platform === 'win32')
    ) {
      await chooseSettingsOption(
        window.getByTestId('settings-managed-delegation-mode'),
        'explicit-only',
      );
      await expect(
        window.getByTestId('settings-managed-delegation-mode'),
      ).toHaveAttribute('data-value', 'explicit-only');
      await consultation.screenshot({
        path: path.join(directory, `consultation-explicit-${stage}.png`),
        animations: 'disabled',
      });
      await chooseSettingsOption(
        window.getByTestId('settings-managed-delegation-mode'),
        'proactive',
      );
      await expect(
        window.getByTestId('settings-managed-delegation-mode'),
      ).toHaveAttribute('data-value', 'proactive');
      await consultation.screenshot({
        path: path.join(directory, `consultation-proactive-${stage}.png`),
        animations: 'disabled',
      });
      await chooseSettingsOption(
        window.getByTestId('settings-managed-delegation-mode'),
        'off',
      );
      await expect(
        window.getByRole('button', { name: 'Retry shutdown', exact: true }),
      ).toBeVisible();
      await consultation.screenshot({
        path: path.join(
          directory,
          `consultation-shutdown-incomplete-${stage}.png`,
        ),
        animations: 'disabled',
      });
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
