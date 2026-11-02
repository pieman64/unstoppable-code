// @capture-keep: reusable before/after proof for removal of the legacy delegation environment default
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// Retired delegation environment default. Deterministic local settings state;
// no live inference. Run DELEGATION_ENV_STAGE=before|after with
// pnpm run test:electron:captures:built delegation-env-default.capture-spec.ts
// --reporter=line, then repeat with --dark-mode. Durable coverage is in
// managed-delegation-settings.spec.mjs; this file only captures the setting.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
const stage =
  process.env.DELEGATION_ENV_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/delegation-env-removal',
);
test('retired environment variable does not control the delegation setting', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_DEVELOPMENT_DELEGATION: '1' },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection(stage === 'before' ? 'chat' : 'experiments');
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toHaveAttribute(
      'data-value',
      stage === 'before' ? 'explicit-only' : 'off',
    );
    mkdirSync(captureDir, { recursive: true });
    const settings = window.getByTestId('managed-delegation-settings');
    await settings.screenshot({
      path: path.join(captureDir, `setting-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
