/** CAN-4908: organization-owned reviewed revision copies via real reconciliation. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  openRevisionJourney,
  promoteRevisionTwo,
  openCopyDialog,
  assertRevisionTwoCopy,
  CONTAINER,
  PUBLICATION,
  NOTE,
  MESSAGE,
} from './sharedContainerForkRevisionFixture.mjs';

test.describe.configure({ mode: 'serial' });

test('copies revision two already displayed into its organization with exact provenance', async () => {
  test.setTimeout(150_000);
  const journey = await openRevisionJourney();
  try {
    await promoteRevisionTwo(journey);
    const { window } = journey;
    const surface = window.getByTestId('shared-container-surface');
    const expandActivity = surface.getByTestId(
      'panel-group-expand-group-activity',
    );
    if (await expandActivity.isVisible()) await expandActivity.click();
    await expect(
      surface
        .getByTestId('workspace-notes-item')
        .filter({ hasText: 'Revision two follow-up' }),
    ).toHaveCount(1);
    const noteBody = await window.evaluate(
      async (containerId) =>
        window.api.sharedContainers.readNote({
          containerId,
          revisionId: 'cowork-revision-2',
          itemId: 'note-1',
        }),
      CONTAINER,
    );
    expect(noteBody).toBe(NOTE);
    await surface.getByTestId('panel-tab-panel-activity').click();
    await surface
      .getByTestId('workspace-notes-item')
      .filter({ hasText: 'Revision two follow-up' })
      .getByRole('button')
      .first()
      .click();
    const noteDialog = window.getByRole('dialog', {
      name: 'Revision two follow-up',
      exact: true,
    });
    await expect(noteDialog).toContainText(
      'Call the customer on Friday. Ada added a scheduling detail.',
    );
    await window.keyboard.press('Escape');
    await expect(noteDialog).toHaveCount(0);
    await surface.getByTestId('panel-tab-panel-chat-chat-1').click();
    await expect(surface).toContainText(MESSAGE);
    await openCopyDialog(window);
    await assertRevisionTwoCopy(journey);
  } finally {
    await journey.cleanup();
  }
});

test('requires explicit review of a publication arriving during viewer confirmation', async () => {
  test.setTimeout(150_000);
  const journey = await openRevisionJourney();
  try {
    const { window } = journey;
    await openCopyDialog(window);
    await promoteRevisionTwo(journey);
    await expect(
      window.getByTestId('shared-container-fork-revision-update'),
    ).toContainText('Review it before making your copy.');
    await expect(
      window.getByTestId('shared-container-fork-confirm'),
    ).toBeDisabled();
    await expect(
      window.getByTestId('shared-container-fork-revision'),
    ).toHaveAttribute('data-revision-id', 'cowork-revision-1');
    await window.getByTestId('shared-container-fork-revision-accept').click();
    await expect(
      window.getByTestId('shared-container-fork-revision').locator('time'),
    ).toHaveAttribute('datetime', PUBLICATION);
    await assertRevisionTwoCopy(journey);
  } finally {
    await journey.cleanup();
  }
});

test('refuses a row-menu copy superseded after refresh, then reviews the replacement', async () => {
  test.setTimeout(150_000);
  const journey = await openRevisionJourney();
  try {
    const { window, electronApp, userDataDir } = journey;
    await openCopyDialog(window, 'row');
    const before = readFileSync(
      path.join(userDataDir, 'workspaces/index.json'),
      'utf8',
    );
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('shared-containers:fork');
      if (!original) throw new Error('Missing fork handler');
      ipcMain.removeHandler('shared-containers:fork');
      ipcMain.handle('shared-containers:fork', async (...args) => {
        ipcMain.__can4908RequestedRevision = args[1].revisionId;
        await new Promise((resolve) => {
          ipcMain.__can4908Release = resolve;
        });
        return original(...args);
      });
      ipcMain.__can4908OriginalFork = original;
    });
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => ipcMain.__can4908RequestedRevision,
        ),
      )
      .toBe('cowork-revision-1');
    try {
      await promoteRevisionTwo(journey);
      await expect(
        window.getByTestId('shared-container-fork-confirm'),
      ).toBeDisabled();
    } finally {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('shared-containers:fork');
        ipcMain.handle('shared-containers:fork', ipcMain.__can4908OriginalFork);
        ipcMain.__can4908Release();
      });
    }
    await expect(
      window.getByTestId('shared-container-fork-error'),
    ).toContainText('published a newer version');
    expect(
      readFileSync(path.join(userDataDir, 'workspaces/index.json'), 'utf8'),
    ).toBe(before);
    await expect(
      window.getByTestId('shared-container-fork-confirm'),
    ).toBeDisabled();
    await window.getByTestId('shared-container-fork-revision-accept').click();
    await assertRevisionTwoCopy(journey);
  } finally {
    await journey.cleanup();
  }
});
