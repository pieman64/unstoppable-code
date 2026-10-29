import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';
import { injectSecureStorageFault } from './secureStorageFixture.mjs';

// Doc 2 Spec 15 — workspace-scoped environment configuration (PR 761).
//
// Everything below is reachable from seeded CANOPY_DATA_DIR state + UI
// structure. No live processes, no real network. Environment values are
// OS-keychain-encrypted when available. CAN-3220 injects native availability
// and encryption faults, preserving native encrypt/decrypt for successful saves.

// CAN-4269: Environments lives in Settings → Environments. The section is a
// list of environments; a row (or New environment) drills into its detail,
// and the page's back control returns to the list.
function backToEnvironmentList(window) {
  return window
    .getByTestId('settings-tab-environment')
    .getByTestId('settings-page-back')
    .click();
}

// The key/value rows use dynamic row ids in their testids
// (`environment-editor-key-<rowId>` / `-value-<rowId>`), so address them via a
// `^=` prefix match on the most-recently-added row.
function lastKeyInput(window, root = window) {
  return root.locator('input[data-testid^="environment-editor-key-"]').last();
}

function lastValueInput(window, root = window) {
  return root.locator('[data-testid^="environment-editor-value-"]').last();
}

// The editor's header testids are static, and `SharedContainerRunPanel`
// renders a second EnvironmentVariableEditor under the always-mounted
// MainPage. Scope header lookups to the Settings section's editor so a second
// instance with rows can never turn these into strict-mode violations.
function environmentEditor(window) {
  return window
    .getByTestId('settings-tab-environment')
    .getByTestId('environment-editor-key-value');
}

const STORAGE_ENVIRONMENT_NAME = 'E2E Build Secrets';
const STORAGE_KEY = 'API_TOKEN';
const STORAGE_VALUE = 'super-secret-value';

function readEnvironmentRecord(userDataDir) {
  return readFileSync(
    path.join(`${userDataDir}-secure`, 'environments.json'),
    'utf8',
  );
}

async function addFixtureEnvironment(window) {
  const page = window.getByTestId('settings-tab-environment');
  await page.getByTestId('environments-new-environment').click();
  await page
    .getByTestId('environments-name-input')
    .fill(STORAGE_ENVIRONMENT_NAME);
  await page.getByTestId('environment-editor-add-row').click();
  await lastKeyInput(window, page).fill(STORAGE_KEY);
  await lastValueInput(window, page).fill(STORAGE_VALUE);
}

async function expectFixtureDraft(window) {
  const page = window.getByTestId('settings-tab-environment');
  await expect(page.getByTestId('environments-name-input')).toHaveValue(
    STORAGE_ENVIRONMENT_NAME,
  );
  await expect(lastKeyInput(window, page)).toHaveValue(STORAGE_KEY);
  await expect(lastValueInput(window, page)).toHaveValue(STORAGE_VALUE);
}

async function selectAndExpectFixtureEnvironment(window) {
  await window
    .getByTestId('environments-list')
    .getByText(STORAGE_ENVIRONMENT_NAME, { exact: true })
    .click();
  await expectFixtureDraft(window);
}

async function openFixtureWorkspaceEnvironmentTab(window, app) {
  const workspaceName = 'TypeScript pnpm Vite';
  await app.closeSettings();
  await app.openMainPage();
  await app.workspaceHeaderLabel(workspaceName).hover();
  await app.workspaceSettingsButton(workspaceName).click();
  const dialog = window.getByRole('dialog', { name: workspaceName });
  await dialog.getByRole('tab', { name: 'Environment', exact: true }).click();
  const tab = dialog.locator('[data-testid^="workspace-environment-tab-"]');
  await expect(tab).toBeVisible();
  return { dialog, tab };
}

