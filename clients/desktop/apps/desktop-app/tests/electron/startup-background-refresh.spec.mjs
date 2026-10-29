import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const LIVE_STARTUP_BACKGROUND_ENV =
  'CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND';
const DRAFT =
  'Background refresh must never steal or reorder startup input. '.repeat(8);

test('live deferred startup refresh preserves sustained Home input', async () => {
  test.setTimeout(90_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: { [LIVE_STARTUP_BACKGROUND_ENV]: '1' },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const editor = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await editor.click();
    // This spans the production 5-second launch point. The assertion is exact,
    // so dropped, duplicated, or reordered input fails even if the UI recovers.
    await editor.pressSequentially(DRAFT, { delay: 18 });
    await expect(editor).toContainText(DRAFT);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
