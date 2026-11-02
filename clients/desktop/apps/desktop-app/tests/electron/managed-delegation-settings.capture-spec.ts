// @capture-keep: reusable before/after evidence for managed delegation policy settings
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/13-phase-3-rollout.md
// Phase 3: user-controlled read-only consultation. Deterministic settings, no inference.
// DELEGATION_STAGE=before|after pnpm run test:electron:captures:built managed-delegation-settings.capture-spec.ts --reporter=line [--dark-mode]
// Run both stages on their corresponding builds and both appearances. Durable coverage:
// managed-delegation-settings.spec.mjs and managed-delegation.spec.mjs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
const stage = process.env.DELEGATION_STAGE === 'before' ? 'before' : 'after';
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/phase-3-delegation',
);
test('captures read-only consultation settings', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
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
    // Capture the feature element after implementation so its layout defines
    // the bounds. The before build has no such element, so retain its Models
    // panel as the comparison surface.
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