// Intercept only the real IPC boundary. The renderer still drives the normal
// controls and successful operations reach the original main-process handlers.
async function interceptEnvironmentConfigIpc(electronApp, mode) {
  const handle = await electronApp.evaluateHandle(
    ({ ipcMain, BrowserWindow }, selectedMode) => {
      const loadChannel = 'environment-config:load';
      const saveChannel = 'environment-config:save';
      const originalLoad = ipcMain._invokeHandlers.get(loadChannel);
      const originalSave = ipcMain._invokeHandlers.get(saveChannel);
      if (!originalLoad || !originalSave) {
        throw new Error('Missing environment config IPC handlers');
      }
      let loadCalls = 0;
      let saveCalls = 0;
      let saveEntered = false;
      let loadSettled = 0;
      let actionResponse = null;
      let resolveActionResponse;
      let actionRequestId = null;
      let fenceSequence = 0;
      const fenceResponses = new Map();
      let responseHandler = null;
      let originalResponseHandler = null;
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      const load = async (event, ...args) => {
        loadCalls += 1;
        if (selectedMode === 'fail-next-load' && loadCalls === 1) {
          return {
            ok: false,
            error: "Couldn't read saved environment values.",
            secureStorageFailure: {
              version: 1,
              code: 'SECURE_STORAGE_READ_UNAVAILABLE',
              operation: 'read',
              state: 'unavailable',
              backend: null,
              retryable: true,
            },
          };
        }
        const response = await originalLoad(event, ...args);
        loadSettled += 1;
        return response;
      };
      const save = async (event, ...args) => {
        saveCalls += 1;
        if (selectedMode === 'gate-next-save' && saveCalls === 1) {
          saveEntered = true;
          await saveGate;
        }
        return originalSave(event, ...args);
      };
      ipcMain.removeHandler(loadChannel);
      ipcMain.removeHandler(saveChannel);
      ipcMain.handle(loadChannel, load);
      ipcMain.handle(saveChannel, save);
      return {
        counts: () => ({ loadCalls, loadSettled, saveCalls, saveEntered }),
        dispatchAssignment: (workspaceId) => {
          if (responseHandler)
            throw new Error('Advisor action already dispatched');
          const main = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes('surface=app-advisor'),
          );
          if (!main) throw new Error('Main window missing');
          const channel = 'app-advisor:tool-response';
          originalResponseHandler = ipcMain._invokeHandlers.get(channel);
          ipcMain.removeHandler(channel);
          actionResponse = new Promise((resolve) => {
            resolveActionResponse = resolve;
          });
          const requestId = `environment-overlap-${Date.now()}`;
          actionRequestId = requestId;
          responseHandler = (_event, response) => {
            if (response?.requestId === actionRequestId) {
              resolveActionResponse(response);
            }
            const resolveFence = fenceResponses.get(response?.requestId);
            if (resolveFence) {
              fenceResponses.delete(response.requestId);
              resolveFence(response);
            }
          };
          ipcMain.handle(channel, responseHandler);
          main.webContents.send('app-advisor:tool-request', {
            kind: 'dispatch_action',
            requestId,
            action: {
              type: 'environment.update_workspace_assignment',
              workspaceId,
              runtimes: { agent: 'default-overall' },
            },
          });
        },
        fenceAdvisor: () => {
          const main = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes('surface=app-advisor'),
          );
          if (!main || !responseHandler)
            throw new Error('Advisor action not started');
          const requestId = `environment-overlap-fence-${++fenceSequence}`;
          const result = new Promise((resolve) =>
            fenceResponses.set(requestId, resolve),
          );
          main.webContents.send('app-advisor:tool-request', {
            kind: 'get_current_ui_state',
            requestId,
          });
          return result;
        },
        actionResponse: () => actionResponse,
        release: () => releaseSave(),
        restore: () => {
          releaseSave();
          if (
            ipcMain._invokeHandlers.get(loadChannel) !== load ||
            ipcMain._invokeHandlers.get(saveChannel) !== save
          ) {
            throw new Error(
              'Environment config IPC handler changed during test',
            );
          }
          ipcMain.removeHandler(loadChannel);
          ipcMain.removeHandler(saveChannel);
          ipcMain.handle(loadChannel, originalLoad);
          ipcMain.handle(saveChannel, originalSave);
          if (responseHandler) {
            const channel = 'app-advisor:tool-response';
            if (ipcMain._invokeHandlers.get(channel) !== responseHandler) {
              throw new Error('Advisor response handler changed during test');
            }
            ipcMain.removeHandler(channel);
            if (originalResponseHandler)
              ipcMain.handle(channel, originalResponseHandler);
          }
        },
      };
    },
    mode,
  );
  return {
    counts: () => handle.evaluate((fixture) => fixture.counts()),
    dispatchAssignment: (workspaceId) =>
      handle.evaluate(
        (fixture, id) => fixture.dispatchAssignment(id),
        workspaceId,
      ),
    fenceAdvisor: () => handle.evaluate((fixture) => fixture.fenceAdvisor()),
    actionResponse: () =>
      handle.evaluate((fixture) => fixture.actionResponse()),
    release: () => handle.evaluate((fixture) => fixture.release()),
    restore: async () => {
      await handle.evaluate((fixture) => fixture.restore());
      await handle.dispose();
    },
  };
}

