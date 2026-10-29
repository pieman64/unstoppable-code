import { expect } from '@playwright/test';
import { buildPickerFixture } from '../../../../scripts/test-support/opencode-model-picker.mjs';

export async function launchPickerFixture(mode = 'light') {
  const { seedPanelWorktree } = await import('./panelHarness.mjs');
  const { closeCanopy } = await import('./launchCanopy.mjs');
  const url = await buildPickerFixture(mode);
  const app = await seedPanelWorktree();
  try {
    await app.window.goto(url);
    await expect(
      app.window.getByTestId('opencode-picker-fixture'),
    ).toBeVisible();
    return app;
  } catch (error) {
    await closeCanopy(app.electronApp, app.userDataDir);
    throw error;
  }
}
