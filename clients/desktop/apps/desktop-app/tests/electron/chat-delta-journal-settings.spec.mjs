import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Older preferences cannot restore the retired control or disable the cutover.
for (const legacyValue of [false, true]) {
  test(`Experiments removes chat storage controls with legacy value ${legacyValue}`, async () => {
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'chat-storage-cutover-'),
    );
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { chatDeltaJournalEnabled: legacyValue },
      }),
    );
    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('experiments');
      await expect(
        window.getByTestId('settings-renderer-code-cache'),
      ).toBeVisible();
      await expect(
        window.getByTestId('settings-chat-delta-journal'),
      ).toHaveCount(0);
      await expect(window.getByTestId('chat-delta-journal-toggle')).toHaveCount(
        0,
      );
      const loaded = await window.evaluate(() => window.api.loadPreferences());
      expect(loaded).not.toHaveProperty('chatDeltaJournalEnabled');
      expect(loaded).not.toHaveProperty('__chatDeltaJournalDemotionIncomplete');
      // A stale client save is normalized through the same canonical writer.
      const saved = await window.evaluate(() =>
        window.api.savePreferences({ chatDeltaJournalEnabled: false }),
      );
      expect(saved).not.toHaveProperty('chatDeltaJournalEnabled');
      await app.openSettingsSection('display');
      await app.openSettingsSection('experiments');
      await expect(
        window.getByTestId('settings-renderer-code-cache'),
      ).toBeVisible();
      await expect(
        window.getByTestId('settings-chat-delta-journal'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}