for (const fault of ['probe-failed', 'locked']) {
  test(`CAN-3220 environment ${fault === 'locked' ? 'locked' : 'unavailable'} encrypted read recovers existing values after Retry`, async () => {
    test.skip(
      fault === 'locked' && process.platform !== 'linux',
      'Recognized-backend lock inference is Linux-only.',
    );
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy();
    let restore;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openEnvironmentsSettings();
      await addFixtureEnvironment(window);
      const page = window.getByTestId('settings-tab-environment');
      await page.getByTestId('environments-save').click();
      await expect(page.getByTestId('environments-save-status')).toHaveText(
        'Saved.',
      );
      const savedRecord = readEnvironmentRecord(userDataDir);
      expect(savedRecord).not.toContain(STORAGE_VALUE);

      restore = await injectSecureStorageFault(electronApp, fault);
      // Reload clears renderer state, forcing the actual encrypted disk read.
      await window.reload();
      await app.waitForShell();
      await app.openEnvironmentsSettings();
      await expect(page).toContainText(
        fault === 'locked'
          ? 'Secure storage is locked or temporarily unavailable.'
          : 'Secure storage is unavailable.',
      );
      await expect(page.getByTestId('secure-storage-notice')).toHaveAttribute(
        'data-storage-state',
        fault === 'locked' ? 'locked' : 'unavailable',
      );
      await expect(page.getByTestId('environments-save-status')).toHaveCount(0);
      await expect(page.getByTestId('environments-list')).toHaveCount(0);
      await expect(page.getByTestId('environments-save-bar')).toHaveCount(0);
      expect(readEnvironmentRecord(userDataDir)).toBe(savedRecord);

      const retry = page.getByTestId('secure-storage-retry');
      await expect(retry).toHaveText('Retry');
      await restore();
      await retry.click();
      await expect(page.getByTestId('secure-storage-notice')).toHaveCount(0);
      await selectAndExpectFixtureEnvironment(window);
      await expect(page.getByTestId('environments-unsaved')).toHaveCount(0);
      expect(readEnvironmentRecord(userDataDir)).toBe(savedRecord);
    } finally {
      try {
        await restore?.();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });
}

test('CAN-3220 failed environment encryption preserves unsaved values and Retry persists them', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    // Establish a real persisted baseline; the refused save cannot replace it.
    const page = window.getByTestId('settings-tab-environment');
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    const savedRecord = readEnvironmentRecord(userDataDir);
    await addFixtureEnvironment(window);
    restore = await injectSecureStorageFault(electronApp, 'encrypt-failed');
    await page.getByTestId('environments-save').click();

    await expect(page).toContainText('Couldn’t access secure storage.');
    await expect(page.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'failed',
    );
    await expect(page.getByTestId('environments-save-status')).toHaveCount(0);
    await expect(page.getByTestId('environments-unsaved')).toBeVisible();
    await expectFixtureDraft(window);
    expect(readEnvironmentRecord(userDataDir)).toBe(savedRecord);

    await backToEnvironmentList(window);
    await expect(page.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'failed',
    );
    await selectAndExpectFixtureEnvironment(window);

    const retry = page.getByTestId('secure-storage-retry');
    await expect(retry).toHaveText('Retry');
    await restore();
    await retry.click();
    await expect(page.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    await expect(page.getByTestId('environments-unsaved')).toHaveCount(0);
    await expectFixtureDraft(window);
    expect(readEnvironmentRecord(userDataDir)).not.toContain(STORAGE_VALUE);
    await window.reload();
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    await selectAndExpectFixtureEnvironment(window);
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('CAN-3220 environment Retry replays the failed save without persisting a newer draft', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    await addFixtureEnvironment(window);
    const page = window.getByTestId('settings-tab-environment');
    restore = await injectSecureStorageFault(electronApp, 'encrypt-failed');
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('secure-storage-notice')).toBeVisible();
    await lastValueInput(window, page).fill('newer-unsaved-environment-draft');
    await restore();
    await page.getByTestId('secure-storage-retry').click();
    await expect(page.getByTestId('secure-storage-notice')).toHaveCount(0);
    await expect(lastValueInput(window, page)).toHaveValue(
      'newer-unsaved-environment-draft',
    );
    await expect(page.getByTestId('environments-unsaved')).toBeVisible();
    await app.closeSettings();
    await app.openMainPage();
    await app.openEnvironmentsSettings();
    await page
      .getByTestId('environments-list')
      .getByText(STORAGE_ENVIRONMENT_NAME, { exact: true })
      .click();
    await expect(lastValueInput(window, page)).toHaveValue(
      'newer-unsaved-environment-draft',
    );
    await expect(page.getByTestId('environments-unsaved')).toBeVisible();
    await window.reload();
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    await selectAndExpectFixtureEnvironment(window);
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('CAN-3220 unavailable environment encryption explicitly warns about the historical plaintext save', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    restore = await injectSecureStorageFault(electronApp, 'unavailable');
    await app.openEnvironmentsSettings();
    const page = window.getByTestId('settings-tab-environment');
    await addFixtureEnvironment(window);
    const warning = page.getByTestId('environment-editor-encryption-warning');
    await expect(warning).toContainText('plaintext');
    await expect(
      page.getByTestId('environment-editor-encryption-status'),
    ).toHaveCount(0);
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    await expect(warning).toBeVisible();
    const persisted = JSON.parse(
      readEnvironmentRecord(userDataDir),
    ).data.environments.find(
      (entry) => entry.name === STORAGE_ENVIRONMENT_NAME,
    );
    expect(persisted.plaintextVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: STORAGE_KEY, value: STORAGE_VALUE }),
      ]),
    );
    expect(persisted.encryptedVariables).toBeUndefined();
    await window.reload();
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    await selectAndExpectFixtureEnvironment(window);
    await expect(warning).toBeVisible();
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('CAN-3220 saved environment values are encrypted and persist across relaunch', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await app.openEnvironmentsSettings();

    // Config seeds default environments on first load. The default set is
    // Overall / Canopy / Agents / Pipelines.
    await expect(window.getByTestId('environments-list')).toBeVisible();
    await expect(
      window.getByTestId('environments-list-row-default-overall'),
    ).toBeVisible();
    await expect(
      window.getByTestId('environments-list-row-default-canopy'),
    ).toBeVisible();

    // Create a new environment, name it, and add one key/value variable.
    await window.getByTestId('environments-new-environment').click();
    const nameInput = window.getByTestId('environments-name-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(STORAGE_ENVIRONMENT_NAME);

    await window.getByTestId('environment-editor-add-row').click();
    await lastKeyInput(window, environmentEditor(window)).fill(STORAGE_KEY);
    await lastValueInput(window, environmentEditor(window)).fill(STORAGE_VALUE);

    // Save and assert the "Saved." status surfaces.
    await window.getByTestId('environments-save').click();
    await expect(window.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    expect(readEnvironmentRecord(userDataDir)).not.toContain(STORAGE_VALUE);
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch reusing the same userDataDir; the new environment name must
  // persist with the native-decrypted values visible again in the editor.
  const relaunch = await launchCanopy({ userDataDir });
  try {
    const window = await relaunch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await app.openEnvironmentsSettings();

    await expect(window.getByTestId('environments-list')).toBeVisible();
    // Scope the assertion to the list rows.
    await expect(
      window
        .getByTestId('environments-list')
        .getByText(STORAGE_ENVIRONMENT_NAME, { exact: true }),
    ).toBeVisible();
    await selectAndExpectFixtureEnvironment(window);
  } finally {
    await closeCanopy(relaunch.electronApp, userDataDir, {
      keepUserData: false,
    });
  }
});

test('Environment editor cases reset state between steps in one app', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();

    const saveChanges = async () => {
      await window.getByTestId('environments-save').click();
      await expect(window.getByTestId('environments-save-status')).toHaveText(
        'Saved.',
      );
      await expect(window.getByTestId('environments-unsaved')).toHaveCount(0);
    };
    const deleteSelected = async () => {
      await window.getByTestId('environments-delete').click();
      await expect(
        window.getByRole('dialog', { name: 'Delete environment' }),
      ).toBeVisible();
      await window.getByTestId('environments-delete-confirm').click();
    };
    const saveThenDeleteSelected = async () => {
      await saveChanges();
      await deleteSelected();
      await saveChanges();
    };

    const boxOf = async (locator) => {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      return box;
    };

    // Header labels and the controls beneath them must share grid tracks.
    // Before the subgrid fix the header and each row were separate grids that
    // each resolved their own `auto` columns, so "Secret" drifted ~78px off its
    // checkbox and sat over the Remove button instead.
    //
    // `scaleLabel` names the UI scale the measurement was taken at, so a soft
    // failure says which one drifted.
    const expectHeadersAlignedWithControls = async (scaleLabel) => {
      // Both halves of every comparison must come from the SAME editor. If
      // only the headers were scoped, a second EnvironmentVariableEditor
      // mounted with rows (SharedContainerRunPanel, under the always-mounted
      // MainPage) would make `.last()` silently pick that editor's inputs —
      // measuring this page's header against another editor's row, which is
      // worse than the strict-mode violation the scoping prevents.
      const editor = environmentEditor(window);
      const [keyHeader, keyInput] = await Promise.all([
        boxOf(editor.getByTestId('environment-editor-header-key')),
        boxOf(lastKeyInput(window, editor)),
      ]);
      const [valueHeader, valueInput] = await Promise.all([
        boxOf(editor.getByTestId('environment-editor-header-value')),
        boxOf(lastValueInput(window, editor)),
      ]);
      const [secretHeader, secretCheckbox] = await Promise.all([
        boxOf(editor.getByTestId('environment-editor-header-secret')),
        boxOf(
          editor
            .locator('input[data-testid^="environment-editor-secret-"]')
            .last(),
        ),
      ]);

      const centerX = (box) => box.x + box.width / 2;
      const ALIGNMENT_TOLERANCE_PX = 2;

      // Soft so a single run reports every misaligned column rather than
      // short-circuiting on the first one.
      // Key/Value headers align to their inputs' left edge.
      expect
        .soft(
          Math.abs(keyHeader.x - keyInput.x),
          `Key header vs key input at ${scaleLabel}`,
        )
        .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
      expect
        .soft(
          Math.abs(valueHeader.x - valueInput.x),
          `Value header vs value input at ${scaleLabel}`,
        )
        .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
      // The centered Secret header sits over its centered checkbox.
      expect
        .soft(
          Math.abs(centerX(secretHeader) - centerX(secretCheckbox)),
          `Secret header vs secret checkbox at ${scaleLabel}`,
        )
        .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
    };

    // Settings → Display owns the UI scale; saving it makes the main process
    // zoom every window uniformly (see `main/lib/ui-zoom.ts`), and the
    // renderer republishes the effective zoom as `--ui-zoom` once it has
    // landed (`lib/theme.ts`). Driving the real slider rather than saving the
    // preference directly keeps this on the user path. Returns to Settings →
    // Environments afterwards, which reopens on its list. Re-entrant: it opens
    // Settings only when a failed step left it closed.
    const setUiScaleAndReturnToEnvironments = async (scale) => {
      if (
        !(await window
          .getByTestId('settings-overlay')
          .isVisible({ timeout: 2_000 }))
      ) {
        await app.openSettings();
      }
      await app.openSettingsSection('display');
      await window.getByTestId('settings-ui-scale-select').click();
      await window.getByTestId(`settings-ui-scale-option-${scale}`).click();
      // The zoom is applied asynchronously after the preference save, so
      // measuring bounding boxes before `--ui-zoom` reflects it would compare
      // pre-zoom geometry against a 2px tolerance. Wait for it to land.
      await expect
        .poll(() =>
          window.evaluate(() => ({
            scale: document.documentElement.getAttribute('data-ui-scale'),
            uiZoom: getComputedStyle(document.documentElement)
              .getPropertyValue('--ui-zoom')
              .trim(),
          })),
        )
        .toEqual({ scale: String(scale), uiZoom: String(scale / 100) });
      await app.openSettingsSection('environment');
    };

    await test.step('variable table headers align with their controls', async () => {
      await window.getByTestId('environments-new-environment').click();
      await window
        .getByTestId('environments-name-input')
        .fill('Header Alignment Probe');
      await window.getByTestId('environment-editor-add-row').click();
      await lastKeyInput(window).fill('ALIGNED_KEY');
      await lastValueInput(window).fill('aligned-value');

      await expectHeadersAlignedWithControls('the default UI scale');

      // Subgrid was chosen over hard-coded pixel tracks precisely so alignment
      // survives the Settings → Display scale slider. Persist the probe first
      // so the round trip through Settings cannot discard unsaved edits, then
      // re-measure at both ends of the slider's range.
      await saveChanges();

      // Set only when the restore below fails. Rethrown *after* the
      // try/finally rather than inside it: `no-unsafe-finally` rightly forbids
      // throwing from a `finally`, and it is unnecessary here — if the body
      // threw, that exception propagates and the statement after the block
      // never runs, so reaching it already proves the body succeeded.
      let restoreError = null;
      try {
        for (const scale of [75, 150]) {
          await setUiScaleAndReturnToEnvironments(scale);
          await window
            .getByTestId('environments-list')
            .getByText('Header Alignment Probe', { exact: true })
            .click();
          await expect(lastKeyInput(window)).toHaveValue('ALIGNED_KEY');
          await expectHeadersAlignedWithControls(`${scale}% UI scale`);
        }
      } finally {
        // UI scale is a global preference. Restoring it only on the success
        // path would leave every later step in this test running at 150%,
        // turning one real failure into a cascade of misleading ones.
        try {
          await setUiScaleAndReturnToEnvironments(100);
        } catch (error) {
          // Never let cleanup mask the failure that got us here. If the body
          // succeeded, a failed restore is itself the failure — swallowing it
          // would silently leave the remaining steps scaled at 150%.
          restoreError = error;
        }
      }

      if (restoreError !== null) throw restoreError;

      await window
        .getByTestId('environments-list')
        .getByText('Header Alignment Probe', { exact: true })
        .click();
      await deleteSelected();
      await saveChanges();
    });

    await test.step('reserved PATH key surfaces inline error and disables Save', async () => {
      await window.getByTestId('environments-new-environment').click();
      await window
        .getByTestId('environments-name-input')
        .fill('Reserved Key Probe');
      await window.getByTestId('environment-editor-add-row').click();
      await lastKeyInput(window).fill('PATH');
      await lastValueInput(window).fill('/tmp/bin');

      const editorError = window
        .getByTestId('environment-editor-key-value')
        .getByText('PATH is managed by Canopy and cannot be overridden here.');
      await expect(editorError).toBeVisible();
      await expect(window.getByTestId('environments-save')).toBeDisabled();

      await lastKeyInput(window).fill('SAFE_KEY');
      await expect(editorError).toBeHidden();
      await expect(window.getByTestId('environments-save')).toBeEnabled();
      await saveThenDeleteSelected();
    });

    await test.step('bulk editor mode round-trips key/value variables', async () => {
      await window.getByTestId('environments-new-environment').click();
      await window
        .getByTestId('environments-name-input')
        .fill('Bulk Round Trip');
      await window.getByTestId('environment-editor-add-row').click();
      await lastKeyInput(window).fill('FOO');
      await lastValueInput(window).fill('bar');

      await window.getByTestId('environment-editor-mode-bulk').click();
      const bulkTextarea = window.getByTestId(
        'environment-editor-bulk-textarea',
      );
      await expect(bulkTextarea).toBeVisible();
      await expect(bulkTextarea).toHaveValue(/FOO=bar/);
      await bulkTextarea.fill('FOO=bar\nBAZ=qux');

      await window.getByTestId('environment-editor-mode-key-value').click();
      await expect(
        window.getByTestId('environment-editor-key-value'),
      ).toBeVisible();
      const keyInputs = window.locator(
        'input[data-testid^="environment-editor-key-"]',
      );
      await expect(keyInputs.first()).toBeVisible();
      const keyValues = await keyInputs.evaluateAll((inputs) =>
        inputs.map((input) => input.value).filter((value) => value.length > 0),
      );
      expect(keyValues.sort()).toEqual(['BAZ', 'FOO']);
      await saveThenDeleteSelected();
    });

    await test.step('parent inheritance updates the resolved preview', async () => {
      await window.getByTestId('environments-new-environment').click();
      await window.getByTestId('environments-name-input').fill('Parent Env');
      await window.getByTestId('environment-editor-add-row').click();
      await lastKeyInput(window).fill('INHERITED');
      await lastValueInput(window).fill('from-parent');

      // New environment lives on the list, so return there first.
      await backToEnvironmentList(window);
      await window.getByTestId('environments-new-environment').click();
      await window.getByTestId('environments-name-input').fill('Child Env');
      const parentSelect = window.getByTestId('environments-parent-select');
      await expect(parentSelect).toBeVisible();
      await parentSelect.selectOption({ label: 'Parent Env' });

      const resolved = window.getByTestId('environments-resolved-list');
      await expect(resolved).toBeVisible();
      await expect(resolved).toContainText('INHERITED');
      await expect(resolved).toContainText('from-parent');
      await expect(resolved).toContainText('Parent Env');

      await deleteSelected();
      await window
        .getByTestId('environments-list')
        .getByText('Parent Env', { exact: true })
        .click();
      await deleteSelected();
      await expect(window.getByTestId('environments-unsaved')).toHaveCount(0);
    });

    await test.step('global runtime defaults modal opens and renders runtime selects', async () => {
      await window.getByTestId('environments-open-global-defaults').click();
      const modal = window.getByTestId('environments-global-defaults-modal');
      await expect(modal).toBeVisible();
      await expect(
        window.getByTestId('environments-global-runtime-canopy'),
      ).toBeVisible();
      await expect(
        window.getByTestId('environments-global-runtime-agent'),
      ).toBeVisible();
      await expect(
        window.getByTestId('environments-global-runtime-pipeline'),
      ).toBeVisible();
      await window.getByTestId('environments-global-defaults-close').click();
      await expect(modal).toBeHidden();
    });

    await test.step('default environments cannot be deleted (delete guard)', async () => {
      await window.getByTestId('environments-list-row-default-overall').click();
      await expect(window.getByTestId('environments-delete')).toBeDisabled();
      await expect(
        window.getByTestId('environments-delete-blocked-reason'),
      ).toHaveText('Default environments cannot be deleted.');
      await backToEnvironmentList(window);
    });

    await test.step('drill-in edits survive Back and save from the list', async () => {
      await window.getByTestId('environments-new-environment').click();
      const page = window.getByTestId('settings-tab-environment');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Untitled environment',
      );
      await window
        .getByTestId('environments-name-input')
        .fill('Drill-in Probe');
      await window.getByTestId('environment-editor-add-row').click();
      await lastKeyInput(window).fill('DRILL_IN');
      await lastValueInput(window).fill('kept');

      await backToEnvironmentList(window);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Environments',
      );
      // The save bar serves both views, so the edit is still pending here.
      await expect(window.getByTestId('environments-unsaved')).toBeVisible();
      await expect(window.getByTestId('environments-save')).toBeVisible();
      await saveChanges();

      await window
        .getByTestId('environments-list')
        .getByText('Drill-in Probe', { exact: true })
        .click();
      await expect(lastKeyInput(window, environmentEditor(window))).toHaveValue(
        'DRILL_IN',
      );
      await deleteSelected();
      // Deleting returns to the list.
      await expect(window.getByTestId('environments-list')).toBeVisible();
      await expect(
        window
          .getByTestId('environments-list')
          .getByText('Drill-in Probe', { exact: true }),
      ).toHaveCount(0);
      await saveChanges();
    });

    await test.step('search filters the environment list and shows the empty state', async () => {
      const search = window.getByTestId('environments-search');
      await expect(search).toBeVisible();
      await search.fill('Overall');
      await expect(
        window.getByTestId('environments-list-row-default-overall'),
      ).toBeVisible();
      await search.fill('zzz-no-such-environment-zzz');
      await expect(
        window.getByTestId('environments-list-no-matches'),
      ).toBeVisible();
      await expect(search).toHaveValue('zzz-no-such-environment-zzz');
      await search.fill('');
      await expect(
        window.getByTestId('environments-list-row-default-overall'),
      ).toBeVisible();
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
test('CAN-3220 workspace Retry saves the pending environment without saving its local assignment draft', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    const page = window.getByTestId('settings-tab-environment');
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    const baselineRecord = readEnvironmentRecord(userDataDir);
    const baselineAssignments =
      JSON.parse(baselineRecord).data.workspaceAssignments;
    await addFixtureEnvironment(window);
    restore = await injectSecureStorageFault(electronApp, 'encrypt-failed');
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'failed',
    );
    expect(readEnvironmentRecord(userDataDir)).toBe(baselineRecord);

    // Navigate with real controls; do not reload or seed the shared store.
    // The failed environment save must survive opening the assignment surface.
    await app.closeSettings();
    await app.openMainPage();
    const workspaceName = 'TypeScript pnpm Vite';
    await app.workspaceHeaderLabel(workspaceName).hover();
    await app.workspaceSettingsButton(workspaceName).click();
    const dialog = window.getByRole('dialog', { name: workspaceName });
    await dialog.getByRole('tab', { name: 'Environment', exact: true }).click();
    const tab = dialog.locator('[data-testid^="workspace-environment-tab-"]');
    await expect(tab.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'failed',
    );
    const runtime = tab.getByTestId('workspace-environment-canopy');
    await runtime.selectOption({ label: 'Overall (default)' });
    const localOverride = await runtime.inputValue();
    const save = tab.getByTestId('workspace-environment-save');
    await expect(save).toBeEnabled();
    await restore();
    await tab.getByTestId('secure-storage-retry').click();
    await expect(tab.getByTestId('secure-storage-notice')).toHaveCount(0);
    await expect(runtime).toHaveValue(localOverride);
    await expect(save).toBeEnabled();
    await expect(tab.getByTestId('workspace-environment-saved')).toHaveCount(0);

    const savedRecord = readEnvironmentRecord(userDataDir);
    expect(savedRecord).not.toContain(STORAGE_VALUE);
    const saved = JSON.parse(savedRecord).data;
    expect(saved.workspaceAssignments).toEqual(baselineAssignments);
    const environment = saved.environments.find(
      ({ name }) => name === STORAGE_ENVIRONMENT_NAME,
    );
    expect(environment).toBeDefined();
    expect(typeof environment.encryptedVariables).toBe('string');
    expect(
      await electronApp.evaluate(
        ({ safeStorage }, { encrypted, key, value }) =>
          JSON.parse(
            safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
          ).some((entry) => entry.key === key && entry.value === value),
        {
          encrypted: environment.encryptedVariables,
          key: STORAGE_KEY,
          value: STORAGE_VALUE,
        },
      ),
    ).toBe(true);
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('project Environment assignment tab saves a runtime override', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const workspaceName = 'TypeScript pnpm Vite';
    await expect(app.workspaceHeaderLabel(workspaceName)).toBeVisible();

    // Open the single-repo workspace settings modal.
    await app.workspaceHeaderLabel(workspaceName).hover();
    await app.workspaceSettingsButton(workspaceName).click();
    const dialog = window.getByRole('dialog', { name: workspaceName });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('tab', { name: 'General', exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('tab', { name: 'Details', exact: true }),
    ).toHaveCount(0);

    // The Environment tab has no testid — it is labelled within the dialog.
    // "Environment" scoped to the dialog.
    await dialog.getByRole('tab', { name: 'Environment' }).click();

    // The assignment tab is keyed by workspace id; match it by prefix.
    const envTab = dialog.locator(
      '[data-testid^="workspace-environment-tab-"]',
    );
    await expect(envTab).toBeVisible();

    // Change the Canopy runtime select to a concrete environment, which marks
    // the tab dirty and enables Save.
    const canopySelect = window.getByTestId('workspace-environment-canopy');
    await expect(canopySelect).toBeVisible();
    // Default environment options render with a "(default)" suffix.
    await canopySelect.selectOption({ label: 'Overall (default)' });

    const saveButton = window.getByTestId('workspace-environment-save');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(window.getByTestId('workspace-environment-saved')).toHaveText(
      'Saved.',
    );

    await window.getByTestId('workspace-environment-manage').click();
    await expect(dialog).toHaveCount(0);
    await expect(window.getByTestId('settings-tab-environment')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3220 PR5406 assignment save then Environments remount has no false unsaved or saved status', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    await addFixtureEnvironment(window);
    const page = window.getByTestId('settings-tab-environment');
    await page.getByTestId('environments-save').click();
    await expect(page.getByTestId('environments-save-status')).toHaveText(
      'Saved.',
    );
    await expect(page.getByTestId('environments-save-status')).toHaveCount(0);

    const { tab } = await openFixtureWorkspaceEnvironmentTab(window, app);
    await tab.getByTestId('workspace-environment-canopy').selectOption({
      label: STORAGE_ENVIRONMENT_NAME,
    });
    await tab.getByTestId('workspace-environment-save').click();
    await expect(tab.getByTestId('workspace-environment-saved')).toHaveText(
      'Saved.',
    );
    await tab.getByTestId('workspace-environment-manage').click();
    await expect(page).toBeVisible();
    await expect(page.getByTestId('environments-unsaved')).toHaveCount(0);
    await expect(page.getByTestId('environments-save-status')).toHaveCount(0);
    await expect(page.getByTestId('environments-save')).toHaveText(
      'Save changes',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const assignmentFirst of [false, true]) {
  test(`CAN-3220 PR5406 overlapping assignment and environment saves settle Save Changes${assignmentFirst ? ' (assignment first)' : ''}`, async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    let fixture;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openEnvironmentsSettings();
      await addFixtureEnvironment(window);
      const page = window.getByTestId('settings-tab-environment');
      await page.getByTestId('environments-save').click();
      await expect(page.getByTestId('environments-save-status')).toHaveText(
        'Saved.',
      );
      await expect(page.getByTestId('environments-save-status')).toHaveCount(0);
      const { tab } = await openFixtureWorkspaceEnvironmentTab(window, app);
      await tab.getByTestId('workspace-environment-canopy').selectOption({
        label: STORAGE_ENVIRONMENT_NAME,
      });
      await tab.getByTestId('workspace-environment-save').click();
      await expect(tab.getByTestId('workspace-environment-saved')).toHaveText(
        'Saved.',
      );
      const workspaceId = JSON.parse(
        readEnvironmentRecord(userDataDir),
      ).data.workspaceAssignments.find(
        (assignment) => assignment.runtimes.canopy,
      )?.workspaceId;
      expect(workspaceId).toBeTruthy();
      await tab.getByTestId('workspace-environment-manage').click();
      await expect(page).toBeVisible();
      await page
        .getByTestId('environments-list')
        .getByText(STORAGE_ENVIRONMENT_NAME, { exact: true })
        .click();
      await page
        .getByTestId('environments-name-input')
        .fill('Overlapping Draft');
      fixture = await interceptEnvironmentConfigIpc(
        electronApp,
        'gate-next-save',
      );
      // App Advisor updates the same assignment store while this page remains
      // mounted. Exercise both physical write orders with the real action.
      if (assignmentFirst) {
        await fixture.dispatchAssignment(workspaceId);
        await expect
          .poll(async () => (await fixture.counts()).saveEntered)
          .toBe(true);
        await page.getByTestId('environments-save').click();
      } else {
        await page.getByTestId('environments-save').click();
        await expect
          .poll(async () => (await fixture.counts()).saveEntered)
          .toBe(true);
        await fixture.dispatchAssignment(workspaceId);
      }
      await expect(page.getByTestId('environments-save')).toHaveText('Saving…');
      await expect
        .poll(async () => (await fixture.counts()).loadSettled)
        .toBeGreaterThanOrEqual(1);
      // A second Advisor round-trip fences the renderer continuation of the
      // assignment action after its preliminary read, before releasing Save.
      const fence = await fixture.fenceAdvisor();
      expect(fence.ok).toBe(true);
      await fixture.release();
      const action = await fixture.actionResponse();
      expect(action.ok).toBe(true);
      await expect(page.getByTestId('environments-save')).toHaveText(
        'Save changes',
      );
      await expect(page.getByTestId('environments-unsaved')).toHaveCount(0);
      await expect(page.getByTestId('environments-save-status')).toHaveText(
        'Saved.',
      );
      const saved = JSON.parse(readEnvironmentRecord(userDataDir)).data;
      expect(
        saved.environments.some(({ name }) => name === 'Overlapping Draft'),
      ).toBe(true);
      expect(
        saved.workspaceAssignments.find(
          (assignment) => assignment.workspaceId === workspaceId,
        )?.runtimes.agent,
      ).toBe('default-overall');
    } finally {
      try {
        await fixture?.restore();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });
}

test('CAN-3220 PR5406 failed preliminary assignment read then Manage Environments Retry rereads without saving', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  let fixture;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openEnvironmentsSettings();
    const { tab } = await openFixtureWorkspaceEnvironmentTab(window, app);
    await tab.getByTestId('workspace-environment-canopy').selectOption({
      label: 'Overall (default)',
    });
    fixture = await interceptEnvironmentConfigIpc(
      electronApp,
      'fail-next-load',
    );
    await tab.getByTestId('workspace-environment-save').click();
    await expect(tab.getByTestId('secure-storage-notice')).toBeVisible();
    expect((await fixture.counts()).saveCalls).toBe(0);
    await tab.getByTestId('workspace-environment-manage').click();
    const page = window.getByTestId('settings-tab-environment');
    await expect(page).toBeVisible();
    await page.getByTestId('secure-storage-retry').click();
    await expect(page.getByTestId('secure-storage-notice')).toHaveCount(0);
    await expect.poll(async () => (await fixture.counts()).loadCalls).toBe(2);
    expect((await fixture.counts()).saveCalls).toBe(0);
    await expect(
      page.getByTestId('environments-list-row-default-overall'),
    ).toBeVisible();
  } finally {
    try {
      await fixture?.restore();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('cowork project settings persist and deep-link back to Environment', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-settings-'),
  );
  const workspaceId = 'cowork-settings';
  const savedDescription = 'Persisted cowork settings description';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Cowork Settings',
    collapsed: false,
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();

    const rowTestId = `sidebar-cowork-project-${workspaceId}`;
    await window.getByTestId(`${rowTestId}-header`).hover();
    await window.getByTestId(`${rowTestId}-settings`).click();
    let dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(dialog).toBeVisible();

    await dialog.locator('#chat-project-description').fill(savedDescription);
    await dialog.getByTestId('chat-project-settings-retention-days').fill('30');
    await expect(
      dialog.getByTestId('chat-project-settings-retention'),
    ).toContainText(
      "Deleted chats and legacy archived chats are kept for 30 days before they're removed. Archived work entries are kept until you delete them.",
    );
    await expect(
      dialog
        .getByTestId('chat-project-settings-retention-card')
        .getByTestId('chat-project-settings-auto-archive-toggle'),
    ).toBeVisible();
    await dialog
      .getByTestId('chat-project-settings-auto-archive-toggle')
      .check();
    await dialog
      .getByTestId('chat-project-settings-auto-archive-days')
      .fill('14');
    await dialog.getByRole('tab', { name: 'Environment' }).click();
    await dialog
      .getByTestId('workspace-environment-canopy')
      .selectOption({ label: 'Overall (default)' });
    await dialog.getByTestId('workspace-environment-save').click();
    await expect(dialog.getByTestId('workspace-environment-saved')).toHaveText(
      'Saved.',
    );
    await dialog.getByRole('tab', { name: 'General' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await window.getByTestId(`${rowTestId}-header`).hover();
    await window.getByTestId(`${rowTestId}-settings`).click();
    dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(dialog.locator('#chat-project-description')).toHaveValue(
      savedDescription,
    );
    await expect(
      dialog.getByTestId('chat-project-settings-retention-days'),
    ).toHaveValue('30');
    await expect(
      dialog.getByTestId('chat-project-settings-auto-archive-toggle'),
    ).toBeChecked();
    await expect(
      dialog.getByTestId('chat-project-settings-auto-archive-days'),
    ).toHaveValue('14');

    await dialog.getByRole('tab', { name: 'Environment' }).click();
    await expect(
      dialog.getByTestId('workspace-environment-canopy'),
    ).toHaveValue('default-overall');
    await dialog.getByTestId('workspace-environment-manage').click();
    await expect(dialog).toHaveCount(0);
    await expect(window.getByTestId('settings-tab-environment')).toBeVisible();

    await window.getByTestId('environments-list-row-default-overall').click();
    await window
      .getByTestId('environment-usage-list')
      .getByRole('button')
      .filter({ hasText: 'Cowork Settings' })
      .click();
    // Settings closes so the project dialog opens in front, not behind it.
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
    dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(
      dialog.getByTestId('workspace-environment-canopy'),
    ).toBeVisible();

    await dialog.getByRole('tab', { name: 'General' }).click();
    await dialog.getByRole('switch', { name: 'Always show project' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await app.openChatPage();

    // Cowork workspaces with live entries remain visible even when
    // `alwaysShow` is disabled. Reopen settings from the row to verify the
    // toggle itself persisted without contradicting that visibility contract.
    await expect(window.getByTestId(rowTestId)).toBeVisible();
    await window.getByTestId(`${rowTestId}-header`).hover();
    await window.getByTestId(`${rowTestId}-settings`).click();
    dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(
      dialog.getByRole('switch', { name: 'Always show project' }),
    ).not.toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('command palette opens Settings → Environments', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // CAN-4269: Environments is no longer a sidebar destination.
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    await expect(
      window.getByTestId('sidebar-more-item-environments'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    await window.getByTestId('sidebar-search').click();
    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await window.getByTestId('command-palette-input').fill('>environments');
    await palette
      .getByTestId('command-palette-result')
      .filter({ hasText: 'Open Environments settings' })
      .click();

    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect(window.getByTestId('settings-tab-environment')).toBeVisible();
    await expect(window.getByTestId('environments-list')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
