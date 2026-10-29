// @capture-keep: reusable before/after proof for managed delegation concurrency controls
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// Managed delegation gains a per-parent concurrency setting, default five.
// Deterministic fresh local preferences, no live agents or inference.
// Run DELEGATION_LIMITS_STAGE=before|after pnpm run test:electron:captures:built managed-delegation-limits.capture-spec.ts --reporter=line;
// repeat with --dark-mode. Durable coverage: managed-delegation-settings.spec.mjs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
const stage =
  process.env.DELEGATION_LIMITS_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/delegation-limits',
);
test('managed delegation concurrency setting', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const setting = window.getByTestId('managed-delegation-settings');
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toHaveValue('off');
    const limit = window.getByTestId('settings-managed-delegation-concurrency');
    if (stage === 'after') await expect(limit).toHaveValue('5');
    else await expect(limit).toHaveCount(0);
    mkdirSync(captureDir, { recursive: true });
    await setting.screenshot({
      path: path.join(captureDir, `section-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
