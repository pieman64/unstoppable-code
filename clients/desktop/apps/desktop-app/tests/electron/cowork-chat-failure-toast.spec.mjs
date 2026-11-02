import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  ENTRY_ID,
  CHAT_ID,
  FAILURE_MESSAGE,
  seedCoworkFailureToast,
  showCoworkFailureToast,
} from './coworkFailureToastFixture.mjs';

for (const detail of [false, true]) {
  test(`Work chat failure toast ${detail ? 'detail' : 'header'} link opens its Work Entry`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cowork-failure-toast-'),
    );
    seedCoworkFailureToast(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const toast = await showCoworkFailureToast(electronApp, window, app);
      if (detail) {
        await toast.getByText(FAILURE_MESSAGE, { exact: true }).click();
        await window
          .getByRole('dialog')
          .getByRole('button', { name: ENTRY_ID, exact: true })
          .click();
      } else {
        await toast
          .getByRole('button', { name: ENTRY_ID, exact: true })
          .click();
      }
      await expect(window.getByTestId('page-chat')).toBeVisible();
      await expect(
        window.locator(
          `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
        ),
      ).toBeVisible();
      await expect(window.getByTestId('page-chat')).toContainText(
        'Draft the refund policy doc.',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
