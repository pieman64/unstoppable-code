import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readEarlyAccess, setEarlyAccess } from './helpers/earlyAccess.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Bulk selection and removal in the App Advisor popout's nav: its rows are
// the shared WorkEntryRow with the same gestures, menu, and confirm as the
// main rail's Chats. The batch runs through the nav's deleteWorkEntry, and
// the open dialog reaches App Advisor's UI state through the popout's window
// report, since only the main window answers get_current_ui_state.
// ---------------------------------------------------------------------------

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const ENTRY_IDS = ['entry-bulk-a', 'entry-bulk-b'];

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function advisorDir(userDataDir, ...segments) {
  return path.join(userDataDir, 'app-workspaces', 'app-advisor', ...segments);
}

function seedTwoEntries(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  writeJson(advisorDir(userDataDir, 'work-entries.json'), {
    version: 1,
    entries: ENTRY_IDS.map((id) => ({ id, createdAt: timestamp })),
  });
  ENTRY_IDS.forEach((id, index) => {
    writeJson(advisorDir(userDataDir, 'chats', `${id}.json`), {
      version: 1,
      activeTabId: `${id}-chat`,
      tabs: [
        {
          id: `${id}-chat`,
          title: `Advisor topic ${index + 1}`,
          createdAt: timestamp,
          kind: 'chat',
          messages: [
            {
              id: `${id}-message`,
              role: 'user',
              blocks: [{ type: 'text', text: `Advisor body ${index + 1}` }],
              timestamp: Date.parse(timestamp),
            },
          ],
        },
      ],
    });
  });
}

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `app-advisor-bulk-ui-state-${Date.now()}-${Math.random()}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      // The full App Advisor window, titled Orchestrator, hosts App
      // Advisor's page as a view, so its own contents are not the main
      // renderer either.
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          candidate.getTitle() !== 'Orchestrator' &&
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor UI state')),
          5_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

test('selects two App Advisor entries and deletes both from the selection menu', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-app-advisor-bulk-'),
  );
  seedTwoEntries(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Under Early access App Advisor opens as the floating panel, which has
    // no nav; the nav lives in the full window.
    if (await readEarlyAccess(window)) {
      expect(await setEarlyAccess(window, false)).toBe(false);
    }
    const advisor = await app.openAppAdvisorWindow(electronApp);
    // It can still open as the floating panel; its Open full window moves the
    // same page into the full window, where the nav is.
    const floatingPanel = advisor.getByTestId('app-advisor-floating');
    if (await floatingPanel.isVisible()) {
      await floatingPanel
        .getByRole('button', { name: 'Open full window' })
        .click();
    }
    await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();

    const row = (id) => advisor.getByTestId(`app-advisor-nav-entry-${id}`);
    const selected = advisor.locator('[data-multiselected="true"]');
    for (const id of ENTRY_IDS) {
      await expect(row(id)).toBeVisible({ timeout: 30_000 });
    }

    for (const id of ENTRY_IDS) {
      await row(id).click({ modifiers: [MODIFIER] });
      await expect(row(id)).toHaveAttribute('data-multiselected', 'true');
    }
    await expect(selected).toHaveCount(2);

    const [first, second] = ENTRY_IDS;
    // Pin and unpin from the selection menu; App Advisor rows have no Mark done.
    const bulkPin = advisor.getByTestId(
      `app-advisor-nav-entry-${first}-bulk-pin`,
    );
    await row(first).click({ button: 'right' });
    await expect(bulkPin).toHaveText(/Pin 2 chats/);
    await expect(
      advisor.getByTestId(`app-advisor-nav-entry-${first}-bulk-done`),
    ).toHaveCount(0);
    await bulkPin.click();
    await expect(selected).toHaveCount(2);
    await row(first).click({ button: 'right' });
    await expect(bulkPin).toHaveText(/Unpin 2 chats/);
    await bulkPin.click();
    await expect(selected).toHaveCount(2);

    await row(first).click({ button: 'right' });
    await expect(
      advisor.getByTestId(`app-advisor-nav-entry-${first}-bulk-delete`),
    ).toHaveText(/Delete 2 chats/);
    await advisor
      .getByTestId(`app-advisor-nav-entry-${first}-bulk-delete`)
      .click();
    const dialog = advisor.getByTestId('app-advisor-batch-removal-dialog');
    await expect(dialog).toContainText('Delete 2 chats?');

    // The open confirm reaches App Advisor's UI state from the popout.
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot
            ?.workEntryBatchRemovalDialog ?? null,
        { timeout: 15_000 },
      )
      .toEqual({ open: true, mode: 'delete', count: 2, phase: 'confirm' });

    await dialog
      .getByTestId('app-advisor-batch-removal-dialog-confirm')
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 120_000 });
    for (const id of [first, second]) {
      await expect(row(id)).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(
          () =>
            existsSync(
              advisorDir(
                userDataDir,
                'archived-containers',
                id,
                'container.json',
              ),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
    }
    await expect(selected).toHaveCount(0);
    // Deleting the last entries leaves App Advisor with a fresh one.
    await expect(
      advisor.locator(
        '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
      ),
    ).not.toHaveCount(0, { timeout: 30_000 });
    // The closed dialog leaves App Advisor's UI state too.
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot
            ?.workEntryBatchRemovalDialog ?? null,
        { timeout: 15_000 },
      )
      .toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
