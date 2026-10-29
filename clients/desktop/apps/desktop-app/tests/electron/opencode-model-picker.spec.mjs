import { test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { launchPickerFixture } from './opencode-model-picker-harness.mjs';
import { exerciseOpenCodePicker } from '../../../../scripts/test-support/opencode-model-picker.mjs';

test('OpenCode picker groups, selects, rejects unavailable rows and removes a revoked catalog', async () => {
  const app = await launchPickerFixture();
  try {
    await exerciseOpenCodePicker(app.window);
  } finally {
    await closeCanopy(app.electronApp, app.userDataDir);
  }
});
