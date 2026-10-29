import path from 'node:path';
import { expect } from '@playwright/test';

/**
 * Add project's Clone panel shows its destination as a path line with a
 * Change button (CAN-3909). Answers the next native folder dialog with
 * `directory`, presses Change, and waits for the line to show it.
 */
export async function chooseCloneDestination(electronApp, window, directory) {
  await electronApp.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [selected] };
    };
  }, directory);
  await window.getByTestId('add-workspace-clone-destination-change').click();
  await expect(
    window.getByTestId('add-workspace-clone-destination'),
  ).toContainText(path.basename(directory));
}

/** Fills Clone's URL source with `remoteUrl`. */
export async function fillCloneUrl(window, remoteUrl) {
  await window.getByTestId('add-workspace-remote-url-input').fill(remoteUrl);
}
